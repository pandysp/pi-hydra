// Live end-to-end check of pi-hydra heads in a Flue agent, on an existing pi login.
//   node live-check.mjs anthropic|codex
// The agent's multiply tool is deliberately wrong. A judge head that checks arithmetic should
// catch the wrong product at the response's finish; the agent should then correct its answer
// before the response settles. Prints the reply, every head record and the cache numbers.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { defineTool, init, useModel, useTool } from "@flue/runtime";
import { start } from "@flue/runtime/node";
import { createFlueHydra } from "./index.ts";

const route = process.argv[2];
const setup = { anthropic: [anthropicProvider, "claude-opus-5-5"], codex: [openaiCodexProvider, "gpt-5.5"] }[route];
if (!setup) throw new Error("usage: node live-check.mjs anthropic|codex");
const [factory, modelId] = setup;
const inner = factory();
const stored = JSON.parse(readFileSync(join(homedir(), ".pi/agent/auth.json"), "utf8"))[inner.id];
if (stored?.type !== "oauth" || stored.expires <= Date.now() + 5 * 60_000) throw new Error(`no fresh ${inner.id} login in pi`);
const auth = await inner.auth.oauth.toAuth(stored); // stays in memory
const provider = { ...inner, auth: { apiKey: { name: "live check (pi login)", resolve: async () => ({ auth }) } } };

const heads = mkdtempSync(join(tmpdir(), "hydra-heads-"));
writeFileSync(join(heads, "arithmetic.md"), `---
name: arithmetic
description: Checks every number the assistant reports against the arithmetic itself
tools: []
---
Check every product the assistant states in its answer by doing the multiplication yourself. If a stated product is wrong, steer with the correct value and say which source was wrong. Report nothing if every product is right.
`);

const records = [];
const hydra = createFlueHydra({ heads: [join(heads, "arithmetic.md")], onRecord: (record) => records.push(record) });

const docs = readFileSync(new URL("../docs/architecture.md", import.meta.url), "utf8"); // a long, stable prefix
function Calculator() {
	useModel(`${inner.id}/${modelId}`, { thinkingLevel: "low" });
	useTool(defineTool({
		name: "multiply",
		description: "Multiply two integers.",
		input: v.object({ a: v.number(), b: v.number() }),
		run: ({ data }) => String(data.a * data.b + 10), // deliberately wrong
	}));
	hydra.useHydra();
	return `Use the multiply tool for every multiplication and report exactly the number it returns. Do not do arithmetic yourself unless a reviewer's feedback says a result is wrong; then work it out and give the corrected answer.\n\nBackground reading (unrelated to the task):\n${docs}`;
}

// An open connection after the run (see hydra.close()) fails the check instead of hanging it.
setTimeout(() => { console.error("live check did not exit within 120 s; something kept the process alive"); process.exit(2); }, 120_000).unref();

const flue = await start({ agents: [Calculator], providers: [hydra.wrap(provider)] });
const startedAt = Date.now();
const handle = init(Calculator);
let signals = 0;
// Hard enough to work out in one's head that the agent relies on its tool.
const reply = await handle.read(await handle.dispatch("What is 1847 times 2963? Use the multiply tool."), {
	onEvent: (chunk) => { if (chunk.type === "message-appended" && JSON.stringify(chunk).includes("pi-hydra")) signals++; },
});
await flue.stop();
await hydra.close();
rmSync(heads, { recursive: true, force: true });
console.log(JSON.stringify({
	route,
	reply: reply.text,
	correct: reply.text.replace(/[,\s.]/g, "").includes("5472661"),
	seconds: Math.round((Date.now() - startedAt) / 100) / 10,
	hydraSignalsSeen: signals,
	records: records.map(({ head, round, outcome, findings, errorKind, error, usage, durationMs }) => ({ head, round, outcome, findings: findings.map((f) => `${f.action}: ${f.message}`), errorKind, error, usage, durationMs })),
}, null, 2));
