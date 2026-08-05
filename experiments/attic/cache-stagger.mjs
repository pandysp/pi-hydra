#!/usr/bin/env node
/**
 * P4a refinement: 4 observation forks from n (marker on M). One fires at t=0,
 * three fire in parallel at t=+STAGGER_MS. Do the delayed forks free-ride on
 * the writer's cache entry?
 *
 * Options:
 *   --model NAME             default claude-haiku-4-5
 *   --stagger-ms N           default 1000
 *   --padding-sentences N    prefix size (~65 tok/sentence); default 100
 *   --m-words N              driver answer length → M size; default 100
 *   --thinking EFFORT        enable adaptive thinking (e.g. xhigh) on ALL
 *                            requests, byte-identical config (mismatch would
 *                            invalidate the messages cache per docs). M is
 *                            replayed as the full content array including
 *                            thinking blocks with their real signatures.
 *   --stagger-from MODE      "fire" (default): stagger counts from writer fetch
 *                            dispatch. "commit": stagger counts from the
 *                            writer's message_start event (the documented
 *                            commit point), isolating propagation from
 *                            prefill/TTFT.
 *
 * The writer (fork1) is streamed and logs the time of its message_start event;
 * per docs the cache entry becomes available "once the response begins", so
 * t(message_start) ≈ commit time.
 */

import {
  API_URL,
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
const STAGGER_MS = Number(argOf(args, "--stagger-ms", "1000"));
const PADDING_SENTENCES = Number(argOf(args, "--padding-sentences", "100"));
const M_WORDS = Number(argOf(args, "--m-words", "100"));
const THINKING = argOf(args, "--thinking", "");
const STAGGER_FROM = argOf(args, "--stagger-from", "fire");

// Thinking config, byte-identical on every request in the run (a mismatch
// would invalidate the messages cache per Anthropic's invalidation table).
const THINKING_EXTRA = THINKING
  ? { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: THINKING } }
  : {};

const NONCE = makeNonce();
const SYSTEM = systemBlocks(NONCE, PADDING_SENTENCES);
const HEADERS = oauthHeaders();
const call = makeCall({ model: MODEL, system: SYSTEM, headers: HEADERS, extra: THINKING_EXTRA });
const log = console.log;

const DRIVER_USER_MSG = {
  role: "user",
  content: [{
    type: "text",
    text: `In about ${M_WORDS} words, describe the recurring structure of the sections in the background document, with examples.`,
    cache_control: { type: "ephemeral" },
  }],
};

function observationMsg(lens) {
  return {
    role: "user",
    content: [{
      type: "text",
      text:
        `<system-reminder>Side watcher (${lens} lens). Reply with one JSON object, nothing else: ` +
        `{"action":"noop|queue|interrupt","reason":"≤120 chars","message":"≤240 chars, empty if noop"} ` +
        `Noop unless something warrants feedback. No tools, no follow-up turn.</system-reminder>`,
    }],
  };
}

// Streamed call: reports t(message_start) relative to tRef, the moment the
// response begins, i.e. the documented cache-commit point.
async function callStream(label, messages, maxTokens, tRef, onStart) {
  const body = { model: MODEL, max_tokens: maxTokens, system: SYSTEM, messages, stream: true, ...THINKING_EXTRA };
  const res = await fetch(API_URL, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`[${label}] HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let startUsage = null;
  let tStart = null;
  let outputTokens = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      let event;
      try { event = JSON.parse(line.slice(5)); } catch { continue; }
      if (event.type === "message_start") {
        tStart = Date.now() - tRef;
        startUsage = event.message?.usage ?? {};
        log(`  writer message_start at +${tStart}ms (response begins ≈ cache commit)`);
        onStart?.(tStart);
      } else if (event.type === "message_delta" && event.usage) {
        outputTokens = event.usage.output_tokens ?? outputTokens;
      }
    }
  }
  const usage = startUsage ?? {};
  return {
    label,
    input: usage.input_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
    output: outputTokens,
    tStart,
  };
}

async function main() {
  log(`model=${MODEL}  stagger=${STAGGER_MS}ms (from ${STAGGER_FROM})  padding=${PADDING_SENTENCES} sentences  thinking=${THINKING || "off"}  nonce=${NONCE}\n`);

  // Driver turn (cold) → M (full content array incl. thinking blocks + signatures).
  const driverMax = THINKING ? 4000 : Math.max(300, Math.round(M_WORDS * 2.5));
  const driver = await call("driver", [DRIVER_USER_MSG], driverMax);
  const prefixTokens = driver.cacheWrite;
  const mTokens = driver.output;
  log(`driver cold: prefix=${prefixTokens}  read=${driver.cacheRead}  M(output incl. thinking)=${mTokens}  blocks=[${driver.content.map((block) => block.type).join(",")}]`);
  assertColdStart(driver, prefixFloor(PADDING_SENTENCES));
  if (driver.text.length < 50) throw new Error("driver text response too short");
  await sleep(3000);

  // M replayed verbatim (thinking blocks with real signatures included);
  // cache_control marker on a COPY of the last ELIGIBLE block. A marker on a
  // thinking block is an API error, and M can end on one if max_tokens truncated it.
  const lastEligible = driver.content.map((block) => block.type).lastIndexOf("text");
  if (lastEligible === -1) throw new Error("M has no text block (truncated mid-thinking?), cannot place marker");
  const mBlocks = driver.content.map((block, i) =>
    i === lastEligible ? { ...block, cache_control: { type: "ephemeral" } } : block
  );
  const forkMessages = (lens) => [DRIVER_USER_MSG, { role: "assistant", content: mBlocks }, observationMsg(lens)];
  const forkMax = THINKING ? 1500 : 150;

  const tFire = Date.now();
  const rows = [];
  const track = (promise, sentAt) => promise.then((row) => rows.push({ ...row, sentAt }));

  // Fork 1: the designated writer, t=0, streamed for commit detection.
  let tCommit = null;
  let commitResolve;
  const commitSeen = new Promise((resolve) => (commitResolve = resolve));
  commitSeen.then((t) => (tCommit = t));
  const first = track(
    callStream("fork1 quality (t=0)", forkMessages("quality"), forkMax, tFire, commitResolve),
    0
  );

  // Forks 2-4: parallel, delayed by STAGGER_MS from fire or from commit.
  if (STAGGER_FROM === "commit") await commitSeen;
  await sleep(STAGGER_MS);
  const sentAt = Date.now() - tFire;
  const rel = tCommit != null ? ` = commit+${sentAt - tCommit}ms` : "";
  const rest = ["security", "simplifier", "api-design"].map((lens, i) =>
    track(call(`fork${i + 2} ${lens} (t=+${sentAt}ms${rel})`, forkMessages(lens), forkMax), sentAt)
  );

  await Promise.all([first, ...rest]);

  rows.sort((a, b) => a.sentAt - b.sentAt);
  log(`\nfork                                sent@      read    write   verdict`);
  let paid = 0;
  for (const row of rows) {
    // Robust to unknown replayed-M size: a free ride reads strictly more than
    // the prefix (prefix + M); a payer reads exactly the prefix and writes M.
    const readM = row.cacheRead >= prefixTokens + 60;
    if (!readM) paid++;
    log(
      `  ${row.label.padEnd(32)} +${String(row.sentAt).padStart(5)}ms  ${String(row.cacheRead).padStart(7)}  ` +
      `${String(row.cacheWrite).padStart(6)}   ${readM ? "read prefix+M (free ride)" : "PAID write ≈ M"}`
    );
  }

  const mode = STAGGER_FROM === "commit" ? `commit+${STAGGER_MS}ms` : `fire+${STAGGER_MS}ms`;
  if (tCommit != null) {
    const delta = sentAt - tCommit;
    log(`\ndelayed forks dispatched at commit${delta >= 0 ? "+" : ""}${delta}ms (writer commit +${tCommit}ms)`);
  }
  log(`${paid}/4 forks paid the cache write for M.`);
  log(
    paid === 1
      ? `→ ${mode} stagger is enough: one writer, three free riders.`
      : `→ ${mode} stagger NOT sufficient: ${paid} forks paid.`
  );
}

runMain(main);
