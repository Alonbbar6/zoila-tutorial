// Owner console (admin.html). English UI; replies are written in Spanish.
import { CONFIG, isConfigured } from "./config.js";
import { call, ApiError } from "./api.js";
import {
  el, renderMarkdown, timeAgo, fullDate, store, takeHashParam, setTitleBadge,
  chime, askNotificationPermission, notify, announce, toast, poll, copyText,
} from "./ui.js";

// ---------- constants ----------

const KEYS = {
  token: "tutor.admin.token",
  filter: "tutor.admin.filter",
  notify: "tutor.admin.notify",
  compose: "tutor.admin.compose", // unsent reply text per thread id
};

const TICK_STALE_MS = 3 * 60 * 1000;
const STATUS_LABELS = { waiting: "Waiting", answering: "Answering…", answered: "Answered", closed: "Closed" };
const KIND_LABELS = { question: "Question", direct: "Direct" };
const FILTERS = {
  needs: (t) => t.needsHuman,
  all: () => true,
  direct: (t) => t.kind === "direct",
  email: (t) => t.origin === "email",
};
const EMPTY_TEXT = {
  needs: "Nothing needs you right now.",
  all: "No threads yet. New questions and messages show up here.",
  direct: "No direct messages.",
  email: "No threads came in by email.",
};

const $ = (id) => document.getElementById(id);
const isUnauthorized = (err) => err instanceof ApiError && err.code === "unauthorized";
const isNarrow = () => matchMedia("(max-width: 879px)").matches;

// ---------- state ----------

const state = {
  token: null,
  poller: null,
  timers: [],
  loaded: false,
  threads: [],
  settings: {},
  stats: null,
  lastSyncAt: 0,
  offline: false,
  filter: "needs",
  listKey: "",
  selectedId: null,
  detail: null, // { thread, messages }
  historyKey: "",
  seenNeeds: new Map(), // id -> updatedAt for threads that need the owner
  baselined: false,
  drafting: new Set(), // thread ids with a Claude draft in flight
  sending: false,
  settingsBase: null,
  seq: { refresh: 0, detail: 0, history: 0, preview: 0 },
};

const tutorName = () => String(state.settings.tutorName || "").trim() || "Owner";
const studentName = () => String(state.settings.studentName || "").trim() || "Student";

// ---------- boot / screens / auth ----------

function boot() {
  wireEvents();
  // Take the token out of the visible URL first, even if the backend is not configured yet.
  const fromHash = takeHashParam("admin");
  if (fromHash) store.set(KEYS.token, fromHash.trim());
  if (!isConfigured()) {
    showScreen("not-configured");
    return;
  }
  const token = store.get(KEYS.token);
  if (typeof token === "string" && token) startConsole(token);
  else showSignIn();
}

function showScreen(name) {
  for (const screen of ["boot", "not-configured", "signin", "console"]) {
    $(`screen-${screen}`).hidden = screen !== name;
  }
}

function showSignIn(message = "", tone = "info") {
  showScreen("signin");
  setSignInMessage(message, tone);
  $("signin-token").value = "";
  $("signin-token").focus();
}

function setSignInMessage(message, tone = "info") {
  const box = $("signin-msg");
  box.textContent = message;
  box.hidden = !message;
  box.className = `notice ${tone === "error" ? "notice-warn" : "notice-info"}`;
}

async function onSignIn(event) {
  event.preventDefault();
  const input = $("signin-token");
  const token = input.value.trim();
  if (!token) {
    setSignInMessage("Paste your admin token first.", "error");
    input.focus();
    return;
  }
  const button = $("signin-submit");
  setBusy(button, true, "Checking…");
  try {
    const result = await call("admin.list", { admin: token }, { timeoutMs: 25000 });
    store.set(KEYS.token, token);
    startConsole(token, result);
  } catch (err) {
    setSignInMessage(
      isUnauthorized(err) ? "That token was not accepted. Check it and try again." : `Could not check the token: ${err.message}`,
      "error",
    );
    input.focus();
    input.select();
  } finally {
    setBusy(button, false);
  }
}

function startConsole(token, initialResult) {
  stopConsole();
  state.token = token;
  state.filter = FILTERS[store.get(KEYS.filter)] ? store.get(KEYS.filter) : "needs";
  showScreen("console");
  updateShortcutHint();
  renderNotifyButton();
  renderFilters();
  renderList(true);
  if (initialResult) applyList(initialResult);
  state.poller = poll(refreshAll, CONFIG.pollSeconds);
  state.timers.push(setInterval(updateClock, 1000));
  state.timers.push(setInterval(() => updateRelativeTimes($("screen-console")), 15000));
}

// Clears everything tied to the signed-in session.
function stopConsole() {
  state.poller?.stop();
  state.poller = null;
  state.timers.forEach(clearInterval);
  state.timers = [];
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  Object.assign(state, {
    token: null, loaded: false, threads: [], settings: {}, stats: null, lastSyncAt: 0, offline: false,
    listKey: "", selectedId: null, detail: null, historyKey: "", seenNeeds: new Map(), baselined: false,
    sending: false, settingsBase: null,
  });
  state.drafting.clear();
  for (const key of Object.keys(state.seq)) state.seq[key]++; // invalidate in-flight responses
  setTitleBadge(0);
}

function signOut() {
  stopConsole();
  store.remove(KEYS.token);
  store.remove(KEYS.compose);
  showSignIn("Signed out. The token was removed from this browser.");
}

function handleUnauthorized() {
  stopConsole();
  store.remove(KEYS.token);
  showSignIn("Your admin token was not accepted (it may have changed). Please sign in again.", "error");
}

// Every admin call goes through here so an expired token always returns to sign-in.
async function adminCall(action, params = {}, opts) {
  const token = state.token;
  if (!token) throw new ApiError("unauthorized", "Signed out.");
  try {
    return await call(action, { ...params, admin: token }, opts);
  } catch (err) {
    if (isUnauthorized(err) && state.token === token) handleUnauthorized();
    throw err;
  }
}

// ---------- data refresh ----------

async function refreshAll() {
  if (!state.token) return;
  const seq = ++state.seq.refresh;
  let result;
  try {
    result = await adminCall("admin.list", {}, { timeoutMs: 25000 });
  } catch (err) {
    if (seq === state.seq.refresh && !isUnauthorized(err)) setOffline(err);
    return;
  }
  if (seq !== state.seq.refresh || !state.token) return; // a newer refresh already started
  setOffline(null);
  applyList(result);
}

function applyList(result) {
  state.threads = Array.isArray(result?.threads) ? result.threads : [];
  state.settings = result?.settings || {};
  state.stats = result?.stats || null;
  state.lastSyncAt = Date.now();
  state.loaded = true;
  detectNeeds();
  renderHeader();
  renderStrip();
  renderFilters();
  renderList();
  renderDetailEmpty();
  syncSelectedThread();
}

function setOffline(err) {
  state.offline = Boolean(err);
  $("conn-banner").hidden = !err;
  if (err) {
    const what = ["network", "timeout"].includes(err.code) ? "Can't reach the backend" : "The backend returned an error";
    $("conn-text").textContent = `${what}: ${err.message} Retrying every ${CONFIG.pollSeconds}s.`;
  }
  updateClock();
}

// Replace one thread in the list with a fresher copy (e.g. from an action result).
// `own` = the change came from this console, so it must not trigger a "needs you" alert.
function mergeThread(thread, { own = false } = {}) {
  if (!thread?.id) return;
  const index = state.threads.findIndex((t) => t.id === thread.id);
  if (index >= 0) state.threads[index] = thread;
  else state.threads.push(thread);
  if (own) {
    if (thread.needsHuman) state.seenNeeds.set(thread.id, thread.updatedAt);
    else state.seenNeeds.delete(thread.id);
  }
  if (state.detail?.thread.id === thread.id) state.detail.thread = thread;
  renderFilters();
  renderList();
  renderDetailEmpty();
  setTitleBadge(state.threads.filter((t) => t.needsHuman).length);
}

// Alert when a thread newly needs the owner (unseen id, or updatedAt changed while it needs them).
function detectNeeds() {
  const needs = state.threads.filter((t) => t.needsHuman);
  const fresh = state.baselined ? needs.filter((t) => state.seenNeeds.get(t.id) !== t.updatedAt) : [];
  state.seenNeeds = new Map(needs.map((t) => [t.id, t.updatedAt]));
  state.baselined = true; // the first load only sets the baseline, no alert
  setTitleBadge(needs.length);
  if (!fresh.length) return;

  const one = fresh.length === 1 ? fresh[0] : null;
  const title = one ? `#${one.number} needs you` : `${fresh.length} threads need you`;
  const body = fresh.map((t) => `#${t.number} ${t.title}`).join(" · ");
  chime();
  announce(`${title}: ${body}`);
  if (store.get(KEYS.notify, false)) notify(title, body);
}

// ---------- header + status strip ----------

function renderHeader() {
  $("console-sub").textContent = `${studentName()} · Power BI + Python`;
  $("send-as-alon-label").textContent = tutorName();
  $("link-warn").hidden = !state.loaded || Boolean(String(state.settings.siteUrl || "").trim());
}

function setPill(node, tone, text) {
  node.hidden = !tone;
  if (!tone) return;
  node.className = `pill pill-xs pill-${tone}`;
  node.textContent = text;
}

function renderStrip() {
  const s = state.stats;
  if (!s) return;

  const used = Number(s.autoCallsToday) || 0;
  const cap = Number(s.dailyCap ?? state.settings.dailyCap) || 0;
  $("calls-today").textContent = String(used);
  $("calls-cap").textContent = String(cap);
  const bar = $("calls-bar");
  bar.style.width = `${cap > 0 ? Math.min(100, (used / cap) * 100) : 100}%`;
  bar.classList.toggle("is-full", used >= cap);
  bar.classList.toggle("is-high", used < cap && used >= cap * 0.8);
  if (cap === 0) setPill($("calls-pill"), "muted", "Automatic calls off");
  else if (used >= cap) setPill($("calls-pill"), "alert", "Cap reached");
  else setPill($("calls-pill"), null);

  const keyOk = Boolean(s.apiKeyConfigured);
  $("key-text").textContent = keyOk ? "Configured" : "Not configured";
  setPill($("key-pill"), keyOk ? "good" : "alert", keyOk ? "OK" : "Missing");
  $("key-hint").hidden = keyOk;

  const emailOk = Boolean(s.emailConfigured);
  $("email-text").textContent = emailOk ? "Configured" : "Not configured";
  setPill($("email-pill"), emailOk ? "good" : "muted", emailOk ? "On" : "Off");
  $("email-hint").textContent = emailOk
    ? (s.lastIntakeAt ? `Last checked ${agoShort(Date.now() - Date.parse(s.lastIntakeAt))}` : "Not checked yet")
    : "Add student email addresses in Settings.";

  const lastError = formatError(s.lastError);
  $("stat-error").hidden = !lastError;
  $("error-text").textContent = lastError;

  updateClock();
}

// Runs every second: backend heartbeat and "updated Xs ago".
function updateClock() {
  const s = state.stats;
  if (s) {
    const at = Date.parse(s.lastTickAt || "");
    const age = Number.isFinite(at) ? Date.now() - at : null;
    const stale = age === null || age > TICK_STALE_MS;
    const text = $("tick-text");
    text.textContent = age === null ? "Never ran" : `Last ran ${agoShort(age)}`;
    text.title = age === null ? "" : fullDate(s.lastTickAt, "en");
    setPill($("tick-pill"), stale ? "alert" : "good", stale ? (age === null ? "Not running" : "Stalled") : "Running");
    $("tick-hint").hidden = !stale;
  }
  const sync = $("sync-status");
  if (state.offline) sync.textContent = "Offline, retrying";
  else sync.textContent = state.lastSyncAt ? `Updated ${agoShort(Date.now() - state.lastSyncAt)}` : "";
}

function agoShort(ms) {
  const sec = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 172800) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

// lastError is normally a string; accept {at, message} too.
function formatError(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  const when = value.at ? `${fullDate(value.at, "en")}\n` : "";
  return when + (value.message || JSON.stringify(value));
}

function updateRelativeTimes(root) {
  for (const node of root.querySelectorAll("[data-rel]")) {
    node.textContent = timeAgo(node.dataset.rel, "en");
  }
}

// ---------- inbox ----------

function compareThreads(a, b) {
  if (Boolean(a.needsHuman) !== Boolean(b.needsHuman)) return a.needsHuman ? -1 : 1;
  return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
}

function renderFilters() {
  for (const [name, test] of Object.entries(FILTERS)) {
    $(`filter-${name}`).setAttribute("aria-pressed", String(state.filter === name));
    $(`count-${name}`).textContent = state.loaded ? String(state.threads.filter(test).length) : "–";
  }
  $("filter-needs").classList.toggle("has-needs", state.threads.some((t) => t.needsHuman));
}

function setFilter(name) {
  if (!FILTERS[name]) return;
  state.filter = name;
  store.set(KEYS.filter, name);
  renderFilters();
  renderList(true);
}

function renderList(force = false) {
  const list = $("thread-list");
  $("list-loading").hidden = state.loaded;
  if (!state.loaded) {
    list.replaceChildren();
    $("list-empty").hidden = true;
    return;
  }

  const items = state.threads.filter(FILTERS[state.filter]).sort(compareThreads);
  const key = JSON.stringify([
    state.filter,
    items.map((t) => [t.id, t.number, t.title, t.updatedAt, t.status, t.kind, t.origin, t.needsHuman, Boolean(t.draft), t.errorCount]),
  ]);
  if (force || key !== state.listKey) {
    state.listKey = key;
    const focusedId = list.contains(document.activeElement) ? document.activeElement.dataset.id : null;
    list.replaceChildren(...items.map(threadRow));
    markSelectedRow(focusedId);
  } else {
    updateRelativeTimes(list);
  }

  const empty = items.length === 0;
  $("list-empty").hidden = !empty;
  if (empty) {
    $("list-empty-text").textContent = EMPTY_TEXT[state.filter];
    $("btn-show-all").hidden = state.filter === "all" || state.threads.length === 0;
  }
}

function threadRow(t) {
  const errors = Number(t.errorCount) || 0;
  return el("li", {},
    el("button", {
      type: "button",
      class: "thread-row",
      tabindex: "-1",
      dataset: { id: t.id },
      onclick: () => selectThread(t.id, { focusDetail: isNarrow() }),
    },
      el("span", { class: "row-num num", text: `#${t.number}` }),
      el("span", { class: "row-title", text: t.title || "(no title)" }),
      el("time", { class: "row-time", datetime: t.updatedAt, title: fullDate(t.updatedAt, "en"), dataset: { rel: t.updatedAt }, text: timeAgo(t.updatedAt, "en") }),
      el("span", { class: "row-meta" },
        statusPill(t.status),
        t.needsHuman ? el("span", { class: "pill pill-alert pill-xs", text: "Needs you" }) : null,
        el("span", { class: "tag", text: KIND_LABELS[t.kind] || t.kind }),
        el("span", { class: "tag", text: t.origin === "email" ? "email" : "site" }),
        t.draft ? el("span", { class: "tag tag-info", text: "Draft ready" }) : null,
        errors > 0 ? el("span", { class: "tag tag-warn", text: `${errors} error${errors === 1 ? "" : "s"}` }) : null,
      ),
    ),
  );
}

function statusPill(status) {
  return el("span", { class: `pill pill-xs pill-${STATUS_LABELS[status] ? status : "closed"}`, text: STATUS_LABELS[status] || status });
}

// Roving tabindex: one row is tabbable, arrow keys move between rows.
function markSelectedRow(focusId = null) {
  const rows = [...$("thread-list").querySelectorAll(".thread-row")];
  for (const row of rows) {
    if (row.dataset.id === state.selectedId) row.setAttribute("aria-current", "true");
    else row.removeAttribute("aria-current");
    row.tabIndex = -1;
  }
  const active = rows.find((r) => r.dataset.id === (focusId || state.selectedId)) || rows[0];
  if (active) active.tabIndex = 0;
  if (focusId && active?.dataset.id === focusId) active.focus();
}

function onListKeydown(event) {
  const rows = [...$("thread-list").querySelectorAll(".thread-row")];
  const index = rows.indexOf(document.activeElement);
  if (index < 0) return;
  const targets = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: rows.length - 1 };
  if (!(event.key in targets)) return;
  event.preventDefault();
  const next = rows[Math.max(0, Math.min(rows.length - 1, targets[event.key]))];
  rows.forEach((r) => (r.tabIndex = -1));
  next.tabIndex = 0;
  next.focus();
}

// ---------- thread detail ----------

function setView(view) {
  $("console-grid").dataset.view = view;
}

function renderDetailEmpty() {
  if (state.selectedId) return;
  const needs = state.threads.filter((t) => t.needsHuman).sort(compareThreads);
  const next = needs[0];
  $("detail-empty-title").textContent = !state.loaded
    ? "Select a thread"
    : needs.length ? `${needs.length} thread${needs.length === 1 ? " needs" : "s need"} you` : "All caught up";
  $("detail-empty-text").textContent = needs.length
    ? "Pick a thread in the inbox, or open the newest one."
    : "Nothing needs you right now. Pick any thread to read it.";
  const button = $("btn-open-next");
  button.hidden = !next;
  if (next) {
    button.textContent = `Open #${next.number}: ${next.title}`;
    button.dataset.id = next.id;
  }
}

function showDetailPart(part) {
  for (const name of ["empty", "loading", "error", "thread"]) $(`detail-${name}`).hidden = name !== part;
}

async function selectThread(id, { focusDetail = false } = {}) {
  const listThread = state.threads.find((t) => t.id === id);
  if (state.selectedId !== id) {
    state.selectedId = id;
    state.detail = null;
    state.historyKey = "";
    $("history").replaceChildren();
    showDetailPart("loading");
    if (listThread) resetComposerFor(listThread);
  }
  setView("detail");
  markSelectedRow();
  const detail = $("detail");
  if (!isNarrow() && detail.getBoundingClientRect().top < 0) detail.scrollIntoView({ block: "start" });
  if (isNarrow()) window.scrollTo(0, 0);

  await loadDetail(id, { quiet: Boolean(state.detail) });
  if (focusDetail && state.selectedId === id && !$("detail-thread").hidden) $("detail-title").focus();
}

function deselect() {
  state.selectedId = null;
  state.detail = null;
  state.historyKey = "";
  $("history").replaceChildren();
  showDetailPart("empty");
  setView("list");
  markSelectedRow();
  renderDetailEmpty();
}

async function loadDetail(id, { quiet = false } = {}) {
  const seq = ++state.seq.detail;
  try {
    const result = await adminCall("admin.thread", { id }, { timeoutMs: 25000 });
    if (seq !== state.seq.detail || state.selectedId !== id) return;
    const firstLoad = !state.detail;
    state.detail = { thread: result.thread, messages: Array.isArray(result.messages) ? result.messages : [] };
    mergeThread(result.thread);
    if (firstLoad) resetComposerFor(result.thread);
    await renderDetail();
  } catch (err) {
    if (seq !== state.seq.detail || state.selectedId !== id || isUnauthorized(err)) return;
    if (err.code === "not_found") {
      state.threads = state.threads.filter((t) => t.id !== id);
      deselect();
      toast("That thread no longer exists.", { tone: "error" });
      refreshAll();
      return;
    }
    if (quiet && state.detail) return; // keep showing what we have; the banner covers connection issues
    $("detail-error-text").textContent = `Could not load the thread: ${err.message}`;
    showDetailPart("error");
  }
}

// Called after each list refresh: reload the open thread only when it changed.
function syncSelectedThread() {
  const id = state.selectedId;
  if (!id || !state.detail) return;
  const fresh = state.threads.find((t) => t.id === id);
  if (!fresh) {
    deselect();
    toast("The open thread was deleted.");
    return;
  }
  const d = state.detail.thread;
  if (d.updatedAt !== fresh.updatedAt || d.status !== fresh.status || d.draftAt !== fresh.draftAt || d.errorCount !== fresh.errorCount) {
    loadDetail(id, { quiet: true });
  }
}

async function renderDetail() {
  const d = state.detail;
  if (!d) return;
  const t = d.thread;
  showDetailPart("thread");
  $("detail-num").textContent = `#${t.number}`;
  $("detail-title-text").textContent = t.title || "(no title)";
  // replaceChildren would print null as text, so empty slots are filtered out.
  $("detail-pills").replaceChildren(...[
    statusPill(t.status),
    t.needsHuman ? el("span", { class: "pill pill-alert pill-xs", text: "Needs you" }) : null,
    el("span", { class: "tag", text: KIND_LABELS[t.kind] || t.kind }),
    el("span", { class: "tag", text: t.origin === "email" ? "email" : "site" }),
    t.kind === "question" && t.topic ? el("span", { class: "tag", text: t.topic }) : null,
    el("span", { class: "hint" },
      `${d.messages.length} message${d.messages.length === 1 ? "" : "s"} · started `,
      el("time", { datetime: t.createdAt, title: fullDate(t.createdAt, "en"), dataset: { rel: t.createdAt }, text: timeAgo(t.createdAt, "en") }),
    ),
  ].filter(Boolean));
  renderNotes(t);
  $("btn-close-thread").disabled = t.status === "closed";
  renderComposerState(t);
  await renderHistory(d);
}

function renderNotes(t) {
  const notes = [];
  if (t.needsHuman) notes.push(note("warn", "Needs you.", needsReason(t)));
  if (t.status === "answering") {
    notes.push(note("info", "Tutor IA is writing an automatic answer right now.", "If you send a reply first, that automatic answer is discarded."));
  }
  if (t.lastError) {
    const count = Number(t.errorCount) || 0;
    notes.push(el("div", { class: "notice notice-warn" },
      el("strong", { text: `Automatic answer failed${count ? ` ${count}×` : ""}.` }),
      count >= 3 ? " It stopped retrying; reply yourself or draft with Claude." : "",
      el("pre", { class: "note-pre", text: formatError(t.lastError) }),
    ));
  }
  if (t.hasEmail) notes.push(note("muted", "Came in by email.", "Replies can also be sent back by email."));
  $("detail-notes").replaceChildren(...notes);
}

function note(tone, strong, text) {
  return el("div", { class: `notice notice-${tone}` }, el("strong", { text: strong }), " ", text);
}

// Best guess at why the backend flagged the thread (mirrors the needsHuman rule in SPEC §1).
function needsReason(t) {
  const reasons = [];
  if (t.kind === "direct") reasons.push(`Direct message for ${tutorName()}.`);
  else if (state.settings.autoQuestion === false) reasons.push("Automatic answers for questions are off.");
  if ((Number(t.errorCount) || 0) >= 3) reasons.push("Automatic answers failed 3 times.");
  const s = state.stats;
  if (s && t.kind !== "direct" && Number(s.autoCallsToday) >= Number(s.dailyCap)) reasons.push("The daily cap of automatic calls is reached.");
  return reasons.join(" ") || "Waiting for a reply.";
}

async function renderHistory({ thread, messages }) {
  const key = [thread.id, messages.map((m) => m.id).join(","), tutorName(), studentName()].join("|");
  if (key === state.historyKey) {
    updateRelativeTimes($("history"));
    return;
  }
  const seq = ++state.seq.history;
  const items = await Promise.all(messages.map(messageItem));
  if (seq !== state.seq.history) return;
  state.historyKey = key;
  $("history").replaceChildren(...items);
  $("history-empty").hidden = messages.length > 0;
  renderComposerState(thread); // stale-draft check needs the messages
}

async function messageItem(m) {
  const author = m.from === "student" ? studentName() : m.from === "tutor" ? "Tutor IA" : tutorName();
  const body = el("div", { class: "msg-body" });
  if (m.from === "student") {
    if (m.text) body.append(el("p", { class: "plain", text: m.text })); // never HTML
  } else {
    const md = el("div", { class: "md" });
    md.append(await renderMarkdown(m.text || ""));
    body.append(md);
  }
  if (m.code) body.append(el("pre", { class: "codeblock", tabindex: "0" }, el("code", { text: m.code })));
  return el("li", { class: `msg msg-${["student", "tutor", "alon"].includes(m.from) ? m.from : "alon"}` },
    el("div", { class: "msg-head" },
      el("span", { class: "msg-author", text: author }),
      m.via ? el("span", { class: "msg-via", text: `via ${m.via}` }) : null,
      el("time", { class: "msg-time", datetime: m.createdAt, title: fullDate(m.createdAt, "en"), dataset: { rel: m.createdAt }, text: timeAgo(m.createdAt, "en") }),
    ),
    body,
  );
}

// ---------- composer ----------

function composeTexts() {
  const value = store.get(KEYS.compose, {});
  return value && typeof value === "object" ? value : {};
}

function saveComposerText() {
  const id = state.selectedId;
  if (!id) return;
  const all = composeTexts();
  const text = $("reply-text").value;
  if (text.trim()) all[id] = text;
  else delete all[id];
  store.set(KEYS.compose, all);
}

function clearComposerText(id) {
  const all = composeTexts();
  delete all[id];
  store.set(KEYS.compose, all);
}

// Defaults when a thread is opened: saved text, sender by kind, email checkbox from settings.
function resetComposerFor(t) {
  $("reply-text").value = composeTexts()[t.id] || "";
  setComposerTab("write", { focus: false });
  showComposerError("");
  $(t.kind === "direct" ? "send-as-alon" : "send-as-tutor").checked = true;
  $("reply-email").checked = state.settings.emailReplies !== false;
  renderComposerState(t);
}

// Parts of the composer that follow the thread data (safe to call on every refresh).
function renderComposerState(t) {
  $("send-as-alon-label").textContent = tutorName();
  $("reply-email-wrap").hidden = !t.hasEmail;

  const hasDraft = Boolean(t.draft);
  $("draft-bar").hidden = !hasDraft;
  if (hasDraft) {
    const at = $("draft-at");
    at.dateTime = t.draftAt || "";
    at.title = t.draftAt ? fullDate(t.draftAt, "en") : "";
    if (t.draftAt) at.dataset.rel = t.draftAt;
    else delete at.dataset.rel;
    at.textContent = t.draftAt ? timeAgo(t.draftAt, "en") : "earlier";
    const lastStudent = (state.detail?.thread.id === t.id ? state.detail.messages : [])
      .filter((m) => m.from === "student").at(-1);
    $("draft-stale").hidden = !(t.draftAt && lastStudent && Date.parse(t.draftAt) < Date.parse(lastStudent.createdAt));
  }

  setBusy($("btn-draft"), state.drafting.has(t.id), "Drafting…");
}

function showComposerError(message) {
  $("composer-error").textContent = message;
  if (message) $("reply-text").setAttribute("aria-invalid", "true");
  else $("reply-text").removeAttribute("aria-invalid");
}

function setComposerTab(name, { focus = true } = {}) {
  const write = name === "write";
  for (const [tab, selected] of [["tab-write", write], ["tab-preview", !write]]) {
    $(tab).setAttribute("aria-selected", String(selected));
    $(tab).tabIndex = selected ? 0 : -1;
  }
  $("panel-write").hidden = !write;
  $("panel-preview").hidden = write;
  if (!write) renderPreview();
  if (focus) $(write ? "tab-write" : "tab-preview").focus();
}

async function renderPreview() {
  const box = $("reply-preview");
  const text = $("reply-text").value;
  const seq = ++state.seq.preview;
  if (!text.trim()) {
    box.replaceChildren(el("p", { class: "hint", text: "Nothing to preview yet." }));
    return;
  }
  const frag = await renderMarkdown(text);
  if (seq === state.seq.preview) box.replaceChildren(frag);
}

function onTabKeydown(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const toPreview = event.key === "End" || (event.key !== "Home" && event.currentTarget.id === "tab-write");
  setComposerTab(toPreview ? "preview" : "write");
}

async function sendReply(event) {
  event?.preventDefault();
  const t = state.detail?.thread;
  if (!t || state.sending) return;
  const textarea = $("reply-text");
  const text = textarea.value.trim();
  if (!text) {
    showComposerError("Write a reply before sending.");
    setComposerTab("write", { focus: false });
    textarea.focus();
    return;
  }
  showComposerError("");
  const as = document.querySelector('input[name="send-as"]:checked')?.value === "tutor" ? "tutor" : "alon";
  const params = { id: t.id, text, as, via: "admin" };
  if (t.hasEmail) params.email = $("reply-email").checked;

  state.sending = true;
  setBusy($("btn-send"), true, "Sending…");
  try {
    const { thread } = await adminCall("admin.reply", params, { timeoutMs: 60000 });
    clearComposerText(t.id);
    // Clear the box only if it still holds what was sent (the owner may have switched threads).
    if (state.selectedId === t.id && textarea.value.trim() === text) {
      textarea.value = "";
      setComposerTab("write", { focus: false });
    }
    mergeThread(thread, { own: true });
    const who = as === "tutor" ? "Tutor IA" : tutorName();
    toast(`Reply sent to #${thread?.number ?? t.number} as ${who}${params.email ? ", also by email" : ""}.`);
    refreshAll();
    if (state.selectedId === t.id) loadDetail(t.id, { quiet: true });
  } catch (err) {
    if (!isUnauthorized(err)) {
      showComposerError(`Not sent: ${err.message}`);
      toast("The reply was not sent.", { tone: "error" });
    }
  } finally {
    state.sending = false;
    setBusy($("btn-send"), false);
  }
}

async function draftWithClaude() {
  const t = state.detail?.thread;
  if (!t || state.drafting.has(t.id)) return;
  state.drafting.add(t.id);
  renderComposerState(t);
  announce("Asking Claude for a draft. This can take a minute.");

  let thread = null;
  try {
    ({ thread } = await adminCall("admin.draft", { id: t.id }, { timeoutMs: 180000 }));
  } catch (err) {
    if (!isUnauthorized(err)) toast(`Draft failed: ${err.message}`, { tone: "error", ms: 6000 });
  } finally {
    state.drafting.delete(t.id);
    if (state.detail) renderComposerState(state.detail.thread);
  }
  if (!thread || !state.token) return;

  mergeThread(thread, { own: true });
  if (!thread.draft) {
    toast("Claude did not return a draft. Try again.", { tone: "error" });
    return;
  }
  if (state.selectedId === thread.id) {
    renderComposerState(thread);
    await insertDraft(thread);
  } else {
    toast(`Draft for #${thread.number} is ready.`);
  }
}

// Put the stored draft into the reply box, asking first if that would replace other text.
async function insertDraft(thread = state.detail?.thread) {
  if (!thread?.draft) return;
  const textarea = $("reply-text");
  const current = textarea.value.trim();
  if (current && current !== thread.draft.trim()) {
    const ok = await confirmDialog({
      title: "Replace your text?",
      body: "The reply box already has text. Replace it with Claude's draft? Your current text will be lost.",
      confirmLabel: "Replace with draft",
      cancelLabel: "Keep my text",
    });
    if (!ok || state.selectedId !== thread.id) return;
  }
  textarea.value = thread.draft;
  saveComposerText();
  showComposerError("");
  setComposerTab("write", { focus: false });
  textarea.focus();
  textarea.setSelectionRange(0, 0);
  textarea.scrollTop = 0;
  toast("Draft inserted. Review it before sending.");
}

// ---------- thread actions ----------

async function closeThread() {
  const t = state.detail?.thread;
  if (!t) return;
  const button = $("btn-close-thread");
  setBusy(button, true, "Closing…");
  try {
    const { thread } = await adminCall("admin.close", { id: t.id });
    mergeThread(thread, { own: true });
    if (state.selectedId === t.id) await renderDetail();
    toast(`#${t.number} closed.`);
    refreshAll();
  } catch (err) {
    if (!isUnauthorized(err)) toast(`Could not close: ${err.message}`, { tone: "error" });
  } finally {
    setBusy(button, false);
    button.disabled = state.detail?.thread.status === "closed";
  }
}

async function deleteThread() {
  const t = state.detail?.thread;
  if (!t) return;
  const ok = await confirmDialog({
    title: `Delete #${t.number}?`,
    body: `“${t.title}” and all its messages will be removed from the sheet, and ${studentName()} will no longer see it.${t.hasEmail ? " The emails stay in Gmail." : ""} This cannot be undone.`,
    confirmLabel: "Delete thread",
    danger: true,
  });
  if (!ok || !state.token) return;
  const button = $("btn-delete-thread");
  setBusy(button, true, "Deleting…");
  try {
    await adminCall("admin.delete", { id: t.id });
    state.threads = state.threads.filter((x) => x.id !== t.id);
    state.seenNeeds.delete(t.id);
    clearComposerText(t.id);
    if (state.selectedId === t.id) deselect();
    renderFilters();
    renderList(true);
    toast(`#${t.number} deleted.`);
    ($("thread-list").querySelector('.thread-row[tabindex="0"]') || $("inbox-heading")).focus?.();
    refreshAll();
  } catch (err) {
    if (!isUnauthorized(err)) toast(`Could not delete: ${err.message}`, { tone: "error" });
  } finally {
    setBusy(button, false);
  }
}

// ---------- dialogs ----------

let confirmOpen = false;
function confirmDialog({ title, body, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false }) {
  const dialog = $("confirm-dialog");
  if (typeof dialog.showModal !== "function") return Promise.resolve(window.confirm(`${title}\n\n${body}`));
  if (confirmOpen) return Promise.resolve(false);
  confirmOpen = true;
  $("confirm-title").textContent = title;
  $("confirm-body").textContent = body;
  const okButton = $("confirm-ok");
  okButton.textContent = confirmLabel;
  okButton.className = `btn btn-sm ${danger ? "btn-danger-solid" : "btn-primary"}`;
  const cancelButton = $("confirm-cancel");
  cancelButton.textContent = cancelLabel;
  const opener = document.activeElement;
  dialog.returnValue = "";
  return new Promise((resolve) => {
    // Settle on the button click itself; the close event covers Escape.
    let settled = false;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      confirmOpen = false;
      okButton.removeEventListener("click", onOk);
      cancelButton.removeEventListener("click", onCancel);
      dialog.removeEventListener("close", onClose);
      if (dialog.open) dialog.close();
      if (opener?.isConnected) opener.focus();
      resolve(answer);
    };
    const onOk = (event) => {
      event.preventDefault();
      finish(true);
    };
    const onCancel = (event) => {
      event.preventDefault();
      finish(false);
    };
    const onClose = () => finish(dialog.returnValue === "ok");
    okButton.addEventListener("click", onOk);
    cancelButton.addEventListener("click", onCancel);
    dialog.addEventListener("close", onClose);
    dialog.showModal();
    // Destructive actions start on Cancel.
    (danger ? cancelButton : okButton).focus();
  });
}

// ---------- settings ----------

const SETTING_SWITCHES = ["autoQuestion", "autoDirect", "draftDirect", "emailReplies"];

let settingsOpener = null;
function openSettings({ focusId = "set-studentName", notice = "" } = {}) {
  const dialog = $("settings-dialog");
  if (dialog.open) return;
  settingsOpener = document.activeElement;
  state.settingsBase = JSON.parse(JSON.stringify(state.settings || {}));
  fillSettingsForm(state.settingsBase);
  showSettingsError("");
  $("settings-notice").textContent = notice;
  $("settings-notice").hidden = !notice;
  $("intake-result").textContent = "";
  dialog.showModal();
  $(focusId)?.focus();
}

function fillSettingsForm(s) {
  $("set-studentName").value = s.studentName ?? "";
  $("set-tutorName").value = s.tutorName ?? "";
  $("set-siteUrl").value = s.siteUrl ?? "";
  $("set-studentEmails").value = Array.isArray(s.studentEmails) ? s.studentEmails.join("\n") : "";
  for (const key of SETTING_SWITCHES) $(`set-${key}`).checked = Boolean(s[key]);
  $("set-notifyEmail").value = s.notifyEmail ?? "";
  $("set-notifyOn").value = ["direct", "all", "none"].includes(s.notifyOn) ? s.notifyOn : "direct";
  $("set-dailyCap").value = s.dailyCap ?? "";
  for (const node of $("settings-form").querySelectorAll("[aria-invalid]")) node.removeAttribute("aria-invalid");
}

function parseEmails(text) {
  const list = String(text).split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  return [...new Set(list)];
}

function collectSettings() {
  const value = (key) => $(`set-${key}`).value.trim();
  const errors = [];
  const looksLikeEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

  const values = {
    studentName: value("studentName"),
    tutorName: value("tutorName"),
    siteUrl: value("siteUrl"),
    studentEmails: parseEmails($("set-studentEmails").value),
    notifyEmail: value("notifyEmail"),
    notifyOn: $("set-notifyOn").value,
    dailyCap: Number(value("dailyCap")),
  };
  for (const key of SETTING_SWITCHES) values[key] = $(`set-${key}`).checked;

  if (!values.studentName) errors.push(["studentName", "Student name can't be empty."]);
  if (!values.tutorName) errors.push(["tutorName", "Your name can't be empty."]);
  if (values.siteUrl && !/^https?:\/\/\S+$/i.test(values.siteUrl)) errors.push(["siteUrl", "Site URL must start with https://"]);
  const badEmails = values.studentEmails.filter((e) => !looksLikeEmail(e));
  if (badEmails.length) errors.push(["studentEmails", `Not an email address: ${badEmails.join(", ")}.`]);
  if (values.notifyEmail && !looksLikeEmail(values.notifyEmail)) errors.push(["notifyEmail", "The notification email doesn't look like an email address."]);
  if (value("dailyCap") === "" || !Number.isInteger(values.dailyCap) || values.dailyCap < 0 || values.dailyCap > 500) {
    errors.push(["dailyCap", "Daily cap must be a whole number from 0 to 500."]);
  }
  return { values, errors };
}

function showSettingsError(message) {
  $("settings-error").textContent = message;
  $("settings-error").hidden = !message;
}

async function saveSettings(event) {
  event.preventDefault();
  const { values, errors } = collectSettings();
  for (const node of $("settings-form").querySelectorAll("[aria-invalid]")) node.removeAttribute("aria-invalid");
  if (errors.length) {
    for (const [key] of errors) $(`set-${key}`).setAttribute("aria-invalid", "true");
    showSettingsError(errors.map(([, msg]) => msg).join(" "));
    $(`set-${errors[0][0]}`).focus();
    return;
  }

  // Send only what changed, so edits made elsewhere (e.g. the bridge) are not overwritten.
  const set = {};
  for (const [key, val] of Object.entries(values)) {
    if (JSON.stringify(val) !== JSON.stringify(state.settingsBase?.[key])) set[key] = val;
  }
  if (!Object.keys(set).length) {
    $("settings-dialog").close();
    toast("No changes to save.");
    return;
  }

  const button = $("settings-save");
  setBusy(button, true, "Saving…");
  showSettingsError("");
  try {
    const { settings } = await adminCall("admin.settings", { set });
    state.settings = settings || { ...state.settings, ...set };
    $("settings-dialog").close();
    toast("Settings saved.");
    rerenderForSettings();
    refreshAll();
  } catch (err) {
    if (!isUnauthorized(err)) showSettingsError(`Not saved: ${err.message}`);
  } finally {
    setBusy(button, false);
  }
}

function rerenderForSettings() {
  renderHeader();
  renderStrip();
  renderList(true);
  if (state.detail) {
    state.historyKey = "";
    renderDetail();
  }
}

async function checkEmailNow() {
  const button = $("btn-intake");
  const result = $("intake-result");
  setBusy(button, true, "Checking…");
  result.textContent = "";
  try {
    const { imported } = await adminCall("admin.intake", {}, { timeoutMs: 120000 });
    const n = Number(imported) || 0;
    const message = n === 0 ? "No new emails." : `Imported ${n} email${n === 1 ? "" : "s"}.`;
    result.textContent = message; // visible inside the modal
    toast(message);
    refreshAll();
  } catch (err) {
    if (!isUnauthorized(err)) {
      result.textContent = `Email check failed: ${err.message}`;
      toast("Email check failed.", { tone: "error" });
    }
  } finally {
    setBusy(button, false);
  }
}

// ---------- header actions ----------

async function copyStudentLink() {
  const siteUrl = String(state.settings.siteUrl || "").trim();
  const room = state.stats?.roomToken;
  if (!state.loaded) {
    toast("Still loading. Try again in a moment.");
    return;
  }
  if (!siteUrl) {
    openSettings({ focusId: "set-siteUrl", notice: "Set the Site URL first: the student link is built from it." });
    return;
  }
  if (!room) {
    toast("There is no room token yet. Run setup() in the Apps Script editor.", { tone: "error", ms: 6000 });
    return;
  }
  const ok = await copyText(`${siteUrl}#sala=${room}`);
  toast(ok ? `Student link copied. Share it only with ${studentName()}.` : "Could not copy the link. Your browser blocked the clipboard.", { tone: ok ? "info" : "error" });
}

function notifyOn() {
  return "Notification" in window && Notification.permission === "granted" && store.get(KEYS.notify, false) === true;
}

function renderNotifyButton() {
  const button = $("btn-notify");
  if (!("Notification" in window)) {
    button.hidden = true;
    return;
  }
  const denied = Notification.permission === "denied";
  button.textContent = notifyOn() ? "Turn off desktop notifications" : "Enable desktop notifications";
  button.disabled = denied && !notifyOn();
  button.title = denied ? "Notifications are blocked for this site in your browser settings." : "";
}

async function toggleNotifications() {
  if (notifyOn()) {
    store.set(KEYS.notify, false);
    toast("Desktop notifications off.");
  } else {
    const permission = await askNotificationPermission();
    if (permission === "granted") {
      store.set(KEYS.notify, true);
      toast("Desktop notifications on. They appear when a thread needs you and this tab is in the background.", { ms: 5000 });
    } else if (permission === "denied") {
      toast("Notifications are blocked for this site in your browser settings.", { tone: "error" });
    } else {
      toast("Notifications were not enabled.");
    }
  }
  renderNotifyButton();
}

// ---------- helpers ----------

function setBusy(button, busy, busyLabel) {
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = busy;
  if (busy) button.setAttribute("aria-busy", "true");
  else button.removeAttribute("aria-busy");
  button.textContent = busy && busyLabel ? busyLabel : button.dataset.label;
}

function updateShortcutHint() {
  const mac = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || "");
  $("send-shortcut").textContent = mac ? "⌘+Enter" : "Ctrl+Enter";
}

// ---------- events ----------

function wireEvents() {
  $("signin-form").addEventListener("submit", onSignIn);
  $("signin-show").addEventListener("change", (e) => {
    $("signin-token").type = e.target.checked ? "text" : "password";
  });

  $("btn-signout").addEventListener("click", signOut);
  $("btn-settings").addEventListener("click", () => openSettings());
  $("btn-copy-link").addEventListener("click", copyStudentLink);
  $("btn-notify").addEventListener("click", toggleNotifications);
  $("btn-refresh").addEventListener("click", async () => {
    await refreshAll();
    if (state.selectedId) loadDetail(state.selectedId, { quiet: true });
  });

  for (const button of document.querySelectorAll(".filter")) {
    button.addEventListener("click", () => setFilter(button.dataset.filter));
  }
  $("btn-show-all").addEventListener("click", () => setFilter("all"));
  $("thread-list").addEventListener("keydown", onListKeydown);
  $("btn-open-next").addEventListener("click", (e) => {
    if (e.currentTarget.dataset.id) selectThread(e.currentTarget.dataset.id, { focusDetail: true });
  });

  $("btn-back").addEventListener("click", () => {
    setView("list");
    markSelectedRow();
    const row = $("thread-list").querySelector('.thread-row[tabindex="0"]');
    (row || $("inbox-heading")).focus?.();
  });
  $("btn-detail-retry").addEventListener("click", () => {
    if (!state.selectedId) return;
    showDetailPart("loading");
    loadDetail(state.selectedId);
  });
  $("btn-close-thread").addEventListener("click", closeThread);
  $("btn-delete-thread").addEventListener("click", deleteThread);

  // Composer
  $("composer").addEventListener("submit", sendReply);
  const textarea = $("reply-text");
  textarea.addEventListener("input", () => {
    saveComposerText();
    if (textarea.value.trim()) showComposerError("");
  });
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendReply();
    }
  });
  for (const id of ["tab-write", "tab-preview"]) {
    $(id).addEventListener("click", () => setComposerTab(id === "tab-write" ? "write" : "preview", { focus: false }));
    $(id).addEventListener("keydown", onTabKeydown);
  }
  $("btn-draft").addEventListener("click", draftWithClaude);
  $("btn-insert-draft").addEventListener("click", () => insertDraft());

  // Settings
  $("settings-form").addEventListener("submit", saveSettings);
  $("settings-close").addEventListener("click", () => $("settings-dialog").close());
  $("settings-cancel").addEventListener("click", () => $("settings-dialog").close());
  $("btn-intake").addEventListener("click", checkEmailNow);
  $("settings-dialog").addEventListener("close", () => {
    if ($("screen-console").hidden) return;
    (settingsOpener?.isConnected ? settingsOpener : $("btn-settings")).focus();
  });
}

boot();
