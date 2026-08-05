/**
 * The recorded-payload replay instrument, driven end to end through a scripted
 * stream: no provider call, but the real merge path, the real ordering
 * composition and the real row schema. Zero provider calls.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPayload, recordedPoints, replay, summarize } from "./recorded-payload-cost.mjs";

const PAYLOAD = {
	model: "claude-opus-5",
	system: [{ type: "text", text: "driver system", cache_control: { type: "ephemeral" } }],
	messages: [
		{ role: "user", content: [{ type: "text", text: "driver task" }] },
		{ role: "assistant", content: [{ type: "text", text: "driver work" }] },
	],
	tools: [{ name: "read", description: "Read a file", input_schema: { type: "object", properties: {} } }],
	max_tokens: 32000,
};

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "replay-check-"));
	const payloadPath = join(dir, "point.json");
	writeFileSync(payloadPath, JSON.stringify(PAYLOAD));
	const observation = (pointId, pointIndex, arm) => ({
		kind: "observation",
		pointId,
		pointIndex,
		pointKind: "piggyback",
		runIndex: 0,
		requestIndex: pointIndex,
		prefixTokens: 4000 + pointIndex,
		capturedPayloadPath: payloadPath,
		capturedPayloadHash: "hash0",
		head: "quality",
		lens: "LENS",
		arm,
	});
	const rows = [
		observation("p0", 0, "MAIN"),
		observation("p0", 0, "F0"),
		observation("p1", 1, "MAIN"),
		{ ...observation("p2", 2, "MAIN"), pointKind: "run-end" },
	];
	return { dir, rows, output: join(dir, "out.jsonl") };
}

/**
 * Arms are identified by a marker their own contract carries — the rendered
 * prompt is the only thing the stream sees, which is also what makes this a
 * real exercise of the handoff path.
 */
const ARM_MARKERS = { F2: "do not deliberate", F1: "not the most actionable one", MAIN: "Side watcher. Reply with one JSON object" };

function armOf(text, arms) {
	const found = arms.find((arm) => text.includes(ARM_MARKERS[arm]));
	if (!found) throw new Error(`scripted stream could not identify the arm from the prompt`);
	return found;
}

/** A stream whose thinking varies by arm, so the C1 metric is observable. */
function scriptedStream(usageByArm) {
	const arms = Object.keys(usageByArm);
	return (model, context, options) => ({
		result: async () => {
			const arm = armOf(context.messages.at(-1).content[0].text, arms);
			// Exercise the merge exactly as the runner does.
			options.onPayload({ messages: context.messages });
			return {
				role: "assistant",
				content: [{ type: "text", text: `finding\n\nDELIVERY: none` }],
				stopReason: "stop",
				usage: { input: 2, output: 100, cacheRead: 4000, cacheWrite: 0, reasoning: usageByArm[arm], cost: { total: 0.01 } },
			};
		},
	});
}

/** A stream that models a cold prefix: the first call at a point writes, the rest read. */
function cachingStream() {
	const writtenFor = new Set();
	return (model, context, options) => ({
		result: async () => {
			const merged = options.onPayload({ messages: context.messages });
			const key = JSON.stringify(merged.messages.slice(0, -1));
			const isWriter = !writtenFor.has(key);
			writtenFor.add(key);
			return {
				role: "assistant",
				content: [{ type: "text", text: "DELIVERY: none" }],
				stopReason: "stop",
				usage: {
					input: 2,
					output: 100,
					cacheRead: isWriter ? 0 : 4000,
					cacheWrite: isWriter ? 4000 : 0,
					reasoning: 40,
					cost: { total: 0.02 },
				},
			};
		},
	});
}

test("recordedPoints keeps piggyback points, deduplicated, in order", () => {
	const { rows } = fixture();
	const points = recordedPoints(rows);
	assert.deepEqual(points.map((point) => point.pointId), ["p0", "p1"]);
	assert.equal(recordedPoints(rows, { pointKind: "run-end" }).length, 1);
});

test("loadPayload throws a useful error when the snapshot is gone", () => {
	assert.throws(
		() => loadPayload({ capturedPayloadPath: "/nonexistent/point.json" }),
		/recorded payload missing.*payloads\.tar\.gz/s,
	);
});

test("replay merges into the recorded payload and never rebuilds it", async () => {
	const { rows, output } = fixture();
	const seen = [];
	const stream = (model, context, options) => ({
		result: async () => {
			seen.push(options.onPayload({ messages: context.messages }));
			return {
				role: "assistant",
				content: [{ type: "text", text: "DELIVERY: none" }],
				stopReason: "stop",
				usage: { input: 2, output: 10, cacheRead: 4000, cacheWrite: 0, reasoning: 5, cost: { total: 0.001 } },
			};
		},
	});
	await replay({ rows, arms: ["MAIN"], config: "opus-high", output, apiKey: "fake", streamFn: stream, head: "quality" });
	assert.equal(seen.length, 2);
	for (const merged of seen) {
		// The driver's prefix is replayed byte-identically; only the tail is new.
		assert.deepEqual(merged.tools, PAYLOAD.tools);
		assert.deepEqual(merged.system, PAYLOAD.system);
		assert.deepEqual(merged.messages.slice(0, PAYLOAD.messages.length), PAYLOAD.messages);
		assert.equal(merged.messages.length, PAYLOAD.messages.length + 1);
	}
});

test("every arm at a point is charged the writer's cache write", async () => {
	const { rows, output } = fixture();
	const results = await replay({
		rows,
		arms: ["MAIN", "F1"],
		config: "opus-high",
		output,
		apiKey: "fake",
		streamFn: cachingStream(),
		head: "quality",
	});
	const written = readFileSync(output, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const observations = written.filter((row) => row.kind === "recorded-observation");
	assert.equal(observations.length, 4);
	for (const row of observations) {
		assert.equal(row.mTokens, observations.find((item) => item.pointId === row.pointId && item.armOrderIndex === 0).cacheWrite);
		assert.ok(row.composedCost > 0);
		assert.equal(typeof row.implementationArm, "string");
	}
	// Same composed cost for both arms at a point when their own usage matches:
	// the ordering artifact is removed, not averaged away.
	for (const pointId of ["p0", "p1"]) {
		const atPoint = observations.filter((row) => row.pointId === pointId);
		assert.equal(new Set(atPoint.map((row) => row.composedCost.toFixed(10))).size, 1, `${pointId}: ordering leaked into cost`);
	}
	assert.equal(results.length, 2);
});

test("summarize reports thinking per arm, which is the C1 metric", async () => {
	const { rows, output } = fixture();
	const results = await replay({
		rows,
		arms: ["MAIN", "F2"],
		config: "opus-high",
		output,
		apiKey: "fake",
		streamFn: scriptedStream({ MAIN: 20, F2: 400 }),
		head: "quality",
	});
	const summary = summarize(results);
	const main = summary.find((item) => item.arm === "MAIN");
	const framed = summary.find((item) => item.arm === "F2");
	assert.equal(main.n, 2);
	assert.equal(main.reasoning, 20);
	assert.equal(framed.reasoning, 400);
	assert.equal(main.answerTokens, 80);
});

test("unknown configs and empty point sets fail loudly", async () => {
	const { rows, output } = fixture();
	await assert.rejects(
		() => replay({ rows, arms: ["MAIN"], config: "gpt-9", output, apiKey: "fake", streamFn: scriptedStream({ MAIN: 1 }) }),
		/unknown config/,
	);
	await assert.rejects(
		() => replay({ rows: [], arms: ["MAIN"], config: "opus-high", output, apiKey: "fake", streamFn: scriptedStream({ MAIN: 1 }) }),
		/no piggyback observation points/,
	);
});
