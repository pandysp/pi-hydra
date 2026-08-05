#!/usr/bin/env node
/**
 * Does AUTOMATIC caching (top-level cache_control) cache the generated
 * response? The docs' multi-turn table says no (Asst(N) is written by request
 * N+1, not by the request that generated it). Verify empirically:
 *
 *   A: request with top-level cache_control → response M.
 *      Expect: write ≈ full prompt, read 0 (cold).
 *   B: same prompt + M + followup (top-level cache_control again).
 *      If M was NOT cached by A: read ≈ prefix, write ≈ M + followup.
 *      If M WAS cached by A (hypothesis rejected): read ≈ prefix + M.
 *
 * Usage: node experiments/attic/cache-automatic.mjs [--model claude-haiku-4-5]
 */

import {
  argOf,
  assertColdStart,
  makeCall,
  makeNonce,
  oauthHeaders,
  prefixFloor,
  runMain,
  sleep,
  systemBlocks,
} from "../lib.mjs";

const args = process.argv.slice(2);
const MODEL = argOf(args, "--model", "claude-haiku-4-5");
const PADDING_SENTENCES = Number(argOf(args, "--padding-sentences", "100"));

const NONCE = makeNonce();
// No per-block cache_control anywhere; automatic caching only.
const SYSTEM = systemBlocks(NONCE, PADDING_SENTENCES, { markers: false });
const call = makeCall({
  model: MODEL,
  system: SYSTEM,
  headers: oauthHeaders(),
  extra: { cache_control: { type: "ephemeral" } },
});
const log = console.log;

const USER1 = {
  role: "user",
  content: [{ type: "text", text: "In about 100 words, summarize the recurring structure of the sections above." }],
};

function logRow(row) {
  log(
    `${row.label.padEnd(10)} input=${String(row.input).padStart(5)}  read=${String(row.cacheRead).padStart(6)}  ` +
    `write=${String(row.cacheWrite).padStart(6)}  output=${row.output}`
  );
}

async function main() {
  log(`model=${MODEL}  nonce=${NONCE}\n`);

  const a = await call("A cold", [USER1], 300);
  logRow(a);
  assertColdStart(a, prefixFloor(PADDING_SENTENCES));
  const prefix = a.cacheWrite;
  const mTokens = a.output;
  await sleep(2500);

  const b = await call("B probe", [
    USER1,
    { role: "assistant", content: [{ type: "text", text: a.text }] },
    { role: "user", content: [{ type: "text", text: "Reply with the single word OK." }] },
  ], 16);
  logRow(b);

  log(`\nprefix=${prefix}  M=${mTokens}`);
  if (b.cacheRead >= prefix + mTokens * 0.5) {
    log("❌ B read prefix+M: automatic caching DID cache the response (docs table wrong)");
  } else if (b.cacheWrite >= mTokens * 0.5) {
    log(`✅ B read only the prefix (${b.cacheRead}) and paid the write for M+followup (${b.cacheWrite}).`);
    log("   Automatic caching does NOT cache the generated response; n-1 remains structural.");
  } else {
    log("⚠ ambiguous result; inspect numbers above");
  }
}

runMain(main);
