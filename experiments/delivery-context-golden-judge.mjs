#!/usr/bin/env node
/** Narrow blind judging for delivery-context golden A/B/C rows. */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { argOf } from "./lib.mjs";
import { GOLDEN_CASES } from "./delivery-context-golden-cases.mjs";
import { DEVELOPMENT_CASES } from "./delivery-context-development-cases.mjs";
import { SCREEN_CASES } from "./delivery-context-screen-cases.mjs";
import { assertJudgeMetric, buildJudgePrompt, parseJudgments } from "./delivery-context-judge-protocol.mjs";

const args = process.argv.slice(2);
const inputPath = argOf(args, "--input", "");
const outputPath = argOf(args, "--output", "");
const judgeName = argOf(args, "--judge", "sol");
const metric = argOf(args, "--metric", "support");
const batchSize = Number.parseInt(argOf(args, "--batch-size", "8"), 10);
const concurrency = Number.parseInt(argOf(args, "--concurrency", "1"), 10);
const cliTimeoutMs = Number.parseInt(argOf(args, "--cli-timeout-ms", "300000"), 10);

if (!inputPath || !outputPath) throw new Error("--input and --output are required");
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 12) {
	throw new Error("--batch-size must be between 1 and 12");
}
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
	throw new Error("--concurrency must be between 1 and 8");
}
if (!Number.isInteger(cliTimeoutMs) || cliTimeoutMs < 10_000) {
	throw new Error("--cli-timeout-ms must be at least 10000");
}

assertJudgeMetric(metric);

const SYSTEM_PROMPT = "You are an independent software-review benchmark judge.";
const CORRECTION =
	"Your output did not match the required JSON schema or case count. Preserve every judgment and return only the corrected JSON object.";

// Opus runs through the Claude Code subscription, not the Anthropic key: the
// `claude -p` recipe below is the calibrated one, and closing stdin explicitly
// avoids the three-second stdin wait the CLI otherwise spends per invocation.
const judgeSpecs = {
	sol: { transport: "pi", provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "high" },
	opus: { transport: "claude-cli", model: "opus", reasoning: "high" },
};
const judgeSpec = judgeSpecs[judgeName];
if (!judgeSpec) throw new Error(`unknown judge: ${judgeName}`);

function textOf(message) {
	return (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
}

/**
 * Both transports answer `ask(prompt, prior)`, where `prior` is the failed first
 * attempt of the one format-only recovery turn. Pi keeps the real second turn it
 * has always used; the CLI has no conversation to continue, so the correction
 * carries the invalid text inline.
 */
async function piTransport(spec) {
	const [{ streamSimple }, { resolveModel }] = await Promise.all([
		import("@earendil-works/pi-ai/compat"),
		import("./model-catalog.mjs"),
	]);
	const model = resolveModel(spec.provider, spec.model);
	if (!model) throw new Error(`judge model unavailable: ${spec.model}`);
	const auth = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/auth.json`, "utf8"));
	const credential = auth[spec.provider];
	if (!credential?.access || (typeof credential.expires === "number" && credential.expires < Date.now())) {
		throw new Error(`missing or expired ${spec.provider} login; run pi and log in first`);
	}
	const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
	return {
		model: model.id,
		async ask(prompt, prior) {
			const messages = prior ? [user(prompt), prior.raw, user(CORRECTION)] : [user(prompt)];
			const result = await streamSimple(
				model,
				{ systemPrompt: SYSTEM_PROMPT, messages, tools: [] },
				{ apiKey: credential.access, reasoning: spec.reasoning, maxTokens: 2500 },
			).result();
			return { text: textOf(result), error: result.errorMessage ?? null, raw: result };
		},
	};
}

function claudeCliTransport(spec) {
	return {
		model: spec.model,
		async ask(prompt, prior) {
			const text = prior ? `${prompt}\n\nYour prior response was structurally invalid:\n${prior.text}\n\n${CORRECTION}` : prompt;
			return new Promise((resolve) => {
				const child = spawn("claude", [
					"-p",
					"--safe-mode",
					"--no-session-persistence",
					"--disable-slash-commands",
					"--tools",
					"",
					"--model",
					spec.model,
					"--effort",
					spec.reasoning,
					"--system-prompt",
					SYSTEM_PROMPT,
					text,
				]);
				let stdout = "";
				let stderr = "";
				const timer = setTimeout(() => child.kill("SIGKILL"), cliTimeoutMs);
				const settle = (error) => {
					clearTimeout(timer);
					resolve({ text: stdout, error, raw: stdout });
				};
				child.stdout.on("data", (chunk) => { stdout += chunk; });
				child.stderr.on("data", (chunk) => { stderr += chunk; });
				child.on("error", (error) => settle(error.message));
				child.on("close", (code, signal) => {
					if (signal === "SIGKILL") return settle(`claude killed after ${cliTimeoutMs}ms`);
					settle(code === 0 ? null : stderr.trim() || `claude exited ${code}`);
				});
				child.stdin.end();
			});
		},
	};
}

// The Claude CLI judge needs neither pi-ai nor a stored provider credential, so
// the Pi transport and its login check load only when that judge is selected.
const transport = judgeSpec.transport === "pi" ? await piTransport(judgeSpec) : claudeCliTransport(judgeSpec);

const caseById = new Map([...GOLDEN_CASES, ...DEVELOPMENT_CASES, ...SCREEN_CASES].map((item) => [item.id, item]));
const rows = readFileSync(inputPath, "utf8")
	.trim()
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line))
	.filter((row) => row.completionValid === true && !row.error);

function sourceKey(row) {
	return `${row.model}/${row.case}/${row.sample}/${row.arm}`;
}

function eligible(row) {
	const testCase = caseById.get(row.case);
	if (!testCase || row.delivery === "none" || !row.message?.trim()) return false;
	return metric === "repeat" ? testCase.expectedDelivery === "none" : testCase.expectedDelivery !== "none";
}

const completed = new Set();
if (existsSync(outputPath)) {
	for (const line of readFileSync(outputPath, "utf8").trim().split("\n").filter(Boolean)) {
		const row = JSON.parse(line);
		completed.add(`${row.judge}/${row.metric}/${row.sourceKey}`);
	}
}

const unknownCases = [...new Set(rows.filter((row) => !caseById.has(row.case)).map((row) => row.case))];
if (unknownCases.length > 0) {
	throw new Error(`input rows reference cases this judge cannot load: ${unknownCases.join(", ")}`);
}

const pendingRows = rows.filter(
	(row) => eligible(row) && !completed.has(`${judgeName}/${metric}/${sourceKey(row)}`),
);
for (let index = pendingRows.length - 1; index > 0; index--) {
	const other = Math.floor(Math.random() * (index + 1));
	[pendingRows[index], pendingRows[other]] = [pendingRows[other], pendingRows[index]];
}

function promptFor(batch) {
	return buildJudgePrompt(
		metric,
		batch.map((row) => {
		const testCase = caseById.get(row.case);
		if (!testCase) throw new Error(`golden case not found: ${row.case}`);
		return { testCase, message: row.message };
		}),
	);
}

function verdictOf(judgment) {
	return metric === "support"
		? `central=${judgment.centralSupported ? "TRUE" : "FALSE"} extra=${judgment.unsupportedExtra ? "TRUE" : "FALSE"}`
		: `${metric}=${judgment.answer ? "TRUE" : "FALSE"}`;
}

async function judgeBatch(batch) {
	const prompt = promptFor(batch);
	const started = Date.now();
	let response = await transport.ask(prompt);
	let judgments = parseJudgments(metric, response.text, batch.length);
	let recovered = false;
	if (!judgments && !response.error) {
		recovered = true;
		response = await transport.ask(prompt, response);
		judgments = parseJudgments(metric, response.text, batch.length);
	}
	const batchMs = Date.now() - started;
	if (!judgments) {
		throw new Error(
			`judge returned invalid output for ${batch.map(sourceKey).join(", ")}: ${response.error ?? response.text.slice(0, 500)}`,
		);
	}

	for (let index = 0; index < batch.length; index++) {
		const source = batch[index];
		const judgment = judgments[index];
		const row = {
			judge: judgeName,
			judgeModel: transport.model,
			judgeTransport: judgeSpec.transport,
			judgeThinking: judgeSpec.reasoning,
			metric,
			sourceKey: sourceKey(source),
			case: source.case,
			model: source.model,
			sample: source.sample,
			arm: source.arm,
			recovered,
			batchSize: batch.length,
			batchMs,
			...judgment,
		};
		appendFileSync(outputPath, `${JSON.stringify(row)}\n`);
		console.log(`${row.sourceKey}: ${verdictOf(judgment)}`);
	}
	console.error(`batch of ${batch.length} judged in ${batchMs}ms${recovered ? " (recovered)" : ""}`);
}

function recordBatchFailure(batch, error) {
	const failure = {
		timestamp: new Date().toISOString(),
		judge: judgeName,
		judgeModel: transport.model,
		judgeTransport: judgeSpec.transport,
		judgeThinking: judgeSpec.reasoning,
		metric,
		sourceKeys: batch.map(sourceKey),
		error: error instanceof Error ? error.message : String(error),
	};
	appendFileSync(`${outputPath}.failures.jsonl`, `${JSON.stringify(failure)}\n`);
}

// TODO: Add a separate unwarranted-noise judgment only if finding quality and
// improper-repeat metrics fail to expose economically meaningful noisy sends.

const batches = [];
for (let offset = 0; offset < pendingRows.length; offset += batchSize) {
	batches.push(pendingRows.slice(offset, offset + batchSize));
}
console.error(
	`${pendingRows.length} ${metric} rows to judge with ${judgeName} (${judgeSpec.transport}) in batches of ${batchSize}, concurrency ${concurrency}`,
);
let nextBatch = 0;
async function worker() {
	while (nextBatch < batches.length) {
		const index = nextBatch++;
		try {
			await judgeBatch(batches[index]);
		} catch (error) {
			recordBatchFailure(batches[index], error);
			throw error;
		}
	}
}
await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()));
