#!/usr/bin/env node
/**
 * Paired qualitative A/B of the current combined-user observation prompt and
 * the split provider-elevated handoff on immutable real-session snapshots.
 *
 * Each current/split pair runs adjacently in randomized order. Output is
 * resumable JSONL: a completed model/checkpoint/head/sample/arm key is never
 * paid twice.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { streamSimple, getModel } from "@earendil-works/pi-ai/compat";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { uuidv7 } from "@earendil-works/pi-agent-core";
import { buildObservationEnvelope, buildObservationPrompt, parseDecision } from "../../utils.ts";
import { buildGeneralObservationEnvelope, buildPolicyOwnedObservationEnvelope } from "./envelope-variants.mjs";
import { argOf } from "../lib.mjs";

const args = process.argv.slice(2);
const sessionPath = argOf(args, "--session", "");
const headsDir = argOf(args, "--heads-dir", "");
const outputPath = argOf(args, "--output", "");
const samples = Number.parseInt(argOf(args, "--samples", "5"), 10);
const reasoning = argOf(args, "--thinking", "low");
const requestedModels = argOf(args, "--models", "sonnet,opus,fable,luna,terra,sol").split(",");
const requestedArms = argOf(args, "--arms", "current,split").split(",");

if (!sessionPath || !headsDir || !outputPath) {
	console.error("--session, --heads-dir, and --output are required");
	process.exit(1);
}
if (!Number.isInteger(samples) || samples < 1) throw new Error("--samples must be a positive integer");

const modelSpecs = {
	sonnet: { provider: "anthropic", id: "claude-sonnet-5" },
	opus: { provider: "anthropic", id: "claude-opus-4-8" },
	fable: { provider: "anthropic", id: "claude-fable-5" },
	luna: { provider: "openai-codex", id: "gpt-5.6-luna" },
	terra: { provider: "openai-codex", id: "gpt-5.6-terra" },
	sol: { provider: "openai-codex", id: "gpt-5.6-sol" },
};
for (const name of requestedModels) {
	if (!(name in modelSpecs)) throw new Error(`unknown model ${name}`);
}
if (requestedArms.some((arm) => !["current", "split", "split-before", "general", "policy"].includes(arm))) {
	throw new Error(`unknown --arms value: ${requestedArms.join(",")}`);
}

const checkpoints = [
	{ id: "defects-visible", through: "6192600d", expected: { security: "steer", quality: "steer" } },
	{ id: "security-reported", through: "6b131390", expected: { security: "noop", quality: "steer" } },
	{ id: "both-reported", through: "af62d194", expected: { security: "noop", quality: "noop" } },
];
const headNames = ["security", "quality"];

const auth = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/auth.json`, "utf8"));
for (const provider of new Set(requestedModels.map((name) => modelSpecs[name].provider))) {
	const credential = auth[provider];
	if (!credential?.access || (typeof credential.expires === "number" && credential.expires < Date.now())) {
		throw new Error(`missing or expired ${provider} login; run pi and log in first`);
	}
}

function messagesThrough(throughId) {
	const messages = [];
	let found = false;
	for (const line of readFileSync(sessionPath, "utf8").trim().split("\n")) {
		const entry = JSON.parse(line);
		if (entry.type === "message") messages.push(entry.message);
		if (entry.id === throughId) {
			found = true;
			break;
		}
	}
	if (!found) throw new Error(`entry ${throughId} not found in ${sessionPath}`);
	return messages;
}

function head(name) {
	const raw = readFileSync(join(headsDir, `${name}.md`), "utf8");
	const match = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]+)$/);
	if (!match) throw new Error(`cannot parse ${name}.md`);
	return match[1].trim();
}

const snapshots = Object.fromEntries(checkpoints.map((checkpoint) => [checkpoint.id, messagesThrough(checkpoint.through)]));
const heads = Object.fromEntries(headNames.map((name) => [name, head(name)]));
const completed = new Set();
if (existsSync(outputPath)) {
	for (const line of readFileSync(outputPath, "utf8").trim().split("\n").filter(Boolean)) {
		const row = JSON.parse(line);
		completed.add(`${row.model}/${row.checkpoint}/${row.head}/${row.sample}/${row.arm}`);
	}
}

function textOf(result) {
	return result.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

async function runOne(modelName, checkpoint, headName, sample, arm) {
	const spec = modelSpecs[modelName];
	const model = getModel(spec.provider, spec.id);
	if (!model) throw new Error(`unknown ${spec.provider} model ${spec.id}`);
	const rawLens = heads[headName];
	const promptText = arm === "current" ? buildObservationPrompt(headName, rawLens, []) : rawLens;
	const prompt = { role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() };
	const sessionId = spec.provider === "openai-codex" ? uuidv7() : undefined;
	const started = performance.now();
	let payloadRoles = [];
	let status = null;
	try {
		const result = await streamSimple(
			model,
			{ systemPrompt: "You are pi, a coding agent.", messages: [...snapshots[checkpoint.id], prompt], tools: [] },
			{
				apiKey: auth[spec.provider].access,
				maxTokens: 500,
				reasoning,
				sessionId,
				transport: spec.provider === "openai-codex" ? "websocket" : undefined,
				onResponse: (response) => { status = response.status; },
				onPayload: (body) => {
					if (arm === "current") {
						const items = spec.provider === "anthropic" ? body.messages : body.input;
						payloadRoles = items.slice(-4).map((item) => item.role ?? item.type ?? "?");
						return body;
					}
					const baseEnvelope = arm === "general"
						? buildGeneralObservationEnvelope(headName, [])
						: arm === "policy"
							? buildPolicyOwnedObservationEnvelope(headName, [])
							: buildObservationEnvelope(headName, []);
					const envelope = baseEnvelope.replace(
						"preceding user message",
						arm === "split-before" ? "following user message" : "preceding user message",
					);
					if (spec.provider === "anthropic") {
						const messages = structuredClone(body.messages);
						if (messages.at(-1)?.role !== "user") throw new Error("serialized lens is not the final user message");
						const system = { role: "system", content: [{ type: "text", text: envelope }] };
						if (arm === "split-before") messages.splice(messages.length - 1, 0, system);
						else messages.push(system);
						payloadRoles = messages.slice(-4).map((message) => message.role);
						return { ...body, messages };
					}
					const input = structuredClone(body.input);
					if (input.at(-1)?.role !== "user") throw new Error("serialized lens is not the final user item");
					const developer = { role: "developer", content: [{ type: "input_text", text: envelope }] };
					if (arm === "split-before") input.splice(input.length - 1, 0, developer);
					else input.push(developer);
					payloadRoles = input.slice(-4).map((item) => item.role ?? item.type ?? "?");
					return { ...body, input };
				},
			},
		).result();
		const response = textOf(result);
		const decision = parseDecision(response);
		return {
			model: modelName,
			modelId: spec.id,
			provider: spec.provider,
			checkpoint: checkpoint.id,
			head: headName,
			sample,
			arm,
			expectedAction: checkpoint.expected[headName],
			ms: Math.round(performance.now() - started),
			status,
			roles: payloadRoles.join(","),
			stop: result.stopReason,
			error: result.errorMessage ?? null,
			usage: result.usage,
			parseValid: decision !== null,
			action: decision?.action ?? null,
			actionCorrect: decision?.action === checkpoint.expected[headName],
			response,
		};
	} finally {
		if (sessionId) closeOpenAICodexWebSocketSessions(sessionId);
	}
}

const tasks = [];
for (const modelName of requestedModels) {
	for (const checkpoint of checkpoints) {
		for (const headName of headNames) {
			for (let sample = 1; sample <= samples; sample++) tasks.push({ modelName, checkpoint, headName, sample });
		}
	}
}
// Shuffle pairs, never individual arms: paired timing stays intact while
// checkpoint/model order cannot create a systematic arm advantage.
for (let i = tasks.length - 1; i > 0; i--) {
	const j = Math.floor(Math.random() * (i + 1));
	[tasks[i], tasks[j]] = [tasks[j], tasks[i]];
}

console.error(`qualitative sweep: ${tasks.length} cases / ${tasks.length * requestedArms.length} calls; ${completed.size} calls already complete`);
for (const task of tasks) {
	const arms = [...requestedArms].sort(() => Math.random() - 0.5);
	const missing = arms.filter((arm) => !completed.has(`${task.modelName}/${task.checkpoint.id}/${task.headName}/${task.sample}/${arm}`));
	if (missing.length === 0) continue;
	for (const arm of missing) {
		try {
			const row = await runOne(task.modelName, task.checkpoint, task.headName, task.sample, arm);
			appendFileSync(outputPath, `${JSON.stringify(row)}\n`);
			console.log(`${row.model}/${row.checkpoint}/${row.head}/${row.sample}/${row.arm}: ${row.action ?? "INVALID"} ${row.ms}ms`);
		} catch (error) {
			console.error(`${task.modelName}/${task.checkpoint.id}/${task.headName}/${task.sample}/${arm}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
