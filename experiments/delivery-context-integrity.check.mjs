/**
 * The two harness invariants that live between modules rather than inside one:
 * the judge and the summarizer must decide "which rows owe which judgments"
 * from one predicate over one snapshot, and every category the corpora use must
 * be classified by the taxonomy the summarizer's category metrics read.
 *
 * Runs under `node --test`; zero provider calls.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
	FOLLOWUP_CATEGORIES,
	KNOWN_CATEGORIES,
	UNMETERED_CATEGORIES,
	WAITING_CATEGORIES,
	categoryClass,
} from "./delivery-context-evaluation.mjs";
import {
	assertNoSnapshotDrift,
	hasRoutedMessage,
	isJudgeable,
	judgeableMetrics,
	observationSucceeded,
	routedRow,
	snapshotDrift,
} from "./delivery-context-judgeable.mjs";
import { GOLDEN_CASES } from "./delivery-context-golden-cases.mjs";
import { DEVELOPMENT_CASES } from "./delivery-context-development-cases.mjs";
import { SCREEN_CASES } from "./delivery-context-screen-cases.mjs";
import { USER_ACTOR_CASES } from "./delivery-context-user-actor-cases.mjs";

const ALL_CASES = [...GOLDEN_CASES, ...DEVELOPMENT_CASES, ...SCREEN_CASES, ...USER_ACTOR_CASES];

function row(overrides = {}) {
	return {
		model: "sonnet-medium",
		case: "webhook-security-fresh",
		sample: 1,
		arm: "F",
		completionValid: true,
		delivery: "steer",
		message: "Verify the webhook signature.",
		expectedDelivery: "steer",
		category: "fresh",
		...overrides,
	};
}

test("a feedback row owes support and target; a quiet row that routed owes repeat", () => {
	assert.deepEqual(judgeableMetrics(row()), ["support", "target"]);
	assert.deepEqual(judgeableMetrics(row({ expectedDelivery: "none", category: "visible-no-response" })), ["repeat"]);
	assert.equal(isJudgeable(row(), "support"), true);
	assert.equal(isJudgeable(row(), "repeat"), false);
	assert.equal(isJudgeable(row({ expectedDelivery: "none" }), "repeat"), true);
	assert.equal(isJudgeable(row({ expectedDelivery: "none" }), "support"), false);
});

test("nothing is owed by a row that routed nothing, said nothing, or failed", () => {
	assert.deepEqual(judgeableMetrics(row({ delivery: "none", message: "" })), []);
	assert.deepEqual(judgeableMetrics(row({ message: "   " })), []);
	assert.deepEqual(judgeableMetrics(row({ message: undefined })), []);
	assert.deepEqual(judgeableMetrics(row({ completionValid: false })), []);
	assert.deepEqual(judgeableMetrics(row({ error: "provider stream error" })), []);
	// A quiet case that stayed quiet is the pass condition, not an unjudged row.
	assert.deepEqual(judgeableMetrics(row({ expectedDelivery: "none", delivery: "none", message: "" })), []);
});

test("the predicate reads the row snapshot, not the live corpus", () => {
	// This is the whole point of the shared module: the same row, judged from
	// its own snapshot, gets the same answer wherever it is read.
	const quietSnapshot = row({ expectedDelivery: "none" });
	assert.deepEqual(judgeableMetrics(quietSnapshot), ["repeat"]);
	assert.equal(observationSucceeded(quietSnapshot), true);
	assert.equal(routedRow(quietSnapshot), true);
	assert.equal(hasRoutedMessage(quietSnapshot), true);
});

test("a row whose snapshot no longer matches the corpus is named, not silently re-bucketed", () => {
	const caseById = new Map([["c1", { id: "c1", expectedDelivery: "steer", category: "fresh" }]]);
	assert.deepEqual(snapshotDrift([row({ case: "c1" })], caseById), []);
	assert.deepEqual(
		snapshotDrift([row({ case: "c1", expectedDelivery: "none" })], caseById),
		["c1: row says none, corpus says steer"],
	);
	assert.deepEqual(
		snapshotDrift([row({ case: "c1", category: "user-only" })], caseById),
		["c1: row category user-only, corpus says fresh"],
	);
	assert.throws(
		() => assertNoSnapshotDrift([row({ case: "c1", expectedDelivery: "none" })], caseById),
		/disagree with the live corpus/,
	);
	assert.doesNotThrow(() => assertNoSnapshotDrift([row({ case: "c1" })], caseById));
	// A row naming a case this reader cannot load is a separate error, raised by
	// the caller; drift reports only rows it can actually compare.
	assert.deepEqual(snapshotDrift([row({ case: "absent" })], caseById), []);
});

test("every producer row of the frozen corpora agrees with itself under the predicate", () => {
	// The corpora are the fixture: for each case, the two snapshots the harness
	// can produce must land in exactly one metric family.
	for (const testCase of ALL_CASES) {
		const routed = row({
			case: testCase.id,
			expectedDelivery: testCase.expectedDelivery,
			category: testCase.category,
		});
		const metrics = judgeableMetrics(routed);
		assert.deepEqual(
			metrics,
			testCase.expectedDelivery === "none" ? ["repeat"] : ["support", "target"],
			`${testCase.id}: metric family disagrees with expectedDelivery`,
		);
	}
});

test("the category taxonomy classifies every category the corpora use", () => {
	const used = [...new Set(ALL_CASES.map((item) => item.category))].sort();
	const unclassified = used.filter((category) => categoryClass(category) === "unclassified");
	assert.deepEqual(unclassified, [], `categories in no taxonomy class: ${unclassified.join(", ")}`);
	assert.deepEqual(used.filter((category) => !KNOWN_CATEGORIES.includes(category)), []);
});

test("the three taxonomy classes are disjoint and name their own metric", () => {
	const all = [...WAITING_CATEGORIES, ...FOLLOWUP_CATEGORIES, ...UNMETERED_CATEGORIES];
	assert.equal(new Set(all).size, all.length, "a category is in two classes");
	assert.deepEqual([...all].sort(), [...KNOWN_CATEGORIES]);
	for (const category of WAITING_CATEGORIES) assert.equal(categoryClass(category), "waiting");
	for (const category of FOLLOWUP_CATEGORIES) assert.equal(categoryClass(category), "followup");
	for (const category of UNMETERED_CATEGORIES) assert.equal(categoryClass(category), "unmetered");
	// A category authored into a fresh case and into no class is the failure the
	// two former string sets could not express.
	assert.equal(categoryClass("print-channel-user-action"), "unclassified");
	assert.equal(categoryClass(undefined), "unclassified");
});
