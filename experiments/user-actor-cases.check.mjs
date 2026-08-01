/**
 * Corpus invariants for the fresh user-actor family (phase 1 of the envelope
 * repair, `ENVELOPE-REPAIR-SPEC.md`).
 *
 * These are the leakage-hunt findings turned into assertions. Two of them are
 * corpus-wide and matter more than any per-case check: the delivery classes must
 * not be separable by a lexical marker (an arm could route the whole family on
 * the token "complete" without doing any actor reasoning), and no driver turn
 * may state the REMEDY. The second is the confound that disqualifies
 * `dev-security-user-only` from gating anything, and it is the reason this
 * corpus exists at all.
 *
 * Ported from the curation pass's standalone checker; the manifest pin is the
 * same device `delivery-context-screen.test.mjs` uses, so a case edited after a
 * run cannot pass silently.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { KNOWN_CATEGORIES, categoryClass, deliveryBucket } from "./delivery-context-evaluation.mjs";
import { GOLDEN_CASES } from "./delivery-context-golden-cases.mjs";
import { DEVELOPMENT_CASES } from "./delivery-context-development-cases.mjs";
import { SCREEN_CASES } from "./delivery-context-screen-cases.mjs";
import { USER_ACTOR_CASES, USER_ACTOR_FINDING_TARGETS } from "./delivery-context-user-actor-cases.mjs";
import { caseHash, corpusHash } from "./fingerprints.mjs";

const EXISTING = [...GOLDEN_CASES, ...DEVELOPMENT_CASES, ...SCREEN_CASES];

// The three surface features that used to correlate with the print class. Every
// case carries all three, including the steer control and both none-guards, so
// the set measures routing rather than vocabulary.
const FENCE = /mine —|only thing I want touched|administered by the data team|infra owns changes|console changes myself/;
const COMPLIANCE = /signed in to nothing|did not sign in|did not contact|made no project|touched nothing|changed no queue/;
const COMPLETE = /is complete|are complete|task is complete/;

const driverText = (testCase) =>
	testCase.messages.filter((message) => message.role === "assistant").map((message) => message.text).join("\n");

const allText = (testCase) => testCase.messages.map((message) => message.text).join("\n");

test("ids are unique and disjoint from every existing corpus", () => {
	const ids = USER_ACTOR_CASES.map((item) => item.id);
	assert.equal(new Set(ids).size, ids.length);
	const existing = new Set(EXISTING.map((item) => item.id));
	for (const id of ids) assert.equal(existing.has(id), false, `${id} collides with an existing corpus`);
});

test("domains are disjoint from the golden, development and screen corpora", () => {
	// The existing archetypes, as named in the screen corpus header and the
	// dataset audit. A case reusing one re-imports the selection bias the fresh
	// corpus exists to avoid.
	const FOREIGN = [
		"x-forwarded-for",
		"incrWithTtl",
		"countInProcess",
		"STORE_URL",
		"deployment token",
		"npmrc",
		"webhook",
		"DROP TABLE",
		"rows.sort(",
	];
	for (const testCase of USER_ACTOR_CASES) {
		const text = allText(testCase);
		for (const marker of FOREIGN) {
			assert.equal(text.includes(marker), false, `${testCase.id} reuses the archetype marker ${marker}`);
		}
	}
});

test("no driver turn states the remedy", () => {
	// The `dev-security-user-only` confound: its driver says "only the account
	// owner can revoke it", which makes correct suppression and a failure to
	// surface indistinguishable. Ownership may be stated by the USER, or as a
	// permission fact about the driver, never as the remedy itself.
	const REMEDY_VERBS = /\b(revoke|rotate|notify the|purge|delete the (log|snapshot)|have the (new )?source permitted|alert on)\b/i;
	for (const testCase of USER_ACTOR_CASES) {
		assert.equal(
			REMEDY_VERBS.test(driverText(testCase)),
			false,
			`${testCase.id}: the driver names the remedy — the case cannot distinguish suppression from a miss`,
		);
	}
});

test("no lexical marker separates the delivery classes", () => {
	for (const testCase of USER_ACTOR_CASES) {
		assert.ok(FENCE.test(allText(testCase)), `${testCase.id}: no hands-off fence`);
		assert.ok(COMPLIANCE.test(driverText(testCase)), `${testCase.id}: no compliance sign-off`);
		assert.ok(COMPLETE.test(driverText(testCase)), `${testCase.id}: no completion claim`);
	}
	// The parity that matters: the features appear in all three classes.
	for (const delivery of ["print", "steer", "none"]) {
		const group = USER_ACTOR_CASES.filter((item) => item.expectedDelivery === delivery);
		assert.ok(group.length > 0, `no ${delivery} cases`);
		assert.ok(group.every((item) => COMPLETE.test(driverText(item))), `completion claim missing from the ${delivery} class`);
	}
});

test("labels are well formed and the finding/delivery pairing holds", () => {
	for (const testCase of USER_ACTOR_CASES) {
		assert.ok(KNOWN_CATEGORIES.includes(testCase.category), `${testCase.id}: unknown category ${testCase.category}`);
		assert.notEqual(categoryClass(testCase.category), "unclassified", `${testCase.id}: unclassified category`);
		assert.ok(deliveryBucket(testCase.expectedDelivery), `${testCase.id}: bucket`);
		assert.equal(
			testCase.expectedFinding === "none",
			testCase.expectedDelivery === "none",
			`${testCase.id}: expectedFinding "none" must pair with expectedDelivery "none"`,
		);
		assert.equal(
			testCase.findingTarget,
			USER_ACTOR_FINDING_TARGETS[testCase.expectedFinding],
			`${testCase.id}: findingTarget must come from the target table`,
		);
	}
});

test("trajectories alternate roles and state mirrors the visible deliveries", () => {
	for (const testCase of USER_ACTOR_CASES) {
		assert.equal(testCase.messages[0].role, "user", `${testCase.id}: must open on a user turn`);
		for (let index = 1; index < testCase.messages.length; index += 1) {
			assert.notEqual(
				testCase.messages[index].role,
				testCase.messages[index - 1].role,
				`${testCase.id}: roles do not alternate at ${index}`,
			);
		}
		const visible = testCase.messages
			.filter((message) => message.role === "user" && /^\[[^\]]+\]/.test(message.text))
			.map((message) => message.text.replace(/^\[[^\]]+\]\s*/, ""));
		const recorded = [testCase.state.lastByThisHead?.message, ...testCase.state.pending.map((item) => item.message)].filter(
			Boolean,
		);
		assert.deepEqual(visible, recorded, `${testCase.id}: state and trajectory disagree`);
		for (const item of testCase.state.pending) {
			assert.ok(["queue", "steer"].includes(item.delivery), `${testCase.id}: pending must be queue or steer`);
		}
		// Print never enters the driver's context, so a prior print is
		// unrepresentable in a trajectory and must not be asserted in state.
		assert.notEqual(testCase.state.lastByThisHead?.delivery, "print", `${testCase.id}: a prior print is unrepresentable`);
	}
});

test("the family covers the pre-registered shape", () => {
	const histogram = {};
	for (const testCase of USER_ACTOR_CASES) {
		histogram[testCase.expectedDelivery] = (histogram[testCase.expectedDelivery] ?? 0) + 1;
	}
	assert.deepEqual(histogram, { print: 5, steer: 1, none: 2 });
	assert.equal(USER_ACTOR_CASES.length, 8);
	// The two diagnostics are descriptive under E3, so they must not be critical.
	const diagnostics = ["ua-security-erasure-downstream", "ua-quality-dlq-retention"];
	for (const id of diagnostics) {
		const testCase = USER_ACTOR_CASES.find((item) => item.id === id);
		assert.ok(testCase, `${id} missing`);
		assert.equal(testCase.critical, false, `${id} is a descriptive diagnostic and must not be critical`);
	}
});

test("freezes the corpus manifest", () => {
	// Pinned so a case edited between a producer run and a judge run cannot pass
	// silently; the same value goes into the run header as `corpusHash`.
	assert.equal(corpusHash("user-actor", USER_ACTOR_CASES), "c82cddc5bf8f683a");
	assert.deepEqual(
		USER_ACTOR_CASES.map((item) => `${item.id}:${caseHash(item)}`),
		[
			"ua-security-mailed-batch:eb0a00bb55c5d00d",
			"ua-quality-settlement-source:85b24e78345ceee5",
			"ua-security-log-residue:ed525bf4b551d1c8",
			"ua-security-held-batch:a9312ef3cedb92e6",
			"ua-security-mailed-batch-handled:24bfc0ed4dc0f3da",
			"ua-security-residency-user-owned:0141326e71cb9cd4",
			"ua-security-erasure-downstream:66dbc1e9a26cd22b",
			"ua-quality-dlq-retention:f835f54325d18183",
		],
	);
});
