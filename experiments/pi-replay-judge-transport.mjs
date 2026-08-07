/**
 * Shared Pi hook/replay transport for evaluator judges.
 *
 * Pi still owns provider serialization, streaming, and response parsing. The
 * onPayload hook starts from a frozen production carrier, then replaces the
 * semantic system/conversation fields so no driver conversation leaks into a
 * judge request.
 */

import { readFileSync } from "node:fs";
import { sha256Hex } from "./fingerprints.mjs";

export const PI_REPLAY_TRANSPORT = "pi-replay";
export const PI_REPLAY_CORRECTION =
	"Your output did not match the required JSON schema or finding count. Preserve every judgment and return only the corrected JSON object.";

const ANTHROPIC_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const PROVIDER_APIS = Object.freeze({
	anthropic: "anthropic-messages",
	"openai-codex": "openai-codex-responses",
});

function object(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(value, label) {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}
}

/** Validate the frozen carrier before any provider work can begin. */
export function validatePiReplayShape({ provider, model, reasoning, shape }) {
	if (!(provider in PROVIDER_APIS)) throw new Error(`unsupported Pi replay provider: ${provider}`);
	assertNonEmptyString(model, "Pi replay model");
	if (!object(shape)) throw new Error(`${provider} Pi replay shape must be an object`);
	if (shape.model !== model) {
		throw new Error(`${provider} Pi replay shape model ${JSON.stringify(shape.model)} does not match ${model}`);
	}
	if (shape.stream !== true) throw new Error(`${provider} Pi replay shape must use stream: true`);

	if (provider === "anthropic") {
		if ("input" in shape || "instructions" in shape) {
			throw new Error("Anthropic Pi replay shape contains OpenAI semantic fields");
		}
		if (!Array.isArray(shape.messages)) throw new Error("Anthropic Pi replay shape requires messages");
		if (!Array.isArray(shape.system) || shape.system.length !== 2) {
			throw new Error("Anthropic Pi replay shape requires exactly two system blocks");
		}
		if (shape.system[0]?.type !== "text" || shape.system[0]?.text !== ANTHROPIC_IDENTITY) {
			throw new Error("Anthropic Pi replay shape lacks the Claude Code identity block");
		}
		if (shape.system[1]?.type !== "text" || typeof shape.system[1]?.text !== "string") {
			throw new Error("Anthropic Pi replay shape lacks its replaceable custom system block");
		}
		if (!Array.isArray(shape.tools)) throw new Error("Anthropic Pi replay shape requires its production tool roster");
		if (!Number.isInteger(shape.max_tokens) || shape.max_tokens < 1) {
			throw new Error("Anthropic Pi replay shape requires a positive max_tokens");
		}
		if (!object(shape.thinking) || !object(shape.output_config)) {
			throw new Error("Anthropic Pi replay shape requires production thinking and output_config fields");
		}
		if (reasoning !== undefined && shape.output_config.effort !== reasoning) {
			throw new Error(`Anthropic Pi replay shape reasoning ${JSON.stringify(shape.output_config.effort)} does not match ${reasoning}`);
		}
		return shape;
	}

	if ("messages" in shape || "system" in shape) {
		throw new Error("OpenAI Pi replay shape contains Anthropic semantic fields");
	}
	if (!Array.isArray(shape.input)) throw new Error("OpenAI Pi replay shape requires input");
	if (typeof shape.instructions !== "string") throw new Error("OpenAI Pi replay shape requires instructions");
	if (!Array.isArray(shape.tools)) throw new Error("OpenAI Pi replay shape requires its production tool roster");
	if (shape.store !== false) throw new Error("OpenAI Pi replay shape must use store: false");
	if (!object(shape.reasoning) || !object(shape.text)) {
		throw new Error("OpenAI Pi replay shape requires production reasoning and text fields");
	}
	if (reasoning !== undefined && shape.reasoning.effort !== reasoning) {
		throw new Error(`OpenAI Pi replay shape reasoning ${JSON.stringify(shape.reasoning.effort)} does not match ${reasoning}`);
	}
	assertNonEmptyString(shape.prompt_cache_key, "OpenAI Pi replay shape prompt_cache_key");
	return shape;
}

function validateAnthropicBuilt({ built, model, systemPrompt }) {
	if (!object(built) || built.model !== model || !Array.isArray(built.messages)) {
		throw new Error("Pi built an incompatible Anthropic judge payload");
	}
	if (!Array.isArray(built.system) || built.system.length !== 2) {
		throw new Error("Pi built an Anthropic judge payload without exactly two system blocks");
	}
	if (built.system[0]?.text !== ANTHROPIC_IDENTITY || built.system[1]?.text !== systemPrompt) {
		throw new Error("Pi did not serialize the requested Anthropic judge system prompt");
	}
}

function validateOpenAIBuilt({ built, model, systemPrompt }) {
	if (!object(built) || built.model !== model || !Array.isArray(built.input)) {
		throw new Error("Pi built an incompatible OpenAI judge payload");
	}
	if (built.instructions !== systemPrompt) {
		throw new Error("Pi did not serialize the requested OpenAI judge system prompt");
	}
}

/** Replay a frozen Anthropic carrier with only the judge semantics replaced. */
export function replayAnthropicJudgePayload({ shape, built, model, systemPrompt }) {
	assertNonEmptyString(systemPrompt, "judge system prompt");
	validatePiReplayShape({ provider: "anthropic", model, shape });
	validateAnthropicBuilt({ built, model, systemPrompt });
	const replayed = structuredClone(shape);
	// Retain both production carrier blocks and their cache metadata, replacing
	// only the custom system text. Pi's built block is the sanitized authority.
	replayed.system[1].text = built.system[1].text;
	replayed.messages = structuredClone(built.messages);
	return replayed;
}

/** Replay a frozen OpenAI Codex carrier with only judge semantics replaced. */
export function replayOpenAIJudgePayload({ shape, built, model, systemPrompt }) {
	assertNonEmptyString(systemPrompt, "judge system prompt");
	validatePiReplayShape({ provider: "openai-codex", model, shape });
	validateOpenAIBuilt({ built, model, systemPrompt });
	const replayed = structuredClone(shape);
	replayed.instructions = built.instructions;
	replayed.input = structuredClone(built.input);
	return replayed;
}

/** Provider-dispatching pure hook used by the live transport and offline tests. */
export function replayPiJudgePayload({ provider, shape, built, model, systemPrompt }) {
	if (provider === "anthropic") {
		return replayAnthropicJudgePayload({ shape, built, model, systemPrompt });
	}
	if (provider === "openai-codex") {
		return replayOpenAIJudgePayload({ shape, built, model, systemPrompt });
	}
	throw new Error(`unsupported Pi replay provider: ${provider}`);
}

/** Exact implementation identity; deliberately drifts on any module edit. */
export function piReplayTransformHash() {
	return sha256Hex(readFileSync(new URL(import.meta.url)));
}

function textOf(message) {
	return (message?.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function invalidJudgeResponse(message) {
	if (message?.role !== "assistant") return "invalid-provider-response-role";
	if (message?.stopReason !== "stop") return `non-terminal-provider-stop:${message?.stopReason ?? "missing"}`;
	if ((message.content ?? []).some((block) => ["toolCall", "tool_call", "tool_use"].includes(block?.type))) {
		return "unsupported-judge-tool-call";
	}
	return null;
}

function userMessage(text) {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function validateContract(contract) {
	if (!object(contract)) throw new Error("judge request must separate systemPrompt and userPrompt");
	assertNonEmptyString(contract.systemPrompt, "judge systemPrompt");
	assertNonEmptyString(contract.userPrompt, "judge userPrompt");
	return contract;
}

async function defaultDependencies() {
	const [{ streamSimple }, { resolveModel }] = await Promise.all([
		import("@earendil-works/pi-ai/compat"),
		import("./model-catalog.mjs"),
	]);
	return { streamSimple, resolveModel };
}

function storedApiKey(provider) {
	const auth = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/auth.json`, "utf8"));
	const credential = auth[provider];
	if (!credential?.access || (typeof credential.expires === "number" && credential.expires < Date.now())) {
		throw new Error(`missing or expired ${provider} login; run pi and log in first`);
	}
	return credential.access;
}

/**
 * Create a single-provider replay transport. Dependency injection exists only
 * to make the full request path testable without credentials or provider calls.
 */
export async function createPiReplayJudgeTransport({
	judgeName,
	provider,
	model,
	reasoning,
	shapePayloadPath,
	shapeArchive,
	shapeMember,
	apiKey,
	streamFn,
	resolveModelFn,
}) {
	assertNonEmptyString(judgeName, "judgeName");
	if (!(provider in PROVIDER_APIS)) throw new Error(`unsupported Pi replay provider: ${provider}`);
	assertNonEmptyString(model, "model");
	assertNonEmptyString(reasoning, "reasoning");
	assertNonEmptyString(shapePayloadPath, "shapePayloadPath");
	assertNonEmptyString(shapeArchive, "shapeArchive");
	assertNonEmptyString(shapeMember, "shapeMember");

	const shapeBytes = readFileSync(shapePayloadPath);
	let shape;
	try {
		shape = JSON.parse(shapeBytes.toString());
	} catch {
		throw new Error(`${shapePayloadPath}: Pi replay shape is not valid JSON`);
	}
	validatePiReplayShape({ provider, model, reasoning, shape });

	let dependencies;
	if (!streamFn || !resolveModelFn) dependencies = await defaultDependencies();
	const send = streamFn ?? dependencies.streamSimple;
	const resolve = resolveModelFn ?? dependencies.resolveModel;
	const resolvedModel = await resolve(provider, model);
	if (!resolvedModel || resolvedModel.provider !== provider || resolvedModel.id !== model) {
		throw new Error(`judge model unavailable or mismatched: ${provider}/${model}`);
	}
	if (resolvedModel.api !== PROVIDER_APIS[provider]) {
		throw new Error(`judge model ${provider}/${model} uses incompatible API ${resolvedModel.api}`);
	}
	const secret = apiKey ?? storedApiKey(provider);
	assertNonEmptyString(secret, `${provider} apiKey`);

	const shapeIdentity = Object.freeze({ archive: shapeArchive, member: shapeMember, sha256: sha256Hex(shapeBytes) });
	const transformHash = piReplayTransformHash();
	const routeIdentity = Object.freeze({
		packageLockSha256: sha256Hex(readFileSync(new URL("../package-lock.json", import.meta.url))),
		api: resolvedModel.api,
		baseUrl: resolvedModel.baseUrl ?? null,
	});
	return Object.freeze({
		name: PI_REPLAY_TRANSPORT,
		judgeName,
		provider,
		model,
		reasoning,
		shapeIdentity,
		transformHash,
		routeIdentity,
		async ask(request, prior = null) {
			const { systemPrompt, userPrompt } = validateContract(request);
			let messages;
			if (prior === null) {
				messages = [userMessage(userPrompt)];
			} else {
				if (!object(prior.raw) || prior.raw.role !== "assistant") {
					throw new Error("format correction requires the actual prior assistant response");
				}
				messages = [userMessage(userPrompt), structuredClone(prior.raw), userMessage(PI_REPLAY_CORRECTION)];
			}
			const result = await send(
				resolvedModel,
				{ systemPrompt, messages, tools: [] },
				{
					apiKey: secret,
					reasoning,
					maxTokens: provider === "anthropic" ? shape.max_tokens : undefined,
					sessionId: provider === "openai-codex" ? shape.prompt_cache_key : undefined,
					transport: provider === "openai-codex" ? "websocket" : undefined,
					onPayload: (built) => replayPiJudgePayload({ provider, shape, built, model, systemPrompt }),
				},
			).result();
			return {
				text: textOf(result),
				error: result?.errorMessage ?? null,
				invalid: result?.errorMessage ? null : invalidJudgeResponse(result),
				raw: result,
				usage: result?.usage ?? null,
			};
		},
	});
}
