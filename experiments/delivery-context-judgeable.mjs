/**
 * The single predicate for "which rows must be judged, and on which metrics".
 *
 * The judge and the summarizer used to answer this from two independently
 * written expressions over two different snapshots: the judge read
 * `expectedDelivery` from the LIVE corpus, the summarizer from the row frozen
 * at produce time. They agreed by coincidence. Edit a case's `expectedDelivery`
 * between producing and judging and the judge assigns the row to one metric
 * family while the summarizer demands the other — `judgedComplete` is then
 * permanently false and `--gates` hard-stops with no recoverable path short of
 * re-judging everything.
 *
 * Both sides now read the ROW SNAPSHOT through this module, and the judge
 * additionally asserts that the live corpus still agrees with the snapshot, so
 * the drift surfaces as a named error before any judge spend rather than as an
 * unexplainable coverage hole afterwards.
 */

export const FEEDBACK_METRICS = Object.freeze(["support", "target"]);
export const QUIET_METRICS = Object.freeze(["repeat"]);
export const JUDGE_METRICS = Object.freeze(["support", "target", "repeat"]);

/** A completion the runner accepted, from a call that did not fail. */
export function observationSucceeded(row) {
	return row.completionValid === true && !row.error;
}

export function routedRow(row) {
	return observationSucceeded(row) && row.delivery !== "none";
}

/** Judgeable at all: something was routed, and it carries text a judge can read. */
export function hasRoutedMessage(row) {
	return routedRow(row) && typeof row.delivery === "string" && Boolean(row.message?.trim?.());
}

/**
 * The metrics this row owes, from its own snapshot. A quiet case that routed
 * anyway owes the improper-repeat judgment; a feedback case that routed owes
 * support and target. Everything else owes nothing.
 */
export function judgeableMetrics(row) {
	if (!hasRoutedMessage(row)) return [];
	return row.expectedDelivery === "none" ? QUIET_METRICS : FEEDBACK_METRICS;
}

export function isJudgeable(row, metric) {
	return judgeableMetrics(row).includes(metric);
}

/**
 * The rows whose snapshot no longer matches the corpus they name. Returned
 * rather than thrown so callers choose the severity: the judge refuses to run,
 * the summarizer reports a count.
 */
export function snapshotDrift(rows, caseById) {
	const drift = [];
	for (const row of rows) {
		const testCase = caseById.get(row.case);
		if (!testCase) continue;
		if (row.expectedDelivery !== undefined && row.expectedDelivery !== testCase.expectedDelivery) {
			drift.push(`${row.case}: row says ${row.expectedDelivery}, corpus says ${testCase.expectedDelivery}`);
		}
		if (row.category !== undefined && row.category !== testCase.category) {
			drift.push(`${row.case}: row category ${row.category}, corpus says ${testCase.category}`);
		}
	}
	return [...new Set(drift)];
}

export function assertNoSnapshotDrift(rows, caseById) {
	const drift = snapshotDrift(rows, caseById);
	if (drift.length > 0) {
		throw new Error(
			`producer rows disagree with the live corpus on ${drift.length} case field(s) — judging them would split one metric family across two definitions: ${drift.join("; ")}`,
		);
	}
}
