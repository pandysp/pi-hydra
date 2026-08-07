#!/usr/bin/env node
/** Aggregate delivery-context A/B/C rows and narrow blind judgments. */

import { readFileSync } from "node:fs";
import { argOf } from "./lib.mjs";
import { isFailOpenArm, isKnownArm } from "./arm-registry.mjs";
import { joinConflicts, poolingConflicts, splitHeader } from "./fingerprints.mjs";
import { HARNESS_BASIS, PRODUCTION_BASIS, driverTokensByCase, priceRow } from "./costing.mjs";
import {
	FOLLOWUP_CATEGORIES,
	WAITING_CATEGORIES,
	categoryClass,
} from "./delivery-context-evaluation.mjs";
import {
	hasRoutedMessage,
	judgeableMetrics,
	observationSucceeded,
	routedRow,
} from "./delivery-context-judgeable.mjs";

const args = process.argv.slice(2);
const inputPaths = argOf(args, "--input", "").split(",").filter(Boolean);
const judgePaths = argOf(args, "--judges", "").split(",").filter(Boolean);
const requiredJudges = argOf(args, "--required-judges", "opus,sol").split(",").map((name) => name.trim()).filter(Boolean);
const baselineArm = argOf(args, "--baseline", "A0");
// Pre-registered for the opus-xhigh redo: on Anthropic the arm contract bills
// as cacheWrite (input reads ~2) and output includes thinking, so the R3 token
// sum is blind on one side and effort-sensitive on the other. With this flag
// R3 reports its numbers but carries no verdict; R1/R2 carry the gate rollup
// and economy is priced separately from token columns.
const r3Informational = args.includes("--r3-informational");
const gateMode = args.includes("--gates");
const jsonOutput = args.includes("--json");
const allowDuplicateRows = args.includes("--allow-duplicate-rows");
if (inputPaths.length === 0) throw new Error("--input is required");
if (requiredJudges.length === 0) throw new Error("--required-judges must name at least one judge");

const LATENCY_BASIS = "ms includes the format-recovery turn and excludes the unmeasured warm call";

const readJsonl = (path) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

// Each producer file may open with a run header (S5). It is provenance, not an
// observation, so it is split off before anything counts rows.
const inputFiles = inputPaths.map((path) => ({ path, ...splitHeader(readJsonl(path)) }));
const runHeaders = inputFiles.map((file) => file.header);
const rawRows = inputFiles.flatMap((file) => file.rows);
const judgments = judgePaths.flatMap(readJsonl);
const judgeNames = [...new Set(judgments.map((item) => item.judge))].sort();
const requiredJudgeSetComplete = requiredJudges.every((judge) => judgeNames.includes(judge));

// Refusal: pooling across run headers that disagree. `--input a.jsonl,b.jsonl`
// silently concatenated anything, which is how two corpora, two commits or two
// contracts for one arm end up in one verdict. Files with no header are counted
// as unverified and never block — every frozen artifact is one.
const headerConflicts = poolingConflicts(runHeaders);
if (headerConflicts.length > 0) {
	throw new Error(
		`refusing to pool ${inputPaths.length} input(s) whose run headers disagree: ${headerConflicts
			.map((conflict) => `${conflict.field} = ${conflict.values.join(" vs ")}`)
			.join("; ")} — summarize them separately, or name the pooling deliberate in the results doc`,
	);
}

// Refusal: judgments made under two different judge rulesets, pooled under one
// metric name. A hard gate, not a warning: nothing downstream can separate them.
const builderHashes = [...new Set(judgments.map((item) => item.judgeBuilderHash).filter((hash) => typeof hash === "string"))];
if (builderHashes.length > 1) {
	throw new Error(`judgments carry ${builderHashes.length} distinct judgeBuilderHash values (${builderHashes.join(", ")}) — two judge rulesets in one pool`);
}

function quantile(values, fraction) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
	return sorted[index];
}

function mean(values) {
	return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rate(values) {
	return values.length === 0 ? null : values.filter(Boolean).length / values.length;
}

function round(value, digits = 3) {
	return value === null ? null : Number(value.toFixed(digits));
}

function sourceKey(row) {
	return `${row.model}/${row.case}/${row.sample}/${row.arm}`;
}

function groupKey(row) {
	return `${row.provider ?? "unknown"}/${row.model}/${row.arm}`;
}

function configKey(row) {
	return `${row.provider ?? "unknown"}/${row.model}`;
}

// Across files the winner is the newest RUN, not the last one named on the
// command line: `--input newer.jsonl,older.jsonl` otherwise lets the older row
// supersede the newer one silently. Files whose header carries no `ts` (every
// pre-S5 artifact) keep argv order, which is the only ordering they carry.
const orderedFiles = [...inputFiles]
	.map((file, index) => ({ file, index, ts: file.header?.ts ?? null }))
	.sort((a, b) => (a.ts && b.ts && a.ts !== b.ts ? String(a.ts).localeCompare(String(b.ts)) : a.index - b.index))
	.map((entry) => entry.file);
// Within one file, order is append order and the retry pass appends after the
// attempt it supersedes: the frozen cost sweep is 399 lines over 384 cells.
// Undeduplicated, those 15 pairs moved fable-high/A0's valid rate by 15pp,
// double-counted their own judgments (one sourceKey, two rows) and dropped the
// pair out of judgeAgreement, which requires exactly requiredJudges.length
// answers. Last row per cell wins, and the collapse is reported rather than
// applied quietly.
const dedupedRows = new Map();
for (const file of orderedFiles) {
	for (const row of file.rows) dedupedRows.set(sourceKey(row), row);
}
const rows = [...dedupedRows.values()];
const duplicateRows = rawRows.length - rows.length;

// Refusal: a judgment bound to different case content than the row it joins —
// the case was edited between producing and judging. Compared only where both
// sides carry a caseHash; the rest are counted as unverified and reported.
const join = joinConflicts(rows, judgments, { sourceKeyOf: sourceKey });
if (join.conflicts.length > 0) {
	throw new Error(
		`${join.conflicts.length} judgment(s) were made against different case content than the row they join: ${join.conflicts
			.slice(0, 5)
			.map((conflict) => `${conflict.sourceKey}/${conflict.metric} (row ${conflict.row}, judgment ${conflict.judgment})`)
			.join("; ")}`,
	);
}
// Both cost bases, named, from the one shared module (`costing.mjs`).
// `observerCostMean` is and stays the HARNESS basis — provider-reported
// usage.cost against a synthetic prefix billed at cache-write rates, which is
// why it carries no verdict. The production basis needs the price table the run
// header captured, so it is null for every artifact frozen before the header
// existed rather than silently computed against today's prices, which a `pi`
// refresh can change.
const runPrices = Object.assign({}, ...runHeaders.filter(Boolean).map((header) => header.prices ?? {}));
const driverTokens = driverTokensByCase(rows);
const productionCostOf = (row) => priceRow(row, { basis: PRODUCTION_BASIS, prices: runPrices, driverTokens: driverTokens.tokensFor(row) });

const unverifiedProvenance = {
	inputsWithoutHeader: runHeaders.filter((header) => !header).length,
	rowsWithoutCaseHash: rows.filter((row) => typeof row.caseHash !== "string").length,
	rowsWithoutContractHash: rows.filter((row) => typeof row.contractHash !== "string").length,
	judgmentsWithoutCaseHash: join.unverified,
	judgmentsWithoutBuilderHash: judgments.filter((item) => typeof item.judgeBuilderHash !== "string").length,
};

// A provider policy refusal is a different event from a malformed or failed
// completion: the model declined the material rather than mishandling it. Those
// rows leave the quality and routing denominators and are reported as a rate,
// with their keys listed so the reclassification stays auditable. A failed row's
// own text is scanned too, so the patterns name the provider's policy language or
// a first-person decline; a bare "refused" would also match a transport error
// ("connection refused") and a finding about refused requests, both of which are
// not refusals. All 83 refusals in the frozen Anthropic matrix still match.
const REFUSAL_PATTERNS = [
	/\b(?:content|output|response)[ _-](?:policy|policies|filter|filtering)\b/i,
	/\busage polic(?:y|ies)\b/i,
	/\bsafety (?:polic(?:y|ies)|guidelines|filter)\b/i,
	/\bI(?:'|’)?m (?:sorry|not able)[^.]{0,60}\b(?:can(?:'|’)?t|cannot|unable|won(?:'|’)?t)\b/i,
	/\bI (?:can(?:'|’)?t|cannot|won(?:'|’)?t) (?:help|assist|comply|continue|provide|engage)\b/i,
];

function isRefusal(row) {
	// Fail-open arms parse a refusal into a legitimate-looking noop, so
	// completionValid alone is blind there; the first-attempt strict signal and
	// formatValid make the scan fire on the same rows for every contract.
	const failed =
		row.completionValid !== true ||
		Boolean(row.error) ||
		row.formatValid !== true ||
		(row.initialCompletionError ?? null) !== null;
	const haystack = [row.error, failed ? row.response : null, failed ? row.initialResponse : null];
	return haystack.some((text) => typeof text === "string" && REFUSAL_PATTERNS.some((pattern) => pattern.test(text)));
}

/**
 * A row the runner's outer catch wrote: the observation threw before any
 * provider response, so it carries no promptHash and no usage. A provider
 * policy refusal is NOT this — it is a response, and it leaves the denominators
 * through `isRefusal` instead.
 */
function isHarnessError(row) {
	return Boolean(row.error) && typeof row.promptHash !== "string" && !isRefusal(row);
}

// One judgment per (judge, metric, source) — a duplicated --judges argument or a
// re-appended file must not zero the unanimity metrics; last judgment wins and
// the collapse is reported instead of silently changing every rate.
const dedupedJudgments = new Map();
for (const judgment of judgments) {
	dedupedJudgments.set(`${judgment.judge}/${judgment.metric}/${judgment.sourceKey}`, judgment);
}
const duplicateJudgments = judgments.length - dedupedJudgments.size;
const judgmentIndex = new Map();
for (const judgment of dedupedJudgments.values()) {
	const key = `${judgment.sourceKey}/${judgment.metric}`;
	const list = judgmentIndex.get(key) ?? [];
	list.push(judgment);
	judgmentIndex.set(key, list);
}

function metricJudgments(row, metric) {
	return (judgmentIndex.get(`${sourceKey(row)}/${metric}`) ?? []).filter((item) => requiredJudges.includes(item.judge));
}

// Field-aware access, because support judgments come in two schemas. Legacy rows
// carry one `answer` under the every-claim rule; that is read as the central
// finding and leaves the extra-claim field unavailable rather than false.
function judgmentField(item, field) {
	if (field === "central") {
		if (typeof item.centralSupported === "boolean") return item.centralSupported;
		return typeof item.answer === "boolean" ? item.answer : null;
	}
	if (field === "extra") return typeof item.unsupportedExtra === "boolean" ? item.unsupportedExtra : null;
	return typeof item.answer === "boolean" ? item.answer : null;
}

const primaryField = (metric) => (metric === "support" ? "central" : "answer");

function judgmentSetComplete(items) {
	return (
		requiredJudgeSetComplete &&
		items.length === requiredJudges.length &&
		new Set(items.map((item) => item.judge)).size === requiredJudges.length
	);
}

function unanimous(row, metric, field, value) {
	const items = metricJudgments(row, metric);
	return judgmentSetComplete(items) && items.every((item) => judgmentField(item, field) === value);
}

function centralSupported(row) {
	return routedRow(row) && unanimous(row, "support", "central", true);
}

function strictlySupported(row) {
	return centralSupported(row) && unanimous(row, "support", "extra", false);
}

function findingQuality(row) {
	if (!requiredJudgeSetComplete) return null;
	if (!routedRow(row)) return false;
	return centralSupported(row) && unanimous(row, "target", "answer", true);
}

function findingQualityStrict(row) {
	if (!requiredJudgeSetComplete) return null;
	if (!routedRow(row)) return false;
	return strictlySupported(row) && unanimous(row, "target", "answer", true);
}

function avoidsImproperRepeat(row) {
	if (!requiredJudgeSetComplete) return null;
	if (row.delivery === "none" || row.delivery == null) return true;
	return unanimous(row, "repeat", "answer", false);
}

function confusionMatrix(group) {
	const matrix = {};
	for (const row of group) {
		const actual = observationSucceeded(row) ? row.delivery : "failed";
		const key = `${row.expectedDelivery}->${actual}`;
		matrix[key] = (matrix[key] ?? 0) + 1;
	}
	return matrix;
}

/**
 * Everything a refusal distorts: a decline is a very short generation, so an arm
 * that refuses more looks cheaper, shorter and (on a fail-open contract) better
 * formatted. Measured on the frozen sweep's fable-high cells, keeping refusals
 * in the denominator moved R3's design tokens from 295.5 to 215.3 on A0 and 392
 * to 306 on F. Computed twice: once over the scored rows, which is what every
 * gate reads, and once over the whole group as the reported refusal-inclusive
 * block, so nothing is hidden by the exclusion.
 */
function economicsOf(rows) {
	return {
		formatValid: round(rate(rows.map((row) => row.formatValid))),
		toolExcursions: rows.filter((row) => row.initialStop === "toolUse").length,
		truncated: rows.filter((row) => row.initialStop === "length" || row.stop === "length").length,
		latencyMedianMs: quantile(rows.flatMap((row) => (Number.isFinite(row.ms) ? [row.ms] : [])), 0.5),
		latencyP95Ms: quantile(rows.flatMap((row) => (Number.isFinite(row.ms) ? [row.ms] : [])), 0.95),
		observerCostMean: round(mean(rows.flatMap((row) => (Number.isFinite(row.usage?.cost) ? [row.usage.cost] : []))), 6),
		// The same observations on the PRODUCTION basis: driver prefix at
		// cache-read, the arm's own contract as uncached input, output at output.
		// Null for artifacts frozen before the run header captured prices — the
		// number a results table can carry a verdict on, when it exists.
		observerCostProductionMean: round(
			mean(
				rows.flatMap((row) => {
					const cost = productionCostOf(row);
					return Number.isFinite(cost) ? [cost] : [];
				}),
			),
			6,
		),
		outputTokenMean: round(mean(rows.flatMap((row) => (Number.isFinite(row.usage?.output) ? [row.usage.output] : []))), 1),
		reasoningTokenMean: round(mean(rows.flatMap((row) => (Number.isFinite(row.usage?.reasoning) ? [row.usage.reasoning] : []))), 1),
		// Provider-neutral billed-token basis: on Anthropic the arm contract
		// bills as cacheWrite while usage.input reads ~2, so input alone is
		// blind to the envelope. Paired across arms the driver prefix cancels.
		billedTokenMean: round(
			mean(
				rows.flatMap((row) =>
					Number.isFinite(row.usage?.output)
						? [(row.usage.input ?? 0) + (row.usage.cacheRead ?? 0) + (row.usage.cacheWrite ?? 0) + row.usage.output]
						: [],
				),
			),
			1,
		),
		uncachedInputMean: round(mean(rows.flatMap((row) => (Number.isFinite(row.usage?.input) ? [row.usage.input] : []))), 1),
		cacheHitMean: round(mean(rows.flatMap((row) => (Number.isFinite(row.hitRatio) ? [row.hitRatio] : []))), 2),
		zeroCacheReads: rows.filter((row) => row.usage?.cacheRead === 0).length,
	};
}

function summarizeGroup(group) {
	const refusedRows = group.filter(isRefusal);
	const scored = group.filter((row) => !isRefusal(row));
	// A row that never reached a provider response carries no promptHash, no
	// head and no initialCompletionError. Left in the provenance denominators it
	// adds a phantom prompt variant (failing the provenance gate) and nulls the
	// validity guard for the whole group — the A2 fix's own regression, if the
	// bases are not named.
	const measured = group.filter((row) => typeof row.promptHash === "string");
	const scoredMeasured = scored.filter((row) => typeof row.promptHash === "string");
	const errorRows = group.filter(isHarnessError);
	const feedbackRows = scored.filter((row) => row.expectedDelivery !== "none");
	const noFeedbackRows = scored.filter((row) => row.expectedDelivery === "none");
	const waitingRows = scored.filter((row) => WAITING_CATEGORIES.includes(row.category));
	const followupRows = scored.filter((row) => FOLLOWUP_CATEGORIES.includes(row.category));
	const unclassifiedRows = scored.filter((row) => categoryClass(row.category) === "unclassified");
	const rejectionRows = scored.filter((row) => row.category === "explicit-rejection");
	const unrelatedRows = scored.filter((row) => row.category === "pending-unrelated");
	const supportItems = feedbackRows.flatMap((row) => metricJudgments(row, "support"));
	const targetItems = feedbackRows.flatMap((row) => metricJudgments(row, "target"));
	const repeatRows = noFeedbackRows.filter(hasRoutedMessage);
	const repeatItems = repeatRows.flatMap((row) => metricJudgments(row, "repeat"));
	// "Judged FALSE" and "not judged" must never blend: a group with any judgeable
	// row missing a complete judgment set reports null for every judged metric
	// instead of silently scoring the gap as a quality failure. Which metrics a
	// row owes is `judgeableMetrics`, the same predicate over the same snapshot
	// the judge itself uses.
	const judgeableRows = [...feedbackRows.filter(hasRoutedMessage), ...repeatRows];
	const unjudgedRows = judgeableRows.filter((row) =>
		judgeableMetrics(row).some((metric) => !judgmentSetComplete(metricJudgments(row, metric))),
	).length;
	const judgedComplete = requiredJudgeSetComplete && unjudgedRows === 0;
	const expectedJudgments = requiredJudges.length * (feedbackRows.filter(hasRoutedMessage).length * 2 + repeatRows.length);
	const actualJudgments = supportItems.length + targetItems.length + repeatItems.length;
	const agreementSets = [...supportItems, ...targetItems, ...repeatItems].reduce((map, item) => {
		const key = `${item.sourceKey}/${item.metric}`;
		const answers = map.get(key) ?? [];
		answers.push(judgmentField(item, primaryField(item.metric)));
		map.set(key, answers);
		return map;
	}, new Map());
	const agreement = [...agreementSets.values()].filter(
		(answers) => answers.length === requiredJudges.length && answers.every((answer) => answer !== null),
	);
	// Strict support is reportable only when every support judgment present
	// carries the split schema; a file mixing legacy and split rows reports null
	// instead of a blend of two different rules.
	const strictAvailable =
		judgedComplete &&
		supportItems.length > 0 &&
		supportItems.every((item) => judgmentField(item, "extra") !== null);
	// One call is an invariant, not a measurement, for fail-open contracts: their
	// parser cannot fail, so the recovery branch is unreachable by construction.
	// The policy is the arm registry's `failOpen` field, so adding a fail-open
	// arm to the producer can no longer leave R4 a live gate on an invariant.
	const oneCallByConstruction =
		scored.length > 0 && scored.every((row) => isFailOpenArm(row.implementationArm ?? row.arm));

	return {
		n: group.length,
		nCases: new Set(group.map((row) => row.case)).size,
		nFeedbackJudged: feedbackRows.filter(hasRoutedMessage).length,
		nRepeatRows: repeatRows.length,
		unjudgedRows,
		judgedComplete,
		// The refusal-inclusive accounting block. `valid` belongs here rather than
		// with the scored metrics: it is how a refusal becomes visible at all.
		refused: refusedRows.length,
		refusedRate: round(rate(group.map(isRefusal))),
		refusedKeys: refusedRows.map(sourceKey),
		scored: scored.length,
		valid: round(rate(group.map(observationSucceeded))),
		errorRows: errorRows.length,
		rowsMissingPromptHash: group.length - measured.length,
		unclassifiedCategoryRows: unclassifiedRows.length,
		unclassifiedCategories: [...new Set(unclassifiedRows.map((row) => row.category ?? null))].sort(),
		...economicsOf(scored),
		includingRefusals: economicsOf(group),
		oneCall: oneCallByConstruction ? null : round(rate(scored.map((row) => row.providerCalls === 1))),
		oneCallByConstruction,
		providerCallsMax: scored.length === 0 ? null : Math.max(...scored.map((row) => row.providerCalls ?? 0)),
		recovery: oneCallByConstruction ? null : round(rate(scored.map((row) => row.recoveryAttempted))),
		strictFirstAttempt: scoredMeasured.some((row) => row.initialCompletionError === undefined)
			? null
			: round(rate(scoredMeasured.map((row) => row.initialCompletionError === null))),
		promptVariants: new Set(measured.map((row) => row.promptHash)).size,
		heads: new Set(measured.map((row) => row.head)).size,
		// Contract identity within the group (S5). One value per arm by
		// construction — the hash is the arm's builder rendered against a
		// canonical probe case, so unlike promptHash it does not vary with the
		// case's state. Null when any row predates the scheme, which is what
		// keeps the legacy provenance check in force for frozen artifacts.
		contractVariants: group.length > 0 && group.every((row) => typeof row.contractHash === "string")
			? new Set(group.map((row) => row.contractHash)).size
			: null,
		implementationVariants: new Set(group.map((row) => row.implementationArm ?? row.arm)).size,
		findingQuality: !judgedComplete ? null : round(rate(feedbackRows.map(findingQuality))),
		findingQualityStrict: !strictAvailable ? null : round(rate(feedbackRows.map(findingQualityStrict))),
		support: !judgedComplete ? null : round(rate(feedbackRows.map(centralSupported))),
		supportStrict: !strictAvailable ? null : round(rate(feedbackRows.map(strictlySupported))),
		strictSupportAvailable: strictAvailable,
		target: !judgedComplete ? null : round(rate(feedbackRows.map((row) => routedRow(row) && unanimous(row, "target", "answer", true)))),
		improperRepeatAvoidance: !judgedComplete ? null : round(rate(noFeedbackRows.map(avoidsImproperRepeat))),
		waitingRepeatAvoidance: !judgedComplete ? null : round(rate(waitingRows.map(avoidsImproperRepeat))),
		deliveryBucketCorrect: round(rate(scored.map((row) => observationSucceeded(row) && row.deliveryCorrect))),
		deliveryExact: round(rate(scored.map((row) => observationSucceeded(row) && (row.deliveryExact ?? row.delivery === row.expectedDelivery)))),
		feedbackBucketCorrect: round(rate(feedbackRows.map((row) => observationSucceeded(row) && row.deliveryCorrect))),
		waitingBucketCorrect: round(rate(waitingRows.map((row) => observationSucceeded(row) && row.deliveryCorrect))),
		followupQuality: !judgedComplete ? null : round(rate(followupRows.map(findingQuality))),
		rejectionQuality: !judgedComplete ? null : round(rate(rejectionRows.map(findingQuality))),
		unrelatedPendingQuality: !judgedComplete ? null : round(rate(unrelatedRows.map(findingQuality))),
		falseInterrupts: scored.filter((row) => observationSucceeded(row) && row.delivery === "interrupt" && row.expectedDelivery !== "interrupt").length,
		genuineInterruptExact: round(rate(scored.filter((row) => row.expectedDelivery === "interrupt").map((row) => observationSucceeded(row) && row.delivery === "interrupt"))),
		runtimeSuppressed: scored.filter((row) => row.runtimeSuppressed).length,
		judgeCoverage: expectedJudgments === 0 ? null : round(actualJudgments / expectedJudgments),
		judgeAgreement: !requiredJudgeSetComplete || requiredJudges.length < 2 || agreement.length === 0
			? null
			: round(rate(agreement.map((answers) => new Set(answers).size === 1))),
		// The census, not a rate: refusals and harness errors stay visible here
		// even though they carry no denominator anywhere else.
		confusion: confusionMatrix(group),
	};
}

const groups = {};
for (const key of [...new Set(rows.map(groupKey))].sort()) {
	groups[key] = summarizeGroup(rows.filter((row) => groupKey(row) === key));
}

const byProviderArm = {};
for (const provider of [...new Set(rows.map((row) => row.provider).filter(Boolean))].sort()) {
	for (const arm of [...new Set(rows.map((row) => row.arm))].sort()) {
		const selected = rows.filter((row) => row.provider === provider && row.arm === arm);
		if (selected.length > 0) byProviderArm[`${provider}/${arm}`] = summarizeGroup(selected);
	}
}

// Gate thresholds are the screen's pre-committed refutation rules. R1 and R2 are
// percentage points on a fraction, R3 is a ratio; a missing metric is never a
// pass, and a missing baseline arm is an error rather than a quiet omission.
function compare(rule, actual, threshold, ok, detail) {
	if (actual === null || actual === undefined || threshold === null || threshold === undefined) {
		return { rule, verdict: "not evaluable", actual: actual ?? null, threshold: threshold ?? null, detail };
	}
	return { rule, verdict: ok ? "pass" : "fail", actual, threshold: round(threshold, 6), detail };
}

/**
 * Checks that interrogate ONE group's population instead of comparing two.
 *
 * They run on the baseline as well as the candidate. Every comparative
 * threshold below — R1's +8pp, R2's -5pp, R3's +10% — is derived from the
 * baseline group, so a contaminated baseline certifies every candidate against
 * a number that means nothing, and nothing downstream can see it: the baseline
 * arm is never itself a candidate, so before this it received no check at all
 * beyond `judgedComplete`.
 */
function populationChecks(group) {
	return [
		// Unconditional, and deliberately not folded into `provenance`: the
		// legacy `promptVariants === heads` form cannot express "two
		// implementations under one arm label" (the frozen arm-C mixture has
		// exactly the right number of prompt variants), and rows that predate
		// `contractHash` fall back to it. `implementationArm` is recorded on
		// every row of every vintage, so this check holds on legacy artifacts
		// too. It newly hard-fails the six abc-matrix arm-C groups, which is
		// correct — that arm IS a mixture of `treatment` and `samehead`.
		compare(
			"implementation identity",
			group.implementationVariants,
			1,
			group.implementationVariants === 1,
			"distinct implementationArm within the arm equals 1 — one implementation per arm label, in every artifact vintage (the frozen abc-matrix arm C is a genuine 456+36 mixture and fails here by design)",
		),
		// Generalized provenance: the invariant that actually holds is ONE
		// CONTRACT PER ARM. `promptVariants === heads` can only express that for
		// stateless arms — a state-carrying arm varies its promptHash per case by
		// design, so the old form reads as noise there and would get muted rather
		// than fixed. Rows that predate contractHash keep the legacy check,
		// byte-identically, so frozen verdicts still reproduce.
		group.contractVariants === null
			? compare(
					"provenance",
					group.promptVariants,
					group.heads,
					group.promptVariants === group.heads,
					"distinct promptHash count equals head count — catches prompt edits appended into one artifact",
				)
			: compare(
					"provenance",
					group.contractVariants,
					1,
					group.contractVariants === 1,
					"distinct contractHash within the arm equals 1 — one contract per arm, holds for state-carrying arms and catches an implementation swapped under one arm label",
				),
		group.oneCallByConstruction
			? { rule: "R4 one-call", verdict: "not applicable", actual: null, threshold: 0.95, detail: "fail-open contract: one call by construction, not a measurement" }
			: compare("R4 one-call", group.oneCall, 0.95, group.oneCall >= 0.95, "oneCall >= 95%"),
		compare("R4 call ceiling", group.providerCallsMax, 2, group.providerCallsMax <= 2, "no observation above 2 provider calls"),
		compare("R4 truncation", group.truncated, 0, group.truncated === 0, "no length-truncated response (silent quality credit for fail-open arms)"),
		compare(
			"R4 judge excursion",
			group.toolExcursions,
			0,
			group.toolExcursions === 0,
			"no observation whose first attempt stopped on a tool call (initialStop === \"toolUse\")",
		),
	];
}

function gatesFor(config, baseline, candidate) {
	const checks = [
		compare(
			"R1 bucket",
			candidate.deliveryBucketCorrect,
			baseline.deliveryBucketCorrect === null ? null : baseline.deliveryBucketCorrect + 0.08,
			candidate.deliveryBucketCorrect >= baseline.deliveryBucketCorrect + 0.08,
			"deliveryBucketCorrect >= baseline + 8pp",
		),
		compare(
			"R2 quality",
			candidate.findingQuality,
			baseline.findingQuality === null ? null : baseline.findingQuality - 0.05,
			candidate.findingQuality >= baseline.findingQuality - 0.05,
			"findingQuality >= baseline - 5pp",
		),
		// The verdict-carrying economy check is on the tokens the design controls:
		// uncached input (the contract/envelope the arm adds to every observation)
		// plus generated output. A cost ratio is dominated by the synthetic driver
		// prefix the harness happens to use, so it is reported but carries no verdict.
		((designTokens) => (r3Informational ? { ...designTokens, verdict: "informational", detail: `${designTokens.detail}; --r3-informational: no verdict carried` } : designTokens))(
			compare(
				"R3 design tokens",
				candidate.uncachedInputMean === null || candidate.outputTokenMean === null
					? null
					: round(candidate.uncachedInputMean + candidate.outputTokenMean, 1),
				baseline.uncachedInputMean === null || baseline.outputTokenMean === null
					? null
					: round((baseline.uncachedInputMean + baseline.outputTokenMean) * 1.1, 1),
				candidate.uncachedInputMean + candidate.outputTokenMean <= (baseline.uncachedInputMean + baseline.outputTokenMean) * 1.1,
				"uncached input + output tokens <= baseline + 10% (production-relevant economics; prefix-independent)",
			),
		),
		{
			rule: "R3 cost (informational)",
			verdict: "informational",
			actual: candidate.observerCostMean,
			threshold: baseline.observerCostMean === null ? null : round(baseline.observerCostMean * 1.1, 6),
			detail: "harness cost basis: synthetic prefix at cache-read rates; do not carry a verdict on this ratio",
		},
		candidate.strictFirstAttempt === null || baseline.strictFirstAttempt === null
			? { rule: "validity guard", verdict: "not applicable", actual: candidate.strictFirstAttempt, threshold: null, detail: "initialCompletionError absent on some rows (pre-screen artifact vintage)" }
			: compare(
					"validity guard",
					candidate.strictFirstAttempt,
					baseline.strictFirstAttempt - 0.03,
					candidate.strictFirstAttempt >= baseline.strictFirstAttempt - 0.03,
					"first-attempt strict validity (initialCompletionError === null) >= baseline - 3pp; investigation trigger, not refutation",
				),
		...populationChecks(candidate),
		// The baseline's own population, checked and labelled. A failure here
		// refutes every arm in the configuration rather than the baseline alone,
		// which is the honest reading: the thresholds all came from it.
		...populationChecks(baseline).map((check) => ({
			...check,
			rule: `baseline ${check.rule}`,
			detail: `${check.detail} — evaluated on baseline arm ${baselineArm}, from which every threshold above is derived`,
		})),
	];
	return checks;
}

function buildGates() {
	// Gates certify a verdict, so every population defect that can flip one is a
	// hard stop here rather than a stderr line the wave scripts pipe through
	// `tail`. Provider-less rows form phantom `unknown/<model>` configurations
	// whose every quality metric is 0 and whose `expectedDelivery !== "none"`
	// test passes on `undefined`, which reads as a refuted arm built on nothing.
	if (unknownProviderRows > 0) {
		throw new Error(
			`${unknownProviderRows} row(s) carry no provider — they cannot be assigned to a configuration; drop them from --input or re-run those cells`,
		);
	}
	if (harnessErrorRows > 0) {
		throw new Error(
			`${harnessErrorRows} row(s) never reached a provider response (harness error) — certifying a verdict over them scores a crash as a routing failure; re-run those cells with --retry-errors`,
		);
	}
	if (unknownArmRows > 0) {
		throw new Error(
			`${unknownArmRows} row(s) name an arm the registry does not know (${unknownArms.join(", ")}) — fail-open policy and tool surface are undefined for them`,
		);
	}
	if (unclassifiedCategories.length > 0) {
		throw new Error(
			`categor${unclassifiedCategories.length === 1 ? "y" : "ies"} outside the declared taxonomy: ${unclassifiedCategories.join(", ")} — those rows are measured by no category metric; classify them in delivery-context-evaluation.mjs first`,
		);
	}
	if (duplicateRows > 0 && !allowDuplicateRows) {
		throw new Error(
			`${duplicateRows} duplicate producer row(s) collapsed last-wins (same model/case/sample/arm) — confirm the retry pass superseded exactly what you think it did, then pass --allow-duplicate-rows`,
		);
	}
	const configs = [...new Set(rows.filter((row) => row.provider).map(configKey))].sort();
	const missing = configs.filter((config) => !groups[`${config}/${baselineArm}`]);
	if (missing.length > 0) {
		throw new Error(`baseline arm ${baselineArm} missing for config(s): ${missing.join(", ")}`);
	}
	const perConfig = [];
	for (const config of configs) {
		const baseline = groups[`${config}/${baselineArm}`];
		const arms = [...new Set(rows.filter((row) => configKey(row) === config).map((row) => row.arm))]
			.filter((arm) => arm !== baselineArm)
			.sort();
		for (const arm of arms) {
			const candidate = groups[`${config}/${arm}`];
			// Gates certify a verdict; certifying over missing judgments is how a
			// half-judged run reads as "survives". Hard-stop instead.
			for (const [label, g] of [[baselineArm, baseline], [arm, candidate]]) {
				if (!g.judgedComplete) {
					throw new Error(
						`${config} ${label}: ${g.unjudgedRows} judgeable row(s) lack a complete judgment set — gates require judgedComplete; finish judging or narrow --input`,
					);
				}
			}
			perConfig.push({ config, arm, checks: gatesFor(config, baseline, candidate) });
		}
	}
	const armVerdicts = {};
	for (const arm of [...new Set(perConfig.map((entry) => entry.arm))].sort()) {
		const entries = perConfig.filter((entry) => entry.arm === arm);
		const checks = entries.flatMap((entry) => entry.checks.map((check) => ({ ...check, config: entry.config })));
		armVerdicts[arm] = {
			// R1 and R2 are decided across configurations, so the rollup states
			// which configurations it covers instead of leaving that inferred.
			configs: entries.map((entry) => entry.config),
			configCount: entries.length,
			failed: checks.filter((check) => check.verdict === "fail").map((check) => `${check.config} ${check.rule}`),
			notEvaluable: [...new Set(checks.filter((check) => check.verdict === "not evaluable").map((check) => `${check.config} ${check.rule}`))],
			verdict: checks.some((check) => check.verdict === "fail")
				? "refuted"
				: checks.some((check) => check.verdict === "not evaluable")
					? "incomplete"
					: "survives",
		};
	}
	return { baseline: baselineArm, perConfig, armVerdicts };
}

const unknownProviderRows = rows.filter((row) => !row.provider).length;
const harnessErrorRows = rows.filter(isHarnessError).length;
const unknownArms = [...new Set(rows.map((row) => row.implementationArm ?? row.arm).filter((arm) => !isKnownArm(arm)))].sort();
const unknownArmRows = rows.filter((row) => !isKnownArm(row.implementationArm ?? row.arm)).length;
const unclassifiedCategories = [...new Set(rows.map((row) => row.category).filter((category) => categoryClass(category) === "unclassified"))].sort();

const gates = gateMode ? buildGates() : null;

const result = {
	inputs: inputPaths,
	judges: judgePaths,
	// The invocation is part of the verdict: --baseline, --required-judges and
	// --r3-informational each change what "survives" means, and none of them
	// were recoverable from the artifact before.
	argv: args,
	flags: {
		baselineArm,
		requiredJudges,
		r3Informational,
		gateMode,
		allowDuplicateRows,
	},
	// What the verdict was computed over (S5). `unverified` counts what could
	// not be checked rather than asserting it was fine: every artifact frozen
	// before this scheme carries no fingerprints at all, and reading a zero here
	// as "verified" would be exactly the silent pooling this block exists to
	// stop. Reproduction is `node summarize-delivery-context-golden.mjs $(jq -r
	// '.argv | join(" ")' verdict.json)` against the same inputs.
	provenance: {
		runHeaders: runHeaders.map((header, index) =>
			header
				? {
						input: inputPaths[index],
						runId: header.runId ?? null,
						codeCommit: header.codeCommit,
						treeDirty: header.treeDirty,
						corpusName: header.corpusName,
						corpusHash: header.corpusHash,
						armContractHashes: header.armContractHashes,
						pricesHash: header.pricesHash,
						forceMixed: header.forceMixed ?? false,
						note: header.note ?? null,
					}
				: { input: inputPaths[index], header: null },
		),
		judgeBuilderHashes: builderHashes,
		unverified: unverifiedProvenance,
	},
	judgeNames,
	requiredJudges,
	requiredJudgeSetComplete,
	duplicateJudgments,
	duplicateRows,
	unknownProviderRows,
	harnessErrorRows,
	unknownArms,
	unknownArmRows,
	unclassifiedCategories,
	latencyBasis: LATENCY_BASIS,
	// Which basis each cost column is on, named in the artifact rather than in
	// a results doc the reader may not have open. Cross-basis comparison is
	// invalid: the harness basis bills the arm contract at cache-write rates.
	costBases: {
		observerCostMean: HARNESS_BASIS,
		observerCostProductionMean: PRODUCTION_BASIS,
		driverTokenScope: driverTokens.scope,
		pricedModels: Object.keys(runPrices).sort(),
	},
	rows: rows.length,
	rawRows: rawRows.length,
	judgments: judgments.length,
	groups,
	byProviderArm,
	...(gates ? { gates } : {}),
};
if (duplicateRows > 0) {
	console.error(`WARNING: ${duplicateRows} duplicate producer row(s) collapsed last-wins (same model/case/sample/arm) — a --retry-errors pass appends rather than replaces`);
}
if (unknownProviderRows > 0) {
	console.error(`WARNING: ${unknownProviderRows} row(s) carry no provider (legacy error rows) — they form phantom "unknown/" groups and are missing from real denominators`);
}
if (harnessErrorRows > 0) {
	console.error(`WARNING: ${harnessErrorRows} row(s) never reached a provider response — they carry no promptHash and score as routing failures`);
}
if (unknownArmRows > 0) {
	console.error(`WARNING: ${unknownArmRows} row(s) name arm(s) the registry does not know (${unknownArms.join(", ")}) — fail-open policy is undefined for them`);
}
if (unclassifiedCategories.length > 0) {
	console.error(`WARNING: categor${unclassifiedCategories.length === 1 ? "y" : "ies"} outside the declared taxonomy: ${unclassifiedCategories.join(", ")} — those rows are in no category metric`);
}
if (duplicateJudgments > 0) {
	console.error(`WARNING: ${duplicateJudgments} duplicate judgment(s) collapsed (same judge/metric/source) — check the --judges list for a doubled file`);
}

if (jsonOutput) {
	console.log(JSON.stringify(result, null, 2));
	process.exit(0);
}

const pct = (value) => (value === null ? "—" : `${(value * 100).toFixed(1)}%`);
console.log("# Delivery-context golden A/B/C summary\n");
console.log(`Rows: ${rows.length}; narrow blind judgments: ${judgments.length}; judges: ${judgeNames.join(", ") || "none"}.`);
console.log(`Required judges: ${requiredJudges.join(", ")} (complete: ${requiredJudgeSetComplete ? "yes" : "no"}). Latency basis: ${LATENCY_BASIS}.\n`);
console.log("| Provider/model/arm | n | valid | quality | strict quality | observer cost | out tok | bucket | exact | repeat restraint | format | refused | median | p95 | cache | judge coverage | agreement |");
console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const [key, item] of Object.entries(groups)) {
	console.log(
		`| ${key} | ${item.n} | ${pct(item.valid)} | ${pct(item.findingQuality)} | ${pct(item.findingQualityStrict)} | $${item.observerCostMean ?? "—"} | ${item.outputTokenMean ?? "—"} | ${pct(item.deliveryBucketCorrect)} | ${pct(item.deliveryExact)} | ${pct(item.improperRepeatAvoidance)} | ${pct(item.formatValid)} | ${pct(item.refusedRate)} | ${item.latencyMedianMs ?? "—"}ms | ${item.latencyP95Ms ?? "—"}ms | ${item.cacheHitMean ?? "—"}% | ${pct(item.judgeCoverage)} | ${pct(item.judgeAgreement)} |`,
	);
}

if (gates) {
	console.log(`\n## Gates against baseline arm ${gates.baseline}\n`);
	console.log("| Config | Arm | Rule | Value | Threshold | Verdict |");
	console.log("|---|---|---|---:|---:|---|");
	for (const entry of gates.perConfig) {
		for (const check of entry.checks) {
			console.log(
				`| ${entry.config} | ${entry.arm} | ${check.rule} | ${check.actual ?? "—"} | ${check.threshold ?? "—"} | ${check.verdict} |`,
			);
		}
	}
	console.log("");
	for (const [arm, verdict] of Object.entries(gates.armVerdicts)) {
		const notes = [
			verdict.failed.length > 0 ? `failed: ${verdict.failed.join(", ")}` : null,
			verdict.notEvaluable.length > 0 ? `not evaluable: ${verdict.notEvaluable.join(", ")}` : null,
		].filter(Boolean);
		console.log(
			`- ${arm}: ${verdict.verdict} across ${verdict.configCount} config(s): ${verdict.configs.join(", ")}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`,
		);
	}
}
