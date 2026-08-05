#!/usr/bin/env node
/** Resumable producer for the registered fresh OpenAI protocol studies. */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { uuidv7 } from "@earendil-works/pi-agent-core";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { argOf } from "../lib.mjs";
import { flatUsage, pricesFor, rawCost } from "../costing.mjs";
import { serializeDriverTools } from "../delivery-context-evaluation.mjs";
import { gitProvenance } from "../fingerprints.mjs";
import { resolveModel } from "../model-catalog.mjs";
import {
	OPENAI_PROTOCOL_STUDY_CASES,
	OPENAI_PROTOCOL_STUDY_CASES_HASH,
} from "./openai-protocol-study-cases.mjs";
import {
	OPENAI_PROTOCOL_STUDY_ARM_HASHES,
	OPENAI_PROTOCOL_STUDY_ARMS,
	STUDY_LENS,
	parseStudyResponse,
} from "./openai-protocol-study-variants.mjs";

export const STUDY_CONFIGS = Object.freeze({
	"sol-high": Object.freeze({ provider: "openai-codex", id: "gpt-5.6-sol", reasoning: "high" }),
	"sol-xhigh": Object.freeze({ provider: "openai-codex", id: "gpt-5.6-sol", reasoning: "xhigh" }),
});

export const DEFAULT_STUDY_ARMS = Object.freeze(Object.keys(OPENAI_PROTOCOL_STUDY_ARMS));
export const DEFAULT_STUDY_CONFIGS = Object.freeze(Object.keys(STUDY_CONFIGS));
export const DEFAULT_SAMPLES = 2;
export const SPEND_CEILING_USD = 8;

function textOf(message) {
	return (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
}

function inputText(item) {
	return (item?.content ?? [])
		.filter((block) => block?.type === "input_text")
		.map((block) => block.text)
		.join("");
}

function assistantMessage(text, model) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			reasoning: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function messagesFor(testCase, model) {
	return testCase.messages.map((message) =>
		message.role === "assistant"
			? assistantMessage(message.text, model)
			: { role: "user", content: [{ type: "text", text: message.text }], timestamp: Date.now() },
	);
}

function transformPayload(envelope) {
	return (body) => {
		const input = structuredClone(body.input);
		const index = input.findIndex((item) => item?.role === "user" && inputText(item) === STUDY_LENS);
		if (index === -1) throw new Error("serialized quality lens not found");
		input.splice(index + 1, 0, {
			type: "message",
			role: "developer",
			content: [{ type: "input_text", text: envelope }],
		});
		return {
			...body,
			input,
			tools: serializeDriverTools("openai-codex", "management-only", body.tools),
		};
	};
}

function seededOrder(values, key) {
	const out = [...values];
	let seed = Number.parseInt(createHash("sha256").update(key).digest("hex").slice(0, 8), 16) >>> 0;
	const random = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed / 2 ** 32;
	};
	for (let index = out.length - 1; index > 0; index--) {
		const other = Math.floor(random() * (index + 1));
		[out[index], out[other]] = [out[other], out[index]];
	}
	return out;
}

export function matrixBlocks({ configs = DEFAULT_STUDY_CONFIGS, samples = DEFAULT_SAMPLES } = {}) {
	return configs.flatMap((config) =>
		OPENAI_PROTOCOL_STUDY_CASES.flatMap((testCase) =>
			Array.from({ length: samples }, (_, index) => ({ config, testCase, sample: index + 1 })),
		),
	);
}

export function rowKey({ config, caseId, sample, arm }) {
	return `${config}/${caseId}/${sample}/${arm}`;
}

function buildHeader({ configs, arms, samples, prices }) {
	return {
		kind: "openai-protocol-study-header",
		version: 1,
		date: "2026-08-02",
		...gitProvenance(),
		caseHash: OPENAI_PROTOCOL_STUDY_CASES_HASH,
		caseIds: OPENAI_PROTOCOL_STUDY_CASES.map((item) => item.id),
		configs,
		modelSpecs: Object.fromEntries(configs.map((id) => [id, STUDY_CONFIGS[id]])),
		arms,
		armHashes: Object.fromEntries(arms.map((id) => [id, OPENAI_PROTOCOL_STUDY_ARM_HASHES[id]])),
		samples,
		matrixCalls: OPENAI_PROTOCOL_STUDY_CASES.length * configs.length * arms.length * samples,
		spendCeilingUsd: SPEND_CEILING_USD,
		prices,
	};
}

function comparableHeader(header) {
	const { ts: _ts, ...stable } = header;
	return stable;
}

function readExisting(output) {
	if (!existsSync(output)) return { header: null, completed: new Set(), spend: 0 };
	const lines = readFileSync(output, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const header = lines.find((row) => row.kind === "openai-protocol-study-header") ?? null;
	const rows = lines.filter((row) => row.kind === "openai-protocol-study-row");
	return {
		header,
		completed: new Set(rows.filter((row) => !row.error).map(rowKey)),
		spend: rows.reduce((sum, row) => sum + (row.cost ?? 0), 0),
	};
}

async function runCall({ block, armId, auth, prices }) {
	const spec = STUDY_CONFIGS[block.config];
	const model = resolveModel(spec.provider, spec.id);
	if (!model) throw new Error(`unresolvable model: ${spec.id}`);
	const arm = OPENAI_PROTOCOL_STUDY_ARMS[armId];
	const prompt = { role: "user", content: [{ type: "text", text: STUDY_LENS }], timestamp: Date.now() };
	const sessionId = uuidv7();
	const started = Date.now();
	try {
		const response = await streamSimple(
			model,
			{
				systemPrompt: "You are pi, a coding agent. Review only the visible trajectory under the supplied side-watcher lens.",
				messages: [...messagesFor(block.testCase, model), prompt],
				tools: [],
			},
			{
				apiKey: auth.access,
				reasoning: spec.reasoning,
				sessionId,
				transport: "websocket",
				onPayload: transformPayload(arm.envelope),
			},
		).result();
		const responseText = textOf(response);
		const parsed = parseStudyResponse(armId, responseText);
		const usage = flatUsage(response.usage);
		return {
			kind: "openai-protocol-study-row",
			config: block.config,
			model: spec.id,
			reasoning: spec.reasoning,
			caseId: block.testCase.id,
			family: block.testCase.family,
			sample: block.sample,
			arm: armId,
			caseHash: OPENAI_PROTOCOL_STUDY_CASES_HASH,
			promptHash: OPENAI_PROTOCOL_STUDY_ARM_HASHES[armId],
			responseText,
			findings: parsed.findings,
			findingCount: parsed.findings?.length ?? null,
			findingChars:
				parsed.findings?.reduce((sum, finding) => sum + finding.reason.length + finding.message.length, 0) ?? null,
			capsValid: parsed.capsValid,
			formatValid: parsed.error === null,
			parseError: parsed.error,
			usage,
			cost: rawCost(usage, prices),
			stopReason: response.stopReason ?? null,
			error: response.errorMessage ?? null,
			ms: Date.now() - started,
			ts: Date.now(),
		};
	} finally {
		closeOpenAICodexWebSocketSessions(sessionId);
	}
}

const args = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
	const output = argOf(args, "--output", "");
	const configs = argOf(args, "--configs", DEFAULT_STUDY_CONFIGS.join(",")).split(",").filter(Boolean);
	const arms = argOf(args, "--arms", DEFAULT_STUDY_ARMS.join(",")).split(",").filter(Boolean);
	const samples = Number.parseInt(argOf(args, "--samples", String(DEFAULT_SAMPLES)), 10);
	const dryRun = args.includes("--dry-run");
	if (!dryRun && !output) throw new Error("--output is required");
	if (!Number.isInteger(samples) || samples < 1) throw new Error("--samples must be a positive integer");
	for (const config of configs) if (!STUDY_CONFIGS[config]) throw new Error(`unknown config: ${config}`);
	for (const arm of arms) if (!OPENAI_PROTOCOL_STUDY_ARMS[arm]) throw new Error(`unknown arm: ${arm}`);

	const model = resolveModel(STUDY_CONFIGS[configs[0]].provider, STUDY_CONFIGS[configs[0]].id);
	if (!model) throw new Error("gpt-5.6-sol is not available");
	const prices = pricesFor(model);
	const header = { ...buildHeader({ configs, arms, samples, prices }), ts: Date.now() };
	if (dryRun) {
		process.stdout.write(`${JSON.stringify(header, null, 2)}\n`);
		process.exit(0);
	}

	const authFile = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/auth.json`, "utf8"));
	const auth = authFile["openai-codex"];
	if (!auth?.access || (typeof auth.expires === "number" && auth.expires < Date.now())) {
		throw new Error("missing or expired openai-codex login; run pi and log in first");
	}
	const existing = readExisting(output);
	if (existing.header) {
		if (JSON.stringify(comparableHeader(existing.header)) !== JSON.stringify(comparableHeader(header))) {
			throw new Error(`${output} header does not match the registered matrix`);
		}
	} else if (existsSync(output)) {
		throw new Error(`${output} exists without a study header`);
	} else {
		appendFileSync(output, `${JSON.stringify(header)}\n`);
	}

	let spend = existing.spend;
	let consecutiveErrors = 0;
	for (const block of seededOrder(matrixBlocks({ configs, samples }), "openai-protocol-study-blocks-v1")) {
		for (const armId of seededOrder(arms, `${block.config}/${block.testCase.id}/${block.sample}`)) {
			const key = rowKey({ config: block.config, caseId: block.testCase.id, sample: block.sample, arm: armId });
			if (existing.completed.has(key)) continue;
			if (spend >= SPEND_CEILING_USD) throw new Error(`producer spend ceiling reached at $${spend.toFixed(4)}`);
			let row;
			try {
				row = await runCall({ block, armId, auth, prices });
				consecutiveErrors = row.error ? consecutiveErrors + 1 : 0;
			} catch (error) {
				consecutiveErrors++;
				row = {
					kind: "openai-protocol-study-row",
					config: block.config,
					caseId: block.testCase.id,
					family: block.testCase.family,
					sample: block.sample,
					arm: armId,
					error: error instanceof Error ? error.message : String(error),
					ts: Date.now(),
				};
			}
			appendFileSync(output, `${JSON.stringify(row)}\n`);
			spend += row.cost ?? 0;
			process.stderr.write(
				`${key}: ${row.error ? `ERROR ${row.error}` : `${row.findingCount} findings, ${row.usage.output} out, $${row.cost.toFixed(4)}`}\n`,
			);
			if (consecutiveErrors >= 3) throw new Error("three consecutive provider errors; stopping registered run");
		}
	}
	appendFileSync(output, `${JSON.stringify({ kind: "openai-protocol-study-end", spend, ts: Date.now() })}\n`);
}
