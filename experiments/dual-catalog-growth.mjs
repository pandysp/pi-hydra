import { normalizeDualCatalogOutcome } from "./dual-catalog-reconcile.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { argOf } from "./lib.mjs";
import { validateFalsePositiveCatalog, validateRealCatalog } from "./dual-catalog.mjs";

function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => [key, canonical(item)]));
	}
	return value;
}

const stable = (value) => JSON.stringify(canonical(value));
const sha256 = (value) => createHash("sha256").update(stable(value)).digest("hex");

/** Exact semantic identity of the complete validated final catalogs. */
export function finalDualCatalogIdentity(realCatalog, falseCatalog) {
	validateRealCatalog(realCatalog);
	const tasks = [...new Set(realCatalog.issues.map((issue) => issue.task))];
	validateFalsePositiveCatalog(falseCatalog, { tasks });
	return {
		algorithm: "sha256-canonical-json-v1",
		real: { version: realCatalog.version, fullHash: sha256(realCatalog) },
		false: { version: falseCatalog.version, fullHash: sha256(falseCatalog) },
	};
}

function activeCatalogEntries(realCatalog, falseCatalog) {
	const entries = new Map();
	for (const issue of realCatalog.issues.filter((item) => item.status === "active")) {
		entries.set(issue.id, {
			id: issue.id,
			truth: "real",
			task: issue.task,
			severity: issue.tier === "blocking" ? "severe" : "minor",
		});
	}
	for (const item of falseCatalog.items.filter((candidate) => candidate.status === "active")) {
		if (entries.has(item.id)) throw new Error(`${item.id}: catalog id exists in both truth lanes`);
		entries.set(item.id, { id: item.id, truth: "false", task: item.task, severity: item.severity });
	}
	return entries;
}

function assertCatalogIds(ids, { caseId, truth, task, severity = null, entries }) {
	if (ids.length === 0) throw new Error(`${caseId}: ${truth} outcome has no final catalog id`);
	for (const id of ids) {
		const item = entries.get(id);
		if (!item || item.truth !== truth) throw new Error(`${caseId}: ${id} is not an active ${truth} catalog id`);
		if (item.task !== task) throw new Error(`${caseId}: ${id} belongs to task ${item.task}, not ${task}`);
		if (severity !== null && item.severity !== severity) {
			throw new Error(`${caseId}: ${id} severity ${item.severity} differs from settled ${severity}`);
		}
	}
}

function normalizeRuling(caseId, ruling) {
	if (!ruling || typeof ruling !== "object") throw new Error(`${caseId}: missing human ruling`);
	const reason = ruling.reason ?? ruling.reasoning;
	if (typeof reason !== "string" || !reason.trim()) throw new Error(`${caseId}: human ruling needs a reason`);
	const ruledBy = ruling.ruledBy ?? ruling.authority;
	if (typeof ruledBy !== "string" || !ruledBy.trim()) throw new Error(`${caseId}: human ruling needs an authority`);
	const outcome = normalizeDualCatalogOutcome(ruling.outcome ?? ruling);
	return { outcome, reason: reason.trim(), ruledBy: ruledBy.trim() };
}

function normalizeIds(value, label) {
	const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
	if (raw.some((id) => typeof id !== "string" || !id)) throw new Error(`${label} contains an invalid catalog id`);
	if (new Set(raw).size !== raw.length) throw new Error(`${label} contains duplicate catalog ids`);
	return [...raw].sort();
}

function normalizeOccurrenceMapping(caseId, mapping, truth, expectedIdentity) {
	if (!mapping || typeof mapping !== "object") throw new Error(`${caseId}: settled unmatched occurrence has no final catalog mapping`);
	const generic = mapping.catalogIds ?? mapping.catalogId;
	const realCatalogIds = normalizeIds(mapping.realCatalogIds ?? mapping.realMatches ?? (truth === "real" ? generic : undefined), `${caseId} real mapping`);
	const falseCatalogIds = normalizeIds(mapping.falseCatalogIds ?? mapping.falseMatches ?? (truth === "false" ? generic : undefined), `${caseId} false mapping`);
	if (truth === "real" && (realCatalogIds.length === 0 || falseCatalogIds.length > 0)) {
		throw new Error(`${caseId}: real occurrence must map only to real catalog ids`);
	}
	if (truth === "false" && (falseCatalogIds.length === 0 || realCatalogIds.length > 0)) {
		throw new Error(`${caseId}: false occurrence must map only to false catalog ids`);
	}
	if (mapping.catalogVersions !== undefined) {
		const expected = { real: expectedIdentity.real.version, false: expectedIdentity.false.version };
		if (stable(mapping.catalogVersions) !== stable(expected)) {
			throw new Error(`${caseId}: occurrence mapping catalog versions differ from the final catalogs`);
		}
	}
	return {
		realCatalogIds,
		falseCatalogIds,
		...(mapping.reason === undefined ? {} : { reason: mapping.reason }),
	};
}

function ledgerEntry(decision, outcome, resolution, mapping = null) {
	const matched = outcome.realMatches.length || outcome.falseMatches.length;
	const unresolved = !matched && outcome.unmatched.truth === "unclear";
	const truth = matched ? (outcome.realMatches.length ? "real" : "false") : outcome.unmatched.truth;
	const catalogIds = matched
		? truth === "real" ? outcome.realMatches : outcome.falseMatches
		: mapping?.realCatalogIds.length ? mapping.realCatalogIds : mapping?.falseCatalogIds ?? [];
	return {
		sourceKey: decision.sourceKey,
		caseId: decision.caseId,
		runId: decision.identity.runId,
		task: decision.identity.task,
		config: decision.identity.config,
		arm: decision.identity.arm,
		status: unresolved ? "unresolved" : truth,
		origin: unresolved ? "unresolved" : matched ? "matched" : "cataloged",
		catalogIds,
		realCatalogIds: matched ? outcome.realMatches : mapping?.realCatalogIds ?? [],
		falseCatalogIds: matched ? outcome.falseMatches : mapping?.falseCatalogIds ?? [],
		truth,
		severity: matched ? null : outcome.unmatched.severity,
		evidenceHashes: decision.evidenceHashes,
		resolution,
		judges: decision.judges,
		...(mapping?.reason === undefined ? {} : { mappingReason: mapping.reason }),
	};
}

function exceptionalLedgerEntry(decision) {
	return {
		sourceKey: decision.sourceKey,
		caseId: decision.caseId,
		runId: decision.identity.runId,
		task: decision.identity.task,
		config: decision.identity.config,
		arm: decision.identity.arm,
		status: decision.status,
		origin: decision.status,
		catalogIds: [],
		realCatalogIds: [],
		falseCatalogIds: [],
		truth: null,
		severity: null,
		evidenceHashes: decision.evidenceHashes,
		resolution: { kind: decision.status, ...(decision.reason === undefined ? {} : { reason: decision.reason }) },
		...(decision.judges === undefined ? {} : { judges: decision.judges }),
	};
}

/**
 * Apply human disagreement rulings and the explicit occurrence-to-catalog map.
 * This is deliberately not a semantic matcher: a settled unmatched occurrence
 * without a mapping is a hard error, because otherwise catalog growth would be
 * mislabeled as a free mechanical rescore.
 */
export function applyDualCatalogGrowth(reconciliation, {
	rulings = {},
	occurrenceMappings = {},
	realCatalog,
	falseCatalog,
} = {}) {
	if (reconciliation?.schemaVersion !== 1 || !reconciliation?.decisions || !reconciliation?.privateMapping) {
		throw new Error("invalid dual-catalog reconciliation artifact");
	}
	const catalogIdentity = finalDualCatalogIdentity(realCatalog, falseCatalog);
	const catalogEntries = activeCatalogEntries(realCatalog, falseCatalog);
	const usedRulings = new Set();
	const usedMappings = new Set();
	const ledger = [];

	for (const [sourceKey, decision] of Object.entries(reconciliation.decisions).sort(([a], [b]) => a.localeCompare(b))) {
		if (decision.sourceKey !== sourceKey) throw new Error(`${sourceKey}: reconciliation decision identity drift`);
		if (!reconciliation.privateMapping[decision.caseId] || reconciliation.privateMapping[decision.caseId].sourceKey !== sourceKey) {
			throw new Error(`${sourceKey}: missing or incorrect private opaque mapping`);
		}
		if (["invalid-output", "unjudgeable"].includes(decision.status)) {
			ledger.push(exceptionalLedgerEntry(decision));
			continue;
		}
		let outcome = decision.outcome;
		let resolution = { kind: "judge-agreement" };
		if (decision.status === "awaiting-human" || (decision.status === "unresolved" && rulings[decision.caseId])) {
			const ruling = normalizeRuling(decision.caseId, rulings[decision.caseId]);
			usedRulings.add(decision.caseId);
			outcome = ruling.outcome;
			resolution = { kind: "human-ruling", ruledBy: ruling.ruledBy, reason: ruling.reason };
		} else if (!["matched", "settled-unmatched", "unresolved"].includes(decision.status)) {
			throw new Error(`${sourceKey}: unknown reconciliation status ${decision.status}`);
		}

		const matched = outcome.realMatches.length || outcome.falseMatches.length;
		const unresolved = !matched && outcome.unmatched.truth === "unclear";
		let mapping = null;
		if (matched) {
			const truth = outcome.realMatches.length ? "real" : "false";
			assertCatalogIds(truth === "real" ? outcome.realMatches : outcome.falseMatches, {
				caseId: decision.caseId,
				truth,
				task: decision.identity.task,
				entries: catalogEntries,
			});
		} else if (!unresolved) {
			mapping = normalizeOccurrenceMapping(decision.caseId, occurrenceMappings[decision.caseId], outcome.unmatched.truth, catalogIdentity);
			assertCatalogIds(outcome.unmatched.truth === "real" ? mapping.realCatalogIds : mapping.falseCatalogIds, {
				caseId: decision.caseId,
				truth: outcome.unmatched.truth,
				task: decision.identity.task,
				severity: outcome.unmatched.severity,
				entries: catalogEntries,
			});
			usedMappings.add(decision.caseId);
		}
		ledger.push(ledgerEntry(decision, outcome, resolution, mapping));
	}

	const unusedRulings = Object.keys(rulings).filter((caseId) => !usedRulings.has(caseId));
	if (unusedRulings.length) throw new Error(`human rulings match no pending disagreement: ${unusedRulings.sort().join(", ")}`);
	const unusedMappings = Object.keys(occurrenceMappings).filter((caseId) => !usedMappings.has(caseId));
	if (unusedMappings.length) throw new Error(`occurrence mappings match no settled unmatched finding: ${unusedMappings.sort().join(", ")}`);
	if (ledger.length !== reconciliation.counts.eligible || new Set(ledger.map((entry) => entry.sourceKey)).size !== ledger.length) {
		throw new Error("final occurrence ledger does not contain every eligible source exactly once");
	}

	return {
		schemaVersion: 1,
		status: "complete",
		basisHash: reconciliation.basisHash,
		catalogIdentity,
		counts: {
			eligible: ledger.length,
			judgeable: reconciliation.counts.judgeable,
			matched: ledger.filter((entry) => entry.origin === "matched").length,
			cataloged: ledger.filter((entry) => entry.origin === "cataloged").length,
			unresolved: ledger.filter((entry) => entry.status === "unresolved").length,
			invalidOutput: ledger.filter((entry) => entry.status === "invalid-output").length,
			unjudgeable: ledger.filter((entry) => entry.status === "unjudgeable").length,
		},
		entries: ledger,
		unjudgeable: reconciliation.unjudgeable,
	};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2);
	const reconciliationPath = argOf(args, "--reconciliation", "");
	const rulingsPath = argOf(args, "--rulings", "");
	const mappingsPath = argOf(args, "--occurrence-mappings", "");
	const outputPath = argOf(args, "--output", "");
	const realPath = argOf(args, "--real-catalog", "experiments/golden-dataset.json");
	const falsePath = argOf(args, "--false-catalog", "experiments/false-positive-catalog.json");
	if (!reconciliationPath || !rulingsPath || !mappingsPath || !outputPath) {
		throw new Error("--reconciliation, --rulings, --occurrence-mappings and --output are required");
	}
	const result = applyDualCatalogGrowth(
		JSON.parse(readFileSync(reconciliationPath, "utf8")),
		{
			rulings: JSON.parse(readFileSync(rulingsPath, "utf8")),
			occurrenceMappings: JSON.parse(readFileSync(mappingsPath, "utf8")),
			realCatalog: JSON.parse(readFileSync(realPath, "utf8")),
			falseCatalog: JSON.parse(readFileSync(falsePath, "utf8")),
		},
	);
	writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
	process.stdout.write(`complete: ${result.counts.eligible} terminal occurrences; ${result.counts.unresolved} unresolved\n`);
}
