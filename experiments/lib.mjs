/**
 * Shared harness for the cache experiments: OAuth, payload scaffolding, the
 * Messages API call, and cold-start guards. Each experiment keeps only its
 * hypotheses, phases, and analysis.
 *
 * Auth mimics Claude Code, which is what the OAuth token is gated to: Bearer
 * auth, the claude-code/oauth beta headers, the CC user-agent, and the CC
 * identity as the FIRST system block. The token is read in-process from
 * ~/.pi/agent/auth.json and never printed; only usage numbers are logged.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const API_URL = "https://api.anthropic.com/v1/messages";

export function argOf(args, flag, dflt) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : dflt;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Unique per run, woven into every padding sentence: each run's prefix is
// byte-unique, so repeated runs can never satisfy each other's cache lookups.
export function makeNonce() {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function loadToken() {
  const authPath = join(homedir(), ".pi", "agent", "auth.json");
  const anthropic = JSON.parse(readFileSync(authPath, "utf8")).anthropic;
  if (!anthropic?.access) throw new Error("no anthropic oauth token in ~/.pi/agent/auth.json");
  if (anthropic.expires && Number(anthropic.expires) < Date.now()) {
    throw new Error("anthropic oauth token expired; open pi briefly to refresh it");
  }
  return anthropic.access;
}

export function oauthHeaders() {
  return {
    "content-type": "application/json",
    accept: "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
    authorization: `Bearer ${loadToken()}`,
    "user-agent": "claude-cli/2.1.75",
    "x-app": "cli",
  };
}

// ~65 tokens per sentence: 100 sentences ≈ 6.5K-token prefix, above every
// model's cache minimum (Haiku 4.5: 4096, fable: 512).
export const TOKENS_PER_SENTENCE = 65;

export function buildPadding(nonce, sentences) {
  const topics = [
    "inventory reconciliation", "thermal throttling", "lease accounting",
    "spectral analysis", "queue backpressure", "soil drainage",
    "cache coherence", "tidal forecasting", "yarn tension", "API pagination",
  ];
  const lines = [];
  for (let i = 0; i < sentences; i++) {
    const topic = topics[i % topics.length];
    lines.push(
      `Section ${i} (${nonce}): The committee reviewed the ${topic} report and noted ` +
      `that metric ${i * 7 % 113} deviated from baseline by ${((i * 13) % 97) / 10} percent, ` +
      `which the working group attributed to seasonal variation in subsystem ${i % 17}.`
    );
  }
  return lines.join("\n");
}

export function systemBlocks(nonce, sentences, { markers = true } = {}) {
  const marked = (block) => (markers ? { ...block, cache_control: { type: "ephemeral" } } : block);
  return [
    marked({ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }),
    marked({ type: "text", text: "Background document for this session:\n\n" + buildPadding(nonce, sentences) }),
  ];
}

/**
 * Build a call(label, messages, maxTokens) function bound to one experiment's
 * model/system/headers. `extra` is merged into every request body (e.g. a
 * thinking config, or top-level cache_control for the automatic-caching
 * experiment). Returns usage as flat token counts plus the response content.
 */
export function makeCall({ model, system, headers, extra = {} }) {
  return async function call(label, messages, maxTokens) {
    const body = { model, max_tokens: maxTokens, system, messages, stream: false, ...extra };
    const t0 = Date.now();
    const res = await fetch(API_URL, { method: "POST", headers, body: JSON.stringify(body) });
    const ms = Date.now() - t0;
    if (!res.ok) throw new Error(`[${label}] HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const json = await res.json();
    const usage = json.usage ?? {};
    const content = json.content ?? [];
    return {
      label,
      input: usage.input_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      ms,
      content,
      text: content.filter((block) => block.type === "text").map((block) => block.text).join("\n"),
    };
  };
}

/**
 * Hard-fail when a cold start is not actually cold. A nonzero cache read means
 * nonce reuse or cross-run leakage (the run would measure someone else's
 * entries); a write below the floor means the prefix never reached the cache
 * minimum (every "miss" below would be expected, proving nothing).
 */
export function assertColdStart(row, expectedPrefixFloor) {
  if (row.cacheRead > 0) {
    throw new Error(`CONTAMINATION: cold start read ${row.cacheRead} cached tokens`);
  }
  if (row.cacheWrite < expectedPrefixFloor) {
    throw new Error(`CALIBRATION: cold write ${row.cacheWrite} below expected floor ${expectedPrefixFloor}`);
  }
}

// Sentence floor for assertColdStart: generous margin under the ~65/sentence rate.
export function prefixFloor(sentences) {
  return sentences * 40;
}

export function runMain(fn) {
  fn().catch((err) => {
    console.error(String(err?.message ?? err));
    process.exit(1);
  });
}
