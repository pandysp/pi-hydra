/** Pure four-bucket scoring over a terminal expanded-2Q occurrence ledger. */

import { readFileSync, writeFileSync } from "node:fs";
import { argOf } from "./lib.mjs";
import { finalDualCatalogIdentity } from "./dual-catalog-growth.mjs";

const TERMINAL = new Set(["real", "false", "unresolved", "unjudgeable", "invalid-output"]);
const SEVERITIES = new Set(["severe", "minor"]);

function activeById(catalog, lane) {
	const rows = lane === "real" ? catalog.issues : catalog.items;
	const out = new Map();
	for (const item of rows ?? []) {
		if (item.status !== "active") continue;
		if (out.has(item.id)) throw new Error(`duplicate active ${lane} catalog id ${item.id}`);
		const severity = lane === "real"
			? item.tier === "blocking" ? "severe" : item.tier === "harmful" ? "minor" : null
			: item.severity;
		if (!SEVERITIES.has(severity)) throw new Error(`${item.id}: invalid ${lane} severity`);
		out.set(item.id, { ...item, severity });
	}
	return out;
}

function rate(found, total) {
	return total === 0 ? null : found / total;
}

function burden(occurrences, distinctIds, trajectoryCount, observationPoints) {
	return {
		occurrences,
		distinctIds: distinctIds.size,
		perTrajectory: trajectoryCount === 0 ? null : occurrences / trajectoryCount,
		per100ObservationPoints: observationPoints === 0 ? null : (100 * occurrences) / observationPoints,
	};
}

function entryInCell(entry, cell) {
	return entry.task === cell.task && entry.config === cell.config && entry.arm === cell.arm &&
		(cell.runIds === undefined || cell.runIds.includes(entry.runId));
}

function nonEmptyString(value) {
	return typeof value === "string" && value.length > 0;
}

function cellKey(cell) {
	return `${cell.task}\0${cell.config}\0${cell.arm}`;
}

export function scoreDualCatalogQuality({ ledger, realCatalog, falseCatalog, cells }) {
	if (ledger?.status !== "complete") throw new Error("occurrence ledger must be complete before scoring");
	if (!Array.isArray(ledger.entries)) throw new Error("occurrence ledger entries must be an array");
	if (!Array.isArray(cells)) throw new Error("cells must be an array");
	const catalogIdentity = finalDualCatalogIdentity(realCatalog, falseCatalog);
	if (JSON.stringify(ledger.catalogIdentity) !== JSON.stringify(catalogIdentity)) {
		throw new Error("occurrence ledger catalog identity differs from the supplied final catalogs");
	}
	if (ledger.counts?.eligible !== ledger.entries.length) throw new Error("occurrence ledger eligible count differs from its entries");
	const realById = activeById(realCatalog, "real");
	const falseById = activeById(falseCatalog, "false");
	const sourceKeys = new Set();
	for (const entry of ledger.entries) {
		if (!entry?.sourceKey || sourceKeys.has(entry.sourceKey)) throw new Error(`duplicate or missing ledger sourceKey ${entry?.sourceKey ?? ""}`);
		sourceKeys.add(entry.sourceKey);
		for (const field of ["runId", "task", "config", "arm"]) {
			if (!nonEmptyString(entry[field])) throw new Error(`${entry.sourceKey}: missing ${field}`);
		}
		if (!TERMINAL.has(entry.status)) throw new Error(`${entry.sourceKey}: non-terminal status ${entry.status}`);
		const ids = entry.catalogIds ?? [];
		if (!Array.isArray(ids) || ids.some((id) => !nonEmptyString(id)) || new Set(ids).size !== ids.length) {
			throw new Error(`${entry.sourceKey}: duplicate or invalid catalogIds`);
		}
		if (entry.status === "real" && (ids.length === 0 || ids.some((id) => !realById.has(id)))) {
			throw new Error(`${entry.sourceKey}: real outcome lacks valid real catalog ids`);
		}
		if (entry.status === "false" && (ids.length === 0 || ids.some((id) => !falseById.has(id)))) {
			throw new Error(`${entry.sourceKey}: false outcome lacks valid false catalog ids`);
		}
		if (entry.status === "real" && ids.some((id) => realById.get(id).task !== entry.task)) {
			throw new Error(`${entry.sourceKey}: real catalog id belongs to another task`);
		}
		if (entry.status === "false" && ids.some((id) => falseById.get(id).task !== entry.task)) {
			throw new Error(`${entry.sourceKey}: false catalog id belongs to another task`);
		}
		if (!["real", "false"].includes(entry.status) && ids.length > 0) {
			throw new Error(`${entry.sourceKey}: ${entry.status} outcome cannot carry catalog ids`);
		}
	}

	const seenCells = new Set();
	const livenessByCell = new Map();
	for (const cell of cells) {
		for (const field of ["task", "config", "arm"]) {
			if (!nonEmptyString(cell?.[field])) throw new Error(`score cell is missing ${field}`);
		}
		const key = cellKey(cell);
		if (seenCells.has(key)) throw new Error(`${cell.task}/${cell.config}/${cell.arm}: duplicate score cell`);
		seenCells.add(key);
		if (cell.runIds !== undefined && (!Array.isArray(cell.runIds) || cell.runIds.length === 0 ||
			cell.runIds.some((id) => !nonEmptyString(id)) || new Set(cell.runIds).size !== cell.runIds.length)) {
			throw new Error(`${cell.task}/${cell.config}/${cell.arm}: runIds must be a non-empty unique string array`);
		}
		for (const field of ["liveRealIds", "excludedRealIds"]) {
			if (!Array.isArray(cell[field]) || cell[field].some((id) => !nonEmptyString(id)) || new Set(cell[field]).size !== cell[field].length) {
				throw new Error(`${cell.task}/${cell.config}/${cell.arm}: ${field} must be a unique string array`);
			}
		}
		const liveIds = new Set(cell.liveRealIds);
		const excludedIds = new Set(cell.excludedRealIds);
		const overlap = cell.liveRealIds.filter((id) => excludedIds.has(id));
		if (overlap.length) throw new Error(`${cell.task}/${cell.config}/${cell.arm}: live and excluded real ids overlap: ${overlap.join(", ")}`);
		for (const [kind, ids] of [["live", cell.liveRealIds], ["excluded", cell.excludedRealIds]]) {
			for (const id of ids) {
				const issue = realById.get(id);
				if (!issue) throw new Error(`${cell.task}/${cell.config}/${cell.arm}: unknown ${kind} real id ${id}`);
				if (issue.task !== cell.task) throw new Error(`${id}: task differs from score cell ${cell.task}`);
			}
		}
		const taskIds = [...realById.values()].filter((issue) => issue.task === cell.task).map((issue) => issue.id).sort();
		const declaredIds = [...liveIds, ...excludedIds].sort();
		if (JSON.stringify(declaredIds) !== JSON.stringify(taskIds)) {
			const missing = taskIds.filter((id) => !liveIds.has(id) && !excludedIds.has(id));
			throw new Error(`${cell.task}/${cell.config}/${cell.arm}: live and excluded real ids do not partition the active task catalog; missing: ${missing.join(", ") || "none"}`);
		}
		livenessByCell.set(key, {
			live: cell.liveRealIds.map((id) => realById.get(id)),
			excluded: cell.excludedRealIds.map((id) => realById.get(id)),
		});
	}
	for (const entry of ledger.entries) {
		const matches = cells.filter((cell) => entryInCell(entry, cell));
		if (matches.length !== 1) {
			throw new Error(`${entry.sourceKey}: ledger entry belongs to ${matches.length} score cells; expected exactly one`);
		}
	}

	return cells.map((cell) => {
		if (!Number.isInteger(cell.trajectoryCount) || cell.trajectoryCount < 1) throw new Error(`${cell.task}/${cell.config}/${cell.arm}: invalid trajectoryCount`);
		if (!Number.isInteger(cell.observationPoints) || cell.observationPoints < 0) throw new Error(`${cell.task}/${cell.config}/${cell.arm}: invalid observationPoints`);
		const { live, excluded } = livenessByCell.get(cellKey(cell));
		const entries = ledger.entries.filter((entry) => entryInCell(entry, cell));
		const foundRealIds = new Set(entries.filter((entry) => entry.status === "real").flatMap((entry) => entry.catalogIds));
		for (const id of foundRealIds) {
			if (!cell.liveRealIds.includes(id)) throw new Error(`${cell.task}/${cell.config}/${cell.arm}: credited real id ${id} is not live`);
		}
		const severeLive = live.filter((issue) => issue.severity === "severe");
		const minorLive = live.filter((issue) => issue.severity === "minor");
		const severeFound = severeLive.filter((issue) => foundRealIds.has(issue.id));
		const minorFound = minorLive.filter((issue) => foundRealIds.has(issue.id));

		// One occurrence is one unique (observer-authored finding, false catalog id)
		// pair. Repeating the same bad proposition in another finding still counts.
		const falsePairs = new Map();
		for (const entry of entries.filter((candidate) => candidate.status === "false")) {
			for (const id of entry.catalogIds) falsePairs.set(`${entry.sourceKey}\0${id}`, falseById.get(id));
		}
		const severePairs = [...falsePairs.entries()].filter(([, item]) => item.severity === "severe");
		const minorPairs = [...falsePairs.entries()].filter(([, item]) => item.severity === "minor");
		const idsOf = (pairs) => new Set(pairs.map(([pair]) => pair.slice(pair.indexOf("\0") + 1)));

		return {
			task: cell.task,
			config: cell.config,
			arm: cell.arm,
			severeRecall: { found: severeFound.length, total: severeLive.length, rate: rate(severeFound.length, severeLive.length) },
			minorRecall: { found: minorFound.length, total: minorLive.length, rate: rate(minorFound.length, minorLive.length) },
			excludedLiveness: {
				total: excluded.length,
				severe: excluded.filter((issue) => issue.severity === "severe").length,
				minor: excluded.filter((issue) => issue.severity === "minor").length,
			},
			severeFalseBurden: burden(severePairs.length, idsOf(severePairs), cell.trajectoryCount, cell.observationPoints),
			minorFalseBurden: burden(minorPairs.length, idsOf(minorPairs), cell.trajectoryCount, cell.observationPoints),
			unresolved: entries.filter((entry) => entry.status === "unresolved").length,
			unjudgeable: entries.filter((entry) => entry.status === "unjudgeable").length,
			invalidOutput: entries.filter((entry) => entry.status === "invalid-output").length,
		};
	});
}

function pct(value) {
	return value === null ? "n/a" : `${(100 * value).toFixed(1)}%`;
}

function burdenCell(value) {
	return `${value.occurrences} (${value.distinctIds} ids; ${value.perTrajectory?.toFixed(2) ?? "n/a"}/traj; ${value.per100ObservationPoints?.toFixed(2) ?? "n/a"}/100pt)`;
}

export function renderDualCatalogQualityTable(rows) {
	const lines = [
		"| task | config | arm | severe recall | minor recall | excluded real ids | severe false burden | minor false burden | unresolved | unjudgeable | invalid |",
		"|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
	];
	for (const row of rows) {
		lines.push(`| ${row.task} | ${row.config} | ${row.arm} | ${row.severeRecall.found}/${row.severeRecall.total} (${pct(row.severeRecall.rate)}) | ${row.minorRecall.found}/${row.minorRecall.total} (${pct(row.minorRecall.rate)}) | ${row.excludedLiveness.total} (${row.excludedLiveness.severe} severe; ${row.excludedLiveness.minor} minor) | ${burdenCell(row.severeFalseBurden)} | ${burdenCell(row.minorFalseBurden)} | ${row.unresolved} | ${row.unjudgeable} | ${row.invalidOutput} |`);
	}
	return `${lines.join("\n")}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2);
	const ledgerPath = argOf(args, "--ledger", "");
	const realPath = argOf(args, "--real-catalog", "experiments/golden-dataset.json");
	const falsePath = argOf(args, "--false-catalog", "experiments/false-positive-catalog.json");
	const cellsPath = argOf(args, "--cells", "");
	const outputPath = argOf(args, "--output", "");
	const tablePath = argOf(args, "--table", "");
	if (!ledgerPath || !cellsPath || !outputPath || !tablePath) {
		throw new Error("--ledger, --cells, --output and --table are required");
	}
	const rows = scoreDualCatalogQuality({
		ledger: JSON.parse(readFileSync(ledgerPath, "utf8")),
		realCatalog: JSON.parse(readFileSync(realPath, "utf8")),
		falseCatalog: JSON.parse(readFileSync(falsePath, "utf8")),
		cells: JSON.parse(readFileSync(cellsPath, "utf8")),
	});
	writeFileSync(outputPath, `${JSON.stringify({ schemaVersion: 1, metric: "expanded-2q-four-buckets-v1", rows }, null, 2)}\n`);
	writeFileSync(tablePath, renderDualCatalogQualityTable(rows));
	process.stdout.write(`complete: ${rows.length} score rows\n`);
}
