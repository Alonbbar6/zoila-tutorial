#!/usr/bin/env node
// Overview of all threads: the ones that need a human first, then the most recent others.

import { ago, backendStatus, call, fromLabel, intFlag, kindLabel, localTime, names, needsHumanReason, parseCli, quoteTitle, runMain } from "./lib.mjs";

const HELP = `
Usage: node bridge/inbox.mjs [--limit N] [--all]

Shows the threads that need a human first, then the most recently updated other threads,
plus a short backend health summary. Read-only: nothing is changed or sent.

Options:
  --limit N   how many other recent threads to list (default 10)
  --all       list every thread
  -h, --help  show this help

Related: node bridge/thread.mjs <number> shows one full conversation.
`;

function statusShort(thread, settings) {
  if (thread.status === "answered") return `answered by ${fromLabel(thread.lastFrom, settings)}`;
  if (thread.status === "answering") return "Tutor IA is writing";
  return thread.status || "unknown";
}

function line(thread, settings, stats) {
  const n = names(settings);
  const bits = [`**#${thread.number}**`, kindLabel(thread.kind), statusShort(thread, settings), `updated ${ago(thread.updatedAt)}`];
  if (thread.origin === "email") bits.push("came in by email");
  if (thread.draft) bits.push("draft saved");
  if (thread.unread) bits.push(`${n.student} has not read the answer yet`);
  if (Number(thread.errorCount) > 0) bits.push(`${thread.errorCount} auto-answer error(s)`);
  let text = `- ${bits.join(" · ")}: ${quoteTitle(thread.title)}`;
  if (thread.needsHuman) text += `\n  Why: ${needsHumanReason(thread, settings, stats)}`;
  return text;
}

runMain(async () => {
  const { values } = parseCli(HELP, { limit: { type: "string" }, all: { type: "boolean" } });
  const limit = intFlag(values.limit, "limit", { fallback: 10, min: 1, max: 1000 });

  const { threads = [], settings = {}, stats = {} } = await call("admin.list", { filter: "all" });
  const n = names(settings);
  const byNewest = [...threads].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  // Needs-human threads: oldest first, because they have waited longest.
  const needs = byNewest.filter((t) => t.needsHuman).reverse();
  const others = byNewest.filter((t) => !t.needsHuman);
  const shownOthers = values.all ? others : others.slice(0, limit);

  const out = [
    `# Inbox: ${n.student}'s threads`,
    "",
    `_Checked ${localTime(new Date().toISOString())}. ${threads.length} thread(s) in total. Replies from the owner appear to ${n.student} as "${n.tutor}"._`,
    "",
    ...backendStatus(settings, stats).flatMap((l) => [l, ""]),
    `## Needs a human (${needs.length})`,
    "",
  ];
  if (needs.length) out.push(...needs.map((t) => line(t, settings, stats)));
  else out.push("Nothing is waiting for a person right now.");

  out.push("", `## Other recent threads (${shownOthers.length === others.length ? others.length : `showing ${shownOthers.length} of ${others.length}`})`, "");
  if (shownOthers.length) out.push(...shownOthers.map((t) => line(t, settings, stats)));
  else out.push("None.");
  if (shownOthers.length < others.length) out.push("", "_Use --all to list every thread._");

  out.push("", "Open one conversation with: `node bridge/thread.mjs <number>`");
  process.stdout.write(out.join("\n") + "\n");
});
