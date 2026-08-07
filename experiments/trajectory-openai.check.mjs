/**
 * Pre-spend invariants for the OpenAI trajectory path. Zero provider calls.
 *
 * These exist because the Anthropic cache assertions do NOT port: there are no
 * `cache_control` markers on OpenAI, so "the observation rode the driver's
 * cache" has to be asserted a different way or the cost numbers are unfounded.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mergeOpenAIObservationPayload } from "../utils.ts";
import { armHandoff } from "./arm-registry.mjs";
import { CONFIGS, OBSERVER_HEAD, OBSERVER_LENS, ARM_PROMPTS } from "./trajectory-cost-ab.mjs";
import {
	OPENAI_CACHE_FLOOR,
	OPENAI_MIN_CACHEABLE_PREFIX,
	checkOpenAIObservationRow,
	composeOpenAIObservationCost,
	enumEnvelopeFrom,
	handoffFor,
	isCodex,
	providerOf,
} from "./trajectory-openai.mjs";

const SOL = CONFIGS["sol-high"];
const OPUS = CONFIGS["opus-high"];

test("the sol configs are codex and the opus configs are not", () => {
	assert.equal(isCodex(SOL), true);
	assert.equal(isCodex(CONFIGS["sol-xhigh"]), true);
	assert.equal(isCodex(OPUS), false);
	assert.equal(providerOf(SOL), "openai-codex");
	assert.equal(providerOf(OPUS), "anthropic");
});

test("Anthropic handoffs are unchanged — the combined prompt, no envelope", () => {
	for (const arm of ["MAIN", "F2", "ENUM"]) {
		const handoff = handoffFor(arm, OPUS, {
			head: OBSERVER_HEAD,
			lens: OBSERVER_LENS,
			anthropicPrompt: ARM_PROMPTS[arm],
		});
		assert.equal(handoff.prompt, ARM_PROMPTS[arm], `${arm}: Anthropic prompt must be byte-identical`);
		assert.equal(handoff.envelope, undefined, `${arm}: Anthropic sends no envelope`);
	}
});

test("OpenAI handoffs split: the prompt is the raw lens, the contract is the envelope", () => {
	for (const arm of ["MAIN", "F2", "ENUM"]) {
		const handoff = handoffFor(arm, SOL, {
			head: OBSERVER_HEAD,
			lens: OBSERVER_LENS,
			anthropicPrompt: ARM_PROMPTS[arm],
		});
		assert.equal(handoff.prompt, OBSERVER_LENS, `${arm}: the user prompt is the raw lens`);
		assert.ok(handoff.envelope && handoff.envelope.length > 100, `${arm}: the contract rides the envelope`);
		// The lens must not ALSO be inside the envelope: that would send it twice
		// and make the OpenAI contract text differ from the Anthropic one by more
		// than the packaging.
		assert.ok(!handoff.envelope.includes(OBSERVER_LENS), `${arm}: the lens leaked into the envelope`);
	}
});

test("ENUM's OpenAI envelope is MAIN's with exactly the two documented edits", () => {
	const main = armHandoff("screen-a0", "openai-codex", { head: OBSERVER_HEAD, lens: OBSERVER_LENS });
	const enumEnvelope = enumEnvelopeFrom(main.envelope);
	// The list grammar arrived and the single-action grammar left.
	assert.ok(enumEnvelope.includes('{"findings":['), "the findings-list grammar is present");
	assert.ok(!enumEnvelope.includes('"action":"noop|print'), "the single-action grammar survived");
	assert.ok(enumEnvelope.includes("Do not rank them or pick one"), "the no-selection instruction is present");
	assert.ok(!enumEnvelope.includes("Noop unless something warrants feedback."), "the noop-unless routing survived");
	// Everything else is untouched: same length modulo the two swaps.
	const expected = main.envelope.length
		- '{"action":"noop|print|queue|steer|interrupt","reason":"≤120 chars","message":"≤240 chars, empty if noop"}'.length
		+ '{"findings":[{"action":"print|queue|steer|interrupt","reason":"≤120 chars","message":"≤240 chars"}]}'.length
		- "Noop unless something warrants feedback.".length
		+ "List every finding the lens surfaces, each as its own entry with its own action; empty findings array if none. Do not rank them or pick one."
			.length;
	assert.equal(enumEnvelope.length, expected, "ENUM's envelope differs from MAIN's by more than the two edits");
});

test("a bad anchor throws rather than silently producing a wrong contract", () => {
	assert.throws(() => enumEnvelopeFrom("nothing to edit here"), /anchor not found/);
});

// ---------------------------------------------------------------------------
// The production merge, on an OpenAI-shaped payload.
// ---------------------------------------------------------------------------

function capturedOpenAI() {
	return {
		model: "gpt-5.6-sol",
		input: [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "Add stats()." }] },
			{ type: "function_call", name: "read", arguments: '{"path":"src/scheduler.js"}', call_id: "c1" },
			{ type: "function_call_output", call_id: "c1", output: "…file…" },
		],
		tools: [{ type: "function", name: "read" }],
		prompt_cache_key: "sess-1",
	};
}

test("the OpenAI merge appends the tail and leaves the captured prefix intact", () => {
	const captured = capturedOpenAI();
	const before = JSON.stringify(captured);
	const tail = [{ type: "message", role: "user", content: [{ type: "input_text", text: "LENS" }] }];
	const merged = mergeOpenAIObservationPayload(captured, tail, "ENVELOPE TEXT");

	assert.equal(JSON.stringify(captured), before, "the captured payload must not be mutated");
	assert.equal(
		JSON.stringify(merged.input.slice(0, captured.input.length)),
		JSON.stringify(captured.input),
		"prefix bytes differ — the observation would not read the driver's cache",
	);
	assert.equal(merged.prompt_cache_key, "sess-1", "the driver's cache key must survive");
});

test("the envelope lands as a developer message immediately after the user prompt", () => {
	const captured = capturedOpenAI();
	const tail = [{ type: "message", role: "user", content: [{ type: "input_text", text: "LENS" }] }];
	const merged = mergeOpenAIObservationPayload(captured, tail, "ENVELOPE TEXT");

	const added = merged.input.slice(captured.input.length);
	assert.equal(added.length, 2, "user prompt plus developer envelope");
	assert.equal(added[0].role, "user");
	assert.equal(added[1].role, "developer");
	assert.equal(added[1].content[0].text, "ENVELOPE TEXT");
});

test("a tail with no user prompt is refused, not silently sent unenveloped", () => {
	const captured = capturedOpenAI();
	assert.throws(
		() => mergeOpenAIObservationPayload(captured, [{ type: "function_call_output", call_id: "x", output: "y" }], "ENV"),
		/no user prompt/,
	);
});

// ---------------------------------------------------------------------------
// Assertions and cost.
// ---------------------------------------------------------------------------

const row = (over = {}) => ({
	capturedPayloadHash: "abc",
	prefixTokens: 20000,
	cacheRead: 19800,
	cacheWrite: 0,
	input: 400,
	output: 200,
	...over,
});

test("the floor is OpenAI-calibrated, not Anthropic's 0.95", () => {
	// Measured: healthy sol rows sit at 87.3-99.2% because OpenAI caches in
	// 128-token blocks and the driver's newest turn is not yet cached. 0.95
	// would fail healthy rows; 0 would assert nothing.
	assert.equal(OPENAI_CACHE_FLOOR, 0.8);
	const healthy = row({ prefixTokens: 12849, cacheRead: 11776 }); // 91.6%, real
	assert.deepEqual(checkOpenAIObservationRow(healthy, { driverPayloadHash: "abc" }), []);
});

test("the cache floor fires when an observation is not riding the driver's cache", () => {
	assert.deepEqual(checkOpenAIObservationRow(row(), { driverPayloadHash: "abc" }), []);
	const missed = checkOpenAIObservationRow(row({ cacheRead: 0 }), { driverPayloadHash: "abc" });
	assert.equal(missed.length, 1);
	assert.match(missed[0], /not riding the driver's cache/);
});

test("the floor is not applicable below OpenAI's caching minimum", () => {
	const short = row({ prefixTokens: OPENAI_MIN_CACHEABLE_PREFIX - 1, cacheRead: 0 });
	assert.deepEqual(checkOpenAIObservationRow(short, { driverPayloadHash: "abc" }), []);
});

test("a payload-hash mismatch fails the row", () => {
	const bad = checkOpenAIObservationRow(row(), { driverPayloadHash: "different" });
	assert.equal(bad.length, 1);
	assert.match(bad[0], /payload hash/);
});

test("OpenAI cost charges cacheRead, input and output — never a cache write", () => {
	const prices = { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 };
	const usage = { cacheRead: 20000, input: 400, output: 200, cacheWrite: 5000, reasoning: 0 };
	const expected = (20000 * 0.5 + 400 * 5 + 200 * 30) / 1e6;
	assert.equal(composeOpenAIObservationCost(usage, prices), expected);
	// The reported-but-unbilled cacheWrite must not enter the charge.
	const withWrite = composeOpenAIObservationCost({ ...usage, cacheWrite: 50000 }, prices);
	assert.equal(withWrite, expected, "cacheWrite must not be charged on OpenAI");
});
