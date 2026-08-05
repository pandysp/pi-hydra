#!/usr/bin/env node
/** Blind, dual-provider semantic judging for handoff-quality-ab JSONL. */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { streamSimple, getModel } from "@earendil-works/pi-ai/compat";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { uuidv7 } from "@earendil-works/pi-agent-core";
import { argOf } from "../lib.mjs";

const args = process.argv.slice(2);
const input = argOf(args, "--input", "");
const output = argOf(args, "--output", "");
const treatmentInput = argOf(args, "--treatment-input", "");
const reasoning = argOf(args, "--thinking", "medium");
const requestedJudges = argOf(args, "--judges", "anthropic-judge,openai-judge").split(",");
const comparedArms = argOf(args, "--arms", "current,split").split(",").filter(Boolean);
const onlyPairs = new Set(argOf(args, "--only-pairs", "").split(",").filter(Boolean));
const batchSize = Number.parseInt(argOf(args, "--batch-size", "15"), 10);
if (!input || !output) throw new Error("--input and --output are required");
if (comparedArms.length !== 2) throw new Error("--arms requires exactly two comma-separated arms");

const inputRows = input.split(",").flatMap((file) => readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse));
const rows = treatmentInput
	? [
		...inputRows.filter((row) => row.arm === "current"),
		...treatmentInput.split(",").flatMap((file) => readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)),
	]
	: inputRows;
const auth = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/auth.json`, "utf8"));
const judges = [
	{ name: "anthropic-judge", provider: "anthropic", id: "claude-opus-4-8" },
	{ name: "openai-judge", provider: "openai-codex", id: "gpt-5.6-terra" },
	{ name: "openai-sol-judge", provider: "openai-codex", id: "gpt-5.6-sol" },
	{ name: "openai-sol-high-judge", provider: "openai-codex", id: "gpt-5.6-sol" },
];
if (requestedJudges.some((name) => !judges.some((judge) => judge.name === name))) {
	throw new Error(`unknown --judges value: ${requestedJudges.join(",")}`);
}
const activeJudges = judges.filter((judge) => requestedJudges.includes(judge.name));
const completed = new Set();
if (existsSync(output)) {
	for (const line of readFileSync(output, "utf8").trim().split("\n").filter(Boolean)) {
		const row = JSON.parse(line);
		if (Number.isInteger(row.batch)) completed.add(`${row.judge}/${row.candidateModel}/${row.batch}`);
	}
}

function parseJson(text) {
	const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
	try { return JSON.parse(cleaned); } catch {}
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	if (start !== -1 && end > start) {
		try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
	}
	return null;
}

function pairedFor(candidateModel) {
	const selected = rows.filter((row) => row.model === candidateModel);
	const groups = new Map();
	for (const row of selected) {
		const key = `${row.thinking}/${row.checkpoint}/${row.head}/${row.sample}`;
		const group = groups.get(key) ?? [];
		group.push(row);
		groups.set(key, group);
	}
	const pairs = [];
	for (const [key, group] of groups) {
		const first = group.find((row) => row.arm === comparedArms[0]);
		const second = group.find((row) => row.arm === comparedArms[1]);
		if (!first || !second) continue;
		const [thinking, checkpoint, head, sample] = key.split("/");
		const firstIsA = Math.random() < 0.5;
		pairs.push({
			id: `p${String(pairs.length + 1).padStart(2, "0")}`,
			thinking,
			checkpoint,
			head,
			sample: Number(sample),
			a: firstIsA ? first.response : second.response,
			b: firstIsA ? second.response : first.response,
			map: {
				A: firstIsA ? comparedArms[0] : comparedArms[1],
				B: firstIsA ? comparedArms[1] : comparedArms[0],
			},
		});
	}
	return pairs;
}

const rubric = `Ground truth:
- defects-visible/security: steer about missing GitHub webhook signature or authenticity verification before accepting, appending, or invoking the hook.
- defects-visible/quality: steer about onAccepted failures being swallowed by .catch(() => {}), with an observable failure path that need not delay HTTP 202.
- security-reported/security: noop; a tagged security finding already appeared after the latest ordinary user task.
- security-reported/quality: steer about the still-unreported swallowed onAccepted failure.
- both-reported/security and both-reported/quality: noop; each finding has already reached the driver.

Two response wrappers are valid and semantically equivalent:
- {"action":"complete_observation","delivery":"none|print|queue|steer|interrupt","message":"..."}
- {"action":"noop|print|queue|steer|interrupt","reason":"...","message":"..."}
- {"delivery":"none|print|queue|steer|interrupt","message":"..."}
- NO_FEEDBACK
- DELIVERY: none
- <message followed by a final line> DELIVERY: print|queue|steer|interrupt
Normalize all before scoring. The optional action wrapper carries no review
content and must receive neither credit nor penalty. Delivery "none" means
noop; its empty message is correct.

Score each anonymized response on accuracy, specificity, usefulness, and restraint from 0 to 4. For an expected noop, an exact noop is fully useful and specific; do not reward invented detail. Penalize invalid protocol, wrong action, duplicates, unrelated findings, and overreach. Pick A, B, or tie based on the overall review quality, not prose style.`;

function promptFor(pairs) {
	const cases = pairs.map((pair) => `\n${pair.id} | thinking=${pair.thinking} | checkpoint=${pair.checkpoint} | head=${pair.head}\nA: ${pair.a}\nB: ${pair.b}`).join("\n");
	return `${rubric}\n\nEvaluate every pair below. The producing approach and model identity are hidden.\n${cases}\n\nReturn JSON only:\n{"pairs":[{"id":"p01","winner":"A|B|tie","a":{"accuracy":0,"specificity":0,"usefulness":0,"restraint":0},"b":{"accuracy":0,"specificity":0,"usefulness":0,"restraint":0},"reason":"<=120 chars"}]}`;
}

async function judgeOne(judge, candidateModel, pairs, batch) {
	const model = getModel(judge.provider, judge.id);
	if (!model) throw new Error(`unknown judge model ${judge.provider}/${judge.id}`);
	const credential = auth[judge.provider];
	if (!credential?.access || (credential.expires && credential.expires < Date.now())) throw new Error(`missing or expired ${judge.provider} login`);
	const sessionId = judge.provider === "openai-codex" ? uuidv7() : undefined;
	const started = performance.now();
	try {
		const result = await streamSimple(
			model,
			{
				systemPrompt: "You are a meticulous blinded software-review evaluator. Follow the supplied ground truth and emit only the requested JSON.",
				messages: [{ role: "user", content: [{ type: "text", text: promptFor(pairs) }], timestamp: Date.now() }],
				tools: [],
			},
			{
				apiKey: credential.access,
				maxTokens: 12000,
				reasoning,
				sessionId,
				transport: judge.provider === "openai-codex" ? "websocket" : undefined,
			},
		).result();
		const response = result.content.filter((block) => block.type === "text").map((block) => block.text).join("");
		return {
			judge: judge.name,
			judgeModel: judge.id,
			candidateModel,
			batch,
			ms: Math.round(performance.now() - started),
			stop: result.stopReason,
			error: result.errorMessage ?? null,
			usage: result.usage,
			blindMap: Object.fromEntries(pairs.map((pair) => [pair.id, pair.map])),
			parsed: parseJson(response),
			response,
		};
	} finally {
		if (sessionId) closeOpenAICodexWebSocketSessions(sessionId);
	}
}

for (const candidateModel of [...new Set(rows.map((row) => row.model))]) {
	const pairs = pairedFor(candidateModel).filter((pair) => onlyPairs.size === 0 || onlyPairs.has(pair.id));
	for (const judge of activeJudges) {
		for (let offset = 0, batch = 1; offset < pairs.length; offset += batchSize, batch++) {
			if (completed.has(`${judge.name}/${candidateModel}/${batch}`)) continue;
			const selected = pairs.slice(offset, offset + batchSize);
			const result = await judgeOne(judge, candidateModel, selected, batch);
			appendFileSync(output, `${JSON.stringify(result)}\n`);
			console.log(`${judge.name}/${candidateModel}/${batch}: ${result.parsed?.pairs?.length ?? 0}/${selected.length} judgments, ${result.ms}ms`);
		}
	}
}
