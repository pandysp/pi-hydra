#!/usr/bin/env node
/**
 * Measures the driver-side cost and behavior of Hydra's public tool schema.
 *
 * Each arm receives the same captured trajectory, system prompt, and user
 * request. One prime call is followed by byte-identical warm calls. Requests
 * are sequential so provider queueing does not become a latency variable.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { uuidv7 } from "@earendil-works/pi-agent-core";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { hydraToolDescription, hydraToolParameters, validateHydraToolParams } from "../../protocol.ts";
import { argOf } from "../lib.mjs";
import {
	managementOnlyHydraDescription,
	managementOnlyHydraParameters,
	validateManagementOnlyParams,
} from "../tool-free-protocol.mjs";

const args = process.argv.slice(2);
const sessionPath = argOf(args, "--session", "");
const throughId = argOf(args, "--through", "af62d194");
const outputPath = argOf(args, "--output", "");
const samples = Number.parseInt(argOf(args, "--samples", "2"), 10);
const warmRepeats = Number.parseInt(argOf(args, "--warm-repeats", "1"), 10);
const reasoning = argOf(args, "--thinking", "low");
const requestedModels = argOf(args, "--models", "luna,terra,sol").split(",").filter(Boolean);
const requestedArms = argOf(args, "--arms", "legacy,current,compact").split(",").filter(Boolean);
const requestedFixtures = argOf(args, "--fixtures", "reply,add").split(",").filter(Boolean);
const retryErrors = args.includes("--retry-errors");
const harnessVersion = 1;

if (!sessionPath || !outputPath) throw new Error("--session and --output are required");
if (!Number.isInteger(samples) || samples < 1) throw new Error("--samples must be a positive integer");
if (!Number.isInteger(warmRepeats) || warmRepeats < 1) {
	throw new Error("--warm-repeats must be a positive integer");
}

const modelSpecs = {
	luna: { provider: "openai-codex", id: "gpt-5.6-luna" },
	terra: { provider: "openai-codex", id: "gpt-5.6-terra" },
	sol: { provider: "openai-codex", id: "gpt-5.6-sol" },
};
for (const name of requestedModels) {
	if (!(name in modelSpecs)) throw new Error(`unknown model ${name}`);
}

const fixtures = {
	reply: {
		prompt: "Reply with exactly OK, with no punctuation or explanation. Do not call any tool.",
		validate(message) {
			const text = message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("")
				.trim();
			return text === "OK" && message.content.every((block) => block.type !== "toolCall");
		},
	},
	add: {
		prompt:
			"We are about to implement authentication and session handling. Add the security Hydra head now, and briefly explain the crew change.",
		validate(message, arm) {
			const calls = message.content.filter((block) => block.type === "toolCall");
			if (calls.length !== 1 || calls[0].name !== "hydra") return false;
			const value = calls[0].arguments;
			if (arm === "legacy") {
				return value?.action === "add" && value?.head === "security";
			}
			try {
				const params =
					arm === "management-only"
						? validateManagementOnlyParams(value)
						: validateHydraToolParams(value);
				return (
					params.action === "manage_heads" &&
					params.operation === "add" &&
					params.head === "security" &&
					params.message.trim().length > 0
				);
			} catch {
				return false;
			}
		},
	},
};
for (const name of requestedFixtures) {
	if (!(name in fixtures)) throw new Error(`unknown fixture ${name}`);
}

const legacyParameters = Type.Object(
	{
		action: StringEnum(["add", "remove"]),
		head: Type.String(),
	},
	{ additionalProperties: false },
);

const compactParameters = Type.Object(
	{
		action: StringEnum(["manage_heads", "complete_observation"], {
			description: "Manage heads or complete an observation",
		}),
		operation: Type.Optional(
			StringEnum(["add", "remove"], { description: "manage_heads: add or remove" }),
		),
		head: Type.Optional(Type.String({ minLength: 1, description: "manage_heads: head name" })),
		delivery: Type.Optional(
			StringEnum(["none", "print", "queue", "steer", "interrupt"], {
				description: "complete_observation: feedback route",
			}),
		),
		message: Type.String({
			maxLength: 1000,
			description: "Reason or feedback; empty only with delivery none",
		}),
	},
	{ additionalProperties: false },
);

function legacyDescription() {
	return [
		"Point your hydra heads: `add` puts a head on the active set,",
		"`remove` takes it off (both idempotent; the set is session state). Each",
		"active head independently reviews your full context as you work. Heads",
		"are markdown files in the benchmark head directory (user) and .pi/hydra (project):",
		"frontmatter `name:` and `description:` are required; `tools:` is omitted",
		"for all tools, `[]` for a judge-only head, or a comma-separated subset;",
		"`autostart: true` joins fresh sessions; heads with write/edit/hydra may",
		"set `after-change:` to `noop` or `print`; the body is the head's",
		"instruction (one focus, clear conditions for acting, work, completion,",
		"and delivery). To create or tune a head, write the file, then add it:",
		"files are re-discovered on every call. Swap heads when work changes phase.",
	].join(" ");
}

function compactDescription() {
	return [
		"Manage active Hydra heads or complete an observation.",
		"`manage_heads` adds or removes a named head and briefly explains why.",
		"`complete_observation` routes concise feedback: none has an empty message;",
		"print is user-only; queue is for agent action later; steer is for agent",
		"action now; interrupt aborts an emergency. Head files in the benchmark",
		"head directory or .pi/hydra require frontmatter name and description.",
		"`tools:` omitted allows all, `[]` makes a judge, or list allowed tools.",
		"`autostart: true` enables fresh sessions; acting heads may set",
		"`after-change:` to noop or print. Write or edit a head before adding it;",
		"files are rediscovered on each call.",
	].join(" ");
}

function toolFor(arm, schemaNonce) {
	const description =
		arm === "legacy"
			? legacyDescription()
			: arm === "current"
				? hydraToolDescription("the benchmark head directory")
				: arm === "management-only"
					? managementOnlyHydraDescription("the benchmark head directory")
					: compactDescription();
	return {
		name: "hydra",
		label: "Hydra",
		description: `${description} Benchmark schema key: ${schemaNonce}.`,
		parameters:
			arm === "legacy"
				? legacyParameters
				: arm === "current"
					? hydraToolParameters
					: arm === "management-only"
						? managementOnlyHydraParameters
						: compactParameters,
		async execute() {
			throw new Error("The single-turn schema harness does not execute tools");
		},
	};
}

function messagesThrough(id) {
	const messages = [];
	let found = false;
	for (const line of readFileSync(sessionPath, "utf8").trim().split("\n")) {
		const entry = JSON.parse(line);
		if (entry.type === "message") messages.push(entry.message);
		if (entry.id === id) {
			found = true;
			break;
		}
	}
	if (!found) throw new Error(`entry ${id} not found in ${sessionPath}`);
	return messages;
}

function digest(value) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function payloadSummary(body) {
	return {
		hash: digest(body),
		bytes: Buffer.byteLength(JSON.stringify(body)),
		toolsHash: digest(body.tools ?? []),
		toolsBytes: Buffer.byteLength(JSON.stringify(body.tools ?? [])),
		systemHash: digest(body.instructions ?? body.system ?? ""),
		messagesHash: digest(body.input ?? body.messages ?? []),
	};
}

function responseShape(message) {
	const calls = message.content.filter((block) => block.type === "toolCall");
	return {
		blockTypes: message.content.map((block) => block.type),
		text: message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join(""),
		toolCalls: calls.map((block) => ({ name: block.name, arguments: block.arguments })),
	};
}

async function request(model, context, options, phase, payloads) {
	const started = performance.now();
	const timing = {};
	const stream = streamSimple(model, context, {
		...options,
		onPayload(body) {
			payloads.push(payloadSummary(body));
			return body;
		},
	});
	for await (const event of stream) {
		const elapsed = Math.round(performance.now() - started);
		if (event.type === "thinking_start" && timing.thinkingStartMs === undefined) {
			timing.thinkingStartMs = elapsed;
		}
		if (event.type === "text_start" && timing.textStartMs === undefined) timing.textStartMs = elapsed;
		if (event.type === "toolcall_start" && timing.toolStartMs === undefined) {
			timing.toolStartMs = elapsed;
		}
	}
	const message = await stream.result();
	const usage = message.usage ?? {};
	return {
		phase,
		ms: Math.round(performance.now() - started),
		timing,
		stop: message.stopReason,
		error: message.errorMessage ?? null,
		usage: {
			input: usage.input ?? 0,
			output: usage.output ?? 0,
			reasoning: usage.reasoning ?? 0,
			cacheRead: usage.cacheRead ?? 0,
			cacheWrite: usage.cacheWrite ?? 0,
			cost: usage.cost ?? {},
		},
		response: responseShape(message),
		message,
	};
}

const auth = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/auth.json`, "utf8"));
const baseMessages = messagesThrough(throughId);

async function runArm(modelName, fixtureName, sample, arm, cacheNonce, schemaNonce) {
	const spec = modelSpecs[modelName];
	const credential = auth[spec.provider];
	if (!credential?.access || (typeof credential.expires === "number" && credential.expires < Date.now())) {
		throw new Error(`missing or expired ${spec.provider} login; run pi and log in first`);
	}
	const model = getModel(spec.provider, spec.id);
	if (!model) throw new Error(`unknown ${spec.provider} model ${spec.id}`);
	const fixture = fixtures[fixtureName];
	const prompt = {
		role: "user",
		content: [{ type: "text", text: fixture.prompt }],
		timestamp: 1_700_000_000_000,
	};
	const context = {
		systemPrompt: `You are pi, a coding agent. Driver schema benchmark cache key: ${cacheNonce}.`,
		messages: [...baseMessages, prompt],
		tools: [toolFor(arm, schemaNonce)],
	};
	const sessionId = uuidv7();
	const options = {
		apiKey: credential.access,
		maxTokens: 500,
		reasoning,
		sessionId,
		transport: "websocket",
	};
	const payloads = [];
	try {
		const requests = [];
		for (let index = 0; index <= warmRepeats; index++) {
			const result = await request(
				model,
				context,
				options,
				index === 0 ? "prime" : `warm-${index}`,
				payloads,
			);
			const correct = fixture.validate(result.message, arm);
			delete result.message;
			requests.push({ ...result, correct });
			if (result.error) break;
		}
		return {
			harnessVersion,
			model: modelName,
			modelId: spec.id,
			provider: spec.provider,
			thinking: reasoning,
			fixture: fixtureName,
			sample,
			arm,
			warmRepeats,
			requests,
			payloads,
			payloadStable:
				payloads.length > 1 && payloads.every((payload) => payload.hash === payloads[0].hash),
		};
	} finally {
		closeOpenAICodexWebSocketSessions(sessionId);
	}
}

const completed = new Set();
if (existsSync(outputPath)) {
	for (const line of readFileSync(outputPath, "utf8").trim().split("\n").filter(Boolean)) {
		const row = JSON.parse(line);
		const failed = row.error || row.requests?.some((item) => item.error);
		if (!retryErrors || !failed) {
			completed.add(`${row.model}/${row.thinking}/${row.fixture}/${row.sample}/${row.arm}`);
		}
	}
}

const tasks = [];
for (const model of requestedModels) {
	for (const fixture of requestedFixtures) {
		for (let sample = 1; sample <= samples; sample++) {
			const cacheNonce = randomUUID();
			const schemaNonce = randomUUID();
			const order = [...requestedArms];
			for (let i = order.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[order[i], order[j]] = [order[j], order[i]];
			}
			for (const arm of order) tasks.push({ model, fixture, sample, arm, cacheNonce, schemaNonce });
		}
	}
}

console.error(
	`main-agent schema ablation: ${tasks.length} arm runs, ${warmRepeats + 1} requests each, sequential`,
);
for (const task of tasks) {
	const key = `${task.model}/${reasoning}/${task.fixture}/${task.sample}/${task.arm}`;
	if (completed.has(key)) continue;
	try {
		const row = await runArm(
			task.model,
			task.fixture,
			task.sample,
			task.arm,
			task.cacheNonce,
			task.schemaNonce,
		);
		appendFileSync(outputPath, `${JSON.stringify(row)}\n`);
		const warm = row.requests.slice(1);
		console.log(
			`${key}: ${row.requests.every((item) => item.correct) ? "PASS" : "FAIL"} ` +
				`warm=${Math.round(warm.reduce((sum, item) => sum + item.ms, 0) / warm.length)}ms ` +
				`input=${warm[0]?.usage.input ?? 0} cache=${warm[0]?.usage.cacheRead ?? 0} ` +
				`payload=${row.payloadStable ? "stable" : "DRIFT"}`,
		);
	} catch (error) {
		const row = {
			...task,
			thinking: reasoning,
			error: error instanceof Error ? error.stack ?? error.message : String(error),
		};
		appendFileSync(outputPath, `${JSON.stringify(row)}\n`);
		console.error(`${key}: ERROR ${row.error}`);
	}
}
