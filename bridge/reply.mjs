#!/usr/bin/env node
// Posts an owner-approved reply to a thread (backend action admin.reply, via "bridge").
// The approval itself happens in the Claude Code conversation; this script only posts
// and prints exactly what was sent.

import { readFileSync } from "node:fs";
import { BridgeError, MISSING_REF, call, fence, fromLabel, kindLabel, names, parseCli, quoteTitle, rememberThread, resolveThread, runMain, statusLabel, when } from "./lib.mjs";

const HELP = `
Usage: node bridge/reply.mjs <number|#number|id> --as alon|tutor (--text "..." | --file FILE) [--email]

Posts a reply to the thread. It appears on the student's site right away.
Only run this after the owner has approved this exact text in the conversation.

Arguments:
  <number>      the thread number, e.g. 12 (quote it if you use a hash: '#12')

Options:
  --as alon     written in the owner's own voice (the student sees the tutorName setting, e.g. "Alon")
  --as tutor    a tutor answer (the student sees "Tutor IA")
  --text TEXT   the reply text (fine for one line; use --file for anything longer)
  --file FILE   read the reply text from a UTF-8 file ("-" reads standard input)
  --email       also send the reply by email (only for threads that came in by email)
  --dry-run     show exactly what would be posted, without posting
  --force       post even if the thread's last message already has this exact text
  -h, --help    show this help
`;

function readReplyText(values) {
  if (values.text !== undefined && values.file !== undefined) {
    throw new BridgeError("usage", "Use either --text or --file, not both.");
  }
  if (values.text === undefined && values.file === undefined) {
    throw new BridgeError("usage", "Missing the reply: pass --file FILE (recommended) or --text \"...\".");
  }
  let raw = values.text;
  if (values.file !== undefined) {
    try {
      raw = readFileSync(values.file === "-" ? 0 : values.file, "utf8");
    } catch (err) {
      throw new BridgeError("usage", `Could not read ${values.file === "-" ? "standard input" : values.file}: ${err.message}`);
    }
  }
  const text = String(raw).replace(/^﻿/, "").replace(/\r\n/g, "\n").trim();
  if (!text) throw new BridgeError("usage", "The reply text is empty. Nothing was posted.");
  return text;
}

runMain(async () => {
  const { values, positionals } = parseCli(
    HELP,
    {
      as: { type: "string" },
      text: { type: "string" },
      file: { type: "string" },
      email: { type: "boolean" },
      "dry-run": { type: "boolean" },
      force: { type: "boolean" },
    },
    { minPositionals: 1, maxPositionals: 1, missing: MISSING_REF },
  );
  if (values.as !== "alon" && values.as !== "tutor") {
    throw new BridgeError("usage", `--as must be "alon" (the owner's own voice) or "tutor" (Tutor IA)${values.as ? `, not "${values.as}"` : ""}.`);
  }
  const text = readReplyText(values);
  const wantEmail = Boolean(values.email);

  const { thread: listed, settings } = await resolveThread(positionals[0]);
  const n = names(settings);
  const shownAs = fromLabel(values.as, settings);

  if (wantEmail && !listed.hasEmail) {
    throw new BridgeError(
      "usage",
      `Thread #${listed.number} did not come in by email, so it cannot be answered by email. Nothing was posted. Run again without --email to post it on the site.`,
    );
  }

  // Safety net for retries (for example after a timeout): refuse to post the same text twice in a row.
  const { messages = [] } = await call("admin.thread", { id: listed.id });
  const lastMessage = messages[messages.length - 1];
  if (!values.force && lastMessage && lastMessage.from === values.as && String(lastMessage.text).trim() === text) {
    throw new BridgeError(
      "duplicate",
      `The last message in #${listed.number} (${when(lastMessage.createdAt)}) already has exactly this text from ${shownAs}, so it looks posted already. Nothing was posted. Check with: node bridge/thread.mjs ${listed.number} (use --force only if a repeat is really intended).`,
    );
  }

  const notes = [];
  if (listed.lastFrom && listed.lastFrom !== "student") {
    notes.push(`Before this reply, the last message was already from ${fromLabel(listed.lastFrom, settings)}.`);
  }
  if (listed.hasEmail && !wantEmail) {
    notes.push(`This thread came in by email, but --email was not given: the reply is on the site only (${n.student} will not get an email).`);
  }

  if (values["dry-run"]) {
    const out = [
      `# Dry run: nothing was posted to #${listed.number}`,
      "",
      `- Would appear to ${n.student} as: ${shownAs} (--as ${values.as})`,
      `- Thread: ${kindLabel(listed.kind)} · ${quoteTitle(listed.title)} · ${statusLabel(listed)}`,
      `- Would be delivered: on the site${wantEmail ? " and by email" : " only"}`,
      ...notes.map((note) => `- Note: ${note}`),
      "",
      "## Exact text that would be sent",
      "",
      fence(text, "markdown"),
    ];
    process.stdout.write(out.join("\n") + "\n");
    return;
  }

  let result;
  try {
    result = await call("admin.reply", { id: listed.id, text, as: values.as, email: wantEmail, via: "bridge" }, { timeoutMs: 120000 });
  } catch (err) {
    if (err instanceof BridgeError && (err.code === "timeout" || err.code === "network")) {
      err.message += ` The reply MAY have been posted anyway. Check with node bridge/thread.mjs ${listed.number} before trying again.`;
    }
    throw err;
  }
  const thread = result?.thread || listed;
  rememberThread(thread); // so the watcher does not report our own reply back

  const out = [
    `# Reply posted to #${thread.number}`,
    "",
    `- Appears to ${n.student} as: ${shownAs} (--as ${values.as})`,
    `- Thread: ${kindLabel(thread.kind)} · ${quoteTitle(thread.title)}`,
    `- Delivered: on the site${wantEmail ? " + email reply requested from the owner's Gmail" : " only (no email)"}`,
    `- Thread status now: ${statusLabel(thread)}`,
    ...notes.map((note) => `- Note: ${note}`),
    "",
    "## Exact text sent",
    "",
    fence(text, "markdown"),
  ];
  process.stdout.write(out.join("\n") + "\n");
});
