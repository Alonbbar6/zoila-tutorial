#!/usr/bin/env node
// Prints one thread with its full history and any saved draft.

import { DATA_NOTICE, MISSING_REF, call, intFlag, parseCli, renderThread, resolveThread, runMain } from "./lib.mjs";

const HELP = `
Usage: node bridge/thread.mjs <number|#number|id> [--last N]

Prints a thread's details, the whole conversation (oldest first) and the saved draft, if any.
Read-only: nothing is changed or sent.

Arguments:
  <number>    the thread number, e.g. 12 (quote it if you use a hash: '#12')

Options:
  --last N    only show the last N messages
  -h, --help  show this help
`;

runMain(async () => {
  const { values, positionals } = parseCli(HELP, { last: { type: "string" } }, { minPositionals: 1, maxPositionals: 1, missing: MISSING_REF });
  const last = intFlag(values.last, "last", { fallback: 0, min: 1, max: 10000 });

  const { thread: listed, settings, stats } = await resolveThread(positionals[0]);
  const { thread, messages } = await call("admin.thread", { id: listed.id });

  const out = [DATA_NOTICE(settings), "", renderThread(thread || listed, messages, settings, stats, { last, level: 1 })];
  process.stdout.write(out.join("\n") + "\n");
});
