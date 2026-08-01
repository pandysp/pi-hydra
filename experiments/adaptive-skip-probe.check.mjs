/**
 * Offline guards for the adaptive-skip probe (`ADAPTIVE-SKIP-SPEC.md`). Zero
 * provider calls: `probe()` takes an injected `streamFn`, and the CLI sits
 * behind an entry-point guard.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRow, contingency, deliveryOf, distributions, pointsFrom, probe, shuffled } from "./adaptive-skip-probe.mjs";
import { FIXTURE_PRICES } from "./costing.mjs";

const PRICES = FIXTURE_PRICES;

function payloadFixture(path) {
	writeFileSync(
		path,
		JSON.stringify({
			model: "claude-opus-5",
			max_tokens: 8000,
			system: [{ type: "text", text: "You are pi." }],
			tools: [{ name: "hydra", description: "wide", input_schema: { type: "object" } }],
			messages: [
				{ role: "user", content: [{ type: "text", text: "Read src/scheduler.js." }] },
				{ role: "assistant", content: [{ type: "text", text: "read it" }] },
			],
		}),
	);
	return path;
}

function rowsFixture(dir) {
	const points = [
		{ pointId: "t/0", pointIndex: 0, pointKind: "piggyback", prefixTokens: 4000 },
		{ pointId: "t/1", pointIndex: 1, pointKind: "run-end", prefixTokens: 4000 },
		{ pointId: "t/2", pointIndex: 2, pointKind: "piggyback", prefixTokens: 20000 },
	];
	return points.map((point, index) => ({
		kind: "observation",
		...point,
		capturedPayloadPath: payloadFixture(join(dir, `p${index}.json`)),
		capturedPayloadHash: `hash${index}`,
	}));
}

// A scripted provider: variant "think" reasons, variant "skip" does not, so the
// probe's own bookkeeping is testable without a model.
function scriptedStream(seen) {
	return (_model, context, options) => {
		const text = context.messages[0].content[0].text;
		if (options?.onPayload) options.onPayload({ messages: context.messages });
		const reasoning = text.includes("THINK") ? 512 : 0;
		seen.push(text);
		return {
			result: async () => ({
				content: [{ type: "text", text: "DELIVERY: none" }],
				stopReason: "stop",
				usage: { input: 10, output: reasoning + 40, reasoning, cacheRead: 3900, cacheWrite: 0, cost: { total: 0.01 } },
			}),
		};
	};
}

test("point selection honours kind and explicit ids", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "skip-check-"));
	const rows = rowsFixture(dir);
	assert.deepEqual(pointsFrom(rows).map((p) => p.pointId), ["t/0", "t/2"]);
	assert.deepEqual(pointsFrom(rows, { pointKinds: "all" }).map((p) => p.pointId), ["t/0", "t/1", "t/2"]);
	assert.deepEqual(pointsFrom(rows, { pointKinds: "all", pointIds: ["t/1"] }).map((p) => p.pointId), ["t/1"]);
});

test("a row carries the metric, the raw reasoning count and the variant identity", () => {
	const point = { pointId: "t/0", pointIndex: 0, pointKind: "piggyback", prefixTokens: 4000, capturedPayloadHash: "h" };
	const usage = { input: 10, output: 552, reasoning: 512, cacheRead: 3900, cacheWrite: 0 };
	const row = buildRow({ header: { runId: "r" }, point, variantId: "v", prompt: "PROMPT", sample: 1, usage, response: null, error: null, ms: 5, prices: PRICES });
	assert.equal(row.kind, "skip-probe");
	assert.equal(row.variantId, "v");
	assert.equal(row.reasoning, 512);
	assert.equal(row.thinkingSkipped, false);
	assert.equal(row.promptChars, 6);
	assert.ok(row.promptHash.length === 16);

	const skipped = buildRow({ header: {}, point, variantId: "v", prompt: "P", sample: 1, usage: { ...usage, reasoning: 0, output: 40 }, response: null, error: null, ms: 5, prices: PRICES });
	assert.equal(skipped.thinkingSkipped, true);
	assert.equal(skipped.reasoning, 0);

	// An errored call must never read as a skip: null, not true.
	const failed = buildRow({ header: {}, point, variantId: "v", prompt: "P", sample: 1, usage: null, response: null, error: "boom", ms: 5, prices: PRICES });
	assert.equal(failed.thinkingSkipped, null);
	assert.equal(failed.reasoning, null);
	assert.equal(failed.cost, null);
});

test("arbitrary prompt strings are what reaches the provider, unwrapped", async () => {
	const dir = mkdtempSync(join(tmpdir(), "skip-check-"));
	const rows = rowsFixture(dir);
	const output = join(dir, "rows.jsonl");
	const seen = [];
	await probe({
		rows,
		variants: { skip: "PLAIN CONTRACT", think: "CONTRACT WITH THINK" },
		config: "opus-high",
		output,
		pointIds: ["t/0"],
		streamFn: scriptedStream(seen),
		random: () => 0,
	});
	assert.ok(seen.includes("PLAIN CONTRACT"), "the variant string must reach the provider verbatim");
	assert.ok(seen.includes("CONTRACT WITH THINK"));
});

test("the distribution reports mean, median and raw values, not only the skip rate", async () => {
	const dir = mkdtempSync(join(tmpdir(), "skip-check-"));
	const rows = rowsFixture(dir);
	const output = join(dir, "rows.jsonl");
	const collected = await probe({
		rows,
		variants: { skip: "PLAIN", think: "THINK" },
		config: "opus-high",
		output,
		samples: 2,
		streamFn: scriptedStream([]),
		random: () => 0,
	});
	const stats = distributions(collected);
	const skip = stats.find((item) => item.variantId === "skip");
	const think = stats.find((item) => item.variantId === "think");

	assert.equal(skip.n, 4, "2 piggyback points x 2 samples");
	assert.deepEqual(skip.values, [0, 0, 0, 0]);
	assert.equal(skip.meanReasoning, 0);
	assert.equal(skip.medianReasoning, 0);
	assert.equal(skip.skips, 4);

	assert.deepEqual(think.values, [512, 512, 512, 512]);
	assert.equal(think.meanReasoning, 512);
	assert.equal(think.medianReasoning, 512);
	assert.equal(think.skipRate, 0);
	// Raw values must survive the summary: the shape of the distribution is the
	// finding under test, so nothing may collapse it to a rate.
	assert.equal(think.values.length, think.n);
});

test("errored calls leave the distribution rather than counting as skips", () => {
	const base = { kind: "skip-probe", variantId: "v", pointIndex: 0, sample: 1, cost: 0.01 };
	const stats = distributions([
		{ ...base, reasoning: 0, thinkingSkipped: true, error: null },
		{ ...base, reasoning: 600, thinkingSkipped: false, error: null },
		{ ...base, reasoning: null, thinkingSkipped: null, error: "transport" },
	]);
	assert.equal(stats[0].n, 2);
	assert.deepEqual(stats[0].values, [0, 600]);
	assert.equal(stats[0].skips, 1);
});

test("delivery parses out of both grammars and normalises noop to none", () => {
	// MAIN answers in JSON, the envelope arms with a footer; Q5 needs one
	// vocabulary across both.
	assert.equal(deliveryOf('{"action":"noop","reason":"nothing","message":""}'), "none");
	assert.equal(deliveryOf('{"action":"queue","reason":"r","message":"m"}'), "queue");
	assert.equal(deliveryOf("Stranded pending jobs are invisible in stats().\nDELIVERY: queue"), "queue");
	assert.equal(deliveryOf("DELIVERY: none"), "none");
	assert.equal(deliveryOf("The retry loop re-POSTs a charge.\nDELIVERY: steer"), "steer");
	assert.equal(deliveryOf(""), null);
	assert.equal(deliveryOf(null), null);
	assert.equal(deliveryOf("no decision here at all"), null);
});

test("the Q5 contingency table counts cells, and errored rows never enter it", () => {
	const base = { kind: "skip-probe", variantId: "MAIN", error: null };
	const rows = [
		{ ...base, reasoning: 0, delivery: "none", prefixTokens: 4000 },
		{ ...base, reasoning: 0, delivery: "queue", prefixTokens: 4000 },
		{ ...base, reasoning: 0, delivery: "queue", prefixTokens: 20000 },
		{ ...base, reasoning: 680, delivery: "steer", prefixTokens: 20000 },
		{ ...base, reasoning: 210, delivery: "steer", prefixTokens: 37000 },
		{ ...base, reasoning: null, delivery: null, prefixTokens: 37000, error: "transport" },
	];

	const byDelivery = contingency(rows, { by: "delivery" });
	const steer = byDelivery.find((cell) => cell.bucket === "steer");
	const queue = byDelivery.find((cell) => cell.bucket === "queue");
	assert.equal(steer.n, 2);
	assert.equal(steer.skipped, 0);
	assert.equal(steer.thought, 2);
	assert.equal(steer.skipRate, 0);
	assert.equal(queue.skipRate, 1);
	assert.equal(byDelivery.reduce((sum, cell) => sum + cell.n, 0), 5, "the errored row must be excluded");

	const byPrefix = contingency(rows, { by: "prefix" });
	assert.deepEqual(byPrefix.map((cell) => cell.bucket).sort(), ["long(>30k)", "mid(10-30k)", "short(<10k)"]);
	assert.equal(byPrefix.find((cell) => cell.bucket === "short(<10k)").skipRate, 1);
});

test("shuffled is a permutation", () => {
	const input = ["a", "b", "c", "d"];
	const out = shuffled(input, () => 0.5);
	assert.equal(out.length, 4);
	assert.deepEqual([...out].sort(), [...input].sort());
	assert.deepEqual(input, ["a", "b", "c", "d"], "the input must not be mutated");
});

test("a nonce makes the prompt unique without altering the variant body", async () => {
	const dir = mkdtempSync(join(tmpdir(), "skip-check-"));
	const rows = rowsFixture(dir);
	const output = join(dir, "rows.jsonl");
	const seen = [];
	const collected = await probe({
		rows,
		variants: { v: "BODY" },
		config: "opus-high",
		output,
		pointIds: ["t/0"],
		nonceMode: true,
		streamFn: scriptedStream(seen),
		random: () => 0.5,
	});
	assert.ok(seen[0].startsWith("BODY"), "the variant body must be preserved verbatim");
	assert.ok(seen[0].includes("probe nonce"));
	assert.ok(collected[0].nonce);
	const written = readFileSync(output, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(written[0].kind, "skip-probe-header");
	assert.equal(written[1].kind, "skip-probe");
});
