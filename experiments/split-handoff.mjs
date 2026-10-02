// Split vs combined head handoff on GPT-6 models, both OpenAI routes, three efforts.
//   node experiments/split-handoff.mjs [wrongPerCell=3] [controlPerCell=1]
// Each call: a driver transcript (multiply tool -> final answer) plus a head review, built with
// pi-hydra's own handoff functions. "wrong": the tool and answer say 5472671 (should be caught).
// "control": they say 5472661, the correct product (any steer is a false alarm).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
	buildEnumeratedJudgeObservationEnvelope,
	buildEnumeratedJudgeObservationPrompt,
	headInstructions,
	mergeOpenAIObservationPayload,
} from "../utils.ts";
import { DeliveryLedger } from "../delivery.ts";
import { classifyJudgeResponse } from "../judge.ts";

//   node experiments/split-handoff.mjs retry   reruns only the calls that ended in an error, then prints the summary
//   node experiments/split-handoff.mjs cell <route> <model> <effort> <form> <n>   runs one cell with wrong answers and prints the raw replies
const RETRY = process.argv[2] === "retry";
const CELL = process.argv[2] === "cell" ? process.argv.slice(3) : null;
const WRONG = Number(process.argv[2] ?? 3), CONTROL = Number(process.argv[3] ?? 1);
const auth = JSON.parse(readFileSync(join(homedir(), ".pi/agent/auth.json"), "utf8"));
const routes = {};
for (const [name, factory, key] of [["codex", openaiCodexProvider, "openai-codex"], ["chatgpt", openaiProvider, "openai"]]) {
	const base = factory();
	const resolved = await base.auth.oauth.toAuth(auth[key]);
	routes[name] = { ...base, auth: { apiKey: { name: `matrix ${name}`, resolve: async () => ({ auth: resolved }) } } };
}
const catalog = createModels();
for (const provider of Object.values(routes)) catalog.setProvider(provider);
const modelFor = (route, id) => {
	const model = catalog.getModel(routes[route].id, id);
	if (!model) throw new Error(`${routes[route].id}/${id} is not in pi-ai's catalog`);
	return model;
};

const HEAD = "arithmetic";
const PROMPT = "Check every product the assistant states in its answer by doing the multiplication yourself. If a stated product is wrong, steer with the correct value and say which source was wrong. Report nothing when every product is right.";
const multiply = { name: "multiply", description: "Multiply two integers exactly.", parameters: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } }, required: ["a", "b"] } };
const transcript = (product) => [
	{ role: "user", content: "What is 1847 × 2963?", timestamp: 1 },
	{ role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "multiply", arguments: { a: 1847, b: 2963 } }], api: "openai-responses", provider: "openai", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
	{ role: "toolResult", toolCallId: "call_1", toolName: "multiply", content: [{ type: "text", text: String(product) }], isError: false, timestamp: 3 },
	{ role: "assistant", content: [{ type: "text", text: `1847 × 2963 = ${product}` }], api: "openai-responses", provider: "openai", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 4 },
];
const system = "Use the multiply tool for every multiplication and report exactly the number it returns.";

// combined: one user message with the head prompt and Hydra's rules (what the ChatGPT route sends);
// split: the head's instructions as a user message, Hydra's rules as a developer message right after it (Codex).
async function review(route, model, effort, form, product) {
	const delivery = new DeliveryLedger().contextFor(HEAD); // a first check: nothing delivered yet
	const prompt = form === "combined" ? buildEnumeratedJudgeObservationPrompt(HEAD, PROMPT, delivery) : headInstructions(PROMPT);
	const envelope = form === "split" ? buildEnumeratedJudgeObservationEnvelope(HEAD, delivery) : undefined;
	const context = { systemPrompt: system, messages: [...transcript(product), { role: "user", content: [{ type: "text", text: prompt }], timestamp: 5 }], tools: [multiply] };
	// As in a real check: the driver's recorded request, then pi-hydra's merge of the head's tail
	// (the driver's final answer and the head's message) with the envelope, if any.
	const onPayload = (params) => {
		const finalAnswer = params.input.findLastIndex((item) => item.role === "assistant" || item.type === "message");
		const captured = { ...params, input: params.input.slice(0, finalAnswer) };
		return mergeOpenAIObservationPayload(captured, params.input.slice(finalAnswer), envelope);
	};
	const r = await catalog.streamSimple(model, context, { reasoning: effort, onPayload }).result();
	if (r.stopReason === "error") return { error: (r.errorMessage ?? "").slice(0, 100) };
	// Scored as Hydra scores a judge head (classifyJudgeResponse); a catch must also name the correct product.
	const judged = classifyJudgeResponse(r);
	const reply = { stopReason: r.stopReason, content: r.content.filter((c) => c.type !== "thinking") };
	if (judged.errorKind) return { invalid: judged.errorKind, reply };
	const steers = judged.decisions.filter((d) => d.action === "steer" || d.action === "interrupt");
	const namesCorrect = steers.some((d) => d.message.replace(/[^0-9]/g, "").includes("5472661"));
	return { steer: steers.length > 0, correctProduct: namesCorrect, reply };
}

const MODELS = ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol"]; // gpt-6-terra: "not supported when using Codex with a ChatGPT account"
// Every call, with the full reply. split-handoff-2026-10-02.jsonl holds the run behind docs/providers.md.
const log = process.env.SPLIT_HANDOFF_LOG ?? join(import.meta.dirname, `split-handoff-${new Date().toISOString().slice(0, 10)}.jsonl`);
const previous = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const jobs = [];
if (CELL) {
	const [route, id, effort, form, n] = CELL;
	for (let i = 0; i < Number(n); i++) {
		const r = await review(route, modelFor(route, id), effort, form, 5472671).catch((e) => ({ error: String(e.message ?? e) }));
		appendFileSync(log, JSON.stringify({ route, id, effort, form, product: 5472671, cellRun: true, ...r }) + "\n");
		console.log(r.correctProduct ? "CAUGHT" : r.invalid ? `INVALID ${r.invalid}` : r.error ? "ERROR" : r.steer ? "STEER (wrong value)" : "MISSED");
	}
	process.exit(0);
}
if (RETRY) {
	for (const { route, id, effort, form, product } of previous.filter((r) => r.error)) jobs.push({ route, id, effort, form, product });
	writeFileSync(log, previous.filter((r) => !r.error).map((r) => JSON.stringify(r) + "\n").join(""));
} else for (const route of ["codex", "chatgpt"]) for (const id of MODELS) for (const effort of ["low", "medium", "high"]) for (const form of ["split", "combined"]) {
	for (let i = 0; i < WRONG; i++) jobs.push({ route, id, effort, form, product: 5472671 });
	for (let i = 0; i < CONTROL; i++) jobs.push({ route, id, effort, form, product: 5472661 });
}
let next = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
	while (next < jobs.length) {
		const job = jobs[next++];
		const result = await review(job.route, modelFor(job.route, job.id), job.effort, job.form, job.product).catch((e) => ({ error: String(e.message ?? e).slice(0, 100) }));
		appendFileSync(log, JSON.stringify({ ...job, ...result }) + "\n");
	}
}));
// Summary over every call in the log: invalid answers (no findings JSON, e.g. the head called the agent's tool) count as failures.
const rows = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse).filter((x) => !x.cellRun);
const pct = (k, n) => `${k}/${n}`.padEnd(7);
console.log("route   model        effort  | split: caught alarms invalid | combined: caught alarms invalid");
for (const route of ["codex", "chatgpt"]) for (const id of MODELS) for (const effort of ["low", "medium", "high"]) {
	const cell = (form) => {
		const r = rows.filter((x) => x.route === route && x.id === id && x.effort === effort && x.form === form && !x.error);
		const wrong = r.filter((x) => x.product === 5472671), control = r.filter((x) => x.product !== 5472671);
		return `${pct(wrong.filter((x) => x.correctProduct).length, wrong.length)} ${pct(control.filter((x) => x.steer).length, control.length)} ${r.filter((x) => x.invalid).length}`;
	};
	console.log(`${route.padEnd(8)}${id.padEnd(13)}${effort.padEnd(8)}| ${cell("split").padEnd(26)}| ${cell("combined")}`);
}
const left = rows.filter((x) => x.error);
if (left.length) console.log(`still failing with errors: ${left.length} (${left[0].error})`);
