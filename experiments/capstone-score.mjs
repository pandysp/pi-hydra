#!/usr/bin/env node
/**
 * Capstone scoring: the registered BENCHMARK-SPEC metrics over the frozen
 * consensus, producer, and baseline artifacts against final golden v2.
 * Deterministic, zero provider calls, fail-closed.
 *
 * Iteration-2 evaluator changes (ITERATION1-DATA-PASS.md lane A, landed
 * between iterations per the registered freeze rule — the published
 * iteration-1 outputs are immutable and this scorer no longer reproduces
 * them byte-for-byte):
 *  - quiet spans come from the registered payload-primary derivation when
 *    `--payloads-<input>` names an extracted payload directory (the walker
 *    now parses the Responses shape); the files derivation remains the
 *    anchor-liveness basis and the fallback, flagged when used (A1);
 *  - a foreign-frame (`state:"end"`) anchor answers "unknown", never
 *    "never-live" (A2);
 *  - the noise column is the registered both-judges-not-real count, read
 *    from claim SUPPORT in the frozen packets, not claim-ref presence (A3);
 *  - precision is reported in both populations (all semantic-v2 findings
 *    and valid-source-only) and additionally per delivering row, the unit
 *    that means the same thing in every cell (A6);
 *  - the one-judge match floor is recorded beside recall (A7).
 */
import { readFileSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { argOf } from "./lib.mjs";
import { TRAJECTORY_TASKS } from "./trajectory-cost-tasks.mjs";
import { compileDefect, defectStateInFiles, defectStateInPayload, cellsOf, pointsOf } from "./trajectory-ground-truth.mjs";
import { renderCapstoneTable } from "./render-capstone-table.mjs";

const logical = (path) => (path.endsWith(".gz") ? gunzipSync(readFileSync(path)) : readFileSync(path)).toString("utf8");

export function parseKey(sourceKey) {
	const parts = sourceKey.split("/");
	return {
		runId: parts[0],
		task: parts[1],
		config: parts[2],
		arm: parts[parts.length - 2],
		pointId: parts.slice(3, parts.length - 2).join("/"),
	};
}

/** sourceKey without the trailing /fN — one key per delivering observation row. */
export function rowKeyOf(sourceKey) {
	return sourceKey.replace(/\/f\d+$/, "");
}

export function anchorLiveAtPoint(files, issue) {
	const anchors = issue.anchors;
	if (!anchors?.file || !anchors?.expression) return "unknown";
	// A2: an end-state anchor transcribes ONE driver run's post-edit bytes;
	// against any other run it is a foreign frame and can only answer
	// "unknown" — never "never-live", which shrinks the denominator and
	// inflates recall.
	if (anchors.state === "end") return "unknown";
	const content = files?.[anchors.file];
	if (content === undefined) return "unknown";
	const hit = anchors.match === "regex" ? new RegExp(anchors.expression).test(content) : content.includes(anchors.expression);
	if (anchors.absent?.length) {
		if (!hit) return "unknown"; // context gone; the gap claim has no anchor to stand on
		return anchors.absent.every((needle) => !content.includes(needle)) ? "live" : "fixed";
	}
	return hit ? "live" : "fixed";
}

/**
 * Per-finding judge support and matches, from the frozen consensus packets.
 * `solSupported`/`opusSupported`: the judge has at least one claim with
 * centralSupported === true (the registered reading of "judged real").
 * `solMatched`/`opusMatched`: catalog ids from claims whose support is not
 * refuted (centralSupported !== false) — the basis of the one-judge floor.
 */
export function packetSupport(packet) {
	const byFinding = new Map();
	for (const finding of packet.findings) {
		const side = (claims) => ({
			supported: (claims ?? []).some((claim) => claim.centralSupported === true),
			matched: new Set((claims ?? [])
				.filter((claim) => claim.centralSupported !== false)
				.flatMap((claim) => (claim.matches ?? []).map((match) => match.issueId).filter(Boolean))),
		});
		byFinding.set(finding.sourceKey, {
			validity: finding.qualitySourceValidity ?? "valid",
			sol: side(finding.solClaims),
			opus: side(finding.opusClaims),
		});
	}
	return byFinding;
}

/** Ids matched by exactly one judge across a set of findings, active only. */
export function oneJudgeFloor(supportEntries, activeById) {
	const sol = new Set();
	const opus = new Set();
	for (const entry of supportEntries) {
		for (const id of entry.sol.matched) sol.add(id);
		for (const id of entry.opus.matched) opus.add(id);
	}
	const oneSided = [...new Set([...sol, ...opus])]
		.filter((id) => activeById.has(id))
		.filter((id) => sol.has(id) !== opus.has(id));
	return {
		ids: oneSided.sort(),
		blocking: oneSided.filter((id) => activeById.get(id).tier === "blocking").length,
	};
}

export function unweightedMeans(rowsForInput, arms) {
	return arms.map((arm) => {
		const armRows = rowsForInput.filter((row) => row.arm === arm);
		const mean = (fn) => armRows.reduce((sum, row) => sum + fn(row), 0) / armRows.length;
		return {
			arm,
			blockingRecall: mean((row) => row.blocking.found / (row.blocking.total || 1)),
			anyHarmRecall: mean((row) => (row.blocking.found + row.harmful.found) / ((row.blocking.total + row.harmful.total) || 1)),
			precision: mean((row) => row.precision.real / (row.precision.raised || 1)),
			precisionValid: mean((row) => row.precisionValid.real / (row.precisionValid.raised || 1)),
			precisionPerRow: mean((row) => row.precisionRows.real / (row.precisionRows.raised || 1)),
		};
	});
}

function payloadIndex(payloadDir) {
	if (!payloadDir) return null;
	const index = new Map();
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name.endsWith(".json")) index.set(entry.name, path);
		}
	};
	walk(payloadDir);
	return index;
}

function main() {
	const args = process.argv.slice(2);
	const OUT = argOf(args, "--output", "");
	if (!OUT) throw new Error("--output is required");
	const EXPECT_VERSION = argOf(args, "--expect-version", "0aadc215658a775b");
	const payloadDirs = {
		fresh: argOf(args, "--payloads-fresh", ""),
		old: argOf(args, "--payloads-old", ""),
	};

	// --- frozen inputs -------------------------------------------------------
	// The capstone table was judged against golden v2, so a rescore must read
	// the dataset version it expects — pass the frozen copy explicitly once the
	// live dataset has moved on (a version-bumped rescore is a deliberate run,
	// never a test side effect).
	const datasetPath = argOf(args, "--dataset", "experiments/golden-dataset.json");
	const datasetBytes = datasetPath.endsWith(".gz")
		? gunzipSync(readFileSync(datasetPath)).toString("utf8")
		: readFileSync(datasetPath, "utf8");
	const dataset = JSON.parse(datasetBytes);
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

	const support = new Map([
		...packetSupport(JSON.parse(logical("experiments/artifacts/2026-08-04-capstone-consensus/fresh-packet.json.gz"))),
		...packetSupport(JSON.parse(logical("experiments/artifacts/2026-08-04-capstone-consensus/old-packet.json.gz"))),
	]);

	const taskDefects = (trajectoryId) => {
		const task = TRAJECTORY_TASKS.find((candidate) => candidate.id === trajectoryId);
		if (!task) throw new Error(`unknown trajectory ${trajectoryId}`);
		return task.defects.map(compileDefect);
	};

	const flags = [];

	function scoreCell({ input, rows, trajectoryId, config, payloads }) {
		const cell = cellsOf(rows).find((candidate) => candidate.trajectoryId === trajectoryId && candidate.config === config);
		if (!cell) throw new Error(`${input}: no complete cell ${trajectoryId}/${config}`);
		const points = pointsOf(cell);
		if (!points.length) throw new Error(`${trajectoryId}/${config}: no points`);
		for (const point of points) if (!point.files) throw new Error(`${point.pointId}: missing file-state`);

		const planted = taskDefects(trajectoryId);
		// Quiet basis: payload-primary (the registered derivation) when the
		// frozen payloads are supplied; files fallback is flagged.
		let liveAt;
		if (payloads) {
			const loaded = points.map((point) => {
				const name = point.payloadPath ? point.payloadPath.split("/").pop() : null;
				const path = name ? payloads.get(name) : null;
				if (!path) throw new Error(`${point.pointId}: captured payload ${name ?? "?"} not in the supplied payload dir`);
				return JSON.parse(readFileSync(path, "utf8"));
			});
			const perDefect = planted.map((defect) => {
				let firstVisible = null;
				let firstFixed = null;
				loaded.forEach((payload, index) => {
					const state = defectStateInPayload(payload, defect)?.state ?? null;
					if (state === "live" && firstVisible === null) firstVisible = index;
					if (state === "fixed" && firstVisible !== null && firstFixed === null && index > firstVisible) firstFixed = index;
				});
				return { firstVisible, firstFixed };
			});
			liveAt = points.map((_, index) => perDefect.filter((defect) =>
				defect.firstVisible !== null && index >= defect.firstVisible && (defect.firstFixed === null || index < defect.firstFixed)).length);
		} else {
			flags.push(`${input}/${trajectoryId}/${config}: quiet spans on the FILES fallback — payload dir not supplied`);
			liveAt = points.map((point) => planted.filter((defect) => defectStateInFiles(point.files, defect).state === "live").length);
		}
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

	const outputs = {};
	for (const spec of INPUTS) {
		const rawRows = logical(spec.rowsPath).trim().split("\n").map((line) => JSON.parse(line));
		const payloads = payloadIndex(payloadDirs[spec.input] || null);
		const comparisonRows = [];
		const details = [];
		for (const trajectoryId of spec.tasks) {
			for (const config of spec.configs) {
				const cell = scoreCell({ input: spec.input, rows: rawRows, trajectoryId, config, payloads });
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
					const supportOf = ({ finding }) => {
						const entry = support.get(finding.sourceKey);
						if (!entry) throw new Error(`${finding.sourceKey}: absent from the frozen packets`);
						return entry;
					};
					const raised = armFindings.length;
					const real = armFindings.filter(({ finding }) => finding.defects.some((defect) => defect.credited)).length;
					// A3: the registered reading — no claim from either judge
					// carries centralSupported === true.
					const bothNotReal = armFindings.filter((item) => {
						const entry = supportOf(item);
						return !entry.sol.supported && !entry.opus.supported;
					}).length;
					// A6: valid-source-only population, same finding unit.
					const validFindings = armFindings.filter((item) => supportOf(item).validity === "valid");
					const precisionValid = {
						real: validFindings.filter(({ finding }) => finding.defects.some((defect) => defect.credited)).length,
						raised: validFindings.length,
					};
					// A6: the row-normalized unit — one delivering observation
					// row counts once whatever its finding volume.
					const rowKeys = new Set(armFindings.map(({ finding }) => rowKeyOf(finding.sourceKey)));
					const realRowKeys = new Set(armFindings
						.filter(({ finding }) => finding.defects.some((defect) => defect.credited))
						.map(({ finding }) => rowKeyOf(finding.sourceKey)));
					const creditedIds = new Set(armFindings.flatMap(({ finding }) => finding.defects
						.filter((defect) => defect.credited)
						.flatMap((defect) => defect.catalogIssueIds ?? [])));
					const floor = oneJudgeFloor(armFindings.map(supportOf), activeById);
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
						precisionValid,
						precisionRows: { real: realRowKeys.size, raised: rowKeys.size },
						absoluteNoise: bothNotReal,
						oneJudgeFloor: { count: floor.ids.length, blocking: floor.blocking },
						quietSpanDeliveries: quietDeliveries,
					});
					details.push({
						task: trajectoryId, config, arm,
						creditedIds: [...creditedIds].sort(),
						excludedNeverLive: excluded.map((issue) => issue.id),
						livenessUnknown: unknown.map((issue) => issue.id),
						quietSpans: cell.spans,
						bothJudgesNotReal: bothNotReal,
						oneJudgeFloorIds: floor.ids,
						disagreementFindings: armFindings.filter(({ finding }) => finding.defects.some((defect) => defect.disagreement)).length,
					});
				}
			}
		}
		outputs[spec.input] = { comparisonRows, details };
	}

	mkdirSync(OUT, { recursive: true });
	for (const [input, { comparisonRows, details }] of Object.entries(outputs)) {
		const payload = { datasetVersion: dataset.version, consensusArtifact: "2026-08-04-capstone-consensus", iteration: 2, rows: comparisonRows };
		writeFileSync(join(OUT, `comparison-${input}.json`), `${JSON.stringify(payload, null, 1)}\n`);
		writeFileSync(join(OUT, `table-${input}.md`), renderCapstoneTable(payload));
		writeFileSync(join(OUT, `details-${input}.json`), `${JSON.stringify(details, null, 1)}\n`);
	}
	writeFileSync(join(OUT, "means-fresh.json"), `${JSON.stringify(unweightedMeans(outputs.fresh.comparisonRows, ["MAIN-SO2", "ENUM-SO2"]), null, 1)}\n`);
	writeFileSync(join(OUT, "means-old.json"), `${JSON.stringify(unweightedMeans(outputs.old.comparisonRows, ["MAIN", "F2", "ENUM"]), null, 1)}\n`);
	writeFileSync(join(OUT, "flags.json"), `${JSON.stringify(flags, null, 1)}\n`);
	console.log(`fresh rows: ${outputs.fresh.comparisonRows.length}; old rows: ${outputs.old.comparisonRows.length}; flags: ${flags.length}`);
	for (const flag of flags) console.log(`FLAG: ${flag}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
