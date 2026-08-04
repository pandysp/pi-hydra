import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { sha256Hex } from "./fingerprints.mjs";
import {
	PI_REPLAY_CORRECTION,
	createPiReplayJudgeTransport,
	piReplayTransformHash,
	replayAnthropicJudgePayload,
	replayOpenAIJudgePayload,
	validatePiReplayShape,
} from "./pi-replay-judge-transport.mjs";

const ANTHROPIC_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const SYSTEM_PROMPT = "Judge the supplied findings under the frozen expanded 2Q contract.";
const USER_PROMPT = "BATCH EVIDENCE: finding j01";
const FAKE_KEY = "test-credential-must-not-enter-payload";
const temporary = mkdtempSync(join(tmpdir(), "pi-replay-judge-"));

afterAll(() => rmSync(temporary, { recursive: true, force: true }));

function realPayload(archive, member) {
	const path = fileURLToPath(new URL(archive, import.meta.url));
	return JSON.parse(execFileSync("tar", ["-xOf", path, member], { encoding: "utf8" }));
}

const anthropicShape = realPayload(
	"./artifacts/2026-08-01-trajectory-pilot/payloads.tar.gz",
	"payloads/scheduler-opus-high-a1-r1-q5.json",
);
const openAIShape = realPayload(
	"./artifacts/2026-08-03-openai-capstone-producer/payloads.tar.gz",
	"payloads/dispatcher-sol-high-a1-r0-q4.json",
);

function shapeFile(name, shape) {
	const path = join(temporary, name);
	writeFileSync(path, JSON.stringify(shape));
	return path;
}

function without(value, keys) {
	return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

describe("Pi replay judge payload transforms", () => {
	it("replays the frozen Anthropic carrier while replacing system block 2 and the entire conversation", () => {
		const original = structuredClone(anthropicShape);
		const built = {
			model: anthropicShape.model,
			stream: true,
			system: [
				{ type: "text", text: ANTHROPIC_IDENTITY },
				{ type: "text", text: SYSTEM_PROMPT },
			],
			messages: [{ role: "user", content: [{ type: "text", text: USER_PROMPT }] }],
		};
		const replayed = replayAnthropicJudgePayload({
			shape: anthropicShape,
			built,
			model: "claude-opus-5",
			systemPrompt: SYSTEM_PROMPT,
		});

		expect(replayed.system[0]).toEqual(anthropicShape.system[0]);
		expect(replayed.system[1]).toEqual({ ...anthropicShape.system[1], text: SYSTEM_PROMPT });
		expect(replayed.messages).toEqual(built.messages);
		expect(replayed.messages).not.toEqual(anthropicShape.messages);
		expect(without(replayed, ["system", "messages"])).toEqual(without(anthropicShape, ["system", "messages"]));
		expect(anthropicShape).toEqual(original);
		expect(JSON.stringify(replayed)).not.toContain(original.system[1].text);
	});

	it("replays the frozen OpenAI carrier while replacing instructions and the entire conversation", () => {
		const original = structuredClone(openAIShape);
		const built = {
			model: openAIShape.model,
			stream: true,
			instructions: SYSTEM_PROMPT,
			input: [{ type: "message", role: "user", content: [{ type: "input_text", text: USER_PROMPT }] }],
		};
		const replayed = replayOpenAIJudgePayload({
			shape: openAIShape,
			built,
			model: "gpt-5.6-sol",
			systemPrompt: SYSTEM_PROMPT,
		});

		expect(replayed.instructions).toBe(SYSTEM_PROMPT);
		expect(replayed.input).toEqual(built.input);
		expect(replayed.input).not.toEqual(openAIShape.input);
		expect(without(replayed, ["instructions", "input"])).toEqual(without(openAIShape, ["instructions", "input"]));
		expect(openAIShape).toEqual(original);
		expect(JSON.stringify(replayed)).not.toContain(original.instructions);
	});

	it("fails closed on provider, model, identity, and built-system drift", () => {
		expect(() => validatePiReplayShape({ provider: "anthropic", model: "claude-opus-4", shape: anthropicShape }))
			.toThrow(/does not match/);
		const wrongProviderShape = { ...anthropicShape, model: "gpt-5.6-sol" };
		expect(() => validatePiReplayShape({ provider: "openai-codex", model: "gpt-5.6-sol", shape: wrongProviderShape }))
			.toThrow(/OpenAI semantic fields|contains Anthropic/);
		const badIdentity = structuredClone(anthropicShape);
		badIdentity.system[0].text = "You are not the entitlement identity";
		expect(() => validatePiReplayShape({ provider: "anthropic", model: "claude-opus-5", shape: badIdentity }))
			.toThrow(/identity block/);
		expect(() => validatePiReplayShape({
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			reasoning: "low",
			shape: openAIShape,
		})).toThrow(/reasoning.*does not match/);
		expect(() => replayOpenAIJudgePayload({
			shape: openAIShape,
			built: { model: "gpt-5.6-sol", instructions: "wrong", input: [] },
			model: "gpt-5.6-sol",
			systemPrompt: SYSTEM_PROMPT,
		})).toThrow(/did not serialize/);
	});

	it("exports one deterministic full implementation hash", () => {
		expect(piReplayTransformHash()).toMatch(/^[a-f0-9]{64}$/);
		expect(piReplayTransformHash()).toBe(piReplayTransformHash());
	});
});

function fakePi(provider, calls, resultOverride = null) {
	const api = provider === "anthropic" ? "anthropic-messages" : "openai-codex-responses";
	const streamFn = (model, context, options) => {
		const built = provider === "anthropic"
			? {
					model: model.id,
					stream: true,
					system: [
						{ type: "text", text: ANTHROPIC_IDENTITY },
						{ type: "text", text: context.systemPrompt },
					],
					messages: structuredClone(context.messages),
				}
			: {
					model: model.id,
					stream: true,
					instructions: context.systemPrompt,
					input: structuredClone(context.messages),
				};
		const payload = options.onPayload(built);
		calls.push({ model, context: structuredClone(context), options: { ...options, apiKey: "<redacted>", onPayload: undefined }, payload });
		const raw = resultOverride ?? {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: '{"findings":[]}' }],
			usage: { input: 10, output: 2 },
		};
		return { result: async () => raw };
	};
	return {
		streamFn,
		resolveModelFn: (candidateProvider, id) => ({ provider: candidateProvider, id, api }),
	};
}

describe.each([
	{
		judgeName: "opus",
		provider: "anthropic",
		model: "claude-opus-5",
		reasoning: "high",
		shape: anthropicShape,
		shapeName: "anthropic-shape.json",
	},
	{
		judgeName: "sol",
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		reasoning: "high",
		shape: openAIShape,
		shapeName: "openai-shape.json",
	},
])("Pi replay judge transport: $judgeName", (spec) => {
	it("uses Pi's hook, keeps system/user roles separate, and preserves the real assistant correction role", async () => {
		const calls = [];
		const shapePayloadPath = shapeFile(spec.shapeName, spec.shape);
		const dependencies = fakePi(spec.provider, calls);
		const transport = await createPiReplayJudgeTransport({
			...spec,
			shape: undefined,
			shapePayloadPath,
			shapeArchive: "frozen/carriers.tar.gz",
			shapeMember: `payloads/${spec.shapeName}`,
			apiKey: FAKE_KEY,
			...dependencies,
		});
		const request = { systemPrompt: SYSTEM_PROMPT, userPrompt: USER_PROMPT };
		const first = await transport.ask(request);
		const second = await transport.ask(request, first);

		expect(first.text).toBe('{"findings":[]}');
		expect(second.error).toBeNull();
		expect(calls).toHaveLength(2);
		expect(calls[0].context.systemPrompt).toBe(SYSTEM_PROMPT);
		expect(calls[0].context.messages.map((message) => message.role)).toEqual(["user"]);
		expect(calls[1].context.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
		expect(calls[1].context.messages[1]).toEqual(first.raw);
		expect(calls[1].context.messages[2].content[0].text).toBe(PI_REPLAY_CORRECTION);
		expect(JSON.stringify(calls.map((call) => call.payload))).not.toContain(FAKE_KEY);
		expect(JSON.stringify(transport)).not.toContain(FAKE_KEY);
		expect(transport.shapeIdentity).toEqual({
			archive: "frozen/carriers.tar.gz",
			member: `payloads/${spec.shapeName}`,
			sha256: sha256Hex(Buffer.from(JSON.stringify(spec.shape))),
		});
		expect(transport.transformHash).toBe(piReplayTransformHash());
		expect(transport.routeIdentity).toMatchObject({ api: spec.provider === "anthropic" ? "anthropic-messages" : "openai-codex-responses" });
		expect(transport.routeIdentity.packageLockSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(calls[0].options.transport).toBe(spec.provider === "openai-codex" ? "websocket" : undefined);
		expect(calls[0].options.sessionId).toBe(spec.provider === "openai-codex" ? spec.shape.prompt_cache_key : undefined);
		expect(calls[0].options.maxTokens).toBe(spec.provider === "anthropic" ? spec.shape.max_tokens : undefined);
	});

	it("rejects a fabricated prior response before Pi is called", async () => {
		const calls = [];
		const dependencies = fakePi(spec.provider, calls);
		const transport = await createPiReplayJudgeTransport({
			...spec,
			shape: undefined,
			shapePayloadPath: shapeFile(`prior-${spec.shapeName}`, spec.shape),
			shapeArchive: "frozen/carriers.tar.gz",
			shapeMember: `payloads/prior-${spec.shapeName}`,
			apiKey: FAKE_KEY,
			...dependencies,
		});
		await expect(transport.ask(
			{ systemPrompt: SYSTEM_PROMPT, userPrompt: USER_PROMPT },
			{ raw: { role: "user", content: [] } },
		)).rejects.toThrow(/actual prior assistant/);
		expect(calls).toHaveLength(0);
	});

	it("marks tool calls and non-terminal provider stops invalid", async () => {
		for (const raw of [
			{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "read", arguments: {} }] },
			{ role: "assistant", stopReason: "length", content: [{ type: "text", text: '{"findings":[]}' }] },
		]) {
			const calls = [];
			const dependencies = fakePi(spec.provider, calls, raw);
			const tx = await createPiReplayJudgeTransport({
				...spec,
				shape: undefined,
				shapePayloadPath: shapeFile(`invalid-${raw.stopReason}-${spec.shapeName}`, spec.shape),
				shapeArchive: "frozen/carriers.tar.gz",
				shapeMember: `payloads/invalid-${spec.shapeName}`,
				apiKey: FAKE_KEY,
				...dependencies,
			});
			const result = await tx.ask({ systemPrompt: SYSTEM_PROMPT, userPrompt: USER_PROMPT });
			expect(result.invalid).toMatch(/unsupported-judge-tool-call|non-terminal-provider-stop/);
		}
	});
});

describe("Pi replay judge transport factory validation", () => {
	it("rejects a resolved provider API mismatch before any call", async () => {
		const calls = [];
		await expect(createPiReplayJudgeTransport({
			judgeName: "opus",
			provider: "anthropic",
			model: "claude-opus-5",
			reasoning: "high",
			shapePayloadPath: shapeFile("api-mismatch.json", anthropicShape),
			shapeArchive: "frozen/carriers.tar.gz",
			shapeMember: "payloads/api-mismatch.json",
			apiKey: FAKE_KEY,
			streamFn: () => { calls.push("called"); },
			resolveModelFn: () => ({ provider: "anthropic", id: "claude-opus-5", api: "openai-codex-responses" }),
		})).rejects.toThrow(/incompatible API/);
		expect(calls).toHaveLength(0);
	});
});
