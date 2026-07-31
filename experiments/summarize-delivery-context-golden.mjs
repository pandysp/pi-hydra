#!/usr/bin/env node
/** Aggregate delivery-context A/B/C rows and narrow blind judgments. */

import { readFileSync } from "node:fs";
import { argOf } from "./lib.mjs";

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
if (inputPaths.length === 0) throw new Error("--input is required");
if (requiredJudges.length === 0) throw new Error("--required-judges must name at least one judge");

const LATENCY_BASIS = "ms includes the format-recovery turn and excludes the unmeasured warm call";

const readJsonl = (path) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const rows = inputPaths.flatMap(readJsonl);
const judgments = judgePaths.flatMap(readJsonl);
const judgeNames = [...new Set(judgments.map((item) => item.judge))].sort();
const requiredJudgeSetComplete = requiredJudges.every((judge) => judgeNames.includes(judge));

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

function observationSucceeded(row) {
	return row.completionValid === true && !row.error;
}

function routedRow(row) {
	return observationSucceeded(row) && row.delivery !== "none";
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

function hasRoutedMessage(row) {
	return routedRow(row) && typeof row.delivery === "string" && Boolean(row.message?.trim?.());
}

const waitingCategories = new Set([
	"pending-equivalent",
	"newly-delivered-no-response",
	"visible-no-response",
	"full-resolution",
]);
const followupCategories = new Set(["explicit-rejection", "material-change", "older-visible-rejection", "partial-resolution"]);

function confusionMatrix(group) {
	const matrix = {};
	for (const row of group) {
		const actual = observationSucceeded(row) ? row.delivery : "failed";
		const key = `${row.expectedDelivery}->${actual}`;
		matrix[key] = (matrix[key] ?? 0) + 1;
	}
	return matrix;
}

function summarizeGroup(group) {
	const refusedRows = group.filter(isRefusal);
	const scored = group.filter((row) => !isRefusal(row));
	const feedbackRows = scored.filter((row) => row.expectedDelivery !== "none");
	const noFeedbackRows = scored.filter((row) => row.expectedDelivery === "none");
	const waitingRows = scored.filter((row) => waitingCategories.has(row.category));
	const followupRows = scored.filter((row) => followupCategories.has(row.category));
	const rejectionRows = scored.filter((row) => row.category === "explicit-rejection");
	const unrelatedRows = scored.filter((row) => row.category === "pending-unrelated");
	const supportItems = feedbackRows.flatMap((row) => metricJudgments(row, "support"));
	const targetItems = feedbackRows.flatMap((row) => metricJudgments(row, "target"));
	const repeatRows = noFeedbackRows.filter(hasRoutedMessage);
	const repeatItems = repeatRows.flatMap((row) => metricJudgments(row, "repeat"));
	// "Judged FALSE" and "not judged" must never blend: a group with any judgeable
	// row missing a complete judgment set reports null for every judged metric
	// instead of silently scoring the gap as a quality failure.
	const requiredMetricsFor = (row) => (row.expectedDelivery === "none" ? ["repeat"] : ["support", "target"]);
	const judgeableRows = [...feedbackRows.filter(hasRoutedMessage), ...repeatRows];
	const unjudgedRows = judgeableRows.filter((row) =>
		requiredMetricsFor(row).some((metric) => !judgmentSetComplete(metricJudgments(row, metric))),
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
	const failOpenImplementations = new Set(["screen-a0", "screen-json", "main-json", "A0", "J", "A"]);
	const oneCallByConstruction =
		group.length > 0 && group.every((row) => failOpenImplementations.has(row.implementationArm ?? row.arm));

	return {
		n: group.length,
		nCases: new Set(group.map((row) => row.case)).size,
		nFeedbackJudged: feedbackRows.filter(hasRoutedMessage).length,
		nRepeatRows: repeatRows.length,
		unjudgedRows,
		judgedComplete,
		refused: refusedRows.length,
		refusedRate: round(rate(group.map(isRefusal))),
		refusedKeys: refusedRows.map(sourceKey),
		scored: scored.length,
		valid: round(rate(group.map(observationSucceeded))),
		formatValid: round(rate(group.map((row) => row.formatValid))),
		oneCall: oneCallByConstruction ? null : round(rate(group.map((row) => row.providerCalls === 1))),
		oneCallByConstruction,
		providerCallsMax: group.length === 0 ? null : Math.max(...group.map((row) => row.providerCalls ?? 0)),
		recovery: oneCallByConstruction ? null : round(rate(group.map((row) => row.recoveryAttempted))),
		toolExcursions: group.filter((row) => row.initialStop === "toolUse").length,
		truncated: group.filter((row) => row.initialStop === "length" || row.stop === "length").length,
		strictFirstAttempt: group.some((row) => row.initialCompletionError === undefined)
			? null
			: round(rate(group.map((row) => row.initialCompletionError === null))),
		promptVariants: new Set(group.map((row) => row.promptHash)).size,
		heads: new Set(group.map((row) => row.head)).size,
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
		falseInterrupts: group.filter((row) => observationSucceeded(row) && row.delivery === "interrupt" && row.expectedDelivery !== "interrupt").length,
		genuineInterruptExact: round(rate(group.filter((row) => row.expectedDelivery === "interrupt").map((row) => observationSucceeded(row) && row.delivery === "interrupt"))),
		runtimeSuppressed: group.filter((row) => row.runtimeSuppressed).length,
		latencyMedianMs: quantile(group.flatMap((row) => Number.isFinite(row.ms) ? [row.ms] : []), 0.5),
		latencyP95Ms: quantile(group.flatMap((row) => Number.isFinite(row.ms) ? [row.ms] : []), 0.95),
		observerCostMean: round(mean(group.flatMap((row) => Number.isFinite(row.usage?.cost) ? [row.usage.cost] : [])), 6),
		outputTokenMean: round(mean(group.flatMap((row) => Number.isFinite(row.usage?.output) ? [row.usage.output] : [])), 1),
		reasoningTokenMean: round(mean(group.flatMap((row) => Number.isFinite(row.usage?.reasoning) ? [row.usage.reasoning] : [])), 1),
		// Provider-neutral billed-token basis: on Anthropic the arm contract
		// bills as cacheWrite while usage.input reads ~2, so input alone is
		// blind to the envelope. Paired across arms the driver prefix cancels.
		billedTokenMean: round(mean(group.flatMap((row) => Number.isFinite(row.usage?.output) ? [(row.usage.input ?? 0) + (row.usage.cacheRead ?? 0) + (row.usage.cacheWrite ?? 0) + row.usage.output] : [])), 1),
		uncachedInputMean: round(mean(group.flatMap((row) => Number.isFinite(row.usage?.input) ? [row.usage.input] : [])), 1),
		cacheHitMean: round(mean(group.flatMap((row) => Number.isFinite(row.hitRatio) ? [row.hitRatio] : [])), 2),
		zeroCacheReads: group.filter((row) => row.usage?.cacheRead === 0).length,
		judgeCoverage: expectedJudgments === 0 ? null : round(actualJudgments / expectedJudgments),
		judgeAgreement: !requiredJudgeSetComplete || requiredJudges.length < 2 || agreement.length === 0
			? null
			: round(rate(agreement.map((answers) => new Set(answers).size === 1))),
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

function gatesFor(config, baseline, candidate) {
	const anthropic = config.startsWith("anthropic");
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
		candidate.oneCallByConstruction
			? { rule: "R4 one-call", verdict: "not applicable", actual: null, threshold: 0.95, detail: "fail-open contract: one call by construction, not a measurement" }
			: compare("R4 one-call", candidate.oneCall, 0.95, candidate.oneCall >= 0.95, "oneCall >= 95%"),
		compare("R4 call ceiling", candidate.providerCallsMax, 2, candidate.providerCallsMax <= 2, "no observation above 2 provider calls"),
		compare("R4 truncation", candidate.truncated, 0, candidate.truncated === 0, "no length-truncated response (silent quality credit for fail-open arms)"),
		compare(
			"provenance",
			candidate.promptVariants,
			candidate.heads,
			candidate.promptVariants === candidate.heads,
			"distinct promptHash count equals head count — catches prompt edits appended into one artifact",
		),
		compare(
			"R4 judge excursion",
			candidate.toolExcursions,
			0,
			candidate.toolExcursions === 0,
			"no observation whose first attempt stopped on a tool call (initialStop === \"toolUse\")",
		),
		candidate.strictFirstAttempt === null || baseline.strictFirstAttempt === null
			? { rule: "validity guard", verdict: "not applicable", actual: candidate.strictFirstAttempt, threshold: null, detail: "initialCompletionError absent on some rows (pre-screen artifact vintage)" }
			: compare(
					"validity guard",
					candidate.strictFirstAttempt,
					baseline.strictFirstAttempt - 0.03,
					candidate.strictFirstAttempt >= baseline.strictFirstAttempt - 0.03,
					"first-attempt strict validity (initialCompletionError === null) >= baseline - 3pp; investigation trigger, not refutation",
				),
	];
	return checks;
}

function buildGates() {
	const configs = [...new Set(rows.map((row) => `${row.provider ?? "unknown"}/${row.model}`))].sort();
	const missing = configs.filter((config) => !groups[`${config}/${baselineArm}`]);
	if (missing.length > 0) {
		throw new Error(`baseline arm ${baselineArm} missing for config(s): ${missing.join(", ")}`);
	}
	const perConfig = [];
	for (const config of configs) {
		const baseline = groups[`${config}/${baselineArm}`];
		const arms = [...new Set(rows.filter((row) => `${row.provider ?? "unknown"}/${row.model}` === config).map((row) => row.arm))]
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

const gates = gateMode ? buildGates() : null;

const unknownProviderRows = rows.filter((row) => !row.provider).length;
const result = {
	inputs: inputPaths,
	judges: judgePaths,
	judgeNames,
	requiredJudges,
	requiredJudgeSetComplete,
	duplicateJudgments,
	unknownProviderRows,
	latencyBasis: LATENCY_BASIS,
	rows: rows.length,
	judgments: judgments.length,
	groups,
	byProviderArm,
	...(gates ? { gates } : {}),
};
if (unknownProviderRows > 0) {
	console.error(`WARNING: ${unknownProviderRows} row(s) carry no provider (likely error rows) — they form phantom "unknown/" groups and are missing from real denominators`);
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
