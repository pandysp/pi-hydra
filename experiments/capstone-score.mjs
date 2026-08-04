#!/usr/bin/env node
/**
 * Iteration-1 capstone scoring: the registered BENCHMARK-SPEC metrics over the
 * frozen consensus, producer, and baseline artifacts against final golden v2.
 * Deterministic, zero provider calls, fail-closed.
 *
 * Liveness/quiet-span basis for this iteration: the FILES derivation (exact
 * per-point workspace snapshots). The registered payload-primary derivation is
 * blind on capstone-format payloads (`defectStateInPayload` finds no
 * authoritative chunks in the Responses-API shape even though the defective
 * expressions are demonstrably inside the payload bytes) — recorded as a
 * harness-bug surprise for iteration 2, not silently papered over.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { argOf } from "./lib.mjs";
import { TRAJECTORY_TASKS } from "./trajectory-cost-tasks.mjs";
import { compileDefect, defectStateInFiles, readRows, cellsOf, pointsOf } from "./trajectory-ground-truth.mjs";
import { renderCapstoneTable } from "./render-capstone-table.mjs";

const args = process.argv.slice(2);
const OUT = argOf(args, "--output", "");
if (!OUT) throw new Error("--output is required");
const EXPECT_VERSION = argOf(args, "--expect-version", "0aadc215658a775b");
const logical = (path) => (path.endsWith(".gz") ? gunzipSync(readFileSync(path)) : readFileSync(path)).toString("utf8");

// --- frozen inputs -----------------------------------------------------------
const dataset = JSON.parse(readFileSync("experiments/golden-dataset.json", "utf8"));
if (dataset.version !== EXPECT_VERSION) throw new Error(`dataset is ${dataset.version}, expected ${EXPECT_VERSION}`);
const activeById = new Map(dataset.issues.map((issue) => [issue.id, issue]));
const activeByTask = new Map();
for (const issue of dataset.issues) {
	if (!activeByTask.has(issue.task)) activeByTask.set(issue.task, []);
	activeByTask.get(issue.task).push(issue);
}

const consensus = JSON.parse(logical("experiments/artifacts/2026-08-04-capstone-consensus/consensus-final.json.gz"));
if (consensus.status !== "analyst-resolved") throw new Error("consensus is not analyst-resolved");
const EXPECTED_FINDINGS = { fresh: 264, old: 107 };
for (const [input, expected] of Object.entries(EXPECTED_FINDINGS)) {
	const n = consensus.findings.filter((finding) => finding.input === input).length;
	if (n !== expected) throw new Error(`${input}: ${n} findings, expected ${expected}`);
}

const badIds = consensus.findings.flatMap((finding) => finding.defects
	.filter((defect) => defect.credited)
	.flatMap((defect) => defect.catalogIssueIds ?? [])
	.filter((id) => !activeById.has(id)));
if (badIds.length) throw new Error(`credited ids absent from final v2 actives: ${[...new Set(badIds)].join(", ")}`);

function parseKey(sourceKey) {
	const parts = sourceKey.split("/");
	return {
		runId: parts[0],
		task: parts[1],
		config: parts[2],
		arm: parts[parts.length - 2],
		pointId: parts.slice(3, parts.length - 2).join("/"),
	};
}

// --- per-cell liveness, spans, deliveries ------------------------------------
const taskDefects = (trajectoryId) => {
	const task = TRAJECTORY_TASKS.find((candidate) => candidate.id === trajectoryId);
	if (!task) throw new Error(`unknown trajectory ${trajectoryId}`);
	return task.defects.map(compileDefect);
};

function anchorLiveAtPoint(files, issue) {
	const anchors = issue.anchors;
	if (!anchors?.file || !anchors?.expression) return "unknown";
	const content = files?.[anchors.file];
	if (content === undefined) return "unknown";
	const hit = anchors.match === "regex" ? new RegExp(anchors.expression).test(content) : content.includes(anchors.expression);
	if (anchors.absent?.length) {
		if (!hit) return "unknown"; // context gone; the gap claim has no anchor to stand on
		return anchors.absent.every((needle) => !content.includes(needle)) ? "live" : "fixed";
	}
	return hit ? "live" : "fixed";
}

function scoreCell({ input, rows, trajectoryId, config }) {
	const cell = cellsOf(rows).find((candidate) => candidate.trajectoryId === trajectoryId && candidate.config === config);
	if (!cell) throw new Error(`${input}: no complete cell ${trajectoryId}/${config}`);
	const points = pointsOf(cell);
	if (!points.length) throw new Error(`${trajectoryId}/${config}: no points`);
	for (const point of points) if (!point.files) throw new Error(`${point.pointId}: missing file-state`);

	const planted = taskDefects(trajectoryId);
	const liveAt = points.map((point) => planted.filter((defect) => defectStateInFiles(point.files, defect).state === "live").length);
	const quiet = new Set(points.filter((_, index) => liveAt[index] === 0).map((point) => point.pointId));
	const spans = [];
	for (let index = 0; index < points.length; index++) {
		if (liveAt[index] !== 0) continue;
		if (spans.length && spans[spans.length - 1].to === index - 1) spans[spans.length - 1].to = index;
		else spans.push({ from: index, to: index });
	}

	const liveness = {};
	for (const issue of activeByTask.get(trajectoryId) ?? []) {
		const states = points.map((point) => anchorLiveAtPoint(point.files, issue));
		liveness[issue.id] = states.includes("live") ? "live" : states.includes("unknown") ? "unknown" : "never-live";
	}
	return { points, quiet, spans, liveness };
}

// --- assembly ----------------------------------------------------------------
// Old-input cost columns transcribed from the frozen N2 table in
// OPENAI-TRAJECTORY-RESULTS.md (basis: per-arm comparable observer cost /
// full driver cost; cache-floor rows excluded there).
const OLD_COSTS = {
	"sol-high/MAIN": { costPerObservation: 0.0212, observerDriverPercent: 51.1 },
	"sol-high/F2": { costPerObservation: 0.0223, observerDriverPercent: 57.3 },
	"sol-high/ENUM": { costPerObservation: 0.027, observerDriverPercent: 69.1 },
	"sol-xhigh/MAIN": { costPerObservation: 0.0269, observerDriverPercent: 58.7 },
	"sol-xhigh/F2": { costPerObservation: 0.0293, observerDriverPercent: 64.0 },
	"sol-xhigh/ENUM": { costPerObservation: 0.0401, observerDriverPercent: 87.5 },
};
const freshCosts = JSON.parse(readFileSync("experiments/OPENAI-CAPSTONE-COMPARISON.json", "utf8"));

const INPUTS = [
	{ input: "fresh", rowsPath: "experiments/artifacts/2026-08-03-openai-capstone-producer/rows.jsonl.gz", tasks: ["scheduler", "exporter", "dispatcher"], configs: ["sol-high", "sol-xhigh"], arms: ["MAIN-SO2", "ENUM-SO2"] },
	{ input: "old", rowsPath: "experiments/artifacts/2026-08-02-openai-trajectory/rows.jsonl.gz", tasks: ["scheduler"], configs: ["sol-high", "sol-xhigh"], arms: ["MAIN", "F2", "ENUM"] },
];

const flags = [];
const outputs = {};
for (const spec of INPUTS) {
	const rawRows = logical(spec.rowsPath).trim().split("\n").map((line) => JSON.parse(line));
	const comparisonRows = [];
	const details = [];
	for (const trajectoryId of spec.tasks) {
		for (const config of spec.configs) {
			const cell = scoreCell({ input: spec.input, rows: rawRows, trajectoryId, config });
			const activeIssues = activeByTask.get(trajectoryId) ?? [];
			const excluded = activeIssues.filter((issue) => cell.liveness[issue.id] === "never-live");
			const unknown = activeIssues.filter((issue) => cell.liveness[issue.id] === "unknown");
			for (const issue of unknown) flags.push(`${spec.input}/${trajectoryId}/${config}: liveness UNKNOWN for ${issue.id} — kept in denominator`);
			let denominator = activeIssues.filter((issue) => cell.liveness[issue.id] !== "never-live");

			const cellFindings = consensus.findings
				.map((finding) => ({ finding, key: parseKey(finding.sourceKey) }))
				.filter(({ finding, key }) => finding.input === spec.input && key.task === trajectoryId && key.config === config);
			// A credited id the files-derivation calls never-live is a
			// derivation miss, not phantom credit: re-admit it CELL-WIDE so
			// both arms score against the same denominator, flagged.
			const cellCreditedIds = new Set(cellFindings.flatMap(({ finding }) => finding.defects
				.filter((defect) => defect.credited)
				.flatMap((defect) => defect.catalogIssueIds ?? [])));
			for (const id of cellCreditedIds) {
				if (cell.liveness[id] === "never-live") {
					flags.push(`${spec.input}/${trajectoryId}/${config}: ${id} credited but files-derivation says never-live — re-admitted to the cell denominator`);
					if (!denominator.some((issue) => issue.id === id)) denominator = [...denominator, activeById.get(id)];
				}
			}
			for (const arm of spec.arms) {
				const armFindings = cellFindings.filter(({ key }) => key.arm === arm);
				const raised = armFindings.length;
				const real = armFindings.filter(({ finding }) => finding.defects.some((defect) => defect.credited)).length;
				const bothNotReal = armFindings.filter(({ finding }) =>
					!finding.defects.some((defect) => (defect.solClaimRefs ?? []).length > 0)
					&& !finding.defects.some((defect) => (defect.opusClaimRefs ?? []).length > 0)).length;
				const creditedIds = new Set(armFindings.flatMap(({ finding }) => finding.defects
					.filter((defect) => defect.credited)
					.flatMap((defect) => defect.catalogIssueIds ?? [])));
				const blockingDen = denominator.filter((issue) => issue.tier === "blocking");
				const harmfulDen = denominator.filter((issue) => issue.tier === "harmful");
				const blockingFound = [...creditedIds].filter((id) => activeById.get(id).tier === "blocking").length;
				const harmfulFound = [...creditedIds].filter((id) => activeById.get(id).tier === "harmful").length;

				const armObservations = cell.points.flatMap((point) => point.observations.filter((observation) => observation.arm === arm));
				const quietDeliveries = armObservations.filter((observation) =>
					cell.quiet.has(observation.pointId) && (observation.delivery === "steer" || observation.delivery === "interrupt")).length;

				const cost = spec.input === "fresh"
					? freshCosts.rows.find((row) => row.task === trajectoryId && row.config === config && row.arm === arm)
					: OLD_COSTS[`${config}/${arm}`];
				if (!cost) throw new Error(`no frozen cost for ${spec.input}/${trajectoryId}/${config}/${arm}`);

				comparisonRows.push({
					task: trajectoryId,
					config,
					arm,
					costPerObservation: cost.costPerObservation,
					observerDriverPercent: cost.observerDriverPercent,
					blocking: { found: blockingFound, total: blockingDen.length },
					harmful: { found: harmfulFound, total: harmfulDen.length },
					precision: { real, raised },
					quietSpanDeliveries: quietDeliveries,
				});
				details.push({
					task: trajectoryId, config, arm,
					creditedIds: [...creditedIds].sort(),
					excludedNeverLive: excluded.map((issue) => issue.id),
					livenessUnknown: unknown.map((issue) => issue.id),
					quietSpans: cell.spans,
					bothJudgesNotReal: bothNotReal,
					disagreementFindings: armFindings.filter(({ finding }) => finding.defects.some((defect) => defect.disagreement)).length,
				});
			}
		}
	}
	outputs[spec.input] = { comparisonRows, details };
}

// Unweighted per-task means (fresh only spans multiple tasks).
function unweightedMeans(rowsForInput, arms) {
	return arms.map((arm) => {
		const armRows = rowsForInput.filter((row) => row.arm === arm);
		const mean = (fn) => armRows.reduce((sum, row) => sum + fn(row), 0) / armRows.length;
		return {
			arm,
			blockingRecall: mean((row) => row.blocking.found / (row.blocking.total || 1)),
			anyHarmRecall: mean((row) => (row.blocking.found + row.harmful.found) / ((row.blocking.total + row.harmful.total) || 1)),
			precision: mean((row) => row.precision.real / (row.precision.raised || 1)),
		};
	});
}

mkdirSync(OUT, { recursive: true });
for (const [input, { comparisonRows, details }] of Object.entries(outputs)) {
	const payload = { datasetVersion: dataset.version, consensusArtifact: "2026-08-04-capstone-consensus", iteration: 1, rows: comparisonRows };
	writeFileSync(join(OUT, `comparison-${input}.json`), `${JSON.stringify(payload, null, 1)}\n`);
	writeFileSync(join(OUT, `table-${input}.md`), renderCapstoneTable(payload));
	writeFileSync(join(OUT, `details-${input}.json`), `${JSON.stringify(details, null, 1)}\n`);
}
writeFileSync(join(OUT, "means-fresh.json"), `${JSON.stringify(unweightedMeans(outputs.fresh.comparisonRows, ["MAIN-SO2", "ENUM-SO2"]), null, 1)}\n`);
writeFileSync(join(OUT, "means-old.json"), `${JSON.stringify(unweightedMeans(outputs.old.comparisonRows, ["MAIN", "F2", "ENUM"]), null, 1)}\n`);
writeFileSync(join(OUT, "flags.json"), `${JSON.stringify(flags, null, 1)}\n`);
console.log(`fresh rows: ${outputs.fresh.comparisonRows.length}; old rows: ${outputs.old.comparisonRows.length}; flags: ${flags.length}`);
for (const flag of flags) console.log(`FLAG: ${flag}`);
