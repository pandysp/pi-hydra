/**
 * The arm registry is the single source of arm identity, so this suite is the
 * golden master of the if-chains it replaced. Every expected handoff below is
 * written as a LITERAL builder call — the same call the runner's `promptFor`
 * made before the table existed — rather than read back out of the registry,
 * because a check that reimplements the thing under test asserts nothing.
 *
 * Coverage matters here beyond the usual: only three of the fifteen arms
 * (`screen-a0`, `screen-json`, `screen-footer`) appear in the frozen artifacts
 * whose `promptHash` values pin the contract, and four more (`main-json`,
 * `control`, `treatment`, `samehead`) only in an unfrozen scratch mirror. For
 * the remaining eight this table is the only thing standing between a refactor
 * and a silently changed contract.
 *
 * Runs under `node --test`; zero provider calls.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
	buildAnthropicObservationPrompt,
	buildJudgeObservationEnvelope,
	buildJudgeObservationPrompt,
	buildObservationEnvelope,
	footerFormatCorrection,
} from "../utils.ts";
import {
	buildUnifiedFooterToolFreeObservationEnvelope,
	buildUnifiedFooterToolFreeObservationPrompt,
} from "./tool-free-protocol.mjs";
import {
	buildCandidate2ObservationEnvelope,
	buildCandidate2ObservationPrompt,
	buildCandidate3ObservationEnvelope,
	buildCandidate3ObservationPrompt,
	buildCandidate4ObservationEnvelope,
	buildCandidate4ObservationPrompt,
	buildCandidateObservationEnvelope,
	buildCandidateObservationPrompt,
	buildStructuredCandidateObservationEnvelope,
	buildStructuredCandidateObservationPrompt,
	buildStructuredContextObservationEnvelope,
	buildStructuredContextObservationPrompt,
	structuredCandidateFormatCorrection,
	structuredContextFormatCorrection,
} from "./delivery-context-candidate.mjs";
import {
	buildFramedFooterObservationEnvelope,
	buildFramedFooterObservationPrompt,
	buildRepairedFooterObservationEnvelope,
	buildRepairedFooterObservationPrompt,
	buildScreenFooterObservationEnvelope,
	buildScreenFooterObservationPrompt,
	buildScreenJsonObservationEnvelope,
	buildScreenJsonObservationPrompt,
	buildShippedMainObservationEnvelope,
	buildShippedMainObservationPrompt,
	sameHeadDeliveryContext,
} from "./delivery-context-evaluation.mjs";
import { GOLDEN_CASES, GOLDEN_HEADS } from "./delivery-context-golden-cases.mjs";
import {
	ARM_ALIASES,
	ARM_NAMES,
	GOLDEN_ARMS,
	armHandoff,
	armSpec,
	assertDistinctImplementations,
	findArmSpec,
	goldenHandoff,
	implementationArm,
	isFailOpenArm,
	isKnownArm,
} from "./arm-registry.mjs";

// A `newly-delivered-no-response` case, chosen because it is the one category
// where `unseenonly` keeps `lastByThisHead` — the projections differ on it.
const CASE =
	GOLDEN_CASES.find((item) => item.category === "newly-delivered-no-response" && item.state.pending.length > 0) ??
	GOLDEN_CASES.find((item) => item.category === "newly-delivered-no-response");
const HEAD = CASE.head;
const LENS = GOLDEN_HEADS[HEAD];
const STATE = CASE.state;

const unseenOnly = {
	lastByThisHead: STATE.lastByThisHead,
	pending: STATE.pending.filter((item) => item.head === HEAD),
};

/** The runner's former `promptFor` if-chain, transcribed branch by branch. */
const EXPECTED = {
	"main-json": {
		anthropic: { prompt: buildShippedMainObservationPrompt(HEAD, LENS) },
		// Deliberate: main-json is combined on BOTH providers, unlike screen-a0.
		"openai-codex": { prompt: buildShippedMainObservationPrompt(HEAD, LENS) },
	},
	control: {
		anthropic: { prompt: buildAnthropicObservationPrompt(HEAD, LENS, []) },
		"openai-codex": { prompt: LENS, envelope: buildObservationEnvelope(HEAD, []) },
	},
	base: {
		anthropic: { prompt: buildUnifiedFooterToolFreeObservationPrompt(HEAD, LENS, []) },
		"openai-codex": { prompt: LENS, envelope: buildUnifiedFooterToolFreeObservationEnvelope(HEAD, []) },
	},
	treatment: {
		anthropic: { prompt: buildJudgeObservationPrompt(HEAD, LENS, STATE) },
		"openai-codex": { prompt: LENS, envelope: buildJudgeObservationEnvelope(HEAD, STATE) },
	},
	samehead: {
		anthropic: { prompt: buildJudgeObservationPrompt(HEAD, LENS, sameHeadDeliveryContext(STATE, HEAD)) },
		"openai-codex": { prompt: LENS, envelope: buildJudgeObservationEnvelope(HEAD, sameHeadDeliveryContext(STATE, HEAD)) },
	},
	unseenonly: {
		anthropic: { prompt: buildJudgeObservationPrompt(HEAD, LENS, unseenOnly) },
		"openai-codex": { prompt: LENS, envelope: buildJudgeObservationEnvelope(HEAD, unseenOnly) },
	},
	candidate: {
		anthropic: { prompt: buildCandidateObservationPrompt(HEAD, LENS, STATE) },
		"openai-codex": { prompt: LENS, envelope: buildCandidateObservationEnvelope(HEAD, STATE) },
	},
	candidate2: {
		anthropic: { prompt: buildCandidate2ObservationPrompt(HEAD, LENS, STATE) },
		"openai-codex": { prompt: LENS, envelope: buildCandidate2ObservationEnvelope(HEAD, STATE) },
	},
	candidate3: {
		anthropic: { prompt: buildCandidate3ObservationPrompt(HEAD, LENS, STATE) },
		"openai-codex": { prompt: LENS, envelope: buildCandidate3ObservationEnvelope(HEAD, STATE) },
	},
	candidate4: {
		anthropic: { prompt: buildCandidate4ObservationPrompt(HEAD, LENS, STATE) },
		"openai-codex": { prompt: LENS, envelope: buildCandidate4ObservationEnvelope(HEAD, STATE) },
	},
	structured: {
		anthropic: { prompt: buildStructuredContextObservationPrompt(HEAD, LENS, STATE) },
		"openai-codex": { prompt: LENS, envelope: buildStructuredContextObservationEnvelope(HEAD, STATE) },
	},
	structured2: {
		anthropic: { prompt: buildStructuredCandidateObservationPrompt(HEAD, LENS, STATE) },
		"openai-codex": { prompt: LENS, envelope: buildStructuredCandidateObservationEnvelope(HEAD, STATE) },
	},
	"screen-a0": {
		anthropic: { prompt: buildShippedMainObservationPrompt(HEAD, LENS) },
		"openai-codex": { prompt: LENS, envelope: buildShippedMainObservationEnvelope(HEAD) },
	},
	"screen-json": {
		anthropic: { prompt: buildScreenJsonObservationPrompt(HEAD, LENS) },
		"openai-codex": { prompt: LENS, envelope: buildScreenJsonObservationEnvelope(HEAD) },
	},
	"screen-footer": {
		anthropic: { prompt: buildScreenFooterObservationPrompt(HEAD, LENS) },
		"openai-codex": { prompt: LENS, envelope: buildScreenFooterObservationEnvelope(HEAD) },
	},
	"screen-footer-repaired": {
		anthropic: { prompt: buildRepairedFooterObservationPrompt(HEAD, LENS) },
		"openai-codex": { prompt: LENS, envelope: buildRepairedFooterObservationEnvelope(HEAD) },
	},
	"screen-footer-framed": {
		anthropic: { prompt: buildFramedFooterObservationPrompt(HEAD, LENS) },
		"openai-codex": { prompt: LENS, envelope: buildFramedFooterObservationEnvelope(HEAD) },
	},
};

test("every registered arm has a transcribed expectation", () => {
	assert.deepEqual(Object.keys(EXPECTED).sort(), Object.keys(GOLDEN_ARMS).sort());
});

test("each arm's handoff is byte-identical to the builder call it replaced", () => {
	for (const [id, byProvider] of Object.entries(EXPECTED)) {
		for (const [provider, expected] of Object.entries(byProvider)) {
			const actual = goldenHandoff(id, provider, CASE);
			assert.equal(actual.prompt, expected.prompt, `${id}/${provider}: prompt changed`);
			assert.equal(actual.envelope ?? undefined, expected.envelope, `${id}/${provider}: envelope changed`);
		}
	}
});

test("the aliases resolve to the same handoff as their implementation", () => {
	for (const [letter, id] of Object.entries(ARM_ALIASES)) {
		for (const provider of ["anthropic", "openai-codex"]) {
			assert.deepEqual(goldenHandoff(letter, provider, CASE), goldenHandoff(id, provider, CASE), `${letter} != ${id}`);
		}
	}
});

test("main-json keeps its combined-on-both placement and screen-a0 does not", () => {
	const mainJson = goldenHandoff("main-json", "openai-codex", CASE);
	const screenA0 = goldenHandoff("screen-a0", "openai-codex", CASE);
	assert.equal(mainJson.envelope, undefined);
	assert.ok(mainJson.prompt.startsWith("<system-reminder>"));
	assert.equal(screenA0.prompt, LENS);
	assert.equal(screenA0.envelope, buildShippedMainObservationEnvelope(HEAD));
});

test("the judge-envelope arms carry three different delivery-state projections", () => {
	// C withholds sibling-head pending state; unseenonly additionally withholds
	// the head's own last delivery unless the case is the one category where it
	// is the material under test. The corpus is the fixture: a case with a
	// sibling pending item separates C from the full state, and any case outside
	// `newly-delivered-no-response` separates unseenonly from C.
	const sibling = GOLDEN_CASES.find(
		(item) => item.state.pending.some((entry) => entry.head !== item.head) && item.state.pending.some((entry) => entry.head === item.head),
	);
	if (sibling) {
		assert.notEqual(
			goldenHandoff("treatment", "anthropic", sibling).prompt,
			goldenHandoff("samehead", "anthropic", sibling).prompt,
			"C is not withholding sibling pending state",
		);
	}
	const ownLast = GOLDEN_CASES.find(
		(item) => item.category !== "newly-delivered-no-response" && item.state.lastByThisHead,
	);
	assert.ok(ownLast, "corpus has no case with a prior own delivery outside newly-delivered");
	assert.notEqual(
		goldenHandoff("samehead", "anthropic", ownLast).prompt,
		goldenHandoff("unseenonly", "anthropic", ownLast).prompt,
		"unseenonly is not withholding the head's own last delivery",
	);
	assert.deepEqual(goldenHandoff("samehead", "anthropic", ownLast), {
		prompt: buildJudgeObservationPrompt(ownLast.head, GOLDEN_HEADS[ownLast.head], sameHeadDeliveryContext(ownLast.state, ownLast.head)),
	});
});

test("an arm the table does not know is a throw, never a default handoff", () => {
	assert.throws(() => armSpec("screen-print"), /unknown arm: screen-print/);
	assert.throws(() => implementationArm("D"), /unknown arm: D/);
	assert.throws(() => goldenHandoff("screen-print", "anthropic", CASE), /unknown arm: screen-print/);
	assert.throws(() => armHandoff("", "anthropic", { head: HEAD, lens: LENS, testCase: CASE }), /unknown arm/);
	assert.equal(findArmSpec("screen-print"), null);
	assert.equal(isKnownArm("screen-print"), false);
	assert.equal(isKnownArm("A0"), true);
});

test("the registry knows exactly the arm vocabulary the runner used to hardcode", () => {
	// The runner's former `knownArms` set, verbatim, plus the envelope-repair
	// arms and their spellings (`ENVELOPE-REPAIR-SPEC.md`).
	const knownArms = [
		"A", "B", "C", "control", "main-json", "base", "treatment", "samehead", "unseenonly",
		"candidate", "candidate2", "candidate3", "candidate4", "structured", "structured2",
		"A0", "J", "F", "screen-a0", "screen-json", "screen-footer",
		"MAIN", "F0", "F1", "F2", "screen-footer-repaired", "screen-footer-framed",
	];
	assert.deepEqual(ARM_NAMES, [...knownArms].sort());
	for (const name of knownArms) assert.equal(isKnownArm(name), true, `${name} dropped out of the registry`);
	assert.deepEqual(
		["A", "B", "C", "A0", "J", "F"].map(implementationArm),
		["main-json", "control", "samehead", "screen-a0", "screen-json", "screen-footer"],
	);
	// MAIN is screen-a0, not main-json: the baseline must differ from the
	// challengers in instruction text alone, and main-json also swaps the tool
	// surface and the OpenAI carrier.
	assert.deepEqual(
		["MAIN", "F0", "F1", "F2"].map(implementationArm),
		["screen-a0", "screen-footer", "screen-footer-repaired", "screen-footer-framed"],
	);
});

test("fail-open policy answers for letters, implementation names and history", () => {
	// The set the summarizer used to carry, mixing both vocabularies.
	for (const name of ["screen-a0", "screen-json", "main-json", "A0", "J", "A"]) {
		assert.equal(isFailOpenArm(name), true, `${name} lost its fail-open policy`);
	}
	for (const name of ["screen-footer", "F", "control", "B", "treatment", "samehead", "structured"]) {
		assert.equal(isFailOpenArm(name), false, `${name} gained a fail-open policy`);
	}
	// Frozen rows must stay loadable: an arm this build never heard of is
	// reported by the summarizer, not treated as strict by a throw here.
	assert.equal(isFailOpenArm("some-2025-arm"), false);
	// One call is an invariant exactly where the parser cannot fail.
	for (const spec of Object.values(GOLDEN_ARMS)) {
		assert.equal(spec.recoveryBudget, spec.failOpen ? 0 : 1, `${spec.id}: recovery budget contradicts fail-open`);
	}
});

test("two arm labels for one implementation are refused before any spend", () => {
	assert.doesNotThrow(() => assertDistinctImplementations(["A", "B", "C"]));
	assert.doesNotThrow(() => assertDistinctImplementations(["A0", "J", "F"]));
	// A and A0 render the same prompt on Anthropic but are different
	// implementations — different tool surface, different fail-open warning — so
	// running both is a legitimate comparison, not an accounting error.
	assert.doesNotThrow(() => assertDistinctImplementations(["A", "A0"]));
	assert.throws(() => assertDistinctImplementations(["A", "main-json"]), /same implementation: main-json/);
	assert.throws(() => assertDistinctImplementations(["A0", "screen-a0"]), /same implementation: screen-a0/);
});

test("each arm parses its own channel and nothing else", () => {
	const text = (value) => ({ content: [{ type: "text", text: value }] });
	const json = '{"action":"steer","reason":"unverified migration","message":"Run the migration test."}';
	const footer = "The migration runs without a test.\nDELIVERY: steer";

	// Fail-open arms turn an unparseable reply into a warned noop, which is what
	// keeps their recovery branch unreachable and R4 an invariant.
	for (const id of ["main-json", "screen-a0", "screen-json"]) {
		const parsed = armSpec(id).parse(text("I reviewed the trajectory and found nothing."));
		assert.deepEqual(parsed.decision, { action: "noop", reason: "unparseable response", message: "" });
		assert.equal(parsed.formatValid, false);
		assert.match(parsed.error, /falls back to noop/);
		assert.equal(armSpec(id).parse(text(json)).decision.action, "steer");
		assert.equal(armSpec(id).parse(text(json)).formatValid, true);
	}
	// The per-arm warning text lands on every frozen row of that arm.
	assert.equal(
		armSpec("main-json").parse(text("nope")).error,
		"unparseable JSON; shipped main falls back to noop",
	);
	assert.equal(
		armSpec("screen-json").parse(text("nope")).error,
		"unparseable JSON; A's contract falls back to noop",
	);

	// F is strict: no footer is an error and a recovery turn, not a noop.
	const strict = armSpec("screen-footer").parse(text("Nothing here warrants feedback."));
	assert.equal(strict.decision, null);
	assert.equal(strict.error, "feedback must end with an exact DELIVERY footer");
	assert.equal(armSpec("screen-footer").parse(text(footer)).decision.action, "steer");
	// F's advertised schema has no completion action, so a tool call is never a
	// completion for it — unlike the typed arms.
	const toolCall = {
		content: [{ type: "toolCall", name: "hydra", arguments: { action: "complete_observation", delivery: "steer", message: "x" } }],
	};
	assert.equal(armSpec("screen-footer").parse(toolCall).decision, null);
	assert.equal(armSpec("treatment").parse(toolCall).decision?.action, "steer");

	// The control arm completes through the agent loop; it has no parser at all.
	assert.equal(armSpec("control").parse, null);
	assert.equal(armSpec("control").runsAgentLoop, true);
	assert.equal(Object.values(GOLDEN_ARMS).filter((spec) => spec.runsAgentLoop).length, 1);
});

test("the correction text is the arm's own", () => {
	assert.equal(armSpec("screen-footer").correction("bad"), footerFormatCorrection("bad"));
	assert.equal(armSpec("treatment").correction("bad"), footerFormatCorrection("bad"));
	assert.equal(armSpec("structured").correction("bad"), structuredContextFormatCorrection("bad"));
	assert.equal(armSpec("structured2").correction("bad"), structuredCandidateFormatCorrection("bad"));
});

test("runtime delivery dedup is applied to exactly the two arms that shipped it", () => {
	const dedup = Object.values(GOLDEN_ARMS).filter((spec) => spec.runtimeDedup).map((spec) => spec.id).sort();
	assert.deepEqual(dedup, ["control", "main-json"]);
});

test("a missing frozen head is named rather than rendered as undefined", () => {
	assert.throws(() => goldenHandoff("A0", "anthropic", { ...CASE, head: "nonesuch" }), /missing frozen head: nonesuch/);
});
