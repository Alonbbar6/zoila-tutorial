// Tests for backend/Code.gs running inside the fake Apps Script environment (dev/fakes.mjs).
// Run from the repo root: node --test   (or: node --test dev/*.test.mjs)

import { test } from "node:test";
import assert from "node:assert/strict";
import { createAppsScriptEnv, coerceCellInput } from "./fakes.mjs";

const START = "2026-09-16T15:00:00.000Z"; // 10:00 in America/Bogota
const SITE = "https://example.github.io/tutor/";
const HOUR = 3600 * 1000;

const STUDENT_THREAD_KEYS = ["createdAt", "id", "kind", "lastFrom", "messageCount", "number", "origin", "status", "title", "topic", "unread", "updatedAt"];
const ADMIN_THREAD_KEYS = [...STUDENT_THREAD_KEYS, "draft", "draftAt", "errorCount", "hasEmail", "lastError", "needsHuman"].sort();
const MESSAGE_KEYS = ["code", "createdAt", "from", "id", "text", "threadId", "via"];
const SETTINGS_KEYS = ["autoDirect", "autoQuestion", "dailyCap", "draftDirect", "emailReplies", "notifyEmail", "notifyOn", "siteUrl", "studentEmails", "studentName", "tutorName"];
const STATS_KEYS = ["apiKeyConfigured", "autoCallsToday", "dailyCap", "emailConfigured", "lastError", "lastIntakeAt", "lastTickAt", "roomToken"];

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function makeEnv({ settings = {}, apiKey = "sk-test-key", claudeMode = "ok" } = {}) {
  const env = createAppsScriptEnv({ start: START, claudeMode });
  const props = env.state.properties;
  if (apiKey) props.ANTHROPIC_API_KEY = apiKey;
  props.SETTINGS = JSON.stringify({
    studentEmails: ["zoila@example.com"],
    notifyEmail: "owner@example.com",
    notifyOn: "direct",
    siteUrl: SITE,
    ...settings,
  });
  env.run("setup");
  env.room = props.ROOM_TOKEN;
  env.adminToken = props.ADMIN_TOKEN;
  env.logs = () => env.state.logs.map((l) => l.text).join("\n");
  return env;
}

// Wraps a scenario: fresh environment, then checks that Code.gs broke no platform rule.
function scenario(name, fn, options) {
  test(name, async () => {
    const env = makeEnv(options);
    await fn(env);
    for (const err of env.state.claude.hookErrors) throw err;
    assert.deepEqual(env.state.violations, [], "platform rule violations");
  });
}

function ok(res) {
  assert.equal(res.ok, true, "expected ok, got " + JSON.stringify(res.error));
  return res.result;
}

function failCode(res) {
  assert.equal(res.ok, false, "expected an error, got " + JSON.stringify(res.result));
  assert.equal(typeof res.error.message, "string");
  assert.ok(res.error.message.length > 0);
  return res.error.code;
}

const student = (env, action, params = {}) => env.call(action, { room: env.room, ...params });
const admin = (env, action, params = {}) => env.call("admin." + action, { admin: env.adminToken, ...params });

function createThread(env, params = {}) {
  return ok(student(env, "create", { kind: "question", topic: "python", title: "¿Cómo leo un CSV?", text: "Quiero abrir ventas.csv", ...params })).thread;
}

function claudeRequests(env) {
  return env.state.claude.requests;
}

function lastClaude(env) {
  const list = claudeRequests(env);
  assert.ok(list.length > 0, "expected a Claude request");
  return list[list.length - 1];
}

function textOf(content) {
  return typeof content === "string" ? content : content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

function notifications(env) {
  return env.state.sentEmails.filter((m) => m.kind === "send");
}

function replies(env) {
  return env.state.sentEmails.filter((m) => m.kind === "reply");
}

// ---------------------------------------------------------------------------------------------
// The harness itself
// ---------------------------------------------------------------------------------------------

test("fake Sheets coerces written strings like Google Sheets (a naive writer would fail)", () => {
  assert.equal(coerceCellInput("00123"), 123);
  assert.equal(coerceCellInput("+1"), 1);
  assert.equal(coerceCellInput("TRUE"), true);
  assert.equal(coerceCellInput("-x"), "#ERROR!");
  assert.equal(coerceCellInput("=SUM(A1)"), 0);
  assert.equal(Object.prototype.toString.call(coerceCellInput("2026-01-05")), "[object Date]");
  assert.equal(coerceCellInput("'00123"), "00123");
  assert.equal(coerceCellInput("''quoted"), "'quoted");
  assert.equal(coerceCellInput("hola"), "hola");
  assert.throws(() => coerceCellInput("x".repeat(50001)), /50000/);
});

test("fake Claude rejects malformed requests with HTTP 400", () => {
  const env = createAppsScriptEnv({ start: START, loadCode: false });
  const { UrlFetchApp } = env.services;
  const base = {
    method: "post",
    contentType: "application/json",
    headers: { "x-api-key": "k", "anthropic-version": "2023-06-01", "anthropic-beta": "server-side-fallback-2026-07-01" },
    muteHttpExceptions: true,
  };
  const send = (body, overrides = {}) => {
    const res = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", { ...base, ...overrides, payload: JSON.stringify(body) });
    return { status: res.getResponseCode(), body: JSON.parse(res.getContentText()) };
  };
  const good = { model: "claude-opus-5", max_tokens: 100, fallbacks: "default", messages: [{ role: "user", content: "hola" }] };
  assert.equal(send(good).status, 200);
  assert.equal(send(good).body.content[0].type, "thinking");
  assert.equal(send({ ...good, messages: [] }).status, 400);
  assert.equal(send({ ...good, messages: [{ role: "assistant", content: "x" }] }).status, 400);
  assert.equal(send({ ...good, messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }] }).status, 400);
  assert.equal(send({ ...good, messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] }).status, 400);
  assert.equal(send({ ...good, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", data: "AAAA" } }] }] }).status, 400);
  assert.equal(send({ ...good, max_tokens: undefined }).status, 400);
  assert.equal(send({ ...good, model: "claude-imaginary" }).status, 404);
  assert.equal(send(good, { headers: { "x-api-key": "k" } }).status, 400);
  assert.equal(send(good, { headers: { "anthropic-version": "2023-06-01" } }).status, 401);
  assert.throws(() => UrlFetchApp.fetch("https://example.com/", { muteHttpExceptions: true }), /Address unavailable/);
  env.setClaudeMode("fail");
  assert.equal(send(good).status, 500);
  assert.throws(() => UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", { ...base, muteHttpExceptions: false, payload: JSON.stringify(good) }), /returned code 500/);
  env.setClaudeMode("refusal");
  const refusal = send(good);
  assert.equal(refusal.body.stop_reason, "refusal");
  assert.deepEqual(refusal.body.content, []);
});

// ---------------------------------------------------------------------------------------------
// HTTP basics and auth
// ---------------------------------------------------------------------------------------------

scenario("GET ping answers pong; other GETs are bad_request", (env) => {
  const pong = ok(env.get({ action: "ping" }));
  assert.equal(pong.pong, true);
  assert.match(pong.now, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(failCode(env.get({})), "bad_request");
  assert.equal(failCode(env.get({ action: "list", room: env.room })), "bad_request");
});

scenario("wrong or missing tokens are unauthorized for student and admin actions", (env) => {
  const wrongRoom = env.room.slice(0, -1) + (env.room.endsWith("a") ? "b" : "a");
  for (const action of ["info", "list", "thread", "create", "send", "resolve", "process"]) {
    assert.equal(failCode(env.call(action, { id: "t_x" })), "unauthorized", action + " without room");
    assert.equal(failCode(env.call(action, { room: wrongRoom, id: "t_x" })), "unauthorized", action + " wrong room");
    assert.equal(failCode(env.call(action, { room: env.adminToken, id: "t_x" })), "unauthorized", action + " admin token as room");
    assert.equal(failCode(env.call(action, { room: env.room.slice(0, 10), id: "t_x" })), "unauthorized", action + " prefix of room");
  }
  for (const action of ["list", "thread", "reply", "draft", "settings", "close", "delete", "intake", "events", "stats"]) {
    assert.equal(failCode(env.call("admin." + action, { id: "t_x" })), "unauthorized", action + " without admin");
    assert.equal(failCode(env.call("admin." + action, { admin: env.room, id: "t_x" })), "unauthorized", action + " room as admin");
    assert.equal(failCode(env.call("admin." + action, { admin: "", id: "t_x" })), "unauthorized", action + " empty admin");
  }
  // The student error is Spanish and uses the tutor name.
  const res = env.call("list", {});
  assert.match(res.error.message, /Alon/);
  // Malformed bodies and unknown actions.
  const raw = env.context.doPost({ parameter: {}, postData: { contents: "not json", type: "text/plain" } });
  assert.equal(JSON.parse(raw.getContent()).error.code, "bad_request");
  assert.equal(failCode(env.call("nope", { room: env.room })), "bad_request");
  assert.equal(failCode(env.call("admin.nope", { admin: env.adminToken })), "bad_request");
  assert.equal(failCode(env.call("toString", { room: env.room })), "bad_request");
  assert.equal(claudeRequests(env).length, 0);
});

scenario("info reports names and whether automatic answers are on", (env) => {
  const info = ok(student(env, "info"));
  assert.equal(info.studentName, "Zoila");
  assert.equal(info.tutorName, "Alon");
  assert.deepEqual(info.auto, { question: true, direct: false });
  delete env.state.properties.ANTHROPIC_API_KEY;
  assert.deepEqual(ok(student(env, "info")).auto, { question: false, direct: false });
});

// ---------------------------------------------------------------------------------------------
// Create, numbering, round-trips, shapes
// ---------------------------------------------------------------------------------------------

scenario("create validates lengths and enums; direct forces topic otro", (env) => {
  const base = { kind: "question", topic: "python", title: "Título", text: "Texto" };
  const bad = (params) => assert.equal(failCode(student(env, "create", { ...base, ...params })), "bad_request", JSON.stringify(params).slice(0, 80));
  bad({ title: "" });
  bad({ title: "   " });
  bad({ title: undefined });
  bad({ title: 42 });
  bad({ title: "x".repeat(141) });
  bad({ text: "" });
  bad({ text: " \n\t " });
  bad({ text: "x".repeat(8001) });
  bad({ code: "x".repeat(8001) });
  bad({ code: 5 });
  bad({ kind: "otra" });
  bad({ kind: undefined });
  bad({ topic: "sql" });
  bad({ topic: undefined });
  assert.equal(ok(student(env, "list")).threads.length, 0, "nothing stored by invalid creates");

  const trimmed = createThread(env, { title: "   Hola  " });
  assert.equal(trimmed.title, "Hola");
  const longest = createThread(env, { title: "t".repeat(140), text: "x".repeat(8000), code: "c".repeat(8000) });
  assert.equal(longest.title.length, 140);
  assert.equal(longest.status, "waiting");
  assert.equal(longest.lastFrom, "student");
  assert.equal(longest.origin, "site");
  assert.equal(longest.unread, false);
  assert.equal(longest.messageCount, 1);

  const direct = createThread(env, { kind: "direct", topic: "python" });
  assert.equal(direct.kind, "direct");
  assert.equal(direct.topic, "otro");
  const directNoTopic = createThread(env, { kind: "direct", topic: undefined });
  assert.equal(directNoTopic.topic, "otro");
});

scenario("thread numbers are sequential and never reused", (env) => {
  const a = createThread(env);
  const b = createThread(env);
  const c = createThread(env);
  assert.deepEqual([a.number, b.number, c.number], [1, 2, 3]);
  assert.equal(ok(admin(env, "delete", { id: c.id })).deleted, true);
  assert.equal(createThread(env).number, 4);
  assert.notEqual(a.id, b.id);
});

scenario("tricky strings round-trip exactly through the Sheet", (env) => {
  const tricky = [
    "=SUM(A1)", "+1", "-x", "@x", "00123", "2026-01-05", "TRUE", "false", "'quoted", "''doble", "1,000", "$2.99",
    "12%", "10:30", "1e5", "#N/A", "=HYPERLINK(\"http://x\")", "😀 emoji 🐍 ñandú", "línea 1\nlínea 2\n\n  - viñeta\n\tfin",
    "- empieza con guion", "<b>html</b> & \"comillas\"",
  ];
  const long = "=" + "x".repeat(7999);
  const created = [];
  for (const s of tricky) {
    const title = s.replace(/\s+/g, " ");
    const t = createThread(env, { title, text: s, code: "    " + s + "\n  -y" });
    created.push({ s, title, id: t.id });
    assert.equal(t.title, title);
  }
  const big = createThread(env, { title: "8000", text: long, code: long });
  created.push({ s: long, title: "8000", id: big.id, code: long });

  for (const c of created) {
    const res = ok(student(env, "thread", { id: c.id }));
    assert.equal(res.thread.title, c.title);
    assert.equal(res.messages[0].text, c.s, "text " + JSON.stringify(c.s).slice(0, 40));
    assert.equal(res.messages[0].code, c.code || "    " + c.s + "\n  -y");
  }
  const listed = ok(student(env, "list")).threads;
  for (const c of created) assert.equal(listed.find((t) => t.id === c.id).title, c.title);

  // Follow-ups and admin replies round-trip too, and code defaults to "".
  const target = created[0].id;
  ok(student(env, "send", { id: target, text: "00123" }));
  ok(admin(env, "reply", { id: target, as: "tutor", text: "- uno\n- =dos" }));
  const msgs = ok(student(env, "thread", { id: target })).messages;
  assert.equal(msgs[1].text, "00123");
  assert.equal(msgs[1].code, "");
  assert.equal(msgs[2].text, "- uno\n- =dos");

  // Stored cell types: numbers and booleans are real values, text is text.
  const row = env.sheetRecords("Threads").find((r) => r.id === target);
  assert.equal(typeof row.number, "number");
  assert.equal(typeof row.unread, "boolean");
  assert.equal(typeof row.errorCount, "number");
  assert.equal(typeof row.createdAt, "string");
  assert.equal(row.title, "=SUM(A1)");
});

scenario("list and thread shapes match SPEC; the student shape hides admin fields", (env) => {
  const t1 = createThread(env, { title: "Primero", code: "print(1)" });
  env.clock.advance(1000);
  const t2 = createThread(env, { title: "Segundo" });

  const list = ok(student(env, "list")).threads;
  assert.deepEqual(list.map((t) => t.id), [t2.id, t1.id], "sorted by updatedAt desc");
  for (const t of list) {
    assert.deepEqual(Object.keys(t).sort(), STUDENT_THREAD_KEYS);
    for (const hidden of ["draft", "draftAt", "lastError", "errorCount", "emailThreadId", "answeringSince", "needsHuman", "hasEmail"]) {
      assert.equal(hidden in t, false, hidden + " must not be in the student shape");
    }
  }
  env.clock.advance(1000);
  ok(student(env, "send", { id: t1.id, text: "Otra cosa" }));
  assert.equal(ok(student(env, "list")).threads[0].id, t1.id, "a follow-up moves the thread to the top");

  const detail = ok(student(env, "thread", { id: t1.id }));
  assert.deepEqual(Object.keys(detail.thread).sort(), STUDENT_THREAD_KEYS);
  assert.equal(detail.messages.length, 2);
  assert.equal(detail.thread.messageCount, 2);
  for (const m of detail.messages) {
    assert.deepEqual(Object.keys(m).sort(), MESSAGE_KEYS);
    assert.equal(m.threadId, t1.id);
    assert.equal(m.from, "student");
    assert.equal(m.via, "site");
  }
  assert.ok(detail.messages[0].createdAt < detail.messages[1].createdAt, "messages ascending");
  assert.equal(detail.messages[0].code, "print(1)");
  assert.equal(failCode(student(env, "thread", { id: "t_missing" })), "not_found");
  assert.equal(failCode(student(env, "thread", {})), "bad_request");

  const adminList = ok(admin(env, "list"));
  assert.deepEqual(Object.keys(adminList.settings).sort(), SETTINGS_KEYS);
  assert.deepEqual(Object.keys(adminList.stats).sort(), STATS_KEYS);
  assert.equal(adminList.stats.roomToken, env.room);
  assert.equal(adminList.stats.apiKeyConfigured, true);
  assert.equal(adminList.stats.emailConfigured, true);
  for (const t of adminList.threads) {
    assert.deepEqual(Object.keys(t).sort(), ADMIN_THREAD_KEYS);
    assert.equal(t.draft, null);
    assert.equal(t.draftAt, null);
    assert.equal(t.lastError, null);
    assert.equal(t.errorCount, 0);
    assert.equal(t.hasEmail, false);
    assert.equal(t.needsHuman, false, "a waiting question with auto answers on does not need a human");
  }
  const adminThread = ok(admin(env, "thread", { id: t1.id }));
  assert.deepEqual(Object.keys(adminThread.thread).sort(), ADMIN_THREAD_KEYS);
  assert.equal(adminThread.messages.length, 2);
  assert.equal(failCode(admin(env, "list", { filter: "weird" })), "bad_request");
  assert.equal(ok(admin(env, "stats")).stats.roomToken, env.room);
});

// ---------------------------------------------------------------------------------------------
// Automatic answers
// ---------------------------------------------------------------------------------------------

scenario("process auto-answers a question with a valid Claude request", (env) => {
  const t = createThread(env, { title: "Leer CSV", text: "¿Cómo leo ventas.csv con pandas?", code: "import pandas as pd" });
  const processed = ok(student(env, "process", { id: t.id })).thread;
  assert.equal(processed.status, "answered");
  assert.equal(processed.lastFrom, "tutor");
  assert.equal(processed.unread, true);
  assert.equal(processed.messageCount, 2);

  const req = lastClaude(env);
  assert.equal(req.status, 200, "fake API accepted the request: " + req.error);
  assert.equal(claudeRequests(env).length, 1);
  assert.equal(req.headers["anthropic-version"], "2023-06-01");
  assert.equal(req.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
  assert.equal(req.body.model, "claude-opus-5");
  assert.equal(req.body.max_tokens, 8000);
  assert.equal(req.body.fallbacks, "default");
  assert.deepEqual(req.body.output_config, { effort: "low" });
  assert.match(req.body.system, /^Eres el tutor de programación de Zoila\./);
  assert.match(req.body.system, /Trabajas junto a Alon/);
  assert.doesNotMatch(req.body.system, /\{studentName\}|\{tutorName\}/);
  assert.equal(req.body.messages.length, 1);
  const first = textOf(req.body.messages[0].content);
  assert.ok(first.startsWith("[Hilo #1 · pregunta · tema: python · título: Leer CSV]\n\n¿Cómo leo ventas.csv con pandas?"), first);
  assert.match(first, /```\nimport pandas as pd\n```/);

  const messages = ok(student(env, "thread", { id: t.id })).messages;
  assert.equal(messages[1].from, "tutor");
  assert.equal(messages[1].via, "auto");
  assert.match(messages[1].text, /Leí tu mensaje: "¿Cómo leo ventas.csv con pandas\?/);
  assert.match(messages[1].text, /```python/);
  assert.doesNotMatch(messages[1].text, /necesita una pista/, "thinking blocks are ignored");

  const stats = ok(admin(env, "stats")).stats;
  assert.equal(stats.autoCallsToday, 1);
  assert.deepEqual(notifications(env), [], "notifyOn=direct: no email for a question");

  // Processing again does nothing.
  assert.equal(ok(student(env, "process", { id: t.id })).thread.messageCount, 2);
  assert.equal(claudeRequests(env).length, 1);
  assert.equal(failCode(student(env, "process", { id: "t_missing" })), "not_found");
});

scenario("thread marks the tutor answer as read", (env) => {
  const t = createThread(env);
  ok(student(env, "process", { id: t.id }));
  assert.equal(ok(student(env, "list")).threads[0].unread, true);
  const opened = ok(student(env, "thread", { id: t.id }));
  assert.equal(opened.thread.unread, false);
  assert.equal(ok(student(env, "list")).threads[0].unread, false);
  assert.equal(env.sheetRecords("Threads")[0].unread, false);
});

scenario("a direct message is not auto-answered; it gets a draft and one owner notification", (env) => {
  const t = createThread(env, { kind: "direct", title: "Hola Alon", text: "¿Podemos hablar el sábado?" });
  assert.equal(notifications(env).length, 0, "the notification waits for the draft");

  const processed = ok(student(env, "process", { id: t.id })).thread;
  assert.equal(processed.status, "waiting");
  assert.equal(processed.lastFrom, "student");
  assert.equal(processed.messageCount, 1, "no tutor message");

  const req = lastClaude(env);
  assert.equal(req.status, 200, req.error);
  const lastTurn = textOf(req.body.messages[req.body.messages.length - 1].content);
  assert.ok(lastTurn.endsWith("\n\n(Nota interna: escribe un borrador que Alon revisará antes de enviarlo.)"), lastTurn);
  assert.match(lastTurn, /^\[Hilo #1 · mensaje directo · tema: otro · título: Hola Alon\]/);

  const detail = ok(admin(env, "thread", { id: t.id })).thread;
  assert.equal(typeof detail.draft, "string");
  assert.match(detail.draft, /Leí tu mensaje/);
  assert.ok(detail.draftAt);
  assert.equal(detail.needsHuman, true);

  const sent = notifications(env);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "owner@example.com");
  assert.match(sent[0].subject, /^\[Tutor\] Direct message #1: Hola Alon/);
  assert.ok(sent[0].body.includes("¿Podemos hablar el sábado?"));
  assert.ok(sent[0].body.includes(detail.draft));
  assert.ok(sent[0].htmlBody.includes(SITE + "admin.html"));

  // The draft is current: no more calls from process or tick.
  ok(student(env, "process", { id: t.id }));
  env.run("tick");
  assert.equal(claudeRequests(env).length, 1);
  assert.equal(ok(admin(env, "stats")).stats.autoCallsToday, 1);

  // A follow-up makes the draft stale, so tick drafts again.
  env.clock.advance(60000);
  ok(student(env, "send", { id: t.id, text: "También el domingo." }));
  env.run("tick");
  assert.equal(claudeRequests(env).length, 2);
  assert.equal(lastClaude(env).status, 200);
  assert.equal(ok(admin(env, "thread", { id: t.id })).messages.length, 2);
});

scenario("direct message without drafts notifies the owner right away", (env) => {
  const t = createThread(env, { kind: "direct", title: "Un saludo", text: "Gracias por todo" });
  const sent = notifications(env);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /Direct message #1/);
  assert.ok(sent[0].body.includes("Gracias por todo"));
  ok(student(env, "process", { id: t.id }));
  env.run("tick");
  assert.equal(claudeRequests(env).length, 0);
  assert.equal(ok(admin(env, "thread", { id: t.id })).thread.needsHuman, true);
}, { settings: { draftDirect: false } });

scenario("a follow-up reopens the thread and gets answered with the full history", (env) => {
  const t = createThread(env, { text: "Primera duda" });
  ok(student(env, "process", { id: t.id }));
  const closed = ok(student(env, "resolve", { id: t.id })).thread;
  assert.equal(closed.status, "closed");
  ok(student(env, "process", { id: t.id }));
  assert.equal(claudeRequests(env).length, 1, "closed threads are not processed");

  env.clock.advance(5000);
  const reopened = ok(student(env, "send", { id: t.id, text: "Segunda duda", code: "df.head()" })).thread;
  assert.equal(reopened.status, "waiting");
  assert.equal(reopened.lastFrom, "student");
  assert.equal(reopened.messageCount, 3);

  const answered = ok(student(env, "process", { id: t.id })).thread;
  assert.equal(answered.status, "answered");
  assert.equal(answered.messageCount, 4);
  const req = lastClaude(env);
  assert.equal(req.status, 200, req.error);
  assert.deepEqual(req.body.messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.match(textOf(req.body.messages[2].content), /^Segunda duda\n\n```\ndf.head\(\)\n```$/);
  assert.match(lastClaude(env).body.messages[1].content, /Leí tu mensaje: "Primera duda"/);

  assert.equal(failCode(student(env, "send", { id: "t_missing", text: "x" })), "not_found");
  assert.equal(failCode(student(env, "resolve", { id: "t_missing" })), "not_found");
});

scenario("resolve closes a thread (student and admin)", (env) => {
  const t = createThread(env);
  const closed = ok(student(env, "resolve", { id: t.id })).thread;
  assert.equal(closed.status, "closed");
  assert.equal(ok(student(env, "list")).threads[0].status, "closed");
  const t2 = createThread(env);
  assert.equal(ok(admin(env, "close", { id: t2.id })).thread.status, "closed");
  env.run("tick");
  assert.equal(claudeRequests(env).length, 0);
});

scenario("alon messages are sent to Claude as assistant turns with the name prefix", (env) => {
  const t = createThread(env, { text: "Hola" });
  ok(admin(env, "reply", { id: t.id, as: "alon", text: "Te ayudo mañana" }));
  ok(student(env, "send", { id: t.id, text: "Gracias, pero tengo otra duda" }));
  ok(student(env, "process", { id: t.id }));
  const req = lastClaude(env);
  assert.equal(req.status, 200, req.error);
  assert.equal(req.body.messages[1].role, "assistant");
  assert.equal(req.body.messages[1].content, "(Respuesta de Alon) Te ayudo mañana");
});

scenario("tick answers waiting questions oldest first, at most 5 per run", (env) => {
  const ids = [];
  for (let i = 0; i < 7; i++) {
    ids.push(createThread(env, { title: "Pregunta " + i, text: "Duda número " + i }).id);
    env.clock.advance(1000);
  }
  env.run("tick");
  assert.equal(claudeRequests(env).length, 5);
  const answered = ok(admin(env, "list")).threads.filter((t) => t.status === "answered").map((t) => t.id);
  assert.deepEqual(answered.sort(), ids.slice(0, 5).sort());
  assert.ok(env.state.properties.LAST_TICK_AT);
  assert.ok(ok(admin(env, "stats")).stats.lastTickAt);
  env.run("tick");
  assert.equal(claudeRequests(env).length, 7);
  assert.equal(env.state.cache.has("tick:lease"), false, "the tick lease is released");
});

scenario("admin.reply appends, clears the draft, supports via bridge", (env) => {
  const t = createThread(env, { kind: "direct", text: "Hola" });
  ok(student(env, "process", { id: t.id }));
  assert.ok(ok(admin(env, "thread", { id: t.id })).thread.draft);
  const res = ok(admin(env, "reply", { id: t.id, as: "alon", text: "¡Hola! Nos vemos pronto.", via: "bridge" }));
  assert.equal(res.thread.status, "answered");
  assert.equal(res.thread.lastFrom, "alon");
  assert.equal(res.thread.unread, true);
  assert.equal(res.thread.draft, null);
  assert.equal(res.thread.needsHuman, false);
  assert.equal(res.emailed, false);
  const msgs = ok(admin(env, "thread", { id: t.id })).messages;
  assert.equal(msgs[1].from, "alon");
  assert.equal(msgs[1].via, "bridge");
  assert.equal(failCode(admin(env, "reply", { id: t.id, as: "zoila", text: "x" })), "bad_request");
  assert.equal(failCode(admin(env, "reply", { id: t.id, as: "tutor", text: "" })), "bad_request");
  assert.equal(failCode(admin(env, "reply", { id: t.id, as: "tutor", text: "x", via: "auto" })), "bad_request");
  assert.equal(failCode(admin(env, "reply", { id: "t_missing", as: "tutor", text: "x" })), "not_found");
});

scenario("admin.draft stores a draft without counting toward the daily cap", (env) => {
  const t = createThread(env, { kind: "direct", text: "Hola" });
  const res = ok(admin(env, "draft", { id: t.id }));
  assert.match(res.thread.draft, /Leí tu mensaje/);
  assert.equal(ok(admin(env, "stats")).stats.autoCallsToday, 0);
  assert.equal(lastClaude(env).status, 200);
  // Drafting a thread whose last message is from the tutor still sends a request that ends with the student.
  const q = createThread(env, { text: "¿Qué es una medida?" });
  ok(student(env, "process", { id: q.id }));
  const redraft = ok(admin(env, "draft", { id: q.id }));
  assert.equal(lastClaude(env).status, 200, lastClaude(env).error);
  assert.deepEqual(lastClaude(env).body.messages.map((m) => m.role), ["user"]);
  assert.ok(redraft.thread.draft);
  env.setClaudeMode("fail");
  assert.equal(failCode(admin(env, "draft", { id: t.id })), "server_error");
  delete env.state.properties.ANTHROPIC_API_KEY;
  assert.equal(failCode(admin(env, "draft", { id: t.id })), "not_configured");
});

// ---------------------------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------------------------

scenario("admin.reply with email on an email thread replies in Gmail to the latest student message", (env) => {
  const first = env.addInboundEmail({ from: "Zoila <zoila@example.com>", subject: "Ayuda con pandas", body: "No sé cómo filtrar filas" });
  assert.equal(ok(admin(env, "intake")).imported, 1);
  env.clock.advance(60000);
  const second = env.addInboundEmail({ from: "zoila@example.com", subject: "Re: Ayuda con pandas", body: "Ya probé df[df.x > 1]", threadId: first.threadId });
  assert.equal(ok(admin(env, "intake")).imported, 1);

  const thread = ok(admin(env, "list")).threads[0];
  assert.equal(thread.origin, "email");
  assert.equal(thread.hasEmail, true);
  assert.equal(thread.messageCount, 2);

  const res = ok(admin(env, "reply", { id: thread.id, as: "alon", text: "Muy bien, **Zoila**. Prueba `df.query`.", email: true }));
  assert.equal(res.emailed, true);
  const sent = replies(env);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].inReplyTo, second.messageId, "replies to the latest student email");
  assert.equal(sent[0].gmailThreadId, first.threadId);
  assert.equal(sent[0].to, "zoila@example.com");
  assert.equal(sent[0].name, "Alon");
  assert.match(sent[0].subject, /Ayuda con pandas/);
  assert.ok(sent[0].body.startsWith("Respuesta a tu pregunta #1\n\nMuy bien, **Zoila**."), sent[0].body);
  const link = SITE + "#sala=" + env.room;
  assert.ok(sent[0].body.includes(link));
  assert.ok(sent[0].htmlBody.includes('<a href="' + link + '">Ver la conversación en tu sitio</a>'), sent[0].htmlBody);
  assert.ok(sent[0].htmlBody.includes("<strong>Zoila</strong>"));
  assert.ok(sent[0].htmlBody.includes(">df.query</code>"));

  // email:false does not send; the owner's reply in Gmail is never imported as a student message.
  ok(admin(env, "reply", { id: thread.id, as: "tutor", text: "Otra nota" }));
  assert.equal(replies(env).length, 1);
  env.state.cache.clear();
  assert.equal(ok(admin(env, "intake")).imported, 0);
  assert.equal(ok(admin(env, "thread", { id: thread.id })).messages.filter((m) => m.from === "student").length, 2);
});

scenario("email intake: allowlist, INTAKE_SINCE, quoted history, follow-ups, idempotence, kinds", (env) => {
  const since = Date.parse(env.state.properties.INTAKE_SINCE);
  assert.ok(Number.isFinite(since));

  env.addInboundEmail({ from: "Otra Persona <otra@example.com>", subject: "Spam", body: "Hola" });
  env.addInboundEmail({ from: "zoila@example.com", subject: "Vieja", body: "Antes de configurar", date: since - 2 * HOUR });
  // A Gmail thread with an old message and a new reply: only the new message is imported.
  const mixed = env.addInboundEmail({ from: "zoila@example.com", subject: "Tema viejo", body: "Mensaje viejo", date: since - HOUR });
  env.addInboundEmail({ from: "zoila@example.com", subject: "Re: Tema viejo", body: "Mensaje nuevo", threadId: mixed.threadId, date: since }); // exactly INTAKE_SINCE counts as new
  const q = env.addInboundEmail({
    from: "Zoila Pérez <ZOILA@Example.com>",
    subject: "RE: Fwd: ¿Qué es un DataFrame?",
    body: "Hola, ¿qué es un DataFrame?\nGracias\n\nEl mié, 16 sept 2026 a las 9:00, Alon <owner@example.com> escribió:\n> Mensaje anterior\n> más",
  });
  env.clock.advance(1000);
  const d = env.addInboundEmail({ from: "zoila@example.com", subject: "Mensaje directo", body: "Hola, esto es solo para ti\n\n-----Original Message-----\nFrom: x" });
  env.clock.advance(1000);
  const p = env.addInboundEmail({ from: "zoila@example.com", subject: "Para Alon", body: "On Wed, Sep 16, 2026 at 9:00 AM Alon <owner@example.com>\nwrote:\n> hola" });
  env.clock.advance(1000);
  env.addInboundEmail({ from: "zoila@example.com", subject: "", body: "Correo sin asunto pero con una duda sobre medidas DAX muy importante que quiero resolver pronto por favor" });
  env.clock.advance(1000);
  env.addInboundEmail({ from: "zoila@example.com", subject: "Fwd: Ejercicio", body: "Mira esto:\n\n> texto citado sin encabezado\n> otra línea" });
  env.clock.advance(1000);
  env.addInboundEmail({ from: "zoila@example.com", subject: "Correo reenviado", body: "Te paso esto\n\nDe: Profesor <profe@example.com>\nEnviado: lunes" });

  assert.equal(ok(admin(env, "intake")).imported, 7);
  const all = ok(admin(env, "list")).threads.sort((a, b) => a.number - b.number);
  assert.equal(all.length, 7);
  // The mixed Gmail thread is the oldest import (its new reply is dated exactly INTAKE_SINCE).
  const mixedThread = all[0];
  assert.equal(mixedThread.title, "Tema viejo");
  const mixedMessages = ok(admin(env, "thread", { id: mixedThread.id })).messages;
  assert.deepEqual(mixedMessages.map((m) => m.text), ["Mensaje nuevo"]);
  const threads = all.slice(1);
  assert.deepEqual(threads.map((t) => t.number), [2, 3, 4, 5, 6, 7]);
  assert.deepEqual(threads.map((t) => t.kind), ["question", "direct", "direct", "question", "question", "question"]);
  assert.ok(threads.every((t) => t.origin === "email" && t.topic === "otro"));
  assert.equal(threads[4].title, "Ejercicio");
  assert.equal(ok(admin(env, "thread", { id: threads[4].id })).messages[0].text, "Mira esto:");
  assert.equal(ok(admin(env, "thread", { id: threads[5].id })).messages[0].text, "Te paso esto");
  assert.equal(threads[0].title, "¿Qué es un DataFrame?");
  assert.equal(threads[1].title, "Mensaje directo");
  // Fallback title: first 80 characters of the body, trimmed like site titles.
  assert.equal(threads[3].title, "Correo sin asunto pero con una duda sobre medidas DAX muy importante que quiero");

  const text = (t) => ok(admin(env, "thread", { id: t.id })).messages[0];
  assert.equal(text(threads[0]).text, "Hola, ¿qué es un DataFrame?\nGracias");
  assert.equal(text(threads[0]).via, "email");
  assert.equal(text(threads[1]).text, "Hola, esto es solo para ti");
  assert.equal(text(threads[2]).text, "(Correo sin texto)");

  // Labels, and the raw emailMessageId stored for idempotence.
  assert.ok(env.state.gmail.threads.get(q.threadId).labels.has("Tutor IA"));
  assert.ok(env.state.gmail.threads.get(d.threadId).labels.has("Tutor IA"));
  assert.ok(env.state.gmail.labels.has("Tutor IA"));
  assert.ok(env.sheetRecords("Messages").some((m) => m.emailMessageId === p.messageId));

  // Idempotent, also after the scan cache is gone.
  assert.equal(ok(admin(env, "intake")).imported, 0);
  env.state.cache.clear();
  assert.equal(ok(admin(env, "intake")).imported, 0);
  assert.equal(ok(admin(env, "list")).threads.length, 7);

  // A follow-up in the same Gmail thread is appended to the same site thread.
  env.clock.advance(60000);
  ok(admin(env, "reply", { id: threads[0].id, as: "tutor", text: "Una tabla" }));
  env.clock.advance(60000);
  env.addInboundEmail({ from: "zoila@example.com", subject: "Re: ¿Qué es un DataFrame?", body: "¿Y una Serie?\n\nOn Wed, Sep 16, 2026 at 10:05 AM Tutor wrote:\n> Una tabla", threadId: q.threadId });
  assert.equal(ok(admin(env, "intake")).imported, 1);
  const followed = ok(admin(env, "thread", { id: threads[0].id }));
  assert.equal(followed.thread.status, "waiting");
  assert.equal(followed.thread.lastFrom, "student");
  assert.equal(followed.messages.length, 3);
  assert.equal(followed.messages[2].text, "¿Y una Serie?");
  assert.equal(ok(admin(env, "list")).threads.length, 7);
  assert.ok(env.state.properties.LAST_INTAKE_AT);
  assert.equal(claudeRequests(env).length, 0, "admin.intake does not call Claude");
});

scenario("email intake does nothing without student emails", (env) => {
  env.addInboundEmail({ from: "zoila@example.com", subject: "Hola", body: "Hola" });
  assert.equal(ok(admin(env, "intake")).imported, 0);
  assert.equal(ok(admin(env, "stats")).stats.emailConfigured, false);
}, { settings: { studentEmails: [] } });

scenario("tick imports email, answers it and replies by email with images sent to Claude", (env) => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
  const mail = env.addInboundEmail({
    from: "Zoila <zoila@example.com>",
    subject: "Error en Power BI",
    body: "<script>alert('x')</script> Me sale este error, mira la captura",
    attachments: [
      { name: "captura.png", contentType: "image/png", bytes: png },
      { name: "notas.pdf", contentType: "application/pdf", bytes: Buffer.from("%PDF-1.4") },
      { name: "enorme.png", contentType: "image/png", bytes: png, size: 4 * 1024 * 1024 },
      { name: "foto.jpg", contentType: "image/jpg", bytes: jpeg, inline: true },
    ],
  });
  env.run("tick");

  const req = lastClaude(env);
  assert.equal(req.status, 200, req.error);
  const content = req.body.messages[req.body.messages.length - 1].content;
  assert.ok(Array.isArray(content));
  const images = content.filter((b) => b.type === "image");
  assert.equal(images.length, 2);
  assert.deepEqual(images[0].source, { type: "base64", media_type: "image/png", data: png.toString("base64") });
  assert.deepEqual(images[1].source, { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") });
  assert.equal(content[content.length - 1].type, "text");

  const thread = ok(admin(env, "list")).threads[0];
  assert.equal(thread.status, "answered");
  const sent = replies(env);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].inReplyTo, mail.messageId);
  assert.equal(sent[0].name, "Tutor IA");
  assert.ok(sent[0].body.startsWith("Respuesta a tu pregunta #1\n\n"));
  assert.ok(!sent[0].htmlBody.includes("<script>"), "HTML email must escape student text quoted by the answer");
  assert.ok(sent[0].htmlBody.includes("&lt;script&gt;"));
  assert.ok(sent[0].htmlBody.includes("<pre"));
  assert.ok(sent[0].htmlBody.includes("Ver la conversación en tu sitio"));

  // The next tick imports nothing new (the tutor reply is from the owner).
  env.run("tick");
  assert.equal(ok(admin(env, "list")).threads[0].messageCount, 2);
  assert.equal(replies(env).length, 1);
});

scenario("emailReplies off: automatic answers to email threads are not emailed", (env) => {
  env.addInboundEmail({ from: "zoila@example.com", subject: "Duda", body: "¿Qué es DAX?" });
  env.run("tick");
  assert.equal(ok(admin(env, "list")).threads[0].status, "answered");
  assert.equal(replies(env).length, 0);
}, { settings: { emailReplies: false } });

// ---------------------------------------------------------------------------------------------
// Failures, limits, concurrency
// ---------------------------------------------------------------------------------------------

scenario("Claude failures count errors, return the thread to waiting, and need a human after 3", (env) => {
  env.setClaudeMode("fail");
  const t = createThread(env, { title: "Falla" });
  const after1 = ok(student(env, "process", { id: t.id })).thread;
  assert.equal(after1.status, "waiting");
  assert.equal(claudeRequests(env).length, 2, "one retry on HTTP 500");
  assert.ok(env.state.counters.sleepMs >= 3000);
  let detail = ok(admin(env, "thread", { id: t.id })).thread;
  assert.equal(detail.errorCount, 1);
  assert.match(detail.lastError, /500/);
  assert.equal(detail.needsHuman, false);
  assert.match(ok(admin(env, "stats")).stats.lastError, /#1/);
  assert.equal(notifications(env).length, 0, "notifyOn=direct: first question failure is silent");

  ok(student(env, "process", { id: t.id }));
  env.run("tick");
  detail = ok(admin(env, "thread", { id: t.id })).thread;
  assert.equal(detail.errorCount, 3);
  assert.equal(detail.needsHuman, true);
  assert.equal(detail.status, "waiting");
  assert.equal(claudeRequests(env).length, 6);

  const sent = notifications(env);
  assert.equal(sent.length, 1, "errors reach the owner once the thread stops retrying");
  assert.match(sent[0].subject, /Needs you/);

  env.setClaudeMode("ok");
  ok(student(env, "process", { id: t.id }));
  env.run("tick");
  assert.equal(claudeRequests(env).length, 6, "no more automatic attempts after 3 errors");
  assert.equal(ok(admin(env, "thread", { id: t.id })).messages.length, 1);
});

scenario("a refusal is stored as an error and no answer is saved", (env) => {
  env.setClaudeMode("refusal");
  const t = createThread(env);
  const res = ok(student(env, "process", { id: t.id })).thread;
  assert.equal(res.status, "waiting");
  assert.equal(res.messageCount, 1);
  const detail = ok(admin(env, "thread", { id: t.id })).thread;
  assert.equal(detail.lastError, "refusal");
  assert.equal(detail.errorCount, 1);
  assert.equal(claudeRequests(env).length, 1, "refusals are not retried within the same call");

  env.setClaudeMode("ok");
  const answered = ok(student(env, "process", { id: t.id })).thread;
  assert.equal(answered.status, "answered");
  const after = ok(admin(env, "thread", { id: t.id })).thread;
  assert.equal(after.errorCount, 0);
  assert.equal(after.lastError, null);
});

scenario("a failed direct draft notifies the owner right away", (env) => {
  env.setClaudeMode("fail");
  const t = createThread(env, { kind: "direct", title: "Directo", text: "Hola" });
  assert.equal(notifications(env).length, 0);
  ok(student(env, "process", { id: t.id }));
  const sent = notifications(env);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /Direct message #1: Directo \(automatic reply failed, retrying\)/);
  assert.ok(sent[0].body.includes("Hola"));
});

scenario("daily cap stops automatic calls and sends one cap email per day", (env) => {
  assert.equal(ok(admin(env, "settings", { set: { dailyCap: 2 } })).settings.dailyCap, 2);
  const a = createThread(env, { title: "A" });
  const b = createThread(env, { title: "B" });
  const c = createThread(env, { title: "C" });
  ok(student(env, "process", { id: a.id }));
  ok(student(env, "process", { id: b.id }));
  assert.equal(ok(student(env, "process", { id: c.id })).thread.status, "waiting");
  assert.equal(claudeRequests(env).length, 2);

  const capMails = () => notifications(env).filter((m) => /Daily limit/.test(m.subject));
  assert.equal(capMails().length, 1);
  ok(student(env, "process", { id: c.id }));
  env.run("tick");
  env.run("tick");
  assert.equal(capMails().length, 1, "at most one cap email per day");
  assert.equal(claudeRequests(env).length, 2);

  const list = ok(admin(env, "list", { filter: "needs" }));
  assert.deepEqual(list.threads.map((t) => t.id), [c.id]);
  assert.equal(list.stats.autoCallsToday, 2);
  assert.equal(list.stats.dailyCap, 2);

  // Next day (script time zone) the counter resets.
  env.clock.advance(24 * HOUR);
  assert.equal(ok(student(env, "process", { id: c.id })).thread.status, "answered");
  assert.equal(ok(admin(env, "stats")).stats.autoCallsToday, 1);
  assert.equal(JSON.parse(env.state.properties.AUTO_CALLS).date, "2026-09-17");
});

scenario("dailyCap 0 turns automatic calls off without a cap email", (env) => {
  const t = createThread(env);
  ok(student(env, "process", { id: t.id }));
  env.run("tick");
  assert.equal(claudeRequests(env).length, 0);
  assert.equal(notifications(env).length, 0);
  assert.equal(ok(admin(env, "thread", { id: t.id })).thread.needsHuman, true);
}, { settings: { dailyCap: 0 } });

scenario("rate limit: 30 create+send per rolling hour", (env) => {
  const t = createThread(env);
  for (let i = 0; i < 19; i++) createThread(env, { title: "T" + i });
  for (let i = 0; i < 10; i++) ok(student(env, "send", { id: t.id, text: "Mensaje " + i }));
  const limited = student(env, "create", { kind: "question", topic: "python", title: "31", text: "x" });
  assert.equal(failCode(limited), "rate_limited");
  assert.match(limited.error.message, /Espera/);
  assert.equal(failCode(student(env, "send", { id: t.id, text: "otro" })), "rate_limited");
  assert.equal(ok(student(env, "list")).threads.length, 20);
  // Reads are not limited.
  ok(student(env, "thread", { id: t.id }));
  env.clock.advance(61 * 60 * 1000);
  ok(student(env, "send", { id: t.id, text: "Ya pasó una hora" }));
});

scenario("tick resets a stale answering thread and the late answer is discarded", (env) => {
  const t = createThread(env);
  let inTick = false;
  env.state.claude.onRequest = () => {
    if (inTick) return;
    inTick = true;
    const busy = ok(admin(env, "thread", { id: t.id })).thread;
    assert.equal(busy.status, "answering");
    assert.equal(ok(student(env, "list")).threads[0].status, "answering", "students see answering");
    // The call hangs for 6 minutes; meanwhile the minute trigger runs without an API key.
    env.clock.advance(6 * 60 * 1000);
    const key = env.state.properties.ANTHROPIC_API_KEY;
    delete env.state.properties.ANTHROPIC_API_KEY;
    env.run("tick");
    env.state.properties.ANTHROPIC_API_KEY = key;
    const reset = ok(admin(env, "thread", { id: t.id })).thread;
    assert.equal(reset.status, "waiting");
    assert.equal(reset.errorCount, 1);
    assert.equal(reset.lastError, "timeout");
  };
  const res = ok(student(env, "process", { id: t.id })).thread;
  env.state.claude.onRequest = null;
  assert.equal(res.status, "waiting", "the late answer is not stored");
  assert.equal(res.messageCount, 1);

  env.clock.advance(1000);
  assert.equal(ok(student(env, "process", { id: t.id })).thread.status, "answered");
  assert.equal(ok(student(env, "thread", { id: t.id })).messages.filter((m) => m.from === "tutor").length, 1);
});

scenario("owner replies while Claude is answering: the late answer is discarded", (env) => {
  const t = createThread(env, { text: "Pregunta" });
  env.state.claude.onRequest = () => {
    ok(admin(env, "reply", { id: t.id, as: "alon", text: "Yo te respondo" }));
  };
  const res = ok(student(env, "process", { id: t.id })).thread;
  env.state.claude.onRequest = null;
  assert.equal(claudeRequests(env).length, 1);
  assert.equal(res.status, "answered");
  assert.equal(res.lastFrom, "alon");
  const msgs = ok(student(env, "thread", { id: t.id })).messages;
  assert.deepEqual(msgs.map((m) => m.from), ["student", "alon"]);
  env.run("tick");
  assert.equal(claudeRequests(env).length, 1);
  assert.equal(ok(admin(env, "thread", { id: t.id })).thread.errorCount, 0);
});

scenario("student follow-up while Claude is answering: stale answer discarded, then answered again", (env) => {
  const t = createThread(env, { text: "Primera" });
  env.state.claude.onRequest = () => {
    env.state.claude.onRequest = null;
    ok(student(env, "send", { id: t.id, text: "Perdón, otra cosa" }));
  };
  const res = ok(student(env, "process", { id: t.id })).thread;
  assert.equal(res.status, "waiting");
  assert.equal(res.messageCount, 2);
  const again = ok(student(env, "process", { id: t.id })).thread;
  assert.equal(again.status, "answered");
  assert.equal(again.messageCount, 3);
  assert.match(textOf(lastClaude(env).body.messages[0].content), /Primera\n\nPerdón, otra cosa$/);
});

scenario("without an API key nothing is called and questions need a human", (env) => {
  const t = createThread(env);
  assert.equal(ok(student(env, "process", { id: t.id })).thread.status, "waiting");
  env.run("tick");
  assert.equal(claudeRequests(env).length, 0);
  const detail = ok(admin(env, "thread", { id: t.id })).thread;
  assert.equal(detail.needsHuman, true);
  assert.equal(ok(admin(env, "stats")).stats.apiKeyConfigured, false);
}, { apiKey: null });

// ---------------------------------------------------------------------------------------------
// Admin: settings, events, delete, setup
// ---------------------------------------------------------------------------------------------

scenario("admin.settings merges and validates", (env) => {
  const current = ok(admin(env, "settings")).settings;
  assert.deepEqual(Object.keys(current).sort(), SETTINGS_KEYS);
  assert.equal(current.tutorName, "Alon");
  assert.equal(current.dailyCap, 40);
  assert.equal(current.autoQuestion, true);

  const bad = (set) => assert.equal(failCode(admin(env, "settings", { set })), "bad_request", JSON.stringify(set));
  bad({ notifyOn: "sometimes" });
  bad({ dailyCap: -1 });
  bad({ dailyCap: 1.5 });
  bad({ dailyCap: "abc" });
  bad({ studentEmails: ["no-es-email"] });
  bad({ studentEmails: 5 });
  bad({ tutorName: "" });
  bad({ tutorName: "x".repeat(41) });
  bad({ autoQuestion: "yes" });
  bad({ siteUrl: "javascript:alert(1)" });
  bad({ notifyEmail: "owner@" });
  bad({ tutorName: "Ana", dailyCap: -5 });
  assert.equal(failCode(admin(env, "settings", { set: "tutorName=Ana" })), "bad_request");
  assert.equal(ok(admin(env, "settings")).settings.tutorName, "Alon", "a rejected patch changes nothing");

  const updated = ok(admin(env, "settings", {
    set: { tutorName: "  Ana  ", studentEmails: "Zoila@Example.com, otra@example.com", siteUrl: "https://x.github.io/t/#sala=abc", dailyCap: "12", unknownKey: 1, notifyOn: "all" },
  })).settings;
  assert.equal(updated.tutorName, "Ana");
  assert.deepEqual(updated.studentEmails, ["zoila@example.com", "otra@example.com"]);
  assert.equal(updated.siteUrl, "https://x.github.io/t/");
  assert.equal(updated.dailyCap, 12);
  assert.equal(updated.notifyOn, "all");
  assert.equal("unknownKey" in updated, false);
  assert.equal(updated.studentName, "Zoila", "untouched keys keep their values");
  assert.equal(ok(student(env, "info")).tutorName, "Ana");
  assert.equal(ok(admin(env, "settings", { set: null })).settings.tutorName, "Ana");

  // The new name reaches Claude.
  const t = createThread(env);
  ok(student(env, "process", { id: t.id }));
  assert.match(lastClaude(env).body.system, /Trabajas junto a Ana/);
  // notifyOn=all: the automatic answer is reported to the owner.
  assert.equal(notifications(env).length, 1);
  assert.match(notifications(env)[0].subject, /answered automatically/);
});

scenario("admin.events returns threads updated after since, oldest first", (env) => {
  const t1 = createThread(env, { title: "Uno" });
  env.clock.advance(1000);
  const since = env.clock.iso();
  env.clock.advance(1000);
  const t2 = createThread(env, { title: "Dos" });
  env.clock.advance(1000);

  let events = ok(admin(env, "events", { since }));
  assert.deepEqual(events.threads.map((t) => t.id), [t2.id]);
  assert.deepEqual(Object.keys(events.threads[0]).sort(), ADMIN_THREAD_KEYS);
  assert.match(events.now, /Z$/);
  assert.equal(ok(admin(env, "events", { since: events.now })).threads.length, 0);

  env.clock.advance(1000);
  ok(admin(env, "reply", { id: t1.id, as: "tutor", text: "Respuesta" }));
  events = ok(admin(env, "events", { since }));
  assert.deepEqual(events.threads.map((t) => t.id), [t2.id, t1.id]);
  assert.equal(ok(admin(env, "events", { since: "2000-01-01T00:00:00Z" })).threads.length, 2);
  assert.equal(failCode(admin(env, "events", { since: "ayer" })), "bad_request");
  assert.equal(failCode(admin(env, "events", {})), "bad_request");
});

scenario("admin.delete removes the thread and its messages only", (env) => {
  const keep = createThread(env, { title: "Se queda" });
  const gone = createThread(env, { title: "Se va" });
  ok(student(env, "send", { id: gone.id, text: "segundo" }));
  ok(student(env, "send", { id: keep.id, text: "segundo" }));
  ok(student(env, "send", { id: gone.id, text: "tercero" }));
  assert.equal(env.sheetRecords("Messages").length, 5);

  assert.deepEqual(ok(admin(env, "delete", { id: gone.id })), { deleted: true });
  const remaining = env.sheetRecords("Messages");
  assert.equal(remaining.length, 2);
  assert.ok(remaining.every((m) => m.threadId === keep.id));
  assert.deepEqual(ok(student(env, "list")).threads.map((t) => t.id), [keep.id]);
  assert.equal(failCode(student(env, "thread", { id: gone.id })), "not_found");
  assert.equal(failCode(admin(env, "delete", { id: gone.id })), "not_found");
  assert.equal(ok(student(env, "thread", { id: keep.id })).messages.length, 2);
});

scenario("setup is idempotent: headers, tokens, one tick trigger", (env) => {
  const props = { ...env.state.properties };
  assert.match(props.ROOM_TOKEN, /^[A-Za-z0-9_-]{32,}$/);
  assert.match(props.ADMIN_TOKEN, /^[A-Za-z0-9_-]{32,}$/);
  assert.notEqual(props.ROOM_TOKEN, props.ADMIN_TOKEN);
  assert.deepEqual(env.sheetValues("Threads")[0], ["id", "number", "kind", "topic", "title", "status", "origin", "createdAt", "updatedAt", "lastFrom", "unread", "draft", "draftAt", "answeringSince", "errorCount", "lastError", "emailThreadId"]);
  assert.deepEqual(env.sheetValues("Messages")[0], ["id", "threadId", "from", "text", "code", "createdAt", "via", "emailMessageId"]);

  const t = createThread(env);
  props.COUNTER = env.state.properties.COUNTER;
  assert.equal(props.COUNTER, "1");
  env.clock.advance(HOUR);
  env.run("setup");
  env.run("setup");
  assert.equal(env.state.triggers.length, 1);
  assert.equal(env.state.triggers[0].getHandlerFunction(), "tick");
  assert.equal(env.state.triggers[0].everyMinutes, 1);
  for (const key of ["ROOM_TOKEN", "ADMIN_TOKEN", "INTAKE_SINCE", "COUNTER"]) assert.equal(env.state.properties[key], props[key], key);
  assert.equal(env.sheetValues("Threads").length, 2, "data kept");
  assert.equal(ok(student(env, "thread", { id: t.id })).messages.length, 1);

  // Duplicate triggers are removed.
  env.services.ScriptApp.newTrigger("tick").timeBased().everyMinutes(1).create();
  env.services.ScriptApp.newTrigger("tick").timeBased().everyMinutes(5).create();
  env.run("setup");
  assert.equal(env.state.triggers.filter((tr) => tr.getHandlerFunction() === "tick").length, 1);
  assert.match(env.logs(), /Admin token/);
  assert.ok(env.logs().includes(SITE + "#sala=" + props.ROOM_TOKEN));
  assert.doesNotMatch(env.logs(), /sk-test-key/, "never logs the API key");
});

scenario("columns the owner adds by hand survive writes", (env) => {
  const sheet = env.services.SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Threads");
  const t = createThread(env);
  const lock = env.services.LockService.getScriptLock();
  lock.waitLock(1000);
  sheet.getRange(1, 18, 1, 1).setValues([["nota"]]);
  sheet.getRange(2, 18, 1, 1).setValues([["'00042"]]);
  lock.releaseLock();
  ok(student(env, "send", { id: t.id, text: "más" }));
  ok(student(env, "process", { id: t.id }));
  const row = env.sheetRecords("Threads")[0];
  assert.equal(row.nota, "00042");
  assert.equal(row.status, "answered");
});

scenario("markdown to HTML for emails escapes before formatting", (env) => {
  const html = env.context.markdownToHtml_(
    "<script>alert(1)</script>\n\n**negrita** y `x<y`\n\n```python\nprint('<b>')\n```\n\n- uno\n- dos\n\n1. a\n2. b\n\n<img src=x onerror=alert(1)>"
  );
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("<strong>negrita</strong>"));
  assert.match(html, /<code[^>]*>x&lt;y<\/code>/);
  assert.match(html, /<pre[^>]*><code>print\(&#39;&lt;b&gt;&#39;\)<\/code><\/pre>/);
  assert.ok(html.includes("<ul><li>uno</li><li>dos</li></ul>"));
  assert.ok(html.includes("<ol><li>a</li><li>b</li></ol>"));
});
