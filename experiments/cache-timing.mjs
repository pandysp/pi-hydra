#!/usr/bin/env node
/**
 * When does an Anthropic prompt-cache write become READABLE?
 *
 * Companion to cache-latest-message.mjs. That experiment established (H3/H4):
 * an observation fork including the driver's latest assistant message M with a
 * cache_control marker on M creates a readable `prefix+M` entry, eventually.
 * This experiment pins down WHEN: at writer request ingestion, mid-processing,
 * or only after response completion (+ propagation lag).
 *
 * Why it matters for hydra: if the driver's next request starts inside the
 * commit window W, the driver misses the entry and pays for M itself (the
 * race). W bounds how soon a driver turn can start and still benefit from the
 * observation's pre-warm.
 *
 * Method (single cold conversation, no probe self-contamination):
 *   - WRITER: prefix + M(cache_control) + prompt forcing a LONG response
 *     (~400 words) → wide gap between ingestion-done and response-done.
 *   - PROBES at staggered delays: prefix + M(no marker) + unique followup_i
 *     (cache_control). A probe miss writes `prefix+M+followup_i`, unique per
 *     probe, so probes can never satisfy each other at the M boundary. Only
 *     the writer can create `prefix+M`. Probe hit signal:
 *     cache_read ≈ prefix+M (vs ≈ prefix on miss).
 *   - CONTROL probe well after writer completion validates that breakpoint
 *     walk-back lookup (followup marker → M block boundary) works at all.
 *
 * Usage: node experiments/cache-timing.mjs [--model claude-haiku-4-5] [--probe-delays 150,500,...]
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
// Probe schedule (ms after writer fire). Resolution chosen to bracket both a
// fast ingestion commit (<1s) and a slow response-completion commit (~5-10s).
// Override per model: slower models (opus/fable-class) need a longer schedule.
const PROBE_DELAYS = argOf(args, "--probe-delays", "150,500,1000,2000,3500,5000,7000,10000")
  .split(",")
  .map(Number);
const CONTROL_EXTRA_MS = 4000; // control probe fires this long after writer completes
const CONTROL_RETRY_MS = 15000; // second-chance control for slow-propagation models

const NONCE = makeNonce();
const SYSTEM = systemBlocks(NONCE, PADDING_SENTENCES);
const call = makeCall({ model: MODEL, system: SYSTEM, headers: oauthHeaders() });
const log = console.log;

const DRIVER_USER_MSG = {
  role: "user",
  content: [
    {
      type: "text",
      text: "In about 100 words, summarize the recurring structure of the sections in the background document.",
      cache_control: { type: "ephemeral" },
    },
  ],
};

async function main() {
  log(`model=${MODEL}  nonce=${NONCE}\n`);

  // P0: driver turn (cold) → produces M, writes the `prefix` entries.
  const p0 = await call("driver cold", [DRIVER_USER_MSG], 300);
  log(`driver cold:    write=${p0.cacheWrite}  output(M)=${p0.output}  ${p0.ms}ms`);
  assertColdStart(p0, prefixFloor(PADDING_SENTENCES));
  const M = p0.text;
  if (!M || M.length < 50) throw new Error("driver response too short");
  const prefixTokens = p0.cacheWrite;
  const mTokens = p0.output;
  await sleep(3000); // let prefix entries settle so probe misses read ≈ prefix cleanly

  // WRITER: observation-style fork, marker ON M, long output to separate
  // ingestion time from completion time. Fired WITHOUT await.
  const writerMessages = [
    DRIVER_USER_MSG,
    { role: "assistant", content: [{ type: "text", text: M, cache_control: { type: "ephemeral" } }] },
    {
      role: "user",
      content: [{
        type: "text",
        text: "Write a detailed ~400 word analysis of the methodology implied by the background document. Prose only.",
      }],
    },
  ];

  const tFire = Date.now();
  let writerDoneAt = null;
  const writerPromise = call("writer", writerMessages, 700).then((row) => {
    writerDoneAt = Date.now() - tFire;
    log(`writer done at +${writerDoneAt}ms  (write=${row.cacheWrite}, expected ≈ M=${mTokens})`);
    return row;
  });

  // PROBES: driver-next-turn shape. NO marker on M (misses must not create the
  // prefix+M entry); marker on the unique followup instead.
  function probeMessages(i) {
    return [
      DRIVER_USER_MSG,
      { role: "assistant", content: [{ type: "text", text: M }] },
      {
        role: "user",
        content: [{
          type: "text",
          text: `Follow-up ${i} (${NONCE}-p${i}): reply with the single word OK.`,
          cache_control: { type: "ephemeral" },
        }],
      },
    ];
  }

  const hitThreshold = prefixTokens + mTokens * 0.5;
  const probeResults = [];
  const probePromises = PROBE_DELAYS.map(async (delay, i) => {
    await sleep(delay);
    const sentAt = Date.now() - tFire;
    const row = await call(`probe@${delay}`, probeMessages(i), 16);
    probeResults.push({
      sentAt,
      hit: row.cacheRead >= hitThreshold,
      cacheRead: row.cacheRead,
      cacheWrite: row.cacheWrite,
    });
  });

  await Promise.all([writerPromise, ...probePromises]);

  // CONTROL: validates walk-back lookup (followup marker finding the M block
  // boundary); if this misses, the probe mechanism itself is invalid.
  await sleep(CONTROL_EXTRA_MS);
  let controlSentAt = Date.now() - tFire;
  let control = await call("control", probeMessages(99), 16);
  let controlHit = control.cacheRead >= hitThreshold;
  let controlLabel = "control";
  if (!controlHit) {
    // Slow-propagation models (fable showed 4-6s visibility) could miss the
    // first control; retry once much later before declaring the mechanism invalid.
    await sleep(CONTROL_RETRY_MS);
    controlSentAt = Date.now() - tFire;
    control = await call("control-retry", probeMessages(98), 16);
    controlHit = control.cacheRead >= hitThreshold;
    controlLabel = "control-retry";
  }

  // ── Report ──
  probeResults.sort((a, b) => a.sentAt - b.sentAt);
  log(`\nprefix=${prefixTokens}  M=${mTokens}  hit threshold: cache_read ≥ ${Math.round(hitThreshold)}`);
  log(`writer fired at +0ms, completed at +${writerDoneAt}ms\n`);
  log("probe sent@    read     write   verdict");
  for (const probe of probeResults) {
    log(
      `  +${String(probe.sentAt).padStart(6)}ms  ${String(probe.cacheRead).padStart(6)}  ` +
      `${String(probe.cacheWrite).padStart(6)}   ${probe.hit ? "HIT  (prefix+M readable)" : "miss (paid for M itself)"}`
    );
  }
  log(
    `  +${String(controlSentAt).padStart(6)}ms  ${String(control.cacheRead).padStart(6)}  ` +
    `${String(control.cacheWrite).padStart(6)}   ${controlHit ? "HIT" : "MISS"} (${controlLabel}, ${controlSentAt - writerDoneAt}ms after writer done)`
  );

  log("\n══ Interpretation ══");
  if (!controlHit) {
    log("❌ Both controls missed: walk-back lookup invalid OR propagation slower than");
    log(`   ~${Math.round((CONTROL_EXTRA_MS + CONTROL_RETRY_MS) / 1000)}s post-completion; probe results inconclusive either way.`);
    return;
  }
  const firstHit = probeResults.find((probe) => probe.hit);
  const lastMiss = [...probeResults].reverse().find((probe) => !probe.hit);
  if (!firstHit) {
    log(`All probes missed; only the control (+${controlSentAt}ms) hit.`);
    log(`→ Commit is at/after writer completion (+${writerDoneAt}ms) with propagation lag.`);
  } else {
    log(`First HIT: probe sent +${firstHit.sentAt}ms; last miss sent +${lastMiss ? lastMiss.sentAt : "—"}ms.`);
    if (firstHit.sentAt < writerDoneAt) {
      log(`→ Entry readable BEFORE writer completion (+${writerDoneAt}ms): commit at request ingestion/processing.`);
    } else {
      log(`→ Entry readable only AFTER writer completion: commit at response time.`);
    }
    log(`→ Race window for hydra: a driver request starting < ~${firstHit.sentAt}ms after the`);
    log(`   observation fires misses the pre-warm and pays cache_creation for M itself (no extra`);
    log(`   cost vs no observation; the write is simply not shared).`);
  }
}

runMain(main);
