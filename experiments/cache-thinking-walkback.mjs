#!/usr/bin/env node
/**
 * Walk-back lookup across thinking-bearing M (fable, adaptive thinking).
 *
 * The driver-pre-warm claim requires: after an observation writes `prefix+M`
 * (marker on M), the driver's NEXT request (M *without* a marker, a new user
 * message *with* one) finds the entry via breakpoint walk-back. Verified on haiku without thinking; this verifies it with
 * thinking blocks (real signatures, replayed verbatim) in M.
 *
 *   1. driver cold (adaptive thinking) → M = [thinking, text] blocks
 *   2. writer: prefix + M(marker) + observation prompt → creates prefix+M entry
 *   3. probe (driver-next-turn shape): prefix + M(no marker) + user(marker)
 *      Expect: read ≈ prefix + M (walk-back hit), write ≈ followup only.
 *
 * Usage: node experiments/cache-thinking-walkback.mjs [--model claude-fable-5] [--effort xhigh]
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
} from "./lib.mjs";

const args = process.argv.slice(2);
const MODEL = argOf(args, "--model", "claude-fable-5");
const EFFORT = argOf(args, "--effort", "xhigh");
const PADDING_SENTENCES = Number(argOf(args, "--padding-sentences", "100"));

const NONCE = makeNonce();
const SYSTEM = systemBlocks(NONCE, PADDING_SENTENCES);
const call = makeCall({
  model: MODEL,
  system: SYSTEM,
  headers: oauthHeaders(),
  extra: { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: EFFORT } },
});
const log = console.log;

// Compute-heavy prompt: adaptive thinking skips trivial asks, so force real
// reasoning to guarantee thinking blocks in M.
const USER1 = {
  role: "user",
  content: [{
    type: "text",
    text:
      "Across the sections above, which subsystem number appears most often, and what is the " +
      "approximate average deviation across all sections? Reason carefully before answering; " +
      "the per-section values follow formulas. Answer in about 80 words.",
    cache_control: { type: "ephemeral" },
  }],
};

function logRow(row) {
  log(`${row.label.padEnd(22)} read=${String(row.cacheRead).padStart(6)}  write=${String(row.cacheWrite).padStart(6)}  output=${row.output}`);
}

async function main() {
  log(`model=${MODEL}  effort=${EFFORT}  nonce=${NONCE}\n`);

  const driver = await call("driver cold", [USER1], 4000);
  logRow(driver);
  assertColdStart(driver, prefixFloor(PADDING_SENTENCES));
  const prefix = driver.cacheWrite;
  log(`M blocks: [${driver.content.map((block) => block.type).join(",")}]`);
  const hasThinking = driver.content.some((block) => block.type === "thinking");
  if (!hasThinking) log("⚠ no thinking block in M; effort may not have engaged");
  await sleep(2000);

  // Writer: marker on M's last ELIGIBLE block. cache_control on a thinking
  // block is rejected by the API, and M can end on one if max_tokens truncated it.
  const lastEligible = driver.content.map((block) => block.type).lastIndexOf("text");
  if (lastEligible === -1) throw new Error("M has no text block (truncated mid-thinking?), cannot place marker; rerun");
  const mMarked = driver.content.map((block, i) =>
    i === lastEligible ? { ...block, cache_control: { type: "ephemeral" } } : block
  );
  const writer = await call("writer (marker on M)", [
    USER1,
    { role: "assistant", content: mMarked },
    { role: "user", content: [{ type: "text", text: "Reply with the single word OK." }] },
  ], 1500);
  logRow(writer);
  const mInputTokens = writer.cacheWrite; // delta prefix→M = M's input size as replayed
  await sleep(2500);

  // Probe: driver-next-turn shape. M verbatim WITHOUT marker, new user WITH marker.
  const probe = await call("probe (driver shape)", [
    USER1,
    { role: "assistant", content: driver.content },
    {
      role: "user",
      content: [{
        type: "text",
        text: `Next question (${NONCE}): reply with the single word OK.`,
        cache_control: { type: "ephemeral" },
      }],
    },
  ], 1500);
  logRow(probe);

  log(`\nprefix=${prefix}  M(replayed input)=${mInputTokens}`);
  if (probe.cacheRead >= prefix + mInputTokens * 0.5 && probe.cacheWrite < mInputTokens * 0.5) {
    if (hasThinking) {
      log("✅ walk-back across thinking-bearing M works: probe read prefix+M, wrote only its followup.");
      log("   Signature parity holds; driver pre-warm is valid under thinking.");
    } else {
      log("✅ walk-back worked, but M had NO thinking block; rerun, this run doesn't cover the thinking case.");
    }
  } else if (probe.cacheRead >= prefix - 60 && probe.cacheWrite >= mInputTokens * 0.5) {
    log("❌ probe paid for M: walk-back missed the writer's entry (or propagation/expiry).");
  } else {
    log("⚠ ambiguous; inspect numbers above");
  }
}

runMain(main);
