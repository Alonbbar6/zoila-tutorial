#!/usr/bin/env node
// Asks the backend to have Claude write a draft reply for a thread. Nothing is sent to the student.

import { writeFileSync } from "node:fs";
import { BridgeError, MISSING_REF, ago, call, fence, kindLabel, names, parseCli, quoteTitle, resolveThread, runMain, statusLabel } from "./lib.mjs";

const HELP = `
Usage: node bridge/draft.mjs <number|#number|id> [--out FILE]

Asks the backend to have Claude write a draft reply for the thread (backend action admin.draft).
The draft is saved on the thread (visible in admin.html) and printed here. Nothing is sent to
the student. This makes one Anthropic API call (small cost; it does not count toward dailyCap)
and can take a minute.

Arguments:
  <number>    the thread number, e.g. 12 (quote it if you use a hash: '#12')

Options:
  --out FILE  also write the raw draft text to FILE (handy for editing before reply.mjs --file)
  -h, --help  show this help

The draft is only a proposal. Post a reply only after the owner approves the exact text:
  node bridge/reply.mjs <number> --as alon|tutor --file <file> [--email]
`;

runMain(async () => {
  const { values, positionals } = parseCli(HELP, { out: { type: "string" } }, { minPositionals: 1, maxPositionals: 1, missing: MISSING_REF });
  const { thread: listed, settings } = await resolveThread(positionals[0]);

  process.stderr.write(`Asking Claude for a draft for #${listed.number}. This can take a minute...\n`);
  // Apps Script allows up to 6 minutes per request; the Claude call happens inside it.
  const { thread } = await call("admin.draft", { id: listed.id }, { timeoutMs: 330000 });
  const draft = String(thread?.draft ?? "").trim();
  if (!draft) {
    const reason = thread?.lastError ? ` Last error: ${thread.lastError}` : "";
    throw new BridgeError("server_error", `The backend did not return a draft for #${listed.number}.${reason}`);
  }
  if (values.out) writeFileSync(values.out, draft + "\n");

  const n = names(settings);
  const suggestedAs = thread.kind === "direct" ? "alon" : "tutor";
  const out = [
    `# Draft for #${thread.number} (NOT sent)`,
    "",
    `- Thread: ${kindLabel(thread.kind)} · ${quoteTitle(thread.title)} · ${statusLabel(thread)}`,
    `- Generated ${ago(thread.draftAt || new Date().toISOString())}; saved on the thread, visible in admin.html`,
    values.out ? `- Raw text also written to: ${values.out}` : null,
    "",
    fence(draft, "markdown"),
    "",
    `Show this to the owner. Only after they approve the exact text (as is or edited), post it with:`,
    `\`node bridge/reply.mjs ${thread.number} --as ${suggestedAs} --file <file-with-approved-text>${thread.hasEmail ? " [--email]" : ""}\``,
    `(--as alon appears to ${n.student} as "${n.tutor}"; --as tutor appears as "Tutor IA".)`,
  ].filter((l) => l !== null);
  process.stdout.write(out.join("\n") + "\n");
});
