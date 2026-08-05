#!/usr/bin/env node
/**
 * Causal ablation for observation-completion latency and cost.
 *
 * Nine arms separate the public schema, envelope semantics, and terminal
 * transport. Each arm gets one cache-prime request and N byte-identical
 * measured warm requests. Calls are
 * deliberately sequential: concurrency would turn provider queueing into an
 * uncontrolled latency variable.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { uuidv7 } from "@earendil-works/pi-agent-core";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { buildObservationEnvelope, buildObservationPrompt, parseDecision } from "../../utils.ts";
import { hydraToolDescription, hydraToolParameters, validateHydraToolParams } from "../../protocol.ts";
import { argOf } from "../lib.mjs";

const args = process.argv.slice(2);
const sessionPath = argOf(args, "--session", "");
const throughId = argOf(args, "--through", "af62d194");
const headsDir = argOf(args, "--heads-dir", "");
const outputPath = argOf(args, "--output", "");
const samples = Number.parseInt(argOf(args, "--samples", "6"), 10);
const sampleStart = Number.parseInt(argOf(args, "--sample-start", "1"), 10);
const warmRepeats = Number.parseInt(argOf(args, "--warm-repeats", "2"), 10);
const schemaPaddingWords = Number.parseInt(argOf(args, "--schema-padding-words", "0"), 10);
const reasoning = argOf(args, "--thinking", "low");
const requestedModels = argOf(args, "--models", "sonnet,luna,terra,sol").split(",").filter(Boolean);
const requestedArms = argOf(args, "--arms", "A,B,C,D,E,F,G").split(",").filter(Boolean);
const requestedFixtures = argOf(args, "--fixtures", "none,steer").split(",").filter(Boolean);
const retryErrors = args.includes("--retry-errors");
const harnessVersion = 5;

if (!sessionPath || !outputPath) {
	console.error("--session and --output are required");
	process.exit(1);
}
if (!Number.isInteger(samples) || samples < 1) throw new Error("--samples must be a positive integer");
if (!Number.isInteger(sampleStart) || sampleStart < 1 || sampleStart > samples) {
	throw new Error("--sample-start must be between 1 and --samples");
}
if (!Number.isInteger(warmRepeats) || warmRepeats < 1) {
	throw new Error("--warm-repeats must be a positive integer");
}
if (!Number.isInteger(schemaPaddingWords) || schemaPaddingWords < 0) {
	throw new Error("--schema-padding-words must be a non-negative integer");
}

const modelSpecs = {
	sonnet: { provider: "anthropic", id: "claude-sonnet-5" },
	opus: { provider: "anthropic", id: "claude-opus-4-8" },
	luna: { provider: "openai-codex", id: "gpt-5.6-luna" },
	terra: { provider: "openai-codex", id: "gpt-5.6-terra" },
	sol: { provider: "openai-codex", id: "gpt-5.6-sol" },
};
for (const name of requestedModels) {
	if (!(name in modelSpecs)) throw new Error(`unknown model ${name}`);
}

const arms = {
	A: { schema: "legacy", semantics: "legacy", completion: "json" },
	B: { schema: "current", semantics: "legacy", completion: "json" },
	C: { schema: "current", semantics: "legacy", completion: "tool" },
	D: { schema: "current", semantics: "current", completion: "json" },
	E: { schema: "current", semantics: "current", completion: "tool" },
	F: { schema: "minimal", semantics: "current", completion: "json" },
	G: { schema: "minimal", semantics: "current", completion: "tool" },
	H: { schema: "compact", semantics: "current", completion: "json" },
	I: { schema: "compact", semantics: "current", completion: "tool" },
	J: { schema: "current", semantics: "compact", completion: "tool" },
	K: { schema: "compact", semantics: "compact", completion: "tool" },
	L: { schema: "compact-description", semantics: "compact", completion: "tool" },
	M: { schema: "compact-parameters", semantics: "compact", completion: "tool" },
};
for (const name of requestedArms) {
	if (!(name in arms)) throw new Error(`unknown arm ${name}`);
}

const FIXED_MESSAGE = "Run the integration test before continuing.";
const fixtures = {
	none: {
		head: "diagnostic-none",
		expectedAction: "noop",
		expectedMessage: "",
		predetermined: true,
		lens: `PURPOSE: Measure observation transport without performing a review.
REQUIRED DECISION: No feedback is warranted.
REQUIRED MESSAGE: Empty.
Do not inspect, summarize, or discuss the trajectory.`,
	},
	steer: {
		head: "diagnostic-steer",
		expectedAction: "steer",
		expectedMessage: FIXED_MESSAGE,
		predetermined: true,
		lens: `PURPOSE: Measure observation transport without performing a review.
REQUIRED DECISION: Immediate agent correction is warranted.
REQUIRED MESSAGE: ${FIXED_MESSAGE}
Do not inspect, summarize, or discuss the trajectory.`,
	},
};
const auth = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/auth.json`, "utf8"));
for (const provider of new Set(requestedModels.map((name) => modelSpecs[name].provider))) {
	const credential = auth[provider];
	if (!credential?.access || (typeof credential.expires === "number" && credential.expires < Date.now())) {
		throw new Error(`missing or expired ${provider} login; run pi and log in first`);
	}
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

function readHead(name) {
	const raw = readFileSync(join(headsDir, `${name}.md`), "utf8");
	const match = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]+)$/);
	if (!match) throw new Error(`cannot parse ${name}.md`);
	return match[1].trim();
}

if (headsDir) {
	Object.assign(fixtures, {
		"security-positive": {
			head: "security",
			expectedAction: "steer",
			lens: readHead("security"),
			trajectory: messagesThrough("6192600d"),
		},
		"quality-positive": {
			head: "quality",
			expectedAction: "steer",
			lens: readHead("quality"),
			trajectory: messagesThrough("6192600d"),
		},
		"security-noop": {
			head: "security",
			expectedAction: "noop",
			expectedMessage: "",
			lens: readHead("security"),
			trajectory: messagesThrough("af62d194"),
		},
		"quality-noop": {
			head: "quality",
			expectedAction: "noop",
			expectedMessage: "",
			lens: readHead("quality"),
			trajectory: messagesThrough("af62d194"),
		},
	});
}
for (const name of requestedFixtures) {
	if (!(name in fixtures)) throw new Error(`unknown fixture ${name}`);
}
const defaultTrajectory = messagesThrough(throughId);
const legacyShape =
	'{"action":"noop|print|queue|steer|interrupt","reason":"≤120 chars","message":"≤240 chars, empty if noop"}';

function legacyDecisionProtocol(head, completion) {
	if (completion === "json") {
		return `Reply with one JSON object, nothing else:
${legacyShape}

Noop unless something warrants feedback. Print a note the user sees but the agent does not. Queue if useful but waitable. Steer to correct the agent between turns. Interrupt only for emergencies that must stop the line. No tools, no "let me check...", no follow-up turn. Don't prefix message with [${head}].`;
	}
	return `When finished, call hydra exactly once, alone in its turn, with action "complete_observation". Use delivery "none" with message "" when no feedback warrants delivery. Otherwise message must be non-empty and concise, ideally under 240 characters. Choose by who must act and when: "print" is a user-only note when the agent need not act; "queue" is for agent action that can wait until its next turn; "steer" is for an agent correction needed before current work continues; "interrupt" is only for an emergency that must abort the run. No work tools, no "let me check...", no follow-up turn, and no unsupported claims. Don't prefix message with [${head}].`;
}

function legacyCombinedPrompt(head, lens, completion) {
	return `<system-reminder>Side watcher. You have no work tools.

LENS: ${lens}

${legacyDecisionProtocol(head, completion)}</system-reminder>`;
}

function legacySplitEnvelope(head, completion) {
	return `Side watcher. The preceding user message is the complete ${head} lens, not merely a topic label. Follow it in full except where it conflicts with this envelope's protocol and tool constraints. The lens alone defines what is in scope and what warrants intervention; do not broaden it. Review the visible trajectory. You have no work tools.

${legacyDecisionProtocol(head, completion)}`;
}

const currentToolProtocol = (head) =>
	`When finished, call hydra exactly once, alone in its turn, with action "complete_observation". Use delivery "none" with message "" when no feedback warrants delivery. Otherwise message must be non-empty and concise, ideally under 240 characters. Choose by who must act and when: "print" is a user-only note when the agent need not act; "queue" is for agent action that can wait until its next turn; "steer" is for an agent correction needed before current work continues; "interrupt" is only for an emergency that must abort the run. Don't prefix message with [${head}].`;

const currentJsonProtocol = (head) =>
	`When finished, reply with one JSON object, nothing else:
${legacyShape}

Use action "noop" with message "" when no feedback warrants delivery. Otherwise message must be non-empty and concise, ideally under 240 characters. Choose by who must act and when: "print" is a user-only note when the agent need not act; "queue" is for agent action that can wait until its next turn; "steer" is for an agent correction needed before current work continues; "interrupt" is only for an emergency that must abort the run. Don't prefix message with [${head}].`;

function currentHandoff(head, lens, completion, split) {
	const toolText = split
		? buildObservationEnvelope(head, [])
		: buildObservationPrompt(head, lens, []);
	if (completion === "tool") {
		return toolText;
	}
	const before = currentToolProtocol(head);
	if (!toolText.includes(before)) {
		throw new Error("current observation protocol text changed; update the causal harness deliberately");
	}
	return toolText
		.replace(
			"The hydra action complete_observation is available only to return your decision.",
			"The hydra action complete_observation is not the selected return transport for this observation.",
		)
		.replace(before, currentJsonProtocol(head));
}

function compactJudgeEnvelope(head) {
	return `Side watcher. The preceding user message is the complete ${head} lens. Follow it in full except where it conflicts with this protocol. The lens alone defines scope, intervention criteria, suppression, and deduplication; do not broaden it. Review the visible trajectory. You have no work tools. When finished, call hydra exactly once, alone in its turn, with action "complete_observation". Use delivery "none" and message "" when no feedback is warranted. Otherwise keep the message concise, ideally under 240 characters. Choose delivery by recipient and urgency: print is a user-only note; queue is agent action later; steer is agent action before current work continues; interrupt is emergency abort. No tools, no "let me check...", no follow-up turn, and no unsupported claims. Don't prefix message with [${head}].`;
}

const legacyHydraParameters = Type.Object(
	{
		action: StringEnum(["add", "remove"]),
		head: Type.String(),
	},
	{ additionalProperties: false },
);

const minimalHydraParameters = Type.Object(
	{
		action: StringEnum(["complete_observation"]),
		delivery: StringEnum(["none", "print", "queue", "steer", "interrupt"]),
		message: Type.String({ maxLength: 1000 }),
	},
	{ additionalProperties: false },
);

const compactHydraParameters = Type.Object(
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

function compactHydraDescription() {
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

function legacyHydraDescription() {
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

function hydraTool(arm, schemaNonce) {
	const currentDescription =
		arm.schema === "current" || arm.schema === "compact-parameters";
	const currentParameters =
		arm.schema === "current" || arm.schema === "compact-description";
	const minimal = arm.schema === "minimal";
	const compact = arm.schema === "compact";
	const compactDescription = compact || arm.schema === "compact-description";
	const compactParameters = compact || arm.schema === "compact-parameters";
	return {
		name: "hydra",
		label: "Hydra",
		description: `${
			currentDescription
				? hydraToolDescription("the benchmark head directory")
				: minimal
					? "Return an observer's final decision. Use none with an empty message for no feedback; otherwise choose print, queue, steer, or interrupt and provide a concise message."
					: compactDescription
						? compactHydraDescription()
					: legacyHydraDescription()
		} Benchmark schema key: ${schemaNonce}.${schemaPaddingWords > 0 ? ` Schema padding: ${" pad".repeat(schemaPaddingWords)}.` : ""}`,
		parameters: currentParameters
			? hydraToolParameters
			: minimal
				? minimalHydraParameters
				: compactParameters
					? compactHydraParameters
					: legacyHydraParameters,
		async execute() {
			throw new Error("The single-turn causal harness does not execute tools");
		},
	};
}

function textOf(message) {
	return (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
}

function itemText(item) {
	return (item?.content ?? [])
		.filter((block) => block?.type === "input_text")
		.map((block) => block.text)
		.join("");
}

function digest(value) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function bytes(value) {
	return Buffer.byteLength(JSON.stringify(value));
}

function payloadSummary(body, provider) {
	const openai = provider === "openai-codex";
	const messages = openai ? body.input : body.messages;
	const system = openai ? body.instructions : body.system;
	return {
		hash: digest(body),
		bytes: bytes(body),
		toolsHash: digest(body.tools ?? []),
		toolsBytes: bytes(body.tools ?? []),
		systemHash: digest(system ?? ""),
		systemBytes: bytes(system ?? ""),
		messagesHash: digest(messages ?? []),
		messagesBytes: bytes(messages ?? []),
		roles: (messages ?? []).slice(-6).map((item) => item?.role ?? item?.type ?? "?"),
	};
}

function handoffFor(spec, arm, fixture) {
	const split = spec.provider === "openai-codex";
	let handoff;
	if (arm.semantics === "legacy") {
		handoff = split
			? { promptText: fixture.lens, envelope: legacySplitEnvelope(fixture.head, arm.completion) }
			: { promptText: legacyCombinedPrompt(fixture.head, fixture.lens, arm.completion) };
	} else if (arm.semantics === "current") {
		handoff = split
			? {
					promptText: fixture.lens,
					envelope: currentHandoff(fixture.head, fixture.lens, arm.completion, true),
				}
			: {
					promptText: currentHandoff(fixture.head, fixture.lens, arm.completion, false),
				};
	} else {
		if (!split || arm.completion !== "tool") {
			throw new Error("compact envelope arm supports only the split tool-completion path");
		}
		handoff = {
			promptText: fixture.lens,
			envelope: compactJudgeEnvelope(fixture.head),
		};
	}
	if (!fixture.predetermined) {
		return handoff;
	}
	const transport =
		arm.completion === "json"
			? "SELECTED TRANSPORT: Return the JSON object and do not call hydra."
			: "SELECTED TRANSPORT: Call hydra and do not return the decision as JSON text.";
	const decision =
		fixture.expectedAction === "noop"
			? "TRANSPORT BENCHMARK REQUIREMENT: Complete with no feedback and an empty message. This semantic decision is predetermined; do not reevaluate it."
			: `TRANSPORT BENCHMARK REQUIREMENT: Complete with immediate steer feedback whose message is exactly "${fixture.expectedMessage}" This semantic decision is predetermined; do not reevaluate it.`;
	const requirement = `${transport} ${decision}`;
	if (split) {
		return { ...handoff, envelope: `${handoff.envelope}\n\n${requirement}` };
	}
	return {
		...handoff,
		promptText: `${handoff.promptText}\n\n<system-reminder>${requirement}</system-reminder>`,
	};
}

function payloadTransform(spec, promptText, envelope, capture) {
	return (rawBody) => {
		let body = rawBody;
		if (spec.provider === "openai-codex" && envelope) {
			const input = structuredClone(rawBody.input);
			const promptIndex = input.findIndex(
				(item) => item?.role === "user" && itemText(item) === promptText,
			);
			if (promptIndex === -1) throw new Error("serialized diagnostic lens not found");
			input.splice(promptIndex + 1, 0, {
				type: "message",
				role: "developer",
				content: [{ type: "input_text", text: envelope }],
			});
			body = { ...rawBody, input };
		}
		capture.push(payloadSummary(body, spec.provider));
		return body;
	};
}

function responseShape(message) {
	const thinking = message.content.filter((block) => block.type === "thinking");
	const text = message.content.filter((block) => block.type === "text");
	const calls = message.content.filter((block) => block.type === "toolCall");
	return {
		blockTypes: message.content.map((block) => block.type),
		thinkingChars: thinking.reduce((sum, block) => sum + block.thinking.length, 0),
		textChars: text.reduce((sum, block) => sum + block.text.length, 0),
		toolArgumentChars: calls.reduce((sum, block) => sum + JSON.stringify(block.arguments).length, 0),
		toolCalls: calls.map((block) => ({ name: block.name, arguments: block.arguments })),
	};
}

function validateCompletion(message, arm, fixture) {
	if (arm.completion === "json") {
		const decision = parseDecision(textOf(message));
		return {
			valid: decision !== null,
			action: decision?.action ?? null,
			message: decision?.message ?? null,
			correct:
				decision?.action === fixture.expectedAction &&
				(fixture.expectedMessage === undefined || decision.message === fixture.expectedMessage),
		};
	}
	const calls = message.content.filter((block) => block.type === "toolCall");
	if (calls.length !== 1 || calls[0].name !== "hydra") {
		return { valid: false, action: null, message: null, correct: false };
	}
	try {
		const params = validateHydraToolParams(calls[0].arguments);
		if (params.action !== "complete_observation") {
			return { valid: false, action: params.action, message: params.message, correct: false };
		}
		const action = params.delivery === "none" ? "noop" : params.delivery;
		return {
			valid: true,
			action,
			message: params.message,
			correct:
				action === fixture.expectedAction &&
				(fixture.expectedMessage === undefined || params.message === fixture.expectedMessage),
		};
	} catch (error) {
		return {
			valid: false,
			action: null,
			message: null,
			correct: false,
			validationError: error instanceof Error ? error.message : String(error),
		};
	}
}

async function singleRequest(model, context, options, phase, capture) {
	const started = performance.now();
	const timing = {};
	const deltas = { thinking: 0, text: 0, tool: 0 };
	const { spec, promptText, envelope, ...providerOptions } = options;
	const stream = streamSimple(model, context, {
		...providerOptions,
		onPayload: payloadTransform(spec, promptText, envelope, capture),
	});
	for await (const event of stream) {
		const elapsed = Math.round(performance.now() - started);
		if (event.type === "start" && timing.streamStartMs === undefined) timing.streamStartMs = elapsed;
		if (event.type === "thinking_start" && timing.thinkingStartMs === undefined) timing.thinkingStartMs = elapsed;
		if (event.type === "thinking_delta") deltas.thinking += event.delta.length;
		if (event.type === "thinking_end") timing.thinkingEndMs = elapsed;
		if (event.type === "text_start" && timing.textStartMs === undefined) timing.textStartMs = elapsed;
		if (event.type === "text_delta") deltas.text += event.delta.length;
		if (event.type === "text_end") timing.textEndMs = elapsed;
		if (event.type === "toolcall_start" && timing.toolStartMs === undefined) timing.toolStartMs = elapsed;
		if (event.type === "toolcall_delta") deltas.tool += event.delta.length;
		if (event.type === "toolcall_end") timing.toolEndMs = elapsed;
		if ((event.type === "done" || event.type === "error") && timing.doneMs === undefined) timing.doneMs = elapsed;
	}
	const message = await stream.result();
	const finishedMs = Math.round(performance.now() - started);
	const firstContentMs = Math.min(
		...["thinkingStartMs", "textStartMs", "toolStartMs"]
			.map((key) => timing[key])
			.filter((value) => value !== undefined),
	);
	const usage = message.usage ?? {};
	return {
		phase,
		ms: finishedMs,
		timing: {
			...timing,
			firstContentMs: Number.isFinite(firstContentMs) ? firstContentMs : null,
		},
		deltas,
		stop: message.stopReason,
		error: message.errorMessage ?? null,
		usage: {
			input: usage.input ?? 0,
			output: usage.output ?? 0,
			reasoning: usage.reasoning ?? 0,
			cacheRead: usage.cacheRead ?? 0,
			cacheWrite: usage.cacheWrite ?? 0,
			cacheWrite1h: usage.cacheWrite1h ?? 0,
			cost: usage.cost ?? {},
		},
		response: responseShape(message),
		message,
	};
}

async function runArm(modelName, fixtureName, sample, armName, cacheNonce, schemaNonce) {
	const spec = modelSpecs[modelName];
	const model = getModel(spec.provider, spec.id);
	if (!model) throw new Error(`unknown ${spec.provider} model ${spec.id}`);
	const arm = arms[armName];
	const fixture = fixtures[fixtureName];
	const handoff = handoffFor(spec, arm, fixture);
	const prompt = {
		role: "user",
		content: [{ type: "text", text: handoff.promptText }],
		timestamp: 1_700_000_000_000,
	};
	const context = {
		systemPrompt: `You are pi, a coding agent. Causal benchmark cache key: ${cacheNonce}.`,
		messages: [...(fixture.trajectory ?? defaultTrajectory), prompt],
		tools: [hydraTool(arm, schemaNonce)],
	};
	const sessionId = spec.provider === "openai-codex" ? uuidv7() : undefined;
	const options = {
		model,
		apiKey: auth[spec.provider].access,
		maxTokens: 700,
		reasoning,
		sessionId,
		transport: spec.provider === "openai-codex" ? "websocket" : undefined,
		spec,
		promptText: handoff.promptText,
		envelope: handoff.envelope,
	};
	const capture = [];
	try {
		const requests = [];
		for (let index = 0; index <= warmRepeats; index++) {
			const phase = index === 0 ? "prime" : `warm-${index}`;
			const request = await singleRequest(model, context, options, phase, capture);
			const validationStarted = performance.now();
			const completion = validateCompletion(request.message, arm, fixture);
			const validationUs = Math.round((performance.now() - validationStarted) * 1000);
			delete request.message;
			requests.push({ ...request, completion, validationUs });
			if (request.error) break;
		}
		return {
			harnessVersion,
			model: modelName,
			modelId: spec.id,
			provider: spec.provider,
			thinking: reasoning,
			fixture: fixtureName,
			sample,
			arm: armName,
			factors: arm,
			expectedAction: fixture.expectedAction,
			expectedMessage: fixture.expectedMessage ?? null,
			warmRepeats,
			schemaPaddingWords,
			requests,
			payloads: capture,
			payloadStable:
				capture.length > 1 &&
				capture.every((payload) => payload.hash === capture[0].hash),
			toolPayloadStable:
				capture.length > 1 &&
				capture.every((payload) => payload.toolsHash === capture[0].toolsHash),
		};
	} finally {
		if (sessionId) closeOpenAICodexWebSocketSessions(sessionId);
	}
}

const completed = new Set();
if (existsSync(outputPath)) {
	for (const line of readFileSync(outputPath, "utf8").trim().split("\n").filter(Boolean)) {
		const row = JSON.parse(line);
		const failed = row.error || row.requests?.some((request) => request.error);
		if (!retryErrors || !failed) {
			completed.add(`${row.model}/${row.thinking}/${row.fixture}/${row.sample}/${row.arm}`);
		}
	}
}

const tasks = [];
for (const model of requestedModels) {
	for (const fixture of requestedFixtures) {
		for (let sample = sampleStart; sample <= samples; sample++) {
			// One block shares every nuisance byte across arms. This makes the
			// warm-request contrasts exact. Because B-E share the current tool
			// prefix, their first request is a cache prime, not assumed cold.
			const cacheNonce = randomUUID();
			const schemaNonce = randomUUID();
			const armOrder = [...requestedArms];
			for (let i = armOrder.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[armOrder[i], armOrder[j]] = [armOrder[j], armOrder[i]];
			}
			for (const arm of armOrder) tasks.push({ model, fixture, sample, arm, cacheNonce, schemaNonce });
		}
	}
}

console.error(
	`causal completion ablation: ${tasks.length} arm runs, ${warmRepeats + 1} requests each, sequential; ${completed.size} already complete`,
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
		const prime = row.requests[0];
		const warm = row.requests.slice(1);
		const warmMs = warm.length
			? Math.round(warm.reduce((sum, request) => sum + request.ms, 0) / warm.length)
			: 0;
		const correct = row.requests.every((request) => request.completion.correct);
		console.log(
			`${key}: ${correct ? "PASS" : "FAIL"} prime=${prime.ms}ms warm=${warmMs}ms out=${prime.usage.output} payload=${row.payloadStable ? "stable" : "DRIFT"}`,
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
