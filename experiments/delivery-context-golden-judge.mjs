#!/usr/bin/env node
/** Blind qualitative judging for delivery-context golden A/B rows. */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { argOf } from "./lib.mjs";
import { GOLDEN_CASES } from "./delivery-context-golden-cases.mjs";
import { DEVELOPMENT_CASES } from "./delivery-context-development-cases.mjs";

const args = process.argv.slice(2);
const inputPath = argOf(args, "--input", "");
const outputPath = argOf(args, "--output", "");
const judgeName = argOf(args, "--judge", "sol");
const batchSize = Number.parseInt(argOf(args, "--batch-size", "6"), 10);
const concurrency = Number.parseInt(argOf(args, "--concurrency", "1"), 10);

if (!inputPath || !outputPath) throw new Error("--input and --output are required");
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 12) {
	throw new Error("--batch-size must be between 1 and 12");
}
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
	throw new Error("--concurrency must be between 1 and 8");
}

const judgeSpecs = {
	sol: { provider: "openai-codex", id: "gpt-5.6-sol", reasoning: "high" },
	opus: { provider: "anthropic", id: "claude-opus-4-8", reasoning: "medium" },
};
const judgeSpec = judgeSpecs[judgeName];
if (!judgeSpec) throw new Error(`unknown judge: ${judgeName}`);
const judge = getModel(judgeSpec.provider, judgeSpec.id);
if (!judge) throw new Error(`judge model unavailable: ${judgeSpec.id}`);

const auth = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/auth.json`, "utf8"));
const credential = auth[judgeSpec.provider];
if (!credential?.access || (typeof credential.expires === "number" && credential.expires < Date.now())) {
	throw new Error(`missing or expired ${judgeSpec.provider} login; run pi and log in first`);
}

const caseById = new Map([...GOLDEN_CASES, ...DEVELOPMENT_CASES].map((item) => [item.id, item]));
const rows = readFileSync(inputPath, "utf8")
	.trim()
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line))
	.filter((row) => row.completionValid === true && !row.error);

function sourceKey(row) {
	return `${row.model}/${row.case}/${row.sample}/${row.arm}`;
}

const completed = new Set();
if (existsSync(outputPath)) {
	for (const line of readFileSync(outputPath, "utf8").trim().split("\n").filter(Boolean)) {
		const row = JSON.parse(line);
		completed.add(`${row.judge}/${row.sourceKey}`);
	}
}

const pendingRows = rows.filter((row) => !completed.has(`${judgeName}/${sourceKey(row)}`));
for (let index = pendingRows.length - 1; index > 0; index--) {
	const other = Math.floor(Math.random() * (index + 1));
	[pendingRows[index], pendingRows[other]] = [pendingRows[other], pendingRows[index]];
}

function renderTrajectory(testCase) {
	return testCase.messages.map((message) => `${message.role.toUpperCase()}: ${message.text}`).join("\n\n");
}

function promptFor(batch) {
	const rendered = batch.map((row, index) => {
		const testCase = caseById.get(row.case);
		if (!testCase) throw new Error(`golden case not found: ${row.case}`);
		const deliveredMessage = row.delivery === "none" ? "" : row.message;
		return `CASE j${String(index + 1).padStart(2, "0")}
Category: ${testCase.category}
Head: ${testCase.head}
Expected delivery: ${testCase.expectedDelivery}
Expected finding class: ${testCase.expectedFinding}
Critical: ${testCase.critical}
Delivery context: ${JSON.stringify(testCase.state)}

VISIBLE TRAJECTORY
${renderTrajectory(testCase)}

ACTUAL DELIVERED OUTCOME
Delivery: ${row.delivery}
Message: ${JSON.stringify(deliveredMessage)}`;
	});

	return `You are a strict blind evaluator of side-observer feedback. The producing model and implementation arm are hidden. Judge the actual delivered outcome, not an unshown model intention.

Use the expected finding as the strongest known target, but accept a different finding only when it is concretely supported, at least as important, and routed correctly. For expected none, related repetition is wrong; an unrelated new critical finding may pass only when directly evidenced. Pending or newly delivered feedback with no response normally should not repeat. Explicit rejection, material change, partial resolution, or an older visible rejected finding can justify a follow-up. Full resolution should not repeat. Queue is genuinely deferrable agent work; steer changes or verifies current work before it continues; print is user-only; interrupt is an active emergency that must abort.

Score each dimension from 0 to 4:
- support: grounded in the visible facts;
- target: catches the expected issue or a justified stronger one;
- context: handles pending, waiting, rejection, change, and resolution correctly;
- route: selects the right delivery urgency/recipient;
- usefulness: concise, specific, and actionable.

Verdict pass requires no material defect; partial has useful substance but one material miss; fail is absent, wrong, redundant, unsupported, or dangerously routed. Set gold_disputed true only when the expected label itself is substantively wrong, not merely because another choice is arguable.

${rendered.join("\n\n---\n\n")}

Return exactly one JSON object and no markdown:
{"cases":[{"id":"j01","finding":"short class or NONE","support":0,"target":0,"context":0,"route":0,"usefulness":0,"verdict":"pass|partial|fail","gold_disputed":false,"reason":"under 160 chars"}]}`;
}

function parseJudgment(text, expectedCount) {
	let value;
	try {
		value = JSON.parse(text.trim());
	} catch {
		return null;
	}
	if (!value || typeof value !== "object" || !Array.isArray(value.cases) || value.cases.length !== expectedCount) {
		return null;
	}
	for (let index = 0; index < value.cases.length; index++) {
		const item = value.cases[index];
		if (item?.id !== `j${String(index + 1).padStart(2, "0")}`) return null;
		if (!["pass", "partial", "fail"].includes(item.verdict)) return null;
		if (typeof item.gold_disputed !== "boolean" || typeof item.reason !== "string" || typeof item.finding !== "string") return null;
		for (const field of ["support", "target", "context", "route", "usefulness"]) {
			if (!Number.isInteger(item[field]) || item[field] < 0 || item[field] > 4) return null;
		}
	}
	return value.cases;
}

function textOf(message) {
	return (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
}

async function judgeBatch(batch) {
	const prompt = promptFor(batch);
	let result = await streamSimple(
		judge,
		{
			systemPrompt: "You are an independent software-review benchmark judge.",
			messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
			tools: [],
		},
		{ apiKey: credential.access, reasoning: judgeSpec.reasoning, maxTokens: 2500 },
	).result();
	let judgments = parseJudgment(textOf(result), batch.length);
	let recovered = false;
	if (!judgments && !result.errorMessage) {
		recovered = true;
		const correction = "Your output did not match the required JSON schema or case count. Preserve every judgment and return only the corrected JSON object.";
		result = await streamSimple(
			judge,
			{
				systemPrompt: "You are an independent software-review benchmark judge.",
				messages: [
					{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
					result,
					{ role: "user", content: [{ type: "text", text: correction }], timestamp: Date.now() },
				],
				tools: [],
			},
			{ apiKey: credential.access, reasoning: judgeSpec.reasoning, maxTokens: 2500 },
		).result();
		judgments = parseJudgment(textOf(result), batch.length);
	}
	if (!judgments) {
		throw new Error(`judge returned invalid output for ${batch.map(sourceKey).join(", ")}: ${textOf(result).slice(0, 500)}`);
	}

	for (let index = 0; index < batch.length; index++) {
		const source = batch[index];
		const judgment = judgments[index];
		const total = judgment.support + judgment.target + judgment.context + judgment.route + judgment.usefulness;
		const row = {
			judge: judgeName,
			judgeModel: judge.id,
			judgeThinking: judgeSpec.reasoning,
			sourceKey: sourceKey(source),
			case: source.case,
			model: source.model,
			sample: source.sample,
			arm: source.arm,
			recovered,
			...judgment,
			total,
		};
		appendFileSync(outputPath, `${JSON.stringify(row)}\n`);
		console.log(`${row.sourceKey}: ${row.verdict} ${row.total}/20${row.gold_disputed ? " DISPUTED" : ""}`);
	}
}

const batches = [];
for (let offset = 0; offset < pendingRows.length; offset += batchSize) {
	batches.push(pendingRows.slice(offset, offset + batchSize));
}
console.error(
	`${pendingRows.length} rows to judge with ${judgeName} in batches of ${batchSize}, concurrency ${concurrency}`,
);
let nextBatch = 0;
async function worker() {
	while (nextBatch < batches.length) {
		const index = nextBatch++;
		await judgeBatch(batches[index]);
	}
}
await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()));
