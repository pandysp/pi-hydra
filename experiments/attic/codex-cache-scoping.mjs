#!/usr/bin/env node
/**
 * How does the ChatGPT Codex backend scope its prompt cache, how long until
 * a write becomes readable, and how long until it expires? Behind hydra's
 * codex session strategy (docs/architecture.md, "OpenAI Codex support").
 *
 * One timed matrix over a ~15K-token prompt X. Every phase runs with
 * transport "websocket" (full input, no delta continuation — matching
 * hydra's observer pin), and the session's websocket is force-closed after
 * each phase so every request rides a fresh connection: reads measured here
 * are cross-connection cache reads, not connection affinity.
 *
 *   W          t+0      write X under (session S, key K)
 *   RA         t+65s    X + tail under (S, K)     → readable in under 65s?
 *   RK         t+95s    X + tail under (S, K2≠K)  → is the KEY the scope?
 *   RB         t+150s   X + tail under (S2≠S, K3) → cross-session read?
 *   RC         t+180s   X + tail under (S, K)     → same-session control
 *   RD         t+750s   X + tail under (S, K)     → expiry after ~9.5min idle
 *
 * Measured on gpt-5.6-luna, twice, a day apart. Stable across both runs:
 * W read=0; RA read≈X (readable in under 65s; an ad-hoc probe at +40s
 * missed); RK read≈X (prompt_cache_key is NOT the scope); RB read=0
 * (cross-session miss — though full pi-stack traffic has shown
 * opportunistic cross-session hits on identical content, so treat scoping
 * as multi-signal routing where only same-session is guaranteed); RD
 * read=0. Volatile: RC hit on 2026-07-13 (entries lived ~2–9 minutes) but
 * missed on -14 (lifetime under ~85s of idle that day) — entry lifetime is
 * a backend mood, not a constant, and nothing in hydra depends on it
 * beyond economics. Reads quantize to 128-token blocks;
 * cache_write_tokens is never reported; nothing resembles the platform's
 * documented 30-minute retention. At --facts 2400 (~65K tokens, 2026-07-14)
 * the structure is identical: readable in under 65s despite 4x prefill,
 * cross-session still 0, and the ~2-minute control hit at 65K on the same
 * day the 15K run's control missed — lifetime volatility, not size decay.
 *
 * Requires a ChatGPT subscription login in ~/.pi/agent/auth.json
 * ("openai-codex"; run `pi` and log in). Costs subscription quota
 * (~75K input tokens ≈ cents) and ~13 minutes of wall clock.
 *
 * Usage: node experiments/codex-cache-scoping.mjs [--model gpt-5.6-luna] [--facts 600]
 */

import { readFileSync } from "node:fs";
import { streamSimple, getModel } from "@earendil-works/pi-ai/compat";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { uuidv7 } from "@earendil-works/pi-agent-core";
import { argOf, sleep } from "../lib.mjs";

const args = process.argv.slice(2);
const MODEL_ID = argOf(args, "--model", "gpt-5.6-luna");
// ~26 tokens per fact: 600 ≈ 15K-token prompt (the reference run), 2400 ≈ 62K
// (the large-context run — commit latency under heavy prefill).
const FACTS = Number(argOf(args, "--facts", "600"));

const auth = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/auth.json`, "utf8"))["openai-codex"];
if (!auth?.access) {
  console.error("no openai-codex login in ~/.pi/agent/auth.json — run `pi` and log in first");
  process.exit(1);
}
if (typeof auth.expires === "number" && auth.expires < Date.now()) {
  console.error("the openai-codex token in ~/.pi/agent/auth.json is expired — run `pi` to refresh it");
  process.exit(1);
}
const model = getModel("openai-codex", MODEL_ID);
if (!model) {
  console.error(`unknown openai-codex model "${MODEL_ID}" — check --model`);
  process.exit(1);
}

// A unique nonce per run keeps every run cold: prior runs cannot satisfy
// this run's lookups, mirroring lib.mjs's cold-start discipline.
const nonce = uuidv7().slice(-12);
const filler = Array.from(
  { length: FACTS },
  (_, i) => `Fact ${i} [${nonce}]: the sequence value is ${(i * 7919) % 104729} and its label is item-${i}.`,
).join(" ");

const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
const contextDoc = user(`Context document follows. Just acknowledge.\n${filler}`);

const S = uuidv7();
const S2 = uuidv7();
const K = uuidv7();
const K2 = uuidv7();
const K3 = uuidv7();

async function probe(label, sessionId, promptCacheKey, tailText) {
  const messages = tailText ? [contextDoc, user(tailText)] : [contextDoc];
  const result = await streamSimple(
    model,
    { systemPrompt: "", messages },
    {
      apiKey: auth.access,
      maxTokens: 200,
      sessionId,
      transport: "websocket",
      onPayload: (body) => ({ ...body, prompt_cache_key: promptCacheKey }),
    },
  ).result();
  // Fresh connection for the next phase: reads must be cross-connection.
  closeOpenAICodexWebSocketSessions(sessionId);
  const u = result.usage;
  console.log(
    `${label.padEnd(3)} input=${String(u.input).padStart(6)} cacheRead=${String(u.cacheRead).padStart(6)} err=${result.errorMessage ?? "-"}`,
  );
  if (result.stopReason === "error") {
    console.error(`${label} errored — the rest of the matrix would be garbage; aborting`);
    process.exit(1);
  }
  return u;
}

const w = await probe("W", S, K, null);
if (w.cacheRead > 0) {
  console.error(`cold start read ${w.cacheRead} tokens — a previous run is polluting this one; aborting`);
  process.exit(1);
}
await sleep(65_000);
await probe("RA", S, K, "Reply exactly: a");
await sleep(30_000);
await probe("RK", S, K2, "Reply exactly: k");
await sleep(55_000);
await probe("RB", S2, K3, "Reply exactly: b");
await sleep(30_000);
await probe("RC", S, K, "Reply exactly: c");
await sleep(570_000);
await probe("RD", S, K, "Reply exactly: d");
process.exit(0);
