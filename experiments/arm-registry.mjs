/**
 * One table owning every per-arm decision the delivery-context harness makes.
 *
 * Before this module the knowledge was spread over eight sites — the runner's
 * `knownArms` set, its `promptFor` if-chain, its `parseResponse` if-chain, its
 * correction-text ternary, its runtime-dedup condition, the implementation
 * alias map, the screen tool-surface set, and a fail-open string set inside the
 * summarizer. Two of those chains ended in an unguarded default: an arm added
 * to `knownArms` and nowhere else produced rows labelled with the new name
 * carrying the judge envelope's contract, and no test failed. Lookups here
 * throw instead.
 *
 * The registry is DATA plus references to the builders that already exist. It
 * re-authors no contract text: every `buildHandoff` below is the corresponding
 * `promptFor` branch moved verbatim, so the frozen `promptHash` values stay
 * reproducible. `arm-registry.check.mjs` pins each one against a literal
 * builder call, and the module is import-safe (no argv, no matrix) so the
 * trajectory harness can cross-check its own arms against it.
 */

import { buildObservationEnvelope, decisionFromCompletion, parseDecision } from "../utils.ts";
import {
	buildJudgeObservationEnvelope,
	buildJudgeObservationPrompt,
	buildLegacyAnthropicJudgePrompt,
	footerFormatCorrection,
	parseFooterDecision,
} from "./frozen-footer-protocol.mjs";
import { completionFromHydraToolCalls } from "../protocol.ts";
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
	parseStructuredCandidateDecision,
	parseStructuredContextDecision,
	structuredCandidateFormatCorrection,
	structuredContextFormatCorrection,
} from "./delivery-context-candidate.mjs";
import {
	buildDecidableFooterObservationEnvelope,
	buildDecidableFooterObservationPrompt,
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
	serializeDriverTools,
} from "./delivery-context-evaluation.mjs";
import { GOLDEN_HEADS } from "./delivery-context-golden-cases.mjs";
import { contractHashOf, probeCase } from "./fingerprints.mjs";

function textOf(message) {
	return (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
}

/**
 * A's lenient parse with A's failure policy: an unparseable reply is a warned
 * noop, never a recovery turn. The non-null decision is what keeps the runner's
 * recovery branch unreachable, so these arms spend exactly one provider call.
 * The warning text is per-arm because it lands in `initialCompletionError` on
 * every frozen row of that arm.
 */
function failOpenJsonDecision(text, error) {
	const legacy = parseDecision(text);
	return {
		decision: legacy ?? { action: "noop", reason: "unparseable response", message: "" },
		candidate: null,
		relation: null,
		error: legacy ? null : error,
		formatValid: legacy !== null,
	};
}

const failOpenParser = (error) => (message) => failOpenJsonDecision(textOf(message), error);

/** The typed-completion channel: a hydra tool call, falling back to the footer. */
function parseTypedOrFooter(message) {
	const typed = completionFromHydraToolCalls(message.content);
	return typed
		? { decision: decisionFromCompletion(typed.delivery, typed.message), candidate: null, relation: null, error: null }
		: { ...parseFooterDecision(textOf(message)), candidate: null, relation: null };
}

function parseFooterOnly(message) {
	return { ...parseFooterDecision(textOf(message)), candidate: null, relation: null };
}

/** The three delivery-state projections the arms measure. */
const fullState = (testCase) => testCase.state;

const sameHeadState = (testCase) => sameHeadDeliveryContext(testCase.state, testCase.head);

const unseenOnlyState = (testCase) => ({
	lastByThisHead: testCase.category === "newly-delivered-no-response" ? testCase.state.lastByThisHead : null,
	pending: testCase.state.pending.filter((item) => item.head === testCase.head),
});

/**
 * The judge envelope: the runner's former unguarded default, now reachable only
 * by the three arms that were ever meant to use it. Each names its own state
 * projection, which is the whole difference between them.
 */
const judgeEnvelopeHandoff = (state) => (provider, { head, lens, testCase }) =>
	provider === "anthropic"
		? { prompt: buildJudgeObservationPrompt(head, lens, state(testCase)) }
		: { prompt: lens, envelope: buildJudgeObservationEnvelope(head, state(testCase)) };

/** The split-carrier arms: combined `<system-reminder>` on Anthropic, raw lens plus envelope on OpenAI. */
const splitHandoff = (buildPrompt, buildEnvelope, stateOf) => (provider, { head, lens, testCase }) =>
	provider === "anthropic"
		? { prompt: buildPrompt(head, lens, stateOf ? stateOf(testCase) : undefined) }
		: { prompt: lens, envelope: buildEnvelope(head, stateOf ? stateOf(testCase) : undefined) };

const arm = (spec) =>
	Object.freeze({
		channel: "single-turn",
		runsAgentLoop: false,
		runtimeDedup: false,
		toolSurface: "wide",
		correction: footerFormatCorrection,
		...spec,
		recoveryBudget: spec.failOpen ? 0 : 1,
	});

/**
 * One entry per IMPLEMENTATION. `ARM_ALIASES` below maps the letters the wave
 * scripts pass on `--arms` onto these; frozen rows carry both spellings.
 */
export const GOLDEN_ARMS = Object.freeze({
	"main-json": arm({
		id: "main-json",
		label: "shipped-main-json",
		// Deliberate asymmetry, kept for history: main-json carries the combined
		// system-reminder on BOTH providers, where screen-a0 splits on OpenAI.
		buildHandoff: (_provider, { head, lens }) => ({ prompt: buildShippedMainObservationPrompt(head, lens) }),
		parse: failOpenParser("unparseable JSON; shipped main falls back to noop"),
		failOpen: true,
		runtimeDedup: true,
	}),
	control: arm({
		id: "control",
		label: "judge-only-typed",
		buildHandoff: (provider, { head, lens }) =>
			provider === "anthropic"
				? { prompt: buildLegacyAnthropicJudgePrompt(head, lens) }
				: { prompt: lens, envelope: buildObservationEnvelope(head, []) },
		// The control arm runs the agent loop and completes through the hydra
		// tool, so the runner never calls a parser for it.
		parse: null,
		correction: null,
		failOpen: false,
		channel: "agent-loop",
		runsAgentLoop: true,
		runtimeDedup: true,
	}),
	base: arm({
		id: "base",
		label: "unified-footer-tool-free",
		buildHandoff: (provider, { head, lens }) =>
			provider === "anthropic"
				? { prompt: buildUnifiedFooterToolFreeObservationPrompt(head, lens, []) }
				: { prompt: lens, envelope: buildUnifiedFooterToolFreeObservationEnvelope(head, []) },
		parse: parseTypedOrFooter,
		failOpen: false,
	}),
	treatment: arm({
		id: "treatment",
		label: "judge-envelope-full-state",
		buildHandoff: judgeEnvelopeHandoff(fullState),
		parse: parseTypedOrFooter,
		failOpen: false,
	}),
	samehead: arm({
		id: "samehead",
		label: "judge-envelope-same-head",
		buildHandoff: judgeEnvelopeHandoff(sameHeadState),
		parse: parseTypedOrFooter,
		failOpen: false,
	}),
	unseenonly: arm({
		id: "unseenonly",
		label: "judge-envelope-unseen-only",
		buildHandoff: judgeEnvelopeHandoff(unseenOnlyState),
		parse: parseTypedOrFooter,
		failOpen: false,
	}),
	candidate: arm({
		id: "candidate",
		label: "candidate-1",
		buildHandoff: splitHandoff(buildCandidateObservationPrompt, buildCandidateObservationEnvelope, fullState),
		parse: parseTypedOrFooter,
		failOpen: false,
	}),
	candidate2: arm({
		id: "candidate2",
		label: "candidate-2",
		buildHandoff: splitHandoff(buildCandidate2ObservationPrompt, buildCandidate2ObservationEnvelope, fullState),
		parse: parseTypedOrFooter,
		failOpen: false,
	}),
	candidate3: arm({
		id: "candidate3",
		label: "candidate-3",
		buildHandoff: splitHandoff(buildCandidate3ObservationPrompt, buildCandidate3ObservationEnvelope, fullState),
		parse: parseTypedOrFooter,
		failOpen: false,
	}),
	candidate4: arm({
		id: "candidate4",
		label: "candidate-4",
		buildHandoff: splitHandoff(buildCandidate4ObservationPrompt, buildCandidate4ObservationEnvelope, fullState),
		parse: parseTypedOrFooter,
		failOpen: false,
	}),
	structured: arm({
		id: "structured",
		label: "structured-context",
		buildHandoff: splitHandoff(
			buildStructuredContextObservationPrompt,
			buildStructuredContextObservationEnvelope,
			fullState,
		),
		parse: (message) => parseStructuredContextDecision(textOf(message)),
		correction: structuredContextFormatCorrection,
		failOpen: false,
	}),
	structured2: arm({
		id: "structured2",
		label: "structured-candidate",
		buildHandoff: splitHandoff(
			buildStructuredCandidateObservationPrompt,
			buildStructuredCandidateObservationEnvelope,
			fullState,
		),
		parse: (message) => parseStructuredCandidateDecision(textOf(message)),
		correction: structuredCandidateFormatCorrection,
		failOpen: false,
	}),
	"screen-a0": arm({
		id: "screen-a0",
		label: "screen-shipped-main",
		buildHandoff: splitHandoff(
			(head, lens) => buildShippedMainObservationPrompt(head, lens),
			(head) => buildShippedMainObservationEnvelope(head),
		),
		parse: failOpenParser("unparseable JSON; A's contract falls back to noop"),
		failOpen: true,
		toolSurface: "management-only",
	}),
	"screen-json": arm({
		id: "screen-json",
		label: "screen-unified-json",
		buildHandoff: splitHandoff(
			(head, lens) => buildScreenJsonObservationPrompt(head, lens),
			(head) => buildScreenJsonObservationEnvelope(head),
		),
		parse: failOpenParser("unparseable JSON; A's contract falls back to noop"),
		failOpen: true,
		toolSurface: "management-only",
	}),
	"screen-footer": arm({
		id: "screen-footer",
		label: "screen-unified-footer",
		// F is the only screen arm with a recovery budget, and a tool call is
		// never a completion here: the advertised schema has no completion action.
		buildHandoff: splitHandoff(
			(head, lens) => buildScreenFooterObservationPrompt(head, lens),
			(head) => buildScreenFooterObservationEnvelope(head),
		),
		parse: parseFooterOnly,
		failOpen: false,
		toolSurface: "management-only",
	}),
	// The envelope repair (`ENVELOPE-REPAIR-SPEC.md`). Both arms are
	// `screen-footer` with a different envelope: same channel, same parser, same
	// tool surface, same recovery budget, so F1 - F0 is the semantic repair and
	// F2 - F1 is framing. Nothing here is a code branch — the branch-cost rule
	// admits instruction text and nothing more.
	"screen-footer-repaired": arm({
		id: "screen-footer-repaired",
		label: "screen-repaired-footer",
		buildHandoff: splitHandoff(
			(head, lens) => buildRepairedFooterObservationPrompt(head, lens),
			(head) => buildRepairedFooterObservationEnvelope(head),
		),
		parse: parseFooterOnly,
		failOpen: false,
		toolSurface: "management-only",
	}),
	"screen-footer-framed": arm({
		id: "screen-footer-framed",
		label: "screen-framed-footer",
		buildHandoff: splitHandoff(
			(head, lens) => buildFramedFooterObservationPrompt(head, lens),
			(head) => buildFramedFooterObservationEnvelope(head),
		),
		parse: parseFooterOnly,
		failOpen: false,
		toolSurface: "management-only",
	}),
	// F3 varies decidability alone against F2: same semantics, same cardinality
	// unit, same channel and surface. It is longer on purpose — the hypothesis is
	// that ambiguity, not length, is what thinking is spent on.
	"screen-footer-decidable": arm({
		id: "screen-footer-decidable",
		label: "screen-decidable-footer",
		buildHandoff: splitHandoff(
			(head, lens) => buildDecidableFooterObservationPrompt(head, lens),
			(head) => buildDecidableFooterObservationEnvelope(head),
		),
		parse: parseFooterOnly,
		failOpen: false,
		toolSurface: "management-only",
	}),
});

/**
 * The letters the wave scripts and the frozen rows use. C must mirror
 * `DeliveryLedger.contextFor()`: the observing head sees its own last
 * successful delivery and its own live pending queue/steer deliveries. The
 * ledger tracks sibling heads internally, but intentionally does not use them
 * to coordinate otherwise-MECE reviews.
 */
export const ARM_ALIASES = Object.freeze({
	A: "main-json",
	B: "control",
	C: "samehead",
	A0: "screen-a0",
	J: "screen-json",
	F: "screen-footer",
	// The envelope-repair spellings. MAIN is `screen-a0` — main's shipped
	// contract text carried on the screen's constant placement and
	// management-only surface, which is what "the re-benchmarked baseline"
	// means: every arm in this comparison differs from it in instruction text
	// alone. (`main-json` is the same contract with the wide surface and the
	// combined carrier on both providers; using it here would confound the
	// comparison with a tool-schema change.)
	MAIN: "screen-a0",
	F0: "screen-footer",
	F1: "screen-footer-repaired",
	F2: "screen-footer-framed",
	F3: "screen-footer-decidable",
});

export const ARM_NAMES = Object.freeze([...Object.keys(ARM_ALIASES), ...Object.keys(GOLDEN_ARMS)].sort());

/** Lookup without a throw, for readers of frozen rows whose arm vocabulary is history. */
export function findArmSpec(name) {
	return GOLDEN_ARMS[ARM_ALIASES[name] ?? name] ?? null;
}

export function isKnownArm(name) {
	return findArmSpec(name) !== null;
}

/** Lookup for anything that produces measurements: an unknown arm is a bug, not a default. */
export function armSpec(name) {
	const spec = findArmSpec(name);
	if (!spec) throw new Error(`unknown arm: ${name}`);
	return spec;
}

export function implementationArm(name) {
	return armSpec(name).id;
}

/**
 * One call is an invariant, not a measurement, for fail-open contracts: their
 * parser cannot fail, so the recovery branch is unreachable by construction.
 * Frozen rows carry either the letter or the implementation name, and an arm
 * this build has never heard of is reported rather than silently treated as
 * strict — the throw belongs in the producer, where the drift enters.
 */
export function isFailOpenArm(name) {
	return findArmSpec(name)?.failOpen === true;
}

export function headLens(head) {
	const lens = GOLDEN_HEADS[head];
	if (!lens) throw new Error(`missing frozen head: ${head}`);
	return lens;
}

/**
 * Build one arm's handoff against an explicit lens. The golden corpus resolves
 * its lens from `GOLDEN_HEADS` (see `goldenHandoff`); the trajectory benchmark
 * carries its own frozen generic lens and calls this directly.
 */
export function armHandoff(name, provider, { head, lens, testCase }) {
	return armSpec(name).buildHandoff(provider, { head, lens, testCase });
}

export function goldenHandoff(name, provider, testCase) {
	return armHandoff(name, provider, { head: testCase.head, lens: headLens(testCase.head), testCase });
}

/**
 * The tool surface the observation advertises. Production-cache fidelity means
 * replaying the driver's tools array, so every arm carries the driver stubs;
 * the arm decides only whether the hydra schema it adds is the shipped wide one
 * or the management-only one.
 */
export function armVisibleDriverTools(name, provider, serializedObservationTools) {
	return serializeDriverTools(provider, armSpec(name).toolSurface, serializedObservationTools);
}

/**
 * Two requested arms resolving to one implementation would run the same
 * contract twice under different labels and report it as a comparison.
 */
export function assertDistinctImplementations(names) {
	const seen = new Map();
	for (const name of names) {
		const id = implementationArm(name);
		if (seen.has(id)) throw new Error(`arms ${seen.get(id)} and ${name} are the same implementation: ${id}`);
		seen.set(id, name);
	}
}

/**
 * Contract identity per (arm, provider), for the S5 fingerprints.
 *
 * The arm's own builder rendered against one canonical probe case
 * (`fingerprints.mjs:probeCase`), lens excised. One value per arm, INVARIANT
 * ACROSS THE CORPUS — which is what lets the summarizer state the provenance
 * invariant as "distinct contractHash within an arm equals 1" and have it hold
 * for the state-carrying arms too. Hashing a real case's rendered contract
 * cannot express that: `control`, `samehead` and `unseenonly` interpolate the
 * case's delivery state, so their per-case hashes vary by design.
 *
 * It separates implementations that share a label. Measured: with the two-head
 * probe state, `treatment`/`control` (full state), `samehead` and `unseenonly`
 * hash differently — the frozen arm-C mixture (456 rows of one implementation
 * plus 36 of another under one letter) would not have survived this check.
 *
 * The tool surface is hashed with the rendered text: `main-json` and
 * `screen-a0` produce byte-identical Anthropic prompts and differ only in the
 * hydra schema they advertise, so text alone under-identifies the arm.
 */
export function armContractHash(name, provider) {
	const spec = armSpec(name);
	const probe = probeCase(Object.keys(GOLDEN_HEADS));
	const lens = headLens(probe.head);
	return contractHashOf(spec.buildHandoff(provider, { head: probe.head, lens, testCase: probe }), lens, spec.toolSurface);
}

/** `{[arm]: hash}` for one provider — the run header's `armContractHashes`. */
export function armContractHashes(names, provider) {
	return Object.fromEntries(names.map((name) => [name, armContractHash(name, provider)]));
}
