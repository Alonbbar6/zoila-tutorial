#!/usr/bin/env node
// Waits quietly until something needs the owner, prints a Markdown report and exits 0.
// Meant to run in the background of a Claude Code session: the session is woken up when this
// process exits, handles the report, and then starts the watcher again.

import { existsSync, unlinkSync } from "node:fs";
import {
  BridgeError, DATA_NOTICE, STATE_PATH, backendStatus, call, formatDuration, intFlag, kindLabel, localTime,
  loadConfig, names, needsHumanReason, parseCli, quoteTitle, readState, renderThread, runMain, sleep, snapshot, writeState,
} from "./lib.mjs";

const HELP = `
Usage: node bridge/watch.mjs [--interval SECONDS] [--once] [--include-auto] [--history N] [--reset]

Checks the backend every few seconds. Stays silent until at least one thread needs a human
(a direct message, or a question nobody can answer automatically) and has changed since it was
last reported. Then it prints a Markdown report and exits with code 0.

The first time it runs, every thread that currently needs a human counts as news, so nothing is
missed. What was already reported is remembered in bridge/.state.json.

Options:
  --interval S     seconds between checks (default 20, minimum 5)
  --once           check once, print the report or "No news.", and exit
  --include-auto   also report threads that Tutor IA just answered automatically
  --history N      messages of history to include per thread (default 10)
  --reset          forget what was already reported (bridge/.state.json) before starting
  -h, --help       show this help

Network problems are retried with increasing waits (up to 5 minutes); the watcher does not exit
for them. Configuration or token problems stop it with an error message.
`;

const OVERLAP_MS = 2 * 60 * 1000; // re-read a little history each poll so late writes are never missed
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const RECONCILE_EVERY = 6; // every Nth poll also asks for all needs-human threads (catches flag-only changes)
const MAX_DETAILED = 6; // threads shown with full history in one report

const count = (t) => (Number.isFinite(Number(t?.messageCount)) ? Number(t.messageCount) : null);

// Did this thread get new messages since the snapshot we reported?
function grew(thread, prev) {
  const now = count(thread);
  const before = count(prev);
  if (now !== null && before !== null) return now > before;
  return thread.updatedAt !== prev.updatedAt;
}

function isNews(thread, prev, includeAuto) {
  if (thread.needsHuman) return !prev || !prev.needsHuman || grew(thread, prev);
  if (includeAuto && thread.status === "answered" && thread.lastFrom === "tutor") return !prev || grew(thread, prev);
  return false;
}

async function checkOnce(ctx) {
  const state = readState();
  const base = new Date(state.since || ctx.startedAt).getTime();
  const since = new Date((Number.isFinite(base) ? base : Date.now()) - OVERLAP_MS).toISOString();

  const events = await call("admin.events", { since });
  const candidates = new Map();
  for (const t of events?.threads || []) candidates.set(t.id, t);

  if (ctx.polls % RECONCILE_EVERY === 0) {
    const needs = await call("admin.list", { filter: "needs" });
    ctx.settings = needs?.settings || ctx.settings;
    ctx.stats = needs?.stats || ctx.stats;
    for (const t of needs?.threads || []) {
      const seen = candidates.get(t.id);
      if (!seen || String(t.updatedAt) >= String(seen.updatedAt)) candidates.set(t.id, t);
    }
  }

  const news = [...candidates.values()]
    .filter((t) => isNews(t, state.notified[t.id], ctx.includeAuto))
    // needs-human first, then oldest first (they have waited longest)
    .sort((a, b) => Number(Boolean(b.needsHuman)) - Number(Boolean(a.needsHuman)) || String(a.updatedAt).localeCompare(String(b.updatedAt)));

  const serverNow = events?.now || new Date().toISOString();
  if (!news.length) {
    state.since = serverNow;
    if (ctx.settings?.studentName) state.studentName = ctx.settings.studentName;
    writeState(state);
    ctx.polls++;
    return null;
  }

  // Full history for the first few; if any call fails, the whole check is retried later.
  const detailed = await Promise.all(news.slice(0, MAX_DETAILED).map((t) => call("admin.thread", { id: t.id })));
  const report = renderReport(news, detailed, ctx);

  // Re-read before writing: reply.mjs may have updated the file in the meantime.
  const fresh = readState();
  news.forEach((t, i) => {
    fresh.notified[t.id] = snapshot(detailed[i]?.thread || t);
  });
  fresh.since = serverNow;
  if (ctx.settings?.studentName) fresh.studentName = ctx.settings.studentName;
  writeState(fresh);
  ctx.polls++;
  return report;
}

function renderReport(news, detailed, ctx) {
  const { settings, stats } = ctx;
  const n = names(settings);
  const needCount = news.filter((t) => t.needsHuman).length;
  const autoCount = news.length - needCount;
  const parts = [];
  if (needCount) parts.push(`${needCount} thread${needCount === 1 ? " needs" : "s need"} a human`);
  if (autoCount) parts.push(`${autoCount} answered automatically`);

  const out = [
    `# Tutor bridge report: ${parts.join(", ")}`,
    "",
    `_Checked ${localTime(new Date().toISOString())}. Student: ${n.student}. Owner replies appear to ${n.student} as "${n.tutor}"._`,
    "",
    DATA_NOTICE(settings),
  ];
  const health = backendStatus(settings, stats).filter((l) => l.startsWith("**Warning:**"));
  if (health.length) out.push("", ...health.flatMap((l) => [l, ""]).slice(0, -1));

  news.forEach((t, i) => {
    const detail = detailed[i];
    if (!detail) return;
    const thread = detail.thread || t;
    const label = thread.needsHuman ? "NEEDS A HUMAN" : "FYI: answered automatically";
    out.push("", "---", "", `**${label}**`, "", renderThread(thread, detail.messages, settings, stats, { last: thread.needsHuman ? ctx.history : Math.min(ctx.history, 4) }));
  });

  const rest = news.slice(detailed.length);
  if (rest.length) {
    out.push("", "---", "", `## ${rest.length} more thread(s)`, "");
    for (const t of rest) {
      const why = t.needsHuman ? `needs a human: ${needsHumanReason(t, settings, stats)}` : "answered automatically";
      out.push(`- **#${t.number}** · ${kindLabel(t.kind)} · ${quoteTitle(t.title)} · ${why}. Details: \`node bridge/thread.mjs ${t.number}\``);
    }
  }

  const restart = `node bridge/watch.mjs${ctx.includeAuto ? " --include-auto" : ""}${ctx.intervalFlag ? ` --interval ${ctx.intervalFlag}` : ""}`;
  out.push(
    "",
    "---",
    "",
    "## Next steps (protocol in CLAUDE.md)",
    "",
    `1. Summarize each thread for the owner in English: who wrote, #number, kind, what ${n.student} asked or said.`,
    `2. For each thread that needs a human, propose a reply in Spanish and ask the owner to approve or edit it.`,
    "3. Post only after the owner approves that exact text:",
    "   `node bridge/reply.mjs <number> --as alon|tutor --file <file> [--email]`",
    `4. Start watching again: \`${restart}\``,
  );
  return out.join("\n");
}

runMain(async () => {
  const { values } = parseCli(HELP, {
    interval: { type: "string" },
    once: { type: "boolean" },
    "include-auto": { type: "boolean" },
    history: { type: "string" },
    reset: { type: "boolean" },
  });
  const intervalSeconds = intFlag(values.interval, "interval", { fallback: 20, min: 5, max: 3600 });
  const history = intFlag(values.history, "history", { fallback: 10, min: 1, max: 500 });
  loadConfig(); // fail fast with setup instructions if bridge/.env is missing

  if (values.reset && existsSync(STATE_PATH)) unlinkSync(STATE_PATH);

  const ctx = {
    includeAuto: Boolean(values["include-auto"]),
    intervalFlag: values.interval !== undefined ? intervalSeconds : null,
    history,
    polls: 0,
    settings: null,
    stats: null,
    startedAt: new Date().toISOString(),
    everSucceeded: false,
  };

  if (values.once) {
    const report = await checkOnce(ctx);
    process.stdout.write((report ?? "No news.") + "\n");
    return;
  }

  const intervalMs = intervalSeconds * 1000;
  let announced = false;
  const announce = () => {
    if (announced) return;
    announced = true;
    const student = ctx.settings?.studentName || readState().studentName || "Zoila";
    process.stderr.write(`Watching for ${student}'s messages every ${intervalSeconds}s…\n`);
  };

  let failures = 0;
  for (;;) {
    let report;
    try {
      report = await checkOnce(ctx);
    } catch (err) {
      // Wrong token, bad config, or a page that never worked: retrying will not help.
      const retryable = err instanceof BridgeError && (err.retryable || (err.code === "bad_response" && ctx.everSucceeded));
      if (!retryable) throw err;
      failures++;
      announce();
      const delay = Math.min(intervalMs * 2 ** failures, MAX_BACKOFF_MS);
      if (failures === 1 || failures % 12 === 0) {
        process.stderr.write(`Could not check for messages (${err.message}). Retrying in ${formatDuration(delay)} and will keep trying.\n`);
      }
      await sleep(delay);
      continue;
    }
    if (failures > 0) process.stderr.write("Connection restored.\n");
    failures = 0;
    ctx.everSucceeded = true;
    announce();
    if (report) {
      process.stdout.write(report + "\n");
      return;
    }
    await sleep(intervalMs);
  }
});
