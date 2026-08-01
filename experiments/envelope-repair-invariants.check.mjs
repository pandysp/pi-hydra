/**
 * Invariants the envelope-repair arms must satisfy before any provider spend
 * (`ENVELOPE-REPAIR-SPEC.md`). Zero provider calls.
 *
 * Three things are asserted, and each of them is the difference between a
 * measurement and a story:
 *
 * 1. F0 is untouched. Every frozen row of the incumbent must stay reproducible,
 *    so the repair ships as separate constants and this suite proves the old
 *    ones did not move.
 * 2. F2 - F1 is FRAMING AND NOTHING ELSE. The spec reads F1 - F0 as the semantic
 *    repair and F2 - F1 as the framing lever; if a semantic criterion silently
 *    dropped out of the checklist rendering, that reading is false and the
 *    ablation measures two factors at once. The fifteen criterion strings below
 *    are the design panel's parity list, and they are checked against BOTH.
 * 3. Neither repaired arm names the answer to the case the repair was designed
 *    against. A contract that says "revoke credentials" would score well for the
 *    wrong reason; the guard is lexical because the failure mode is lexical.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { GOLDEN_HEADS } from "./delivery-context-golden-cases.mjs";
import {
	REPAIRED_ACT_NOW_CLAUSE,
	REPAIRED_CHECKLIST_ROUTING,
	REPAIRED_COMPLETION_CARDINALITY,
	REPAIRED_DECIDABLE_ROUTING,
	REPAIRED_DEDUP_CLAUSE,
	REPAIRED_LENS_AUTHORITY,
	REPAIRED_ROUTING,
	REPAIRED_SELECTION_CLAUSE,
	REPAIRED_STEER_CLAUSE,
	SCREEN_DEDUP_CLAUSE,
	SCREEN_FOOTER_GRAMMAR,
	SCREEN_STEER_CLAUSE,
	buildDecidableFooterObservationEnvelope,
	buildDecidableFooterObservationPrompt,
	buildFramedFooterObservationEnvelope,
	buildFramedFooterObservationPrompt,
	buildRepairedFooterObservationEnvelope,
	buildRepairedFooterObservationPrompt,
	buildScreenFooterObservationPrompt,
} from "./delivery-context-evaluation.mjs";
import { armSpec, goldenHandoff } from "./arm-registry.mjs";
import { SCREEN_CASES } from "./delivery-context-screen-cases.mjs";

const HEAD = "security";
const LENS = GOLDEN_HEADS[HEAD];
const CASE = SCREEN_CASES[0];

const F0 = buildScreenFooterObservationPrompt(HEAD, LENS);
const F1 = buildRepairedFooterObservationPrompt(HEAD, LENS);
const F2 = buildFramedFooterObservationPrompt(HEAD, LENS);
const F3 = buildDecidableFooterObservationPrompt(HEAD, LENS);

/** The design panel's parity list: every semantic criterion, verbatim. */
const SEMANTIC_CRITERIA = [
	REPAIRED_ACT_NOW_CLAUSE,
	"work currently underway",
	"the agent itself must carry out",
	"incorrect, unsafe, incomplete, or unverified",
	"that it could be addressed on a later turn does not make it queue",
	"the agent need not act",
	"the remedy is not the agent's to carry out because it lacks the ability or the permission",
	"print reaches the user and never the agent, so say what the user must do",
	"genuinely deferrable follow-up",
	"an emergency that must abort the run",
	SCREEN_DEDUP_CLAUSE.replace(/\.$/, ""),
	"live again if the agent refuses it or the situation changes",
	"neither delivers nor resolves it",
	REPAIRED_SELECTION_CLAUSE,
	"none.",
];

test("F0's constants did not move", () => {
	// Spelled out rather than imported: an assertion that reads the constant it
	// guards passes after any edit to it.
	assert.equal(
		SCREEN_STEER_CLAUSE,
		"For feedback about work currently underway, use steer when leaving it unresolved would leave that work incorrect, unsafe, incomplete, or unverified; that it could be addressed on a later turn does not make it queue. Use print when the agent need not act, queue only for genuinely deferrable follow-up, and interrupt only for an emergency that must abort the run.",
	);
	assert.equal(
		SCREEN_DEDUP_CLAUSE,
		"Semantically equivalent feedback counts as already delivered even while the underlying issue remains unresolved.",
	);
	assert.ok(F0.includes("The lens alone defines scope, intervention criteria, suppression, and deduplication."));
	assert.equal(F0.includes(REPAIRED_SELECTION_CLAUSE), false, "the repair leaked into F0");
});

test("F2 - F1 is framing and nothing else: all fifteen criteria in both", () => {
	// Case-insensitive on purpose: a clause that is mid-sentence in the prose
	// rendering opens a numbered item in the checklist, so its first letter
	// capitalizes. That capitalization IS the framing difference under test;
	// requiring byte-identity here would fail on the very thing being varied.
	const f1 = F1.toLowerCase();
	const f2 = F2.toLowerCase();
	for (const criterion of SEMANTIC_CRITERIA) {
		const needle = criterion.toLowerCase();
		assert.ok(f1.includes(needle), `F1 is missing the criterion: ${criterion.slice(0, 60)}`);
		assert.ok(f2.includes(needle), `F2 is missing the criterion: ${criterion.slice(0, 60)}`);
	}
});

test("F3 - F2 is decidability and nothing else: all fifteen criteria in F3 too", () => {
	// Same parity list, same reason. If a criterion dropped out while the rules
	// were being made decidable, F3 - F2 would measure decidability AND a
	// semantic edit, and D1's reading would be false.
	const f3 = F3.toLowerCase();
	for (const criterion of SEMANTIC_CRITERIA) {
		assert.ok(f3.includes(criterion.toLowerCase()), `F3 is missing the criterion: ${criterion.slice(0, 60)}`);
	}
	// F3 keeps F2's cardinality unit verbatim: varying the anti-deliberation
	// sentence as well would make F3 - F2 two factors.
	assert.ok(F3.includes(REPAIRED_COMPLETION_CARDINALITY));
	// Longer by design. The hypothesis is that ambiguity, not length, is what
	// thinking is spent on, so a shorter F3 would not test it.
	assert.ok(F3.length > F2.length, "F3 must be longer than F2 — that is the point of the test");
});

test("F3 states the precedence F2 leaves to first-match alone", () => {
	// Each device, with the ambiguity it removes. These are the decidability
	// factor; if one is dropped the arm is no longer the registered F3.
	const DEVICES = [
		// selection-vs-routing order: F2 appends the selection clause after the
		// rules, leaving open whether the rules run per candidate finding.
		["STEP 1 — pick the finding", "selection runs before routing"],
		["carry exactly one forward", "how many findings the rules operate on"],
		// 1 over 2: an in-progress emergency that was already raised.
		["Test 1 outranks every later test, including test 2", "interrupt vs already-delivered"],
		// 3 vs 4: the substitution defect's own boundary.
		["When the agent cannot or may not carry out the remedy, test 3 is false", "steer vs print, from test 3's side"],
		["Tests 3 and 4 collide only over who must act", "steer vs print, stated as a pair"],
		// 4 over 5: user-owned remedy vs deferrable agent work.
		["When the required actor is the user, test 5 is false", "queue vs print"],
		// underdetermination, decided rather than deliberated.
		["Decide each test on what the trajectory shows and do not assume what it does not show", "what to do when the trajectory is silent"],
	];
	for (const [device, ambiguity] of DEVICES) {
		assert.ok(F3.includes(device), `F3 lost the device that removes: ${ambiguity}`);
		assert.equal(F2.includes(device), false, `the device leaked into F2, which must keep the ambiguity: ${ambiguity}`);
	}
});

test("the framing arm differs from the repaired arm only in the two framed units", () => {
	// Substituting F2's routing and cardinality back into F1 must reproduce F2
	// exactly: that is the operational meaning of "framing and nothing else".
	const reconstructed = F1.replace(REPAIRED_ROUTING, REPAIRED_CHECKLIST_ROUTING).replace(
		"Answer in exactly one turn; there is no follow-up turn.",
		REPAIRED_COMPLETION_CARDINALITY,
	);
	assert.equal(reconstructed, F2);
	assert.ok(F2.includes("Decide from what is visible; do not deliberate."));
	assert.equal(F1.includes("do not deliberate"), false, "the framing sentence leaked into the ablation arm");
});

test("the anti-deliberation sentence stays out of the acting surface", async () => {
	// `SCREEN_ACTING_CARDINALITY` tells an acting head to take as many turns as
	// the lens needs; the judge-only sentence is its opposite.
	const acting = await import("./delivery-context-evaluation.mjs");
	assert.equal(acting.SCREEN_ACTING_CARDINALITY.includes("do not deliberate"), false);
	assert.equal(acting.SCREEN_ROUTING.includes(REPAIRED_SELECTION_CLAUSE), false, "the repair leaked into the acting envelope");
	assert.equal(acting.SCREEN_ROUTING.includes("STEP 1 — pick the finding"), false, "F3's decidability rewrite leaked into the acting envelope");
});

test("no repaired arm names the answer to the case it was designed against", () => {
	// The known-bad case is a leaked-credential review whose consequential remedy
	// is revoking the credential. A contract naming any of these would be scoring
	// its own answer key.
	const FORBIDDEN = ["credential", "token", "revoke", "rotate", "secret", "history", "account", "deployment"];
	for (const [name, text] of [
		["F1", F1],
		["F2", F2],
		["F3", F3],
		["F1 envelope", buildRepairedFooterObservationEnvelope(HEAD)],
		["F2 envelope", buildFramedFooterObservationEnvelope(HEAD)],
		["F3 envelope", buildDecidableFooterObservationEnvelope(HEAD)],
	]) {
		// The lens is corpus text, not contract text; strip it before checking.
		const contract = text.replace(LENS, "");
		for (const word of FORBIDDEN) {
			assert.equal(
				new RegExp(`\\b${word}`, "i").test(contract),
				false,
				`${name} names "${word}" — that is an answer key, not a general rule`,
			);
		}
	}
});

test("both repaired arms keep the footer channel, parser, surface and recovery budget", () => {
	// The spec's branch-cost rule: these arms differ from F0 in instruction text
	// alone. A channel or schema change would make F1 - F0 two factors.
	const f0 = armSpec("F0");
	for (const name of ["F1", "F2", "F3"]) {
		const spec = armSpec(name);
		assert.equal(spec.toolSurface, f0.toolSurface, `${name}: tool surface differs from F0`);
		assert.equal(spec.failOpen, f0.failOpen, `${name}: fail-open policy differs from F0`);
		assert.equal(spec.recoveryBudget, f0.recoveryBudget, `${name}: recovery budget differs from F0`);
		assert.equal(spec.channel, f0.channel, `${name}: channel differs from F0`);
		assert.equal(spec.parse, f0.parse, `${name}: parser differs from F0`);
	}
	for (const text of [F1, F2, F3]) assert.ok(text.includes(SCREEN_FOOTER_GRAMMAR));
});

test("the lens-authority split reaches every repaired builder", () => {
	for (const text of [
		F1,
		F2,
		F3,
		buildRepairedFooterObservationEnvelope(HEAD),
		buildFramedFooterObservationEnvelope(HEAD),
		buildDecidableFooterObservationEnvelope(HEAD),
	]) {
		assert.ok(text.includes(REPAIRED_LENS_AUTHORITY));
		assert.equal(text.includes("The lens alone defines scope"), false);
	}
});

test("the OpenAI split carrier holds for both repaired arms", () => {
	for (const name of ["F1", "F2", "F3"]) {
		const anthropic = goldenHandoff(name, "anthropic", CASE);
		const openai = goldenHandoff(name, "openai-codex", CASE);
		assert.equal(anthropic.envelope, undefined, `${name}: Anthropic must carry one combined prompt`);
		assert.equal(openai.prompt, GOLDEN_HEADS[CASE.head], `${name}: OpenAI must carry the raw lens`);
		assert.ok(openai.envelope.includes(REPAIRED_SELECTION_CLAUSE), `${name}: OpenAI envelope lost the repair`);
	}
});
