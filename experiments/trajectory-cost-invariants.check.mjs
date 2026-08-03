/**
 * Invariants the trajectory cost benchmark must satisfy BEFORE any provider
 * spend (`artifacts/wave8-designs/wave8-benchmark.md:118-122`, spec §Execution
 * gates). Zero provider calls: importing the runner only pulls its pure helpers
 * in, because the matrix runs behind an entry-point guard.
 *
 * Six families: the four pre-registered invariants, the ground-truth deriver,
 * and one end-to-end pass of the whole live path against a scripted provider:
 *   1. the production merge leaves the captured prefix byte-true (piggyback) or
 *      byte-true modulo the one marker it is allowed to move (run-end);
 *   2. point enumeration reproduces production's firing rules on a recorded
 *      event log;
 *   3. lens and contract hash separately, so the arms vary the contract alone;
 *   4. the composed run-end accounting charges every arm one M write, and the
 *      live assertions catch each way it can go wrong;
 *   5. the ground-truth deriver finds the planted expression, ignores the bare
 *      identifier, and closes the window when the expression goes away;
 *   6. a full cell runs end to end — emit wiring, point enumeration inside the
 *      real agent loop, row assembly, composed accounting, resume — with the
 *      provider scripted, so the first live run is not the first run.
 *
 * Runs under `node --test`, like the other `*.check.mjs` guards: the runner is a
 * script, not a vitest module, and these must be runnable without the provider.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	buildEnumeratedJudgeObservationEnvelope,
	buildEnumeratedJudgeObservationPrompt,
	mergeObservationPayload,
} from "../utils.ts";
import { armHandoff, armSpec } from "./arm-registry.mjs";
import {
	ARMS,
	ARM_PROMPTS,
	OBSERVER_HEAD,
	OBSERVER_LENS,
	checkObservationRow,
	composeObservationCost,
	contractHash,
	contractRegion,
	createPointScheduler,
	enumerateObservationPoints,
	flatUsage,
	lensHash,
	parseEnumDecision,
	parseEnumSo2Decision,
	promptHash,
	rawCost,
	sumUsage,
} from "./trajectory-cost-ab.mjs";
import { MAIN_SO2 } from "./steer-only-variants.mjs";
import { EMPTY_DELIVERY_CONTEXT, handoffFor, mainSo2EnvelopeFrom } from "./trajectory-openai.mjs";
import { FIXTURE_PRICES } from "./costing.mjs";
import { deriveGroundTruth, defectStateInPayload, payloadChunks } from "./trajectory-ground-truth.mjs";
import { TRAJECTORY_TASKS, setupTask, taskById } from "./trajectory-cost-tasks.mjs";

// opus-5 prices as a frozen literal (`costing.mjs`), never the live catalog:
// an offline check must not depend on ~/.pi/agent/models-store.json.
const PRICES = FIXTURE_PRICES;

// ---------------------------------------------------------------------------
// 1. Merge byte-identity against a captured payload.
// ---------------------------------------------------------------------------

function capturedPayloadFixture() {
	return {
		model: "claude-opus-5",
		max_tokens: 8000,
		system: [{ type: "text", text: "You are pi.", cache_control: { type: "ephemeral", ttl: "1h" } }],
		tools: [{ name: "hydra", description: "wide schema", input_schema: { type: "object" } }],
		thinking: { type: "enabled", budget_tokens: 4000 },
		messages: [
			{ role: "user", content: [{ type: "text", text: "Read src/scheduler.js." }] },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "…" },
					{ type: "tool_use", id: "t1", name: "read", input: { path: "src/scheduler.js" } },
				],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "…file…" }], cache_control: { type: "ephemeral", ttl: "5m" } }],
			},
		],
	};
}

const promptMessage = { role: "user", content: [{ type: "text", text: ARM_PROMPTS.MAIN }] };
const finalAssistant = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "considered" },
		{ type: "text", text: "I rewrote the claim path." },
	],
};

test("a piggyback merge replays the captured prefix byte-for-byte", () => {
	const captured = capturedPayloadFixture();
	const before = JSON.stringify(captured);
	const merged = mergeObservationPayload(captured, [promptMessage], undefined);

	assert.equal(JSON.stringify(captured), before, "the captured payload must not be mutated");
	assert.equal(merged.messages.length, captured.messages.length + 1);
	assert.equal(
		JSON.stringify(merged.messages.slice(0, captured.messages.length)),
		JSON.stringify(captured.messages),
		"prefix bytes differ — the fork would not read the driver's cache entry",
	);
	// Nothing moves for a `[prompt]` tail (utils.ts:786-806), so the driver's own
	// markers are still exactly where the driver put them, TTL included.
	assert.deepEqual(merged.messages[2].content[0].cache_control, { type: "ephemeral", ttl: "5m" });
	assert.equal(merged.messages.at(-1).content[0].cache_control, undefined, "the observation prompt must stay uncached");
	for (const field of ["model", "max_tokens", "system", "tools", "thinking"]) {
		assert.equal(JSON.stringify(merged[field]), JSON.stringify(captured[field]), `${field} passed through modified`);
	}
});

test("a run-end merge moves exactly one marker, with the driver's TTL, onto M", () => {
	const captured = capturedPayloadFixture();
	const merged = mergeObservationPayload(captured, [finalAssistant, promptMessage], undefined);

	assert.equal(merged.messages.length, captured.messages.length + 2);
	// The prefix is byte-identical once the one marker the merge is allowed to
	// move is accounted for: that is the whole run-end write.
	const strippedPrefix = structuredClone(captured.messages);
	delete strippedPrefix[2].content[0].cache_control;
	assert.equal(JSON.stringify(merged.messages.slice(0, captured.messages.length)), JSON.stringify(strippedPrefix));

	const m = merged.messages[captured.messages.length];
	assert.equal(m.role, "assistant");
	// cache_control on a thinking block is an API error; the marker rides the
	// deepest MARKABLE block (utils.ts:758-770).
	assert.equal(m.content[0].cache_control, undefined);
	assert.deepEqual(m.content[1].cache_control, { type: "ephemeral", ttl: "5m" });
	assert.equal(merged.messages.at(-1).content[0].cache_control, undefined);
});

test("no arm asks for an envelope, and the merge would refuse a tail without a prompt", () => {
	const captured = capturedPayloadFixture();
	const merged = mergeObservationPayload(captured, [promptMessage], undefined);
	assert.ok(merged.messages.every((message) => message.role !== "system"), "an Anthropic arm injects no system message");
	assert.throws(() => mergeObservationPayload(captured, [finalAssistant], "envelope"), /no user prompt/);
});

// ---------------------------------------------------------------------------
// 2. Point enumeration against production's rules.
// ---------------------------------------------------------------------------

const assistantAt = (timestamp, extra = {}) => ({
	role: "assistant",
	timestamp,
	content: [{ type: "text", text: "ok" }],
	...extra,
});

function recordedRun(timestamps, { finalStopReason } = {}) {
	// One capture per request, one assistant message per capture, agent_end
	// carrying every message the run produced — the shape agent-loop.js emits.
	const events = [{ type: "agent_start" }];
	const messages = [];
	for (const [index, timestamp] of timestamps.entries()) {
		const isLast = index === timestamps.length - 1;
		const message = assistantAt(timestamp, isLast && finalStopReason ? { stopReason: finalStopReason } : {});
		messages.push(message);
		events.push({ type: "capture" }, { type: "message_end", message });
	}
	events.push({ type: "agent_end", messages });
	return events;
}

test("a run observes every assistant message except its first, plus one run-end", () => {
	const points = enumerateObservationPoints(recordedRun([10, 20, 30, 40]));
	assert.deepEqual(points.map((point) => point.kind), ["piggyback", "piggyback", "piggyback", "run-end"]);
	// K assistant messages produce K observations: K-1 piggybacks and one
	// run-end. That is the ceiling; production's conflating scheduler sheds ~20%
	// of it (wave8-mechanics.md:14), which is why the summarizer never reports a
	// bare R without the discounted forms.
	assert.equal(points.length, 4);
	assert.equal(points.filter((point) => point.kind === "run-end").length, 1);
});

test("a single-message run observes only at run-end", () => {
	assert.deepEqual(enumerateObservationPoints(recordedRun([10])).map((point) => point.kind), ["run-end"]);
});

test("run-end selects M by timestamp identity and refuses anything else", () => {
	// A later assistant message that is not the one this request produced makes
	// selectFinalAssistant return null (index.ts:1600-1603, utils.ts:631-652).
	const events = recordedRun([10, 20]);
	events.at(-1).messages.push(assistantAt(999));
	assert.deepEqual(enumerateObservationPoints(events).map((point) => point.kind), ["piggyback"]);

	// An error-terminated final message is not usable either.
	assert.deepEqual(
		enumerateObservationPoints(recordedRun([10, 20], { finalStopReason: "error" })).map((point) => point.kind),
		["piggyback"],
	);
});

test("consecutive runs each re-arm the first-response gate", () => {
	const points = enumerateObservationPoints([...recordedRun([10, 20]), ...recordedRun([30, 40, 50])]);
	assert.deepEqual(points.map((point) => point.kind), ["piggyback", "run-end", "piggyback", "piggyback", "run-end"]);
});

test("a run with no captured payload schedules nothing", () => {
	const scheduler = createPointScheduler();
	scheduler.onAgentStart();
	assert.equal(scheduler.onAssistantMessage(assistantAt(1)), null);
	assert.equal(scheduler.onAgentEnd([assistantAt(1)]), null);
});

// ---------------------------------------------------------------------------
// 3. Lens and contract hash separately.
// ---------------------------------------------------------------------------

test("the arms share one lens and differ only in the contract region", () => {
	assert.deepEqual(ARMS, ["MAIN", "J", "F", "F1", "F2", "F3", "ENUM", "MAIN-SO2", "ENUM-SO2"]);
	const lens = lensHash();
	for (const arm of ARMS) {
		assert.equal(ARM_PROMPTS[arm].split(OBSERVER_LENS).length - 1, 1, `${arm}: the lens must appear exactly once`);
		assert.ok(!contractRegion(arm).includes(OBSERVER_LENS), `${arm}: the lens leaked into the contract region`);
		assert.ok(contractRegion(arm).includes("<LENS>"));
		assert.equal(lensHash(), lens, "the lens hash must not depend on the arm");
	}
	const contracts = ARMS.map(contractHash);
	assert.equal(new Set(contracts).size, ARMS.length, "two arms share a contract hash");
	assert.equal(new Set(ARMS.map(promptHash)).size, ARMS.length);
	// The lens names no defect: a head that pre-targets the planted list would
	// make coverage meaningless (wave8-quality.md:15).
	const planted = TRAJECTORY_TASKS.flatMap((task) => task.defects);
	for (const defect of planted) {
		assert.ok(!OBSERVER_LENS.includes(defect.identifier), `the frozen lens names ${defect.identifier}`);
	}
	assert.ok(/QUALITY lens/.test(OBSERVER_LENS));
});

test("this harness's arms are the screen registry's arms under other names", () => {
	// `ARM_PROMPTS` is pre-rendered against the frozen generic lens and stays
	// that way: importing the screen producer would run its matrix. What must
	// not drift is the CONTRACT — "F" in this benchmark's report.json and "F" in
	// the screen's verdict.json have to be the same contract text, or the two
	// harnesses report one letter for two experiments.
	const equivalent = { MAIN: "screen-a0", J: "screen-json", F: "screen-footer", F1: "F1", F2: "F2", F3: "F3" };
	// ENUM is deliberately NOT a registry arm: it is a throwaway diagnostic
	// built by string surgery on MAIN (`enumerate-variants.mjs` header), and
	// registering it would drag a dead contract through every invariant suite.
	// So it is exempt from the registry-equivalence check and carries a
	// PROVENANCE assertion instead — it must still be MAIN plus exactly the two
	// documented edits, or it is a third unrelated contract wearing the name.
	const exempt = new Set(["ENUM", "MAIN-SO2", "ENUM-SO2"]);
	assert.deepEqual([...Object.keys(equivalent), ...exempt], [...ARMS]);
	assert.notEqual(ARM_PROMPTS.ENUM, ARM_PROMPTS.MAIN, "ENUM is byte-identical to MAIN — the grammar edit did not land");
	assert.ok(
		ARM_PROMPTS.ENUM.includes('{"findings":['),
		"ENUM lost its list grammar — it would no longer test enumeration",
	);
	assert.ok(
		ARM_PROMPTS.ENUM.includes("Do not rank them or pick one."),
		"ENUM lost its no-selection instruction",
	);
	assert.ok(
		!ARM_PROMPTS.ENUM.includes("Noop unless something warrants feedback."),
		"ENUM still carries MAIN's noop-unless routing — the routing edit did not land",
	);
	assert.equal(ARM_PROMPTS["MAIN-SO2"], MAIN_SO2, "MAIN-SO2 drifted from the frozen steer-only candidate");
	assert.equal(
		ARM_PROMPTS["ENUM-SO2"],
		buildEnumeratedJudgeObservationPrompt(OBSERVER_HEAD, OBSERVER_LENS, EMPTY_DELIVERY_CONTEXT),
		"ENUM-SO2 drifted from the current production combined handoff",
	);
	for (const [local, registryArm] of Object.entries(equivalent)) {
		const handoff = armHandoff(registryArm, "anthropic", {
			head: OBSERVER_HEAD,
			lens: OBSERVER_LENS,
			testCase: undefined,
		});
		assert.equal(ARM_PROMPTS[local], handoff.prompt, `${local} has drifted from the registry's ${registryArm}`);
		assert.equal(handoff.envelope, undefined, "Anthropic carries the whole handoff in one combined message");
	}
	// The surface differs deliberately and is recorded, not assumed: the screen
	// measures the management-only hydra schema, this benchmark replays the
	// driver's wide one for all three arms (TRAJECTORY-COST-SPEC.md).
	for (const registryArm of Object.values(equivalent)) {
		assert.equal(armSpec(registryArm).toolSurface, "management-only");
	}
});

test("the ENUM parser takes the most urgent action and keeps every finding", () => {
	// An empty list is a genuine noop, not a parse failure.
	assert.deepEqual(parseEnumDecision('{"findings":[]}'), {
		action: "noop",
		reason: "no findings",
		message: "",
		findings: [],
	});

	// The row's single delivery must be the MOST URGENT action in the batch: a
	// batch containing a steer interrupts the driver whatever else it carries.
	const mixed = parseEnumDecision(
		'{"findings":[{"action":"queue","reason":"r1","message":"m1"},{"action":"steer","reason":"r2","message":"m2"},{"action":"print","reason":"r3","message":"m3"}]}',
	);
	assert.equal(mixed.action, "steer");
	assert.equal(mixed.reason, "r2");
	// Every finding survives — coverage is read from the text, but the parsed
	// list must not silently drop the non-urgent ones either.
	assert.equal(mixed.findings.length, 3);
	assert.equal(mixed.message, "m1 | m2 | m3");

	// Fenced JSON is what a model actually emits often enough to matter.
	const fenced = parseEnumDecision('```json\n{"findings":[{"action":"print","reason":"r","message":"m"}]}\n```');
	assert.equal(fenced.action, "print");

	// Unparseable and wrong-shape replies return null so the caller can fail
	// open to a warned noop, exactly as MAIN's contract does.
	assert.equal(parseEnumDecision("not json at all"), null);
	assert.equal(parseEnumDecision('{"action":"steer","message":"m"}'), null, "MAIN's shape is not ENUM's shape");
	assert.equal(parseEnumDecision('{"findings":[{"action":"shout","message":"m"}]}'), null, "an out-of-enum action is a parse failure");
});

test("the SO2 OpenAI handoffs and mixed-delivery parser match production", () => {
	const spec = { provider: "openai-codex" };
	const main = armHandoff("screen-a0", "openai-codex", { head: OBSERVER_HEAD, lens: OBSERVER_LENS });
	const mainSo2 = handoffFor("MAIN-SO2", spec, {
		head: OBSERVER_HEAD,
		lens: OBSERVER_LENS,
		anthropicPrompt: ARM_PROMPTS["MAIN-SO2"],
	});
	assert.equal(mainSo2.prompt, OBSERVER_LENS);
	assert.equal(mainSo2.envelope, mainSo2EnvelopeFrom(main.envelope));
	assert.ok(!/queue/i.test(mainSo2.envelope));

	const enumSo2 = handoffFor("ENUM-SO2", spec, {
		head: OBSERVER_HEAD,
		lens: OBSERVER_LENS,
		anthropicPrompt: ARM_PROMPTS["ENUM-SO2"],
	});
	assert.equal(enumSo2.prompt, OBSERVER_LENS);
	assert.equal(
		enumSo2.envelope,
		buildEnumeratedJudgeObservationEnvelope(OBSERVER_HEAD, EMPTY_DELIVERY_CONTEXT),
	);

	const mixed = parseEnumSo2Decision(
		'{"findings":[{"action":"print","reason":"r1","message":"m1"},{"action":"steer","reason":"r2","message":"m2"}]}',
	);
	assert.equal(mixed.action, "steer");
	assert.deepEqual(mixed.deliveries.map((item) => item.action), ["print", "steer"]);
	assert.equal(mixed.findings.length, 2);
	assert.equal(parseEnumSo2Decision('{"findings":[{"action":"queue","message":"m"}]}'), null);
});

// ---------------------------------------------------------------------------
// 4. Composed run-end accounting and the live assertions.
// ---------------------------------------------------------------------------

const usage = (fields) => flatUsage({ cost: { total: 0 }, ...fields });

test("every arm at a run-end point is charged exactly one M write", () => {
	const prefix = 20_000;
	const mTokens = 1500;
	const writer = usage({ cacheRead: prefix, cacheWrite: mTokens, input: 400, output: 300 });
	const reader = usage({ cacheRead: prefix + mTokens, cacheWrite: 0, input: 400, output: 300 });

	const writerCost = composeObservationCost(writer, { mTokens, isWriter: true }, PRICES);
	const readerCost = composeObservationCost(reader, { mTokens, isWriter: false }, PRICES);
	const expected =
		(prefix * PRICES.cacheRead + mTokens * PRICES.cacheWrite + 400 * PRICES.input + 300 * PRICES.output) / 1e6;
	assert.equal(writerCost, expected);
	assert.equal(readerCost, expected);
	// Without the composition the readers look ~$0.009 cheaper on a 1.5k M —
	// pure firing order, which is exactly what must not reach a verdict.
	assert.ok(rawCost(reader, PRICES) < rawCost(writer, PRICES));
});

test("a piggyback composition is the raw price, and 1h writes are priced apart", () => {
	const piggyback = usage({ cacheRead: 12_000, cacheWrite: 0, input: 380, output: 260 });
	assert.equal(composeObservationCost(piggyback, { mTokens: 0, isWriter: true }, PRICES), rawCost(piggyback, PRICES));

	const oneHour = composeObservationCost(
		usage({ cacheRead: 5000, cacheWrite: 800, input: 100, output: 100 }),
		{ mTokens: 800, isWriter: true, m1hTokens: 800 },
		PRICES,
	);
	const fiveMinute = composeObservationCost(
		usage({ cacheRead: 5000, cacheWrite: 800, input: 100, output: 100 }),
		{ mTokens: 800, isWriter: true, m1hTokens: 0 },
		PRICES,
	);
	assert.ok(oneHour > fiveMinute);
	// Dollar sums are floats; compare to the sixteenth of a cent, not bit-exactly.
	assert.ok(Math.abs(oneHour - fiveMinute - (800 * (PRICES.cacheWrite1h - PRICES.cacheWrite)) / 1e6) < 1e-9);
});

test("a recovery turn is added at raw price and never folded into mTokens", () => {
	const first = usage({ cacheRead: 10_000, cacheWrite: 0, input: 380, output: 40 });
	const recovery = usage({ cacheRead: 10_000, cacheWrite: 500, input: 60, output: 200 });
	const composed = composeObservationCost(first, { mTokens: 0, isWriter: true }, PRICES, sumUsage([recovery]));
	assert.equal(composed, rawCost(first, PRICES) + rawCost(recovery, PRICES));
});

function observationRow(overrides) {
	return {
		pointKind: "piggyback",
		armOrderIndex: 0,
		capturedPayloadHash: "abc123",
		prefixTokens: 20_000,
		cacheRead: 20_000,
		cacheWrite: 0,
		cacheWrite1h: 0,
		mDelta: null,
		...overrides,
	};
}

test("the live assertions fail the row for each way cache parity can break", () => {
	const context = { driverPayloadHash: "abc123", driverUsed1h: false };
	assert.deepEqual(checkObservationRow(observationRow({}), context), []);
	assert.match(checkObservationRow(observationRow({ cacheWrite: 640 }), context)[0], /piggyback wrote 640/);
	assert.match(checkObservationRow(observationRow({ cacheRead: 18_000 }), context)[0], /below 0.95/);
	assert.match(
		checkObservationRow(observationRow({ capturedPayloadHash: "other" }), context)[0],
		/payload hash other != driver abc123/,
	);
	assert.match(checkObservationRow(observationRow({ cacheWrite1h: 12 }), context)[0], /unexpected 1h write/);
	assert.deepEqual(checkObservationRow(observationRow({ cacheWrite1h: 12 }), { ...context, driverUsed1h: true }), []);

	const runEndWriter = observationRow({ pointKind: "run-end", armOrderIndex: 0, cacheWrite: 1500, mDelta: null });
	assert.deepEqual(checkObservationRow(runEndWriter, context), []);
	assert.match(
		checkObservationRow({ ...runEndWriter, cacheWrite: 0 }, context)[0],
		/run-end writer wrote nothing/,
	);
	const runEndReader = observationRow({ pointKind: "run-end", armOrderIndex: 1, cacheRead: 21_500, mDelta: 0 });
	assert.deepEqual(checkObservationRow(runEndReader, context), []);
	assert.match(checkObservationRow({ ...runEndReader, cacheWrite: 700 }, context)[0], /run-end reader wrote 700/);
	assert.match(checkObservationRow({ ...runEndReader, mDelta: -320 }, context)[0], /delta -320/);
	// The cache floor covers run-end too: it is one point in four, and a miss
	// there is the same broken parity that makes the dollar figures meaningless.
	assert.match(checkObservationRow({ ...runEndWriter, cacheRead: 15_000 }, context)[0], /below 0.95/);
	assert.match(checkObservationRow({ ...runEndReader, cacheRead: 15_000 }, context)[0], /below 0.95/);
});

// ---------------------------------------------------------------------------
// 5. Ground truth on a fixture with known plant and fix points.
// ---------------------------------------------------------------------------

const DEFECT = taskById("scheduler").defects.find((defect) => defect.id === "sched-claim-toctou");
const DEFECT_LINE = '\t\tif (job.claimedBy === null) {';
const FIXED_LINE = "\t\tconst claimed = await store.compareAndClaim(job.id, worker);";

const payloadWith = (blocks) => ({ messages: [{ role: "user", content: blocks }] });
const toolResult = (text) => ({ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text }] });
const readOfFile = (body) => toolResult(`1\texport async function claimNext(store, worker) {\n2\t${body}\n3\t}`);

test("payload chunking separates a replacement from the text it replaced", () => {
	const payload = payloadWith([
		{
			type: "tool_use",
			id: "t",
			name: "edit",
			input: { path: "src/scheduler.js", edits: [{ oldText: DEFECT_LINE, newText: FIXED_LINE }] },
		},
	]);
	const chunks = payloadChunks(payload);
	assert.deepEqual(chunks.map((chunk) => [chunk.kind, chunk.authoritative]), [
		["edit-new", true],
		["edit-old", false],
	]);
	// The old text is where the defective expression lives while it is being
	// removed; counting it would make every fix read as a re-plant.
	assert.equal(defectStateInPayload(payload, DEFECT), null);
});

test("the bare identifier decides nothing; the expression opens a window and the declaration closes it", () => {
	// An import line, a doc sentence or a grep hit carries the name with none of
	// the body. Deciding "fixed" on any of them would end the window at the first
	// second file the driver opens — every planted anchor has such a line inside
	// the corpus itself — and the manufactured quiet span is exactly the length
	// the Q0a gate asks for.
	const importLine = payloadWith([toolResult('import { MAX_ATTEMPTS, claimNext, complete } from "./scheduler.js";')]);
	assert.equal(defectStateInPayload(importLine, DEFECT), null, "an identifier-only view must decide nothing");
	const prose = payloadWith([toolResult("The worker calls claimNext in a loop.")]);
	assert.equal(defectStateInPayload(prose, DEFECT), null, "a doc sentence naming the identifier decides nothing");
	const listing = payloadWith([toolResult("src/scheduler.js\nsrc/store.js\nsrc/worker.js")]);
	assert.equal(defectStateInPayload(listing, DEFECT), null, "ls reveals nothing about the expression");

	const read = payloadWith([readOfFile(DEFECT_LINE)]);
	assert.equal(defectStateInPayload(read, DEFECT).state, "live");
	// The declaration WITHOUT the defective expression is the one thing that
	// closes the window: the region was on screen and the defect was not in it.
	const fixedRead = payloadWith([readOfFile(FIXED_LINE)]);
	assert.equal(defectStateInPayload(fixedRead, DEFECT).state, "fixed");
});

test("an edit delivered in a legacy shape still registers as a fix", () => {
	// The edit tool normalizes `edits`-as-JSON-string and the singular
	// {oldText,newText} shape (pi-coding-agent/dist/core/tools/edit.js:33-49), so
	// both reach the workspace as real edits and both must reach the derivation.
	const declared = `export async function claimNext(store, worker) {\n${FIXED_LINE}\n}`;
	const asString = payloadWith([
		{ type: "tool_use", id: "t", name: "edit", input: { path: "src/scheduler.js", edits: JSON.stringify([{ oldText: DEFECT_LINE, newText: declared }]) } },
	]);
	assert.equal(defectStateInPayload(asString, DEFECT).state, "fixed");
	const legacySingular = payloadWith([
		{ type: "tool_use", id: "t", name: "edit", input: { path: "src/scheduler.js", oldText: DEFECT_LINE, newText: declared } },
	]);
	assert.equal(defectStateInPayload(legacySingular, DEFECT).state, "fixed");
});

test("firstVisible, firstFixed, liveness and quiet spans come out of the recorded points", () => {
	const files = (body) => ({ "src/scheduler.js": `export async function claimNext(store, worker) {\n${body}\n}\n` });
	const points = [
		{ pointIndex: 0, pointId: "p0", payload: payloadWith([toolResult("test/format.test.js\ndocs/scheduling.md")]), files: files(DEFECT_LINE) },
		{ pointIndex: 1, pointId: "p1", payload: payloadWith([toolResult("src/scheduler.js:8: claimNext")]), files: files(DEFECT_LINE) },
		{ pointIndex: 2, pointId: "p2", payload: payloadWith([readOfFile(DEFECT_LINE)]), files: files(DEFECT_LINE) },
		{ pointIndex: 3, pointId: "p3", payload: payloadWith([readOfFile(DEFECT_LINE)]), files: files(DEFECT_LINE) },
		{ pointIndex: 4, pointId: "p4", payload: payloadWith([readOfFile(FIXED_LINE)]), files: files(FIXED_LINE) },
		{ pointIndex: 5, pointId: "p5", payload: payloadWith([readOfFile(FIXED_LINE)]), files: files(FIXED_LINE) },
	];
	const derived = deriveGroundTruth(points, [DEFECT]);
	const defect = derived.defects[0];
	assert.equal(defect.firstVisible, 2);
	assert.equal(defect.firstFixed, 4);
	assert.deepEqual(defect.livenessWindow, [2, 4]);
	assert.equal(defect.firstVisibleFiles, 0, "the file state is live from the start; the payload is what the head saw");
	assert.equal(defect.firstFixedFiles, 4);
	// A planted defect is on disk from point 0 by construction, so comparing
	// firstVisible across the two derivations would mark every defect as
	// disagreeing. Only firstFixed alignment carries information, and it agrees.
	assert.equal(defect.agrees, true, "the fix indices align; the visibility offset is structural, not a disagreement");
	assert.deepEqual(derived.liveByPoint.map((entry) => entry.live.length), [0, 0, 1, 1, 0, 0]);
	assert.deepEqual(
		derived.quietSpans.map((span) => [span.from, span.to, span.length]),
		[
			[0, 1, 2],
			[4, 5, 2],
		],
	);
	assert.equal(derived.longestQuietSpan, 2);
});

// ---------------------------------------------------------------------------
// Corpus shape: the guards that keep the plant honest.
// ---------------------------------------------------------------------------

test("every planted expression occurs exactly once in the file it is planted in", async () => {
	const { mkdtempSync, readFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	assert.equal(TRAJECTORY_TASKS.length, 3);
	const ids = new Set();
	for (const task of TRAJECTORY_TASKS) {
		assert.ok(task.defects.length >= 3 && task.defects.length <= 4, `${task.id}: 3-4 defects`);
		assert.equal(task.prompts.length, 4, `${task.id}: four scripted prompts`);
		const root = mkdtempSync(join(tmpdir(), `hydra-traj-check-${task.id}-`));
		const { trackedPaths, seedManifest } = setupTask(task, root);
		assert.ok(seedManifest.reduce((total, entry) => total + entry.bytes, 0) > 50_000, "seeded subtree carries token mass");
		for (const defect of task.defects) {
			assert.equal(ids.has(defect.id), false, `duplicate defect id ${defect.id}`);
			ids.add(defect.id);
			assert.ok(trackedPaths.includes(defect.file));
			const source = readFileSync(join(root, defect.file), "utf8");
			assert.equal((source.match(new RegExp(defect.expression, "g")) ?? []).length, 1, `${defect.id}: expression is not unique`);
			assert.ok(new RegExp(defect.declaration).test(source), `${defect.id}: declaration does not match its own file`);
			assert.ok(source.includes(defect.identifier), `${defect.id}: identifier missing`);
			assert.ok(defect.target.length > 80, `${defect.id}: target string is too thin to score against`);
		}
		// No prompt may name a defect area: the driver must reach the defective
		// code by doing the work, never by being pointed at it.
		for (const prompt of task.prompts) {
			for (const defect of task.defects) {
				assert.ok(!prompt.includes(defect.identifier), `${task.id}: a prompt names ${defect.identifier}`);
			}
		}
		// The quiet stretch: prompt 1 must not name a file that carries a defect.
		const quiet = task.prompts[task.quietPromptIndex];
		for (const defect of task.defects) {
			assert.ok(!quiet.includes(defect.file), `${task.id}: the quiet prompt sends the driver into ${defect.file}`);
		}
	}
	assert.equal(ids.size, 10, "ten planted defects, one manual confirmation each (spec Q0a)");
});

test("the archetypes stay disjoint from the golden, development and screen corpora", async () => {
	const { SCREEN_FINDING_TARGETS } = await import("./delivery-context-screen-cases.mjs");
	const burned = [
		"x-forwarded-for",
		"incrWithTtl",
		"countInProcess",
		"rate limit",
		"limiter",
		"parameterize",
		"webhook signature",
		"revoke",
	];
	const planted = TRAJECTORY_TASKS.flatMap((task) => task.defects);
	for (const defect of planted) {
		for (const phrase of burned) {
			assert.ok(
				!defect.target.toLowerCase().includes(phrase.toLowerCase()),
				`${defect.id} re-imports a screened archetype (${phrase})`,
			);
		}
		for (const target of Object.values(SCREEN_FINDING_TARGETS)) {
			if (target) assert.notEqual(defect.target, target);
		}
	}
});

// ---------------------------------------------------------------------------
// 6. The whole live path, end to end, against a scripted provider. Still zero
// provider calls: `runCell`'s `streamFn` seam is not reachable from argv.
// ---------------------------------------------------------------------------

/** A driver payload in the shape the merge and the snapshots expect. */
function fakeDriverPayload(context, marked) {
	return {
		model: "claude-opus-5",
		system: [{ type: "text", text: context.systemPrompt ?? "" }],
		tools: (context.tools ?? []).map((tool) => ({ name: tool.name })),
		messages: (context.messages ?? []).map((message, index) => ({
			role: message.role === "assistant" ? "assistant" : "user",
			content: [
				{
					type: "text",
					text: JSON.stringify(message).slice(0, 4000),
					...(marked && index === (context.messages?.length ?? 0) - 1 ? { cache_control: { type: "ephemeral", ttl: "5m" } } : {}),
				},
			],
		})),
	};
}

function scriptedProvider() {
	const state = { driverCalls: 0, armCalls: 0, prefix: 0, mWritesByAnchor: new Map(), payloads: [] };
	const M_TOKENS = 1000;

	// Synchronous, like the real `streamSimple`: the arm path calls
	// `streamFn(...).result()` without awaiting the call itself.
	function streamFn(model, context, options) {
		const stream = createAssistantMessageEventStream();
		const isObservation = context.systemPrompt === "" && Array.isArray(context.tools) && context.tools.length === 0;
		let usage;
		let content;

		if (isObservation) {
			const tail = context.messages;
			const anchored = tail[0]?.role === "assistant";
			const key = anchored ? String(tail[0].timestamp) : `piggyback-${state.prefix}-${state.driverCalls}`;
			const seen = state.mWritesByAnchor.get(key) ?? 0;
			state.mWritesByAnchor.set(key, seen + 1);
			const writes = anchored && seen === 0;
			usage = {
				input: 380,
				output: 220,
				reasoning: 90,
				cacheRead: state.prefix + (anchored && !writes ? M_TOKENS : 0),
				cacheWrite: writes ? M_TOKENS : 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
			};
			const promptText = (tail.at(-1)?.content ?? []).map((block) => block.text ?? "").join("");
			const isFooterArm = promptText === ARM_PROMPTS.F;
			content = [
				{
					type: "text",
					text: isFooterArm
						? "The claim path reads and writes across an await.\nDELIVERY: steer"
						: '{"action":"steer","reason":"claim race","message":"Two workers can claim the same job."}',
				},
			];
			state.armCalls++;
			// The runner's onPayload returns the production merge; running it here
			// is what proves the merge is exercised on the live path, not only in
			// the fixture tests above.
			const merged = options?.onPayload?.({ messages: context.messages.map((message) => ({ role: message.role, content: message.content })) });
			assert.ok(merged?.messages?.length > 1, "the observation payload must be the merged driver prefix");
		} else {
			state.driverCalls++;
			state.prefix = 10_000 + state.driverCalls * 500;
			const payload = fakeDriverPayload(context, true);
			state.payloads.push(options?.onPayload?.(payload) ?? payload);
			usage = {
				input: 10,
				output: 900,
				reasoning: 400,
				cacheRead: state.prefix - 210,
				cacheWrite: 200,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.05 },
			};
			const step = state.driverCalls % 3;
			content =
				step === 1
					? [{ type: "toolCall", id: `t${state.driverCalls}`, name: "read", arguments: { path: "src/format.js" } }]
					: step === 2
						? [{ type: "toolCall", id: `t${state.driverCalls}`, name: "ls", arguments: { path: "." } }]
						: [{ type: "text", text: "Done." }];
		}

		const message = {
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: model?.id ?? "claude-opus-5",
			usage,
			stopReason: content[0].type === "toolCall" ? "toolUse" : "stop",
			timestamp: Date.now() + state.driverCalls * 1000 + state.armCalls,
		};
		stream.push({ type: "start", partial: { ...message, content: [] } });
		stream.push({ type: "done", message });
		return stream;
	}

	return { streamFn, state };
}

test("a full cell runs end to end: points, rows, composed costs and assertions", async () => {
	const { mkdtempSync, readFileSync, existsSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { runCell } = await import("./trajectory-cost-ab.mjs");

	const directory = mkdtempSync(join(tmpdir(), "hydra-traj-e2e-"));
	const outputPath = join(directory, "rows.jsonl");
	const payloadDir = join(directory, "payloads");
	const { streamFn, state } = scriptedProvider();

	// The runner narrates every point; a check that prints 12 of those buries its
	// own result.
	const [log, error] = [console.log, console.error];
	console.log = () => {};
	console.error = () => {};
	try {
		await runCell({
			task: taskById("scheduler"),
			config: "opus-high",
			attempt: 1,
			outputPath,
			payloadDir,
			requestedArms: ["MAIN", "J", "F"],
			maxTurnsPerRun: 8,
			driverMaxTokens: 8000,
			apiKey: "fake",
			streamFn,
		});
	} finally {
		console.log = log;
		console.error = error;
	}

	const rows = readFileSync(outputPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const kinds = (kind) => rows.filter((row) => row.kind === kind);
	assert.equal(kinds("cell-start").length, 1);
	assert.equal(kinds("cell-end").length, 1);

	// Four scripted prompts, three assistant messages each: two piggybacks and
	// one run-end per run, which is one observation per driver request.
	const driverTurns = kinds("driver-turn");
	assert.equal(driverTurns.length, state.driverCalls);
	assert.equal(driverTurns.length, 12);
	const points = [...new Set(kinds("observation").map((row) => row.pointId))];
	assert.equal(points.length, 12);
	assert.equal(kinds("observation").length, 36);
	assert.equal(kinds("file-state").length, 12);
	assert.deepEqual(
		[...new Set(kinds("observation").map((row) => row.pointKind))].sort(),
		["piggyback", "run-end"],
	);
	assert.equal(new Set(kinds("observation").filter((row) => row.pointKind === "run-end").map((row) => row.pointId)).size, 4);
	assert.equal(driverTurns.filter((row) => row.firstRequestOfRun).length, 4);

	// Every row passed the live assertions, and the payload each arm merged onto
	// is the one the driver's own request wrote.
	for (const row of kinds("observation")) {
		assert.deepEqual(row.assertionFailures, [], `${row.pointId} ${row.arm}: ${row.assertionFailures.join("; ")}`);
		assert.equal(row.valid, true);
		assert.ok(existsSync(row.capturedPayloadPath), "payload snapshot missing");
		const driverRow = driverTurns.find((turn) => turn.requestIndex === row.requestIndex);
		assert.equal(row.capturedPayloadHash, driverRow.payloadHash);
		assert.equal(row.decision.action, "steer");
		assert.equal(row.providerCalls, 1);
	}

	// The composed accounting removes the firing-order artifact: at a run-end
	// point all three arms pay the same M write despite only one of them writing.
	for (const pointId of points) {
		const armRows = kinds("observation").filter((row) => row.pointId === pointId);
		assert.equal(armRows.length, 3);
		assert.equal(new Set(armRows.map((row) => row.armOrderIndex)).size, 3);
		if (armRows[0].pointKind !== "run-end") continue;
		assert.equal(armRows.filter((row) => row.cacheWrite > 0).length, 1, "exactly one arm writes M");
		const composed = armRows.map((row) => row.composedCost);
		for (const value of composed) assert.ok(Math.abs(value - composed[0]) < 1e-12, "composed costs differ by firing order");
		const raw = armRows.map((row) => row.rawCost);
		assert.ok(Math.max(...raw) - Math.min(...raw) > 0, "the raw prices should differ, which is why composition exists");
	}

	// The driver really worked in the seeded workspace, and the file-state
	// timeline the ground truth needs came out of it.
	const seeded = kinds("cell-start")[0];
	assert.ok(seeded.trackedPaths.includes("src/scheduler.js"));
	assert.ok(kinds("file-state")[0].files["src/scheduler.js"].includes("claimNext"));
	assert.ok(!Object.keys(kinds("file-state")[0].files).some((path) => path.startsWith("reference/")), "the seeded subtree stays out of the timeline");
});

test("resume keeps only the attempt that reached cell-end", async () => {
	const { cellsOf } = await import("./trajectory-ground-truth.mjs");
	const rows = [
		{ kind: "cell-start", trajectoryId: "scheduler", config: "opus-high", attempt: 1 },
		{ kind: "observation", trajectoryId: "scheduler", config: "opus-high", attempt: 1, pointId: "lost" },
		{ kind: "cell-start", trajectoryId: "scheduler", config: "opus-high", attempt: 2 },
		{ kind: "observation", trajectoryId: "scheduler", config: "opus-high", attempt: 2, pointId: "kept" },
		{ kind: "cell-end", trajectoryId: "scheduler", config: "opus-high", attempt: 2 },
	];
	const cells = cellsOf(rows);
	assert.equal(cells.length, 1);
	assert.equal(cells[0].attempt, 2);
	assert.deepEqual(cells[0].rows.filter((row) => row.kind === "observation").map((row) => row.pointId), ["kept"]);
});
