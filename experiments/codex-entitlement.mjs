#!/usr/bin/env node
/**
 * Does the ChatGPT Codex backend gate GPT-5.6 models on the session id
 * format? Behind hydra's requirement that codex observations always carry a
 * UUIDv7 session id (docs/architecture.md, "OpenAI Codex support").
 *
 * Four one-shot requests to the same model, varying the session id and, in
 * the last, the transport:
 *
 *   none   no sessionId option
 *   v4     crypto.randomUUID() (version nibble 4)
 *   v7     uuidv7() (pi's own session id format)
 *   sse    v7 session id, transport "sse"
 *
 * Measured on gpt-5.6-luna, twice, a day apart — and the two days
 * disagree, which is itself the finding. 2026-07-13: none and v4 failed
 * with the model misrouted to a nonexistent free-tier variant ("Model not
 * found gpt-5.6-luna-free-1p-..."), sse failed even with a valid v7 id,
 * only v7 over websocket worked (gpt-5.5 worked in all shapes). 2026-07-14:
 * all four shapes passed. The backend's entitlement gating changes without
 * notice; hydra keeps the v7 id and the websocket pin as costless
 * defensive invariants that were required at least once. Note pi-ai's own
 * fallback request id (createCodexRequestId) is a v4 UUID, which would
 * have hit the -13 misroute.
 *
 * Requires a ChatGPT subscription login in ~/.pi/agent/auth.json. Costs a
 * few tiny requests of subscription quota.
 *
 * Usage: node experiments/codex-entitlement.mjs [--model gpt-5.6-luna]
 */

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { streamSimple, getModel } from "@earendil-works/pi-ai/compat";
import { uuidv7 } from "@earendil-works/pi-agent-core";
import { argOf } from "./lib.mjs";

const args = process.argv.slice(2);
const MODEL_ID = argOf(args, "--model", "gpt-5.6-luna");

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

async function probe(label, sessionId, transport) {
  const result = await streamSimple(
    model,
    {
      systemPrompt: "",
      messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly: ok" }], timestamp: Date.now() }],
    },
    { apiKey: auth.access, maxTokens: 100, ...(sessionId ? { sessionId } : {}), ...(transport ? { transport } : {}) },
  ).result();
  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  console.log(`${label.padEnd(5)} stop=${result.stopReason} text=${JSON.stringify(text)} err=${result.errorMessage ?? "-"}`);
}

await probe("none", undefined);
await probe("v4", randomUUID());
await probe("v7", uuidv7());
await probe("sse", uuidv7(), "sse");
process.exit(0);
