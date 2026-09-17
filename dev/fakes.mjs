// In-memory fakes for the Apps Script services that backend/Code.gs uses (see its
// "PLATFORM API SURFACE" comment), plus a fake Claude Messages API behind UrlFetchApp.
//
//   import { createAppsScriptEnv } from "./fakes.mjs";
//   const env = createAppsScriptEnv({ start: "2026-09-16T15:00:00Z" });
//   env.context.setup();
//   const res = env.call("list", { room: env.state.properties.ROOM_TOKEN });
//
// The fakes are deliberately strict: they throw where Apps Script throws, emulate the way Google
// Sheets coerces written strings (formulas, numbers, dates, booleans, leading apostrophe), and
// record "violations" when Code.gs breaks its own rules (writes without the script lock, network
// or Gmail calls while holding it). Nothing here talks to the network.

import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..");
export const CODE_PATH = path.join(REPO_ROOT, "backend", "Code.gs");

const CLAUDE_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODES = ["ok", "fail", "refusal", "slow"];
const KNOWN_MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-opus-4-7"];
const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

function toMs(value) {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error("fakes: invalid time " + value);
  return ms;
}

function isDate(value) {
  return Object.prototype.toString.call(value) === "[object Date]";
}

// Synchronous sleep (Apps Script code is synchronous, so the harness must block too).
function blockFor(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function appsScriptError(message) {
  // Apps Script errors surface as "Exception: <message>".
  return new Error("Exception: " + message);
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return undefined;
}

/**
 * Clock shared by the fakes and the Date object inside the vm context.
 * - start omitted: real time (plus an offset that advance()/set() change).
 * - start given: frozen time that only moves by advance()/set() and by autoAdvanceMs per read
 *   (1 ms per read keeps timestamps distinct, like real time would).
 */
export function createClock({ start, autoAdvanceMs = 0 } = {}) {
  let fixed = start === undefined || start === null ? null : toMs(start);
  let offset = 0;
  return {
    get frozen() {
      return fixed !== null;
    },
    now() {
      if (fixed === null) return Date.now() + offset;
      const t = fixed;
      fixed += autoAdvanceMs;
      return t;
    },
    peek() {
      return fixed === null ? Date.now() + offset : fixed;
    },
    iso() {
      return new Date(this.peek()).toISOString();
    },
    set(value) {
      const ms = toMs(value);
      if (fixed === null) offset = ms - Date.now();
      else fixed = ms;
    },
    advance(ms) {
      if (fixed === null) offset += ms;
      else fixed += ms;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Google Sheets value coercion
// ---------------------------------------------------------------------------------------------
//
// Range.setValues / Sheet.appendRow parse strings like typed input (documented: "=" starts a
// formula; the setValues example shows "$2.99" and "1,000,000" becoming numbers). A leading
// apostrophe forces text and is not part of the stored value. The rules below are a strict
// approximation, so that a naive String write fails the round-trip tests.

const NUMBER_LIKE = /^[+-]?\$?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:e[+-]?\d+)?%?$/i;

function parseNumberLike(text) {
  if (!/\d/.test(text) || !NUMBER_LIKE.test(text)) return null;
  const percent = text.endsWith("%");
  const n = Number(text.replace(/[$,%]/g, ""));
  if (!Number.isFinite(n)) return null;
  return percent ? n / 100 : n;
}

function validYmd(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function parseDateLike(text) {
  let m = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/i);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!validYmd(y, mo, d)) return null;
    return new Date(Date.UTC(y, mo - 1, d, Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0)));
  }
  m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // US locale M/D/YYYY
  if (m) {
    const [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!validYmd(y, mo, d)) return null;
    return new Date(Date.UTC(y, mo - 1, d));
  }
  m = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/); // a time of day becomes a date-time value
  if (m && Number(m[1]) < 24 && Number(m[2]) < 60) {
    return new Date(Date.UTC(1899, 11, 30, Number(m[1]), Number(m[2]), Number(m[3] || 0)));
  }
  return null;
}

/** What Google Sheets stores for a value written with setValues/appendRow. */
export function coerceCellInput(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw appsScriptError("Invalid argument: value is not a finite number");
    return value;
  }
  if (typeof value === "boolean") return value;
  if (isDate(value)) return new Date(value.getTime());
  if (typeof value !== "string") {
    throw appsScriptError("The parameters (" + Object.prototype.toString.call(value) + ") don't match the method signature for SpreadsheetApp.Range.setValues.");
  }
  if (value.length > 50000) {
    throw appsScriptError("Your input contains more than the maximum of 50000 characters in a single cell.");
  }
  if (value === "") return "";
  if (value[0] === "'") return value.slice(1); // text escape: the apostrophe is not stored
  if (value[0] === "=") {
    const simple = value.match(/^=\s*([+-]?\d+(?:\.\d+)?)\s*$/);
    if (simple) return Number(simple[1]);
    if (/^=\s*SUM\(/i.test(value)) return 0; // references to empty cells sum to 0
    return "#ERROR!";
  }
  const trimmed = value.trim();
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true";
  const n = parseNumberLike(trimmed);
  if (n !== null) return n;
  const d = parseDateLike(trimmed);
  if (d) return d;
  if (/^[+-]/.test(trimmed)) return "#ERROR!"; // "+x" / "-x" are parsed as formulas and fail
  return value;
}

function cloneCell(value) {
  return isDate(value) ? new Date(value.getTime()) : value;
}

// ---------------------------------------------------------------------------------------------
// The environment
// ---------------------------------------------------------------------------------------------

/**
 * options:
 *   codePath        path to Code.gs (default backend/Code.gs); loadCode:false skips loading it
 *   start           frozen start time (ISO/ms). Omit for real time.
 *   autoAdvanceMs   ms added per clock read when frozen (default 1)
 *   sleep           "real" (Atomics.wait) | "virtual" (advance the clock). Default: virtual when frozen.
 *   timeZone        Session.getScriptTimeZone() (default from backend/appsscript.json)
 *   ownerEmail      the Gmail account the script runs as (default owner@example.com)
 *   claudeMode      ok | fail | refusal | slow (default ok)
 *   claudeDelayMs   delay for slow mode (default env FAKE_CLAUDE_DELAY_MS or 1500)
 *   verbose         forward Logger/console output to the Node console
 */
export function createAppsScriptEnv(options = {}) {
  const clock = createClock({ start: options.start, autoAdvanceMs: options.autoAdvanceMs ?? 1 });
  const sleepMode = options.sleep || (clock.frozen ? "virtual" : "real");
  const timeZone = options.timeZone || readManifestTimeZone();
  const ownerEmail = (options.ownerEmail || "owner@example.com").toLowerCase();
  const verbose = Boolean(options.verbose);

  const state = {
    clock,
    timeZone,
    ownerEmail,
    spreadsheet: null,
    properties: {}, // Script Properties as a plain object (tests may edit it directly)
    cache: new Map(),
    lock: { held: false, acquisitions: 0 },
    violations: [], // broken platform rules (writes without lock, network while locked, ...)
    logs: [], // Logger.log and console.* output
    sentEmails: [], // every outgoing mail: {kind:"reply"|"send", to, subject, body, htmlBody, name, ...}
    gmail: { threads: new Map(), messages: new Map(), labels: new Set(), nextId: 0x18f0000000 },
    triggers: [],
    claude: {
      mode: CLAUDE_MODES.includes(options.claudeMode) ? options.claudeMode : "ok",
      delayMs: options.claudeDelayMs ?? (Number(process.env.FAKE_CLAUDE_DELAY_MS) || 1500),
      queue: [], // one-shot modes consumed before `mode`
      requests: [], // {at, url, headers, body, status, mode, error?}
      onRequest: null, // test hook (request) => void, runs before the fake answers
    },
    counters: { urlFetch: 0, gmailSend: 0, sleepMs: 0 },
  };

  function violation(text) {
    state.violations.push(text);
    if (verbose) console.warn("[fakes] violation: " + text);
  }
  function requireLock(operation) {
    if (!state.lock.held) violation(operation + " called without holding the script lock");
  }
  function forbidLock(operation) {
    if (state.lock.held) violation(operation + " called while holding the script lock");
  }
  function log(level, args) {
    const text = args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" ");
    state.logs.push({ level, text, at: clock.peek() });
    if (verbose) (level === "error" ? console.error : console.log)("[gas " + level + "] " + text);
  }

  // ----- SpreadsheetApp -------------------------------------------------------------------

  function makeSheet(name) {
    const cells = []; // rows of stored values ("" = empty)

    function lastRow() {
      for (let r = cells.length - 1; r >= 0; r--) {
        if (cells[r] && cells[r].some((v) => v !== "")) return r + 1;
      }
      return 0;
    }
    function lastColumn() {
      let max = 0;
      cells.forEach((row) => {
        if (!row) return;
        for (let c = row.length - 1; c >= 0; c--) {
          if (row[c] !== "") {
            max = Math.max(max, c + 1);
            break;
          }
        }
      });
      return max;
    }
    function writeCell(r, c, value) {
      while (cells.length <= r) cells.push([]);
      const row = cells[r];
      while (row.length <= c) row.push("");
      row[c] = coerceCellInput(value);
    }
    function checkPositive(value, what) {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw appsScriptError("The parameters don't match the method signature for SpreadsheetApp.Sheet.getRange (" + what + ").");
      }
      if (value < 1) throw appsScriptError("The " + what + " of the range is too small.");
    }

    const sheet = {
      getName: () => name,
      getLastRow: () => lastRow(),
      getLastColumn: () => lastColumn(),
      getRange(row, column, numRows, numColumns) {
        if (arguments.length !== 4 && arguments.length !== 2) {
          throw new Error("fakes: Code.gs only uses getRange(row, column[, numRows, numColumns])");
        }
        const rows = numRows === undefined ? 1 : numRows;
        const cols = numColumns === undefined ? 1 : numColumns;
        checkPositive(row, "starting row");
        checkPositive(column, "starting column");
        checkPositive(rows, "number of rows");
        checkPositive(cols, "number of columns");
        return {
          getValues() {
            const out = [];
            for (let r = 0; r < rows; r++) {
              const src = cells[row - 1 + r] || [];
              const line = [];
              for (let c = 0; c < cols; c++) {
                const v = src[column - 1 + c];
                line.push(v === undefined ? "" : cloneCell(v));
              }
              out.push(line);
            }
            return out;
          },
          setValues(values) {
            requireLock("Range.setValues");
            if (!Array.isArray(values) || values.some((line) => !Array.isArray(line))) {
              throw appsScriptError("The parameters don't match the method signature for SpreadsheetApp.Range.setValues.");
            }
            if (values.length !== rows) {
              throw appsScriptError("The number of rows in the data does not match the number of rows in the range. The data has " + values.length + " but the range has " + rows + ".");
            }
            values.forEach((line) => {
              if (line.length !== cols) {
                throw appsScriptError("The number of columns in the data does not match the number of columns in the range. The data has " + line.length + " but the range has " + cols + ".");
              }
            });
            // Validate every value before writing anything (a failing call writes nothing).
            values.forEach((line) => line.forEach((v) => coerceCellInput(v)));
            values.forEach((line, r) => line.forEach((v, c) => writeCell(row - 1 + r, column - 1 + c, v)));
            return this;
          },
        };
      },
      appendRow(rowContents) {
        requireLock("Sheet.appendRow");
        if (!Array.isArray(rowContents) || rowContents.length === 0) {
          throw appsScriptError("The parameters don't match the method signature for SpreadsheetApp.Sheet.appendRow.");
        }
        rowContents.forEach((v) => coerceCellInput(v));
        const r = lastRow();
        cells.splice(r); // drop trailing empty rows so the new row lands right after the data
        rowContents.forEach((v, c) => writeCell(r, c, v));
        return sheet;
      },
      deleteRow(rowPosition) {
        requireLock("Sheet.deleteRow");
        if (typeof rowPosition !== "number" || !Number.isInteger(rowPosition) || rowPosition < 1 || rowPosition > Math.max(lastRow(), 1000)) {
          throw appsScriptError("Those rows are out of bounds.");
        }
        if (rowPosition <= cells.length) cells.splice(rowPosition - 1, 1);
        return sheet;
      },
      // Harness-only accessors (not part of the Apps Script surface).
      _cells: cells,
    };
    return sheet;
  }

  function makeSpreadsheet() {
    const sheets = [makeSheet("Sheet1")];
    return {
      getSheetByName: (name) => sheets.find((s) => s.getName() === name) || null,
      insertSheet(name) {
        requireLock("Spreadsheet.insertSheet");
        if (typeof name !== "string" || !name) throw appsScriptError("Invalid argument: sheetName");
        if (sheets.some((s) => s.getName() === name)) {
          throw appsScriptError('A sheet with the name "' + name + '" already exists. Please enter another name.');
        }
        const sheet = makeSheet(name);
        sheets.push(sheet);
        return sheet;
      },
      getSheets: () => sheets.slice(),
    };
  }

  state.spreadsheet = options.noSpreadsheet ? null : makeSpreadsheet();

  const SpreadsheetApp = {
    getActiveSpreadsheet: () => state.spreadsheet,
  };

  // ----- PropertiesService ----------------------------------------------------------------

  const scriptProperties = {
    getProperty(key) {
      if (typeof key !== "string") throw appsScriptError("Invalid argument: key");
      return Object.prototype.hasOwnProperty.call(state.properties, key) ? state.properties[key] : null;
    },
    setProperty(key, value) {
      requireLock("Properties.setProperty");
      if (typeof key !== "string" || !key) throw appsScriptError("Invalid argument: key");
      if (typeof value !== "string") violation("Properties.setProperty(" + key + ") with a non-string value");
      const text = String(value);
      if (Buffer.byteLength(key) + Buffer.byteLength(text) > 9 * 1024) {
        throw appsScriptError("Argument too large: value");
      }
      state.properties[key] = text;
      return scriptProperties;
    },
    deleteProperty(key) {
      requireLock("Properties.deleteProperty");
      delete state.properties[key];
      return scriptProperties;
    },
  };
  const PropertiesService = { getScriptProperties: () => scriptProperties };

  // ----- LockService ----------------------------------------------------------------------

  const LockService = {
    getScriptLock() {
      let mine = false;
      return {
        waitLock(timeoutInMillis) {
          if (typeof timeoutInMillis !== "number") throw appsScriptError("Invalid argument: timeoutInMillis");
          if (state.lock.held) {
            // Single-threaded harness: whoever holds it cannot release it while we wait.
            if (mine) violation("waitLock called again on a lock this execution already holds (nested lock)");
            else violation("waitLock while the script lock is held (nested lock or re-entrant call)");
            throw appsScriptError("Lock timeout: another process was holding the lock for too long.");
          }
          state.lock.held = true;
          state.lock.acquisitions++;
          mine = true;
        },
        tryLock(timeoutInMillis) {
          if (state.lock.held) return false;
          this.waitLock(timeoutInMillis);
          return true;
        },
        hasLock: () => mine && state.lock.held,
        releaseLock() {
          if (mine) {
            state.lock.held = false;
            mine = false;
          }
        },
      };
    },
  };

  // ----- CacheService ---------------------------------------------------------------------

  const scriptCache = {
    get(key) {
      if (typeof key !== "string") throw appsScriptError("Invalid argument: key");
      const entry = state.cache.get(key);
      if (!entry) return null;
      if (entry.expires <= clock.peek()) {
        state.cache.delete(key);
        return null;
      }
      return entry.value;
    },
    put(key, value, expirationInSeconds) {
      if (typeof key !== "string" || key.length > 250) throw appsScriptError("Invalid argument: key");
      if (typeof value !== "string") throw appsScriptError("Invalid argument: value");
      if (Buffer.byteLength(value) > 100 * 1024) throw appsScriptError("Argument too large: value");
      let seconds = expirationInSeconds === undefined ? 600 : expirationInSeconds;
      if (typeof seconds !== "number" || seconds < 1 || seconds > 21600) {
        throw appsScriptError("Invalid argument: expirationInSeconds (1-21600)");
      }
      state.cache.set(key, { value, expires: clock.peek() + seconds * 1000 });
    },
    remove(key) {
      state.cache.delete(key);
    },
  };
  const CacheService = { getScriptCache: () => scriptCache };

  // ----- Utilities / Session / Logger -----------------------------------------------------

  const Utilities = {
    getUuid: () => crypto.randomUUID(),
    base64Encode(data) {
      if (typeof data === "string") return Buffer.from(data, "utf8").toString("base64");
      if (!Array.isArray(data) && !ArrayBuffer.isView(data)) throw appsScriptError("Invalid argument: data");
      return Buffer.from(Array.from(data, (b) => b & 255)).toString("base64");
    },
    formatDate(date, tz, format) {
      if (!date || typeof date.getTime !== "function" || !Number.isFinite(date.getTime())) {
        throw appsScriptError("Invalid argument: date");
      }
      if (typeof tz !== "string" || typeof format !== "string") throw appsScriptError("Invalid argument");
      return formatDateInZone(date.getTime(), tz, format);
    },
    sleep(milliseconds) {
      if (typeof milliseconds !== "number" || milliseconds < 0 || milliseconds > 300000) {
        throw appsScriptError("Invalid argument: milliseconds");
      }
      state.counters.sleepMs += milliseconds;
      if (sleepMode === "real") blockFor(milliseconds);
      else clock.advance(milliseconds);
    },
  };

  const Session = { getScriptTimeZone: () => timeZone };

  const Logger = {
    log(message) {
      log("Logger", [message]);
      return Logger;
    },
  };

  const fakeConsole = {
    log: (...args) => log("log", args),
    info: (...args) => log("info", args),
    warn: (...args) => log("warn", args),
    error: (...args) => log("error", args),
  };

  // ----- ContentService -------------------------------------------------------------------

  const MimeType = { JSON: "JSON", TEXT: "TEXT", JAVASCRIPT: "JAVASCRIPT", CSV: "CSV", ICAL: "ICAL", RSS: "RSS", ATOM: "ATOM", VCARD: "VCARD", XML: "XML" };
  const ContentService = {
    MimeType,
    createTextOutput(content) {
      let text = content === undefined ? "" : String(content);
      let mime = MimeType.TEXT;
      const output = {
        getContent: () => text,
        setContent(value) {
          text = String(value);
          return output;
        },
        getMimeType: () => mime,
        setMimeType(value) {
          if (!Object.values(MimeType).includes(value)) throw appsScriptError("Invalid argument: mimeType");
          mime = value;
          return output;
        },
      };
      return output;
    },
  };

  // ----- ScriptApp ------------------------------------------------------------------------

  let triggerSeq = 0;
  const ScriptApp = {
    getProjectTriggers: () => state.triggers.slice(),
    deleteTrigger(trigger) {
      const index = state.triggers.findIndex((t) => t.getUniqueId() === (trigger && trigger.getUniqueId && trigger.getUniqueId()));
      if (index < 0) throw appsScriptError("Invalid argument: trigger");
      state.triggers.splice(index, 1);
    },
    newTrigger(functionName) {
      if (typeof functionName !== "string" || !functionName) throw appsScriptError("Invalid argument: functionName");
      return {
        timeBased() {
          const spec = { minutes: null };
          const builder = {
            everyMinutes(n) {
              if (![1, 5, 10, 15, 30].includes(n)) throw appsScriptError("Invalid argument: minutes (1, 5, 10, 15 or 30)");
              spec.minutes = n;
              return builder;
            },
            create() {
              if (!spec.minutes) throw appsScriptError("A time-based trigger needs a schedule before create().");
              const id = String(++triggerSeq);
              const trigger = {
                getHandlerFunction: () => functionName,
                getUniqueId: () => id,
                getEventType: () => "CLOCK",
                everyMinutes: spec.minutes, // harness inspection
              };
              state.triggers.push(trigger);
              return trigger;
            },
          };
          return builder;
        },
      };
    },
  };

  // ----- GmailApp -------------------------------------------------------------------------

  const gmail = state.gmail;

  function newGmailId() {
    gmail.nextId += 1 + Math.floor(Math.random() * 7);
    return gmail.nextId.toString(16).padStart(16, "0");
  }

  function makeLabel(name) {
    return { getName: () => name, _fakeLabel: true };
  }

  function wrapAttachment(a) {
    const bytes = toByteArray(a.bytes !== undefined ? a.bytes : a.data !== undefined ? a.data : Buffer.alloc(a.size || 0));
    return {
      getName: () => a.name || "attachment",
      getContentType: () => (a.contentType === undefined ? null : a.contentType),
      getSize: () => (a.size !== undefined ? a.size : bytes.length),
      // Apps Script returns Java byte[] as an array of signed numbers.
      getBytes: () => Array.from(bytes, (b) => (b > 127 ? b - 256 : b)),
      _inline: Boolean(a.inline),
    };
  }

  function wrapMessage(record) {
    return {
      getId: () => record.id,
      getFrom: () => record.from,
      getTo: () => record.to,
      getDate: () => new Date(record.date),
      getSubject: () => record.subject,
      getPlainBody: () => record.body,
      getBody: () => record.htmlBody || record.body,
      getThread: () => wrapThread(gmail.threads.get(record.threadId)),
      getAttachments(opts) {
        const o = opts || {};
        Object.keys(o).forEach((key) => {
          if (!["includeInlineImages", "includeAttachments"].includes(key)) {
            throw appsScriptError("Invalid argument: unknown getAttachments option " + key);
          }
        });
        const includeInline = o.includeInlineImages !== false;
        const includeRegular = o.includeAttachments !== false;
        return (record.attachments || []).map(wrapAttachment).filter((a) => (a._inline ? includeInline : includeRegular));
      },
      reply(body, opts) {
        forbidLock("GmailMessage.reply");
        if (typeof body !== "string") throw appsScriptError("Invalid argument: body");
        const o = opts || {};
        Object.keys(o).forEach((key) => {
          if (!["htmlBody", "name", "cc", "bcc", "replyTo", "attachments", "inlineImages", "noReply", "from"].includes(key)) {
            throw appsScriptError("Invalid argument: unknown reply option " + key);
          }
        });
        const thread = gmail.threads.get(record.threadId);
        const subject = /^re:/i.test(record.subject) ? record.subject : "Re: " + record.subject;
        const sent = addMessage({
          threadId: record.threadId,
          from: (o.name ? o.name + " <" + ownerEmail + ">" : ownerEmail),
          to: record.from,
          subject,
          body,
          htmlBody: o.htmlBody,
          date: clock.now(),
          folder: "sent",
        });
        state.counters.gmailSend++;
        state.sentEmails.push({
          kind: "reply",
          to: extractAddress(record.from),
          subject,
          body,
          htmlBody: o.htmlBody || null,
          name: o.name || null,
          inReplyTo: record.id,
          gmailThreadId: thread.id,
          messageId: sent.id,
          at: new Date(sent.date).toISOString(),
        });
        return this;
      },
    };
  }

  function wrapThread(thread) {
    return {
      getId: () => thread.id,
      getMessages: () => thread.messageIds.map((id) => gmail.messages.get(id)).sort((a, b) => a.date - b.date).map(wrapMessage),
      getLastMessageDate: () => new Date(Math.max(...thread.messageIds.map((id) => gmail.messages.get(id).date))),
      getFirstMessageSubject: () => gmail.messages.get(thread.messageIds[0]).subject,
      getLabels: () => Array.from(thread.labels).map(makeLabel),
      addLabel(label) {
        if (!label || !label._fakeLabel || !gmail.labels.has(label.getName())) {
          throw appsScriptError("Invalid argument: label");
        }
        thread.labels.add(label.getName());
        return this;
      },
    };
  }

  function addMessage(input) {
    const id = newGmailId();
    let thread = input.threadId ? gmail.threads.get(input.threadId) : null;
    if (input.threadId && !thread) {
      thread = { id: input.threadId, messageIds: [], labels: new Set() };
      gmail.threads.set(thread.id, thread);
    }
    if (!thread) {
      thread = { id, messageIds: [], labels: new Set() }; // Gmail thread id = its first message id
      gmail.threads.set(id, thread);
    }
    const record = {
      id,
      threadId: thread.id,
      from: input.from,
      to: input.to || ownerEmail,
      subject: input.subject === undefined ? "" : String(input.subject),
      body: input.body === undefined ? "" : String(input.body),
      htmlBody: input.htmlBody,
      date: toMs(input.date === undefined ? clock.peek() : input.date),
      folder: input.folder || "inbox",
      attachments: input.attachments || [],
    };
    gmail.messages.set(id, record);
    thread.messageIds.push(id);
    return record;
  }

  // Supports the query shapes Code.gs builds: from:(a OR b) / from:a, newer_than:Nd, -in:x, in:x.
  function searchThreads(query) {
    const tokens = [];
    const re = /(-?)(\w+):\(([^)]*)\)|(-?)(\w+):(\S+)|(\S+)/g;
    let m;
    while ((m = re.exec(query))) {
      if (m[2]) tokens.push({ neg: m[1] === "-", key: m[2].toLowerCase(), values: m[3].split(/\s+OR\s+|\s+/i).filter(Boolean) });
      else if (m[5]) tokens.push({ neg: m[4] === "-", key: m[5].toLowerCase(), values: [m[6]] });
      else tokens.push({ neg: false, key: "text", values: [m[7]] });
    }
    const now = clock.peek();
    function messageMatches(msg) {
      return tokens.every((t) => {
        let hit;
        if (t.key === "from") hit = t.values.some((v) => extractAddress(msg.from) === v.toLowerCase() || msg.from.toLowerCase().includes(v.toLowerCase()));
        else if (t.key === "in") hit = t.values.some((v) => msg.folder === v.toLowerCase());
        else if (t.key === "newer_than") {
          const nm = t.values[0].match(/^(\d+)([dmy])$/);
          if (!nm) throw appsScriptError("fakes: unsupported newer_than value " + t.values[0]);
          const days = Number(nm[1]) * (nm[2] === "d" ? 1 : nm[2] === "m" ? 30 : 365);
          hit = msg.date >= now - days * 86400000;
        } else if (t.key === "text") hit = (msg.subject + "\n" + msg.body).toLowerCase().includes(t.values[0].toLowerCase());
        else throw appsScriptError("fakes: unsupported Gmail search operator " + t.key);
        return t.neg ? !hit : hit;
      });
    }
    return Array.from(gmail.threads.values())
      .filter((thread) => thread.messageIds.some((id) => messageMatches(gmail.messages.get(id))))
      .sort((a, b) => lastDate(b) - lastDate(a)); // newest thread first, like Gmail
  }
  function lastDate(thread) {
    return Math.max(...thread.messageIds.map((id) => gmail.messages.get(id).date));
  }

  const GmailApp = {
    search(query, start, max) {
      forbidLock("GmailApp.search");
      if (typeof query !== "string") throw appsScriptError("Invalid argument: query");
      if (arguments.length !== 1 && arguments.length !== 3) throw appsScriptError("Invalid argument: search(query, start, max)");
      const from = start === undefined ? 0 : start;
      const count = max === undefined ? 500 : max;
      if (!Number.isInteger(from) || from < 0 || !Number.isInteger(count) || count < 1 || count > 500) {
        throw appsScriptError("Invalid argument: max must be 1-500");
      }
      return searchThreads(query).slice(from, from + count).map(wrapThread);
    },
    getMessageById(id) {
      forbidLock("GmailApp.getMessageById");
      const record = gmail.messages.get(String(id));
      if (!record) throw appsScriptError("Invalid argument: id"); // Apps Script throws for unknown ids
      return wrapMessage(record);
    },
    getUserLabelByName(name) {
      forbidLock("GmailApp.getUserLabelByName");
      return gmail.labels.has(name) ? makeLabel(name) : null;
    },
    createLabel(name) {
      forbidLock("GmailApp.createLabel");
      if (typeof name !== "string" || !name) throw appsScriptError("Invalid argument: name");
      gmail.labels.add(name);
      return makeLabel(name);
    },
    sendEmail(recipient, subject, body, opts) {
      forbidLock("GmailApp.sendEmail");
      if (typeof recipient !== "string" || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(recipient.trim())) {
        throw appsScriptError("Invalid email: " + recipient);
      }
      if (typeof subject !== "string" || typeof body !== "string") throw appsScriptError("Invalid argument");
      if (subject.length > 250) throw appsScriptError("Argument too large: subject");
      const o = opts || {};
      Object.keys(o).forEach((key) => {
        if (!["htmlBody", "name", "cc", "bcc", "replyTo", "attachments", "inlineImages", "noReply", "from"].includes(key)) {
          throw appsScriptError("Invalid argument: unknown sendEmail option " + key);
        }
      });
      state.counters.gmailSend++;
      state.sentEmails.push({
        kind: "send",
        to: recipient.trim().toLowerCase(),
        subject,
        body,
        htmlBody: o.htmlBody || null,
        name: o.name || null,
        at: new Date(clock.now()).toISOString(),
      });
      return GmailApp;
    },
  };

  // ----- UrlFetchApp + fake Claude --------------------------------------------------------

  const FETCH_PARAMS = ["method", "contentType", "headers", "payload", "muteHttpExceptions", "timeoutSeconds", "followRedirects", "validateHttpsCertificates", "escaping"];

  function httpResponse(status, bodyText) {
    return {
      getResponseCode: () => status,
      getContentText: () => bodyText,
      getHeaders: () => ({ "Content-Type": "application/json" }),
    };
  }

  const UrlFetchApp = {
    fetch(url, params) {
      forbidLock("UrlFetchApp.fetch");
      state.counters.urlFetch++;
      if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw appsScriptError("Invalid argument: url");
      const p = params || {};
      Object.keys(p).forEach((key) => {
        if (!FETCH_PARAMS.includes(key)) throw appsScriptError("Invalid argument: unknown fetch parameter " + key);
      });
      if (p.timeoutSeconds !== undefined && (typeof p.timeoutSeconds !== "number" || p.timeoutSeconds <= 0)) {
        throw appsScriptError("Invalid argument: timeoutSeconds");
      }
      if (url !== CLAUDE_URL) {
        throw appsScriptError("Address unavailable: " + url + " (the dev harness only fakes " + CLAUDE_URL + ")");
      }
      const { status, body } = fakeClaude(p);
      const text = JSON.stringify(body);
      if (status >= 400 && !p.muteHttpExceptions) {
        throw appsScriptError("Request failed for https://api.anthropic.com returned code " + status + ". Truncated server response: " + text.slice(0, 200) + " (use muteHttpExceptions option to examine full response)");
      }
      return httpResponse(status, text);
    },
  };

  function apiError(status, type, message) {
    return { status, body: { type: "error", error: { type, message }, request_id: "req_fake_" + crypto.randomUUID().slice(0, 8) } };
  }

  function fakeClaude(p) {
    const headers = p.headers || {};
    const entry = { at: new Date(clock.peek()).toISOString(), url: CLAUDE_URL, headers: redactHeaders(headers), body: null, status: 0, mode: null, error: null };
    state.claude.requests.push(entry);
    const finish = (result) => {
      entry.status = result.status;
      if (result.body && result.body.error) entry.error = result.body.error.message;
      return result;
    };

    let body;
    try {
      body = typeof p.payload === "string" ? JSON.parse(p.payload) : null;
    } catch {
      body = null;
    }
    entry.body = body;

    const problem = validateClaudeRequest(p, headers, body);
    if (problem) return finish(problem);

    const mode = state.claude.queue.length ? state.claude.queue.shift() : state.claude.mode;
    entry.mode = mode;
    if (typeof state.claude.onRequest === "function") state.claude.onRequest(entry);

    if (mode === "slow") {
      const delay = state.claude.delayMs;
      if (p.timeoutSeconds !== undefined && delay > p.timeoutSeconds * 1000) {
        if (sleepMode === "real") blockFor(p.timeoutSeconds * 1000);
        else clock.advance(p.timeoutSeconds * 1000);
        entry.status = -1;
        entry.error = "timeout";
        throw appsScriptError("Timeout: " + CLAUDE_URL);
      }
      if (sleepMode === "real") blockFor(delay);
      else clock.advance(delay);
    }
    if (mode === "fail") return finish(apiError(500, "api_error", "Internal server error (fake)"));
    if (mode === "refusal") {
      return finish({
        status: 200,
        body: { id: "msg_fake_" + state.claude.requests.length, type: "message", role: "assistant", model: body.model, content: [], stop_reason: "refusal", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } },
      });
    }
    const lastText = lastUserText(body.messages);
    return finish({
      status: 200,
      body: {
        id: "msg_fake_" + state.claude.requests.length,
        type: "message",
        role: "assistant",
        model: body.model,
        content: [
          { type: "thinking", thinking: "La estudiante necesita una pista corta.", signature: "fake-signature" },
          { type: "text", text: fakeAnswer(lastText, body.messages) },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: Math.ceil(JSON.stringify(body).length / 4), output_tokens: 120 },
      },
    });
  }

  function validateClaudeRequest(p, headers, body) {
    const bad = (message) => apiError(400, "invalid_request_error", message);
    if (String(p.method || "get").toLowerCase() !== "post") return apiError(405, "not_found_error", "Method not allowed (use POST)");
    const apiKey = headerValue(headers, "x-api-key");
    if (typeof apiKey !== "string" || !apiKey) return apiError(401, "authentication_error", "x-api-key header is required");
    if (headerValue(headers, "authorization")) return bad("use x-api-key, not Authorization");
    const version = headerValue(headers, "anthropic-version");
    if (!version) return bad("anthropic-version: header is required");
    if (version !== "2023-06-01") return bad("anthropic-version: unsupported version " + version);
    const contentType = String(p.contentType || headerValue(headers, "content-type") || "");
    if (!/^application\/json\b/i.test(contentType)) return bad("content-type must be application/json");
    if (!body || typeof body !== "object" || Array.isArray(body)) return bad("request body must be a JSON object");

    const allowed = ["model", "max_tokens", "messages", "system", "metadata", "stop_sequences", "stream", "temperature", "top_p", "top_k", "tools", "tool_choice", "thinking", "output_config", "fallbacks", "service_tier"];
    for (const key of Object.keys(body)) {
      if (!allowed.includes(key)) return bad(key + ": Extra inputs are not permitted");
    }
    if (typeof body.model !== "string" || !body.model) return bad("model: Field required");
    if (!KNOWN_MODELS.includes(body.model)) return apiError(404, "not_found_error", "model: " + body.model);
    if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 128000) {
      return bad("max_tokens: must be an integer between 1 and 128000");
    }
    if (body.stream === true) return bad("stream: the dev harness does not fake streaming");
    if (body.fallbacks !== undefined) {
      const beta = String(headerValue(headers, "anthropic-beta") || "");
      if (!beta.split(",").map((s) => s.trim()).includes("server-side-fallback-2026-07-01")) {
        return bad("fallbacks: requires the anthropic-beta header server-side-fallback-2026-07-01");
      }
      if (body.fallbacks !== "default" && !Array.isArray(body.fallbacks)) return bad('fallbacks: must be "default" or a list');
    }
    if (body.output_config !== undefined) {
      const oc = body.output_config;
      if (!oc || typeof oc !== "object" || Array.isArray(oc)) return bad("output_config: must be an object");
      for (const key of Object.keys(oc)) {
        if (!["effort", "format"].includes(key)) return bad("output_config." + key + ": Extra inputs are not permitted");
      }
      if (oc.effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(oc.effort)) {
        return bad("output_config.effort: invalid value " + oc.effort);
      }
    }
    if (body.system !== undefined) {
      if (typeof body.system === "string") {
        if (!body.system.trim()) return bad("system: text content blocks must be non-empty");
      } else if (!Array.isArray(body.system) || body.system.some((b) => !b || b.type !== "text" || typeof b.text !== "string" || !b.text)) {
        return bad("system: must be a string or a list of text blocks");
      }
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) return bad("messages: at least one message is required");
    for (let i = 0; i < body.messages.length; i++) {
      const msg = body.messages[i];
      const where = "messages." + i;
      if (!msg || typeof msg !== "object") return bad(where + ": must be an object");
      for (const key of Object.keys(msg)) {
        if (!["role", "content"].includes(key)) return bad(where + "." + key + ": Extra inputs are not permitted");
      }
      if (msg.role !== "user" && msg.role !== "assistant") return bad(where + ".role: must be user or assistant");
      if (i === 0 && msg.role !== "user") return bad("messages: first message must use the user role");
      if (i > 0 && body.messages[i - 1].role === msg.role) return bad("messages: roles must alternate between user and assistant");
      const blockProblem = validateContent(msg.content, where + ".content", msg.role);
      if (blockProblem) return bad(blockProblem);
    }
    if (body.messages[body.messages.length - 1].role !== "user") {
      return bad("messages: the final message must use the user role (this model does not support assistant prefill)");
    }
    return null;
  }

  function validateContent(content, where, role) {
    if (typeof content === "string") return content.trim() ? null : where + ": text content must be non-empty";
    if (!Array.isArray(content) || content.length === 0) return where + ": must be a non-empty string or list of blocks";
    for (let j = 0; j < content.length; j++) {
      const block = content[j];
      const at = where + "." + j;
      if (!block || typeof block !== "object") return at + ": must be an object";
      if (block.type === "text") {
        if (typeof block.text !== "string" || !block.text.trim()) return at + ".text: must be a non-empty string";
        for (const key of Object.keys(block)) if (!["type", "text", "cache_control"].includes(key)) return at + "." + key + ": Extra inputs are not permitted";
      } else if (block.type === "image") {
        if (role !== "user") return at + ": image blocks are only allowed in user messages";
        const src = block.source;
        if (!src || typeof src !== "object") return at + ".source: Field required";
        if (src.type !== "base64") return at + ".source.type: the harness only accepts base64 images";
        if (!IMAGE_MEDIA_TYPES.includes(src.media_type)) return at + ".source.media_type: must be one of " + IMAGE_MEDIA_TYPES.join(", ");
        if (typeof src.data !== "string" || !src.data || !/^[A-Za-z0-9+/]+={0,2}$/.test(src.data) || src.data.length % 4 !== 0) {
          return at + ".source.data: must be valid base64";
        }
        if (Buffer.from(src.data, "base64").length > 5 * 1024 * 1024) return at + ".source.data: image exceeds 5 MB maximum";
        for (const key of Object.keys(block)) if (!["type", "source", "cache_control"].includes(key)) return at + "." + key + ": Extra inputs are not permitted";
      } else {
        return at + ".type: unsupported block type " + block.type;
      }
    }
    return null;
  }

  // ----- The vm context -------------------------------------------------------------------

  const sandbox = {
    SpreadsheetApp,
    PropertiesService,
    LockService,
    CacheService,
    Utilities,
    Session,
    ContentService,
    UrlFetchApp,
    GmailApp,
    ScriptApp,
    Logger,
    console: fakeConsole,
    __fakeNow: () => clock.now(),
  };
  const context = vm.createContext(sandbox, { name: "Apps Script (fake)" });
  // Replace Date inside the context so new Date() / Date.now() follow the harness clock.
  vm.runInContext(
    `(function () {
      const RealDate = Date;
      const now = __fakeNow;
      class FakeDate extends RealDate {
        constructor(...args) {
          if (args.length === 0) super(now());
          else super(...args);
        }
        static now() { return now(); }
      }
      globalThis.Date = FakeDate;
      delete globalThis.__fakeNow;
    })();`,
    context,
    { filename: "fakes-prelude.js" }
  );

  const services = { SpreadsheetApp, PropertiesService, LockService, CacheService, Utilities, Session, ContentService, UrlFetchApp, GmailApp, ScriptApp, Logger, console: fakeConsole };

  if (options.loadCode !== false) {
    const source = fs.readFileSync(options.codePath || CODE_PATH, "utf8");
    vm.runInContext(source, context, { filename: "Code.gs" });
  }

  // ----- Harness helpers ------------------------------------------------------------------

  /** Adds an inbound email to the owner's Gmail. Returns {messageId, threadId}. */
  function addInboundEmail({ from, subject = "", body = "", date, threadId, attachments, to } = {}) {
    if (!from) throw new Error("fakes: addInboundEmail needs from");
    if (threadId && !gmail.threads.has(threadId)) throw new Error("fakes: unknown Gmail thread " + threadId);
    const record = addMessage({ from, subject, body, date, threadId, attachments, to, folder: "inbox" });
    return { messageId: record.id, threadId: record.threadId };
  }

  function setClaudeMode(mode, { delayMs } = {}) {
    if (!CLAUDE_MODES.includes(mode)) throw new Error("fakes: unknown Claude mode " + mode);
    state.claude.mode = mode;
    if (delayMs !== undefined) state.claude.delayMs = Number(delayMs);
  }

  function queueClaudeModes(...modes) {
    modes.forEach((mode) => {
      if (!CLAUDE_MODES.includes(mode)) throw new Error("fakes: unknown Claude mode " + mode);
    });
    state.claude.queue.push(...modes);
  }

  /** Raw stored cell values of a sheet (including the header row). */
  function sheetValues(name) {
    const sheet = state.spreadsheet && state.spreadsheet.getSheetByName(name);
    if (!sheet) return null;
    const rows = sheet.getLastRow();
    const cols = sheet.getLastColumn();
    if (!rows || !cols) return [];
    return sheet.getRange(1, 1, rows, cols).getValues();
  }

  /** Rows of a sheet as objects keyed by header (raw stored values). */
  function sheetRecords(name) {
    const values = sheetValues(name);
    if (!values || !values.length) return [];
    const header = values[0].map(String);
    return values.slice(1).map((row) => Object.fromEntries(header.map((h, i) => [h, row[i]])));
  }

  /** Runs a doPost call like the web app would receive it and returns the parsed JSON envelope. */
  function call(action, params = {}) {
    const contents = JSON.stringify({ action, ...params });
    const output = context.doPost({
      parameter: {},
      parameters: {},
      queryString: "",
      contextPath: "",
      contentLength: Buffer.byteLength(contents),
      postData: { contents, type: "text/plain", length: Buffer.byteLength(contents), name: "postData" },
    });
    return parseOutput(output);
  }

  /** Runs a doGet call with the given query parameters and returns the parsed JSON envelope. */
  function get(query = {}) {
    const parameter = {};
    const parameters = {};
    Object.entries(query).forEach(([k, v]) => {
      parameter[k] = String(v);
      parameters[k] = [String(v)];
    });
    const output = context.doGet({ parameter, parameters, queryString: new URLSearchParams(parameter).toString(), contextPath: "", contentLength: -1 });
    return parseOutput(output);
  }

  function parseOutput(output) {
    if (!output || typeof output.getContent !== "function") throw new Error("fakes: handler did not return a TextOutput");
    if (output.getMimeType() !== MimeType.JSON) throw new Error("fakes: handler returned mime type " + output.getMimeType());
    return JSON.parse(output.getContent());
  }

  Object.assign(state, { addInboundEmail, setClaudeMode, queueClaudeModes, sheetValues, sheetRecords });

  return {
    context,
    services,
    state,
    clock,
    call,
    get,
    addInboundEmail,
    setClaudeMode,
    queueClaudeModes,
    sheetValues,
    sheetRecords,
    run: (name, ...args) => {
      if (typeof context[name] !== "function") throw new Error("fakes: Code.gs has no function " + name);
      return context[name](...args);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------------------------

function readManifestTimeZone() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "backend", "appsscript.json"), "utf8"));
    return manifest.timeZone || "Etc/UTC";
  } catch {
    return "Etc/UTC";
  }
}

function formatDateInZone(ms, timeZone, format) {
  let parts;
  try {
    parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
      }).formatToParts(new Date(ms)).map((p) => [p.type, p.value])
    );
  } catch {
    throw appsScriptError("Invalid argument: timeZone " + timeZone);
  }
  return format.replace(/yyyy|MM|dd|HH|mm|ss|[A-Za-z]/g, (token) => {
    switch (token) {
      case "yyyy": return parts.year;
      case "MM": return parts.month;
      case "dd": return parts.day;
      case "HH": return parts.hour;
      case "mm": return parts.minute;
      case "ss": return parts.second;
      default: throw new Error("fakes: Utilities.formatDate pattern letter not faked: " + token);
    }
  });
}

function extractAddress(from) {
  const text = String(from || "");
  const m = text.match(/<([^>]+)>/);
  return (m ? m[1] : text).trim().toLowerCase();
}

function toByteArray(value) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (Array.isArray(value)) return Buffer.from(value.map((b) => b & 255));
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new Error("fakes: attachment bytes must be a Buffer, Uint8Array, array or string");
}

function redactHeaders(headers) {
  const out = {};
  Object.keys(headers).forEach((key) => {
    out[key] = key.toLowerCase() === "x-api-key" ? "[redacted]" : headers[key];
  });
  return out;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// Text of the final user turn (string content or its text blocks).
function lastUserText(messages) {
  const last = messages[messages.length - 1];
  if (typeof last.content === "string") return last.content;
  return last.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

// Deterministic Spanish Markdown answer that quotes the start of the student's last text.
function fakeAnswer(lastText, messages) {
  const withoutHeader = lastText.replace(/^\[Hilo #[^\]]*\]\s*/, "");
  const start = withoutHeader.replace(/\s+/g, " ").trim().slice(0, 60);
  const images = messages[messages.length - 1].content;
  const imageCount = Array.isArray(images) ? images.filter((b) => b.type === "image").length : 0;
  const lines = [
    "**¡Buena pregunta!** Leí tu mensaje: \"" + start + "\"",
    "",
    "Vamos paso a paso. Primero prueba este ejemplo corto:",
    "",
    "```python",
    "# Guardamos un saludo en una variable",
    "saludo = \"hola\"",
    "# Lo mostramos en pantalla",
    "print(saludo)",
    "```",
    "",
    "- Ejecuta el código y mira qué aparece.",
    "- Cambia `saludo` por tu nombre.",
  ];
  if (imageCount) lines.push("", "(Vi " + imageCount + " imagen(es) adjunta(s).)");
  lines.push("", "Mini tarea: cuéntame qué resultado obtuviste.");
  return lines.join("\n");
}
