#!/usr/bin/env node
/**
 * Empirical verification of Anthropic prompt-cache behavior around the
 * "latest assistant message": the rationale behind hydra's n-1 fork heuristic.
 *
 * Hypotheses:
 *   H1  The driver's latest assistant message M is NOT cached after the driver's
 *       own request completes (it was a response, never part of a sent prefix).
 *       An observer fork that includes M pays uncached input for it.
 *   H2  A fork from n-1 (excluding M) is a pure cache read: creation ≈ 0,
 *       input ≈ observer prompt only. This holds for N parallel observers.
 *   H3  A fork including M with a cache_control marker ON M pays cache_creation
 *       for M once; a subsequent serial fork reads M from cache.
 *   H4  N PARALLEL forks including M (marker on M) each pay cache_creation,
 *       i.e. racing cache writes are not deduplicated server-side.
 *
 * Usage: node experiments/cache-latest-message.mjs [--model claude-haiku-4-5] [--padding-sentences 100]
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
const MODEL = argOf(args, "--model", "claude-haiku-4-5");
const PADDING_SENTENCES = Number(argOf(args, "--padding-sentences", "100"));
const PHASE_SLEEP_MS = 3000; // settle between phases so earlier writes are readable

const NONCE = makeNonce();
const SYSTEM = systemBlocks(NONCE, PADDING_SENTENCES);
const call = makeCall({ model: MODEL, system: SYSTEM, headers: oauthHeaders() });

const DRIVER_USER_MSG = {
  role: "user",
  content: [
    {
      type: "text",
      text: "In about 150 words, summarize the recurring structure of the sections in the background document.",
      cache_control: { type: "ephemeral" },
    },
  ],
};

// ~150-token observer prompts, hydra-style. Content varies per "lens" so the
// parallel requests are realistic (shared prefix, divergent suffix).
function observerPrompt(lens) {
  return (
    `<system-reminder>Side observer (${lens} lens). Reply with one JSON object, nothing else: ` +
    `{"action":"noop|queue|interrupt","reason":"≤120 chars","message":"≤240 chars, empty if noop"} ` +
    `Review the conversation through the ${lens} lens: focus on correctness risks, missing verification, ` +
    `dangerous assumptions, and obvious regressions. Noop unless something warrants feedback. ` +
    `Queue if useful but waitable. Interrupt only for urgent issues. No tools, no follow-up turn.</system-reminder>`
  );
}

function observerMsg(lens) {
  return { role: "user", content: [{ type: "text", text: observerPrompt(lens) }] };
}

// Assistant message M (captured from the driver response), optionally with a
// cache_control marker so observers can advance the cache breakpoint past M.
function assistantMsg(text, withMarker = false) {
  const block = { type: "text", text };
  if (withMarker) block.cache_control = { type: "ephemeral" };
  return { role: "assistant", content: [block] };
}

const log = console.log;

function logRow(row) {
  log(
    `${row.label.padEnd(26)} input=${String(row.input).padStart(5)}  ` +
    `read=${String(row.cacheRead).padStart(6)}  write=${String(row.cacheWrite).padStart(6)}  ` +
    `output=${String(row.output).padStart(4)}  ${row.ms}ms`
  );
}

function approx(a, b, tolFrac = 0.2, tolAbs = 60) {
  return Math.abs(a - b) <= Math.max(tolAbs, b * tolFrac);
}

function verdict(name, pass, detail) {
  log(`  ${pass ? "✅" : "❌"} ${name}: ${detail}`);
  return pass;
}

async function main() {
  log(`model=${MODEL}  nonce=${NONCE}`);
  log(`(padding ${PADDING_SENTENCES} sentences ≈ ${PADDING_SENTENCES * 65} tokens; all numbers are token counts)\n`);

  // ── P0: driver turn (cold), produces assistant message M ──
  log("── P0: driver request (cold cache) ──");
  const p0 = await call("P0 driver cold", [DRIVER_USER_MSG], 400);
  logRow(p0);
  assertColdStart(p0, prefixFloor(PADDING_SENTENCES));
  const M = p0.text;
  if (!M || M.length < 50) throw new Error("driver response too short to be a useful M");
  await sleep(PHASE_SLEEP_MS);

  // ── P1: identical driver replay, calibrates that caching works at all ──
  log("\n── P1: identical replay (calibration: cache works under OAuth) ──");
  const p1 = await call("P1 driver replay", [DRIVER_USER_MSG], 400);
  logRow(p1);
  await sleep(PHASE_SLEEP_MS);

  // ── P2: three PARALLEL n-1 observers (the original hydra behavior) ──
  log("\n── P2: 3 parallel observers, fork from n-1 (exclude M) ──");
  const p2 = await Promise.all(
    ["quality", "security", "simplifier"].map((lens) =>
      call(`P2 n-1 obs ${lens}`, [DRIVER_USER_MSG, observerMsg(lens)], 150)
    )
  );
  p2.forEach(logRow);
  await sleep(PHASE_SLEEP_MS);

  // ── P3: observer fork from n (includes M), NO new marker ──
  log("\n── P3: observer fork from n (include M), no marker on M ──");
  const p3 = await call(
    "P3 n obs no-marker",
    [DRIVER_USER_MSG, assistantMsg(M), observerMsg("quality")],
    150
  );
  logRow(p3);
  await sleep(PHASE_SLEEP_MS);

  // ── P4a: three PARALLEL observers fork from n, marker ON M ──
  log("\n── P4a: 3 parallel observers, fork from n, cache_control marker on M ──");
  const p4a = await Promise.all(
    ["quality", "security", "simplifier"].map((lens) =>
      call(`P4a n obs+mark ${lens}`, [DRIVER_USER_MSG, assistantMsg(M, true), observerMsg(lens)], 150)
    )
  );
  p4a.forEach(logRow);
  await sleep(PHASE_SLEEP_MS);

  // ── P4b: serial observer after the parallel writers ──
  log("\n── P4b: serial observer fork from n, marker on M (after P4a settled) ──");
  const p4b = await call(
    "P4b n obs+mark serial",
    [DRIVER_USER_MSG, assistantMsg(M, true), observerMsg("api-design")],
    150
  );
  logRow(p4b);

  // ── Analysis ──
  log("\n══ Analysis ══");
  const prefixTokens = p1.cacheRead; // full driver prefix as measured by replay
  const obsPromptTokens = Math.round(p2.reduce((sum, row) => sum + row.input, 0) / p2.length);
  const mTokens = p0.output; // output tokens of M ≈ its input cost when replayed
  log(`measured: driver prefix ≈ ${prefixTokens}, observer prompt ≈ ${obsPromptTokens}, M (output) ≈ ${mTokens}\n`);

  let all = true;

  all = verdict(
    "calibration",
    p1.cacheRead > 1000 && p1.cacheWrite < 100,
    `replay read=${p1.cacheRead} write=${p1.cacheWrite}; cache + usage reporting work under OAuth`
  ) && all;

  all = verdict(
    "H2 n-1 fork is pure read (×3 parallel)",
    p2.every((row) => row.cacheWrite < 100 && approx(row.cacheRead, prefixTokens) && row.input < obsPromptTokens * 2 + 60),
    p2.map((row) => `write=${row.cacheWrite},input=${row.input}`).join("  ")
  ) && all;

  const p3ExtraInput = p3.input - obsPromptTokens;
  all = verdict(
    "H1 M not cached after driver turn",
    p3ExtraInput > mTokens * 0.5 && p3.cacheWrite < 100,
    `n-fork input=${p3.input} vs n-1 input=${obsPromptTokens} → ~${p3ExtraInput} uncached tokens ≈ M (${mTokens})`
  ) && all;

  const writers = p4a.filter((row) => row.cacheWrite > mTokens * 0.5).length;
  all = verdict(
    "H4 parallel writers all pay",
    writers === p4a.length,
    `${writers}/${p4a.length} parallel n-forks paid cache_creation ≈ M (${p4a.map((row) => row.cacheWrite).join(", ")})`
  ) && all;
  if (writers > 0 && writers < p4a.length) {
    log("     ↳ partial: server deduped some racing writes; heuristic less costly than feared");
  }

  all = verdict(
    "H3 serial fork after write reads M",
    p4b.cacheWrite < 100 && p4b.cacheRead > prefixTokens + mTokens * 0.5,
    `read=${p4b.cacheRead} (prefix+M), write=${p4b.cacheWrite}`
  ) && all;

  // ── Cost model summary ──
  log("\n══ Cost interpretation (per observer, for the latest-message tokens M) ══");
  log("  fork n-1:                0, but the observer judges a stale snapshot");
  log("  fork n, no marker:       1.0× input price for M, every observer, every turn");
  log("  fork n, marker, serial:  1.25× once (first observer), 0.1× for later observers");
  log(`  fork n, marker, parallel: ${writers === p4a.length ? "1.25× for EACH racing observer (no dedup)" : "partially deduped; see P4a rows"}`);

  log(all ? "\nAll hypotheses confirmed." : "\nSome hypotheses NOT confirmed; read rows above.");
}

runMain(main);
