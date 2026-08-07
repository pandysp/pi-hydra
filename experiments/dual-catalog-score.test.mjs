import { describe, expect, it } from "vitest";
import { renderDualCatalogQualityTable, scoreDualCatalogQuality } from "./dual-catalog-score.mjs";
import { finalDualCatalogIdentity } from "./dual-catalog-growth.mjs";
import { falsePositiveCatalogVersion, realCatalogVersion } from "./dual-catalog.mjs";

const realIssues = [
	{ id: "R-severe", task: "scheduler", statement: "Severe real issue", status: "active", tier: "blocking", provenance: ["test"], frame: "test" },
	{ id: "R-minor", task: "scheduler", statement: "Minor real issue", status: "active", tier: "harmful", provenance: ["test"], frame: "test" },
	{ id: "O-minor", task: "other", statement: "Other real issue", status: "active", tier: "harmful", provenance: ["test"], frame: "test" },
];
const realCatalog = { version: realCatalogVersion(realIssues), issues: realIssues };
const falseItem = (id, task, severity) => ({
	id,
	task,
	statement: `False proposition ${id}`,
	severity,
	invalidBecause: "It is absent in this test frame.",
	applicability: { codeState: "test", boundary: "test" },
	provenance: [{ kind: "golden-rejection", artifact: "test", reference: id, reviewers: ["sol", "opus"] }],
	dissent: null,
	status: "active",
});
const falseItems = [falseItem("FP-severe", "scheduler", "severe"), falseItem("FP-minor", "scheduler", "minor"), falseItem("FP-other", "other", "severe")];
const falseCatalog = { schemaVersion: 1, version: falsePositiveCatalogVersion(falseItems), items: falseItems };

function entry(sourceKey, status, catalogIds = []) {
	return { sourceKey, runId: "run", task: "scheduler", config: "sol-high", arm: "ENUM", status, catalogIds };
}

function ledger(entries) {
	return {
		status: "complete",
		catalogIdentity: finalDualCatalogIdentity(realCatalog, falseCatalog),
		counts: { eligible: entries.length },
		entries,
	};
}

function scoreCell(overrides = {}) {
	return {
		task: "scheduler",
		config: "sol-high",
		arm: "ENUM",
		trajectoryCount: 1,
		observationPoints: 1,
		liveRealIds: ["R-severe", "R-minor"],
		excludedRealIds: [],
		...overrides,
	};
}

describe("expanded 2Q scoring", () => {
	it("deduplicates real recall but preserves false finding occurrences", () => {
		const occurrenceLedger = ledger([
			entry("a", "real", ["R-severe"]),
			entry("b", "real", ["R-severe", "R-minor"]),
			entry("c", "false", ["FP-minor"]),
			entry("d", "false", ["FP-minor"]),
			entry("e", "false", ["FP-severe", "FP-minor"]),
			entry("f", "unresolved"),
			entry("g", "invalid-output"),
		]);
		const [row] = scoreDualCatalogQuality({
			ledger: occurrenceLedger, realCatalog, falseCatalog,
			cells: [scoreCell({ trajectoryCount: 2, observationPoints: 50 })],
		});
		expect(row.severeRecall).toEqual({ found: 1, total: 1, rate: 1 });
		expect(row.minorRecall).toEqual({ found: 1, total: 1, rate: 1 });
		expect(row.severeFalseBurden).toEqual({ occurrences: 1, distinctIds: 1, perTrajectory: 0.5, per100ObservationPoints: 2 });
		expect(row.minorFalseBurden).toEqual({ occurrences: 3, distinctIds: 1, perTrajectory: 1.5, per100ObservationPoints: 6 });
		expect(row.unresolved).toBe(1);
		expect(row.invalidOutput).toBe(1);
		expect(renderDualCatalogQualityTable([row])).toContain("3 (1 ids; 1.50/traj; 6.00/100pt)");
	});

	it("fails closed on unresolved catalog identities and credited non-live real ids", () => {
		const cell = scoreCell({ observationPoints: 10, liveRealIds: ["R-severe"], excludedRealIds: ["R-minor"] });
		expect(() => scoreDualCatalogQuality({
			ledger: ledger([entry("a", "false", ["missing"])]), realCatalog, falseCatalog, cells: [cell],
		})).toThrow(/valid false catalog ids/);
		expect(() => scoreDualCatalogQuality({
			ledger: ledger([entry("a", "real", ["R-minor"])]), realCatalog, falseCatalog, cells: [cell],
		})).toThrow(/is not live/);
	});

	it("keeps unresolved, unjudgeable, and invalid outputs outside all four buckets", () => {
		const occurrenceLedger = ledger([entry("a", "unresolved"), entry("b", "unjudgeable"), entry("c", "invalid-output")]);
		const [row] = scoreDualCatalogQuality({
			ledger: occurrenceLedger, realCatalog, falseCatalog,
			cells: [scoreCell({ observationPoints: 5, liveRealIds: [], excludedRealIds: ["R-severe", "R-minor"] })],
		});
		expect(row.severeRecall).toEqual({ found: 0, total: 0, rate: null });
		expect(row.minorFalseBurden.occurrences).toBe(0);
		expect(row.excludedLiveness).toEqual({ total: 2, severe: 1, minor: 1 });
		expect([row.unresolved, row.unjudgeable, row.invalidOutput]).toEqual([1, 1, 1]);
		expect(renderDualCatalogQualityTable([row])).toContain("2 (1 severe; 1 minor)");
	});

	it("requires the supplied catalogs to match the frozen ledger identity", () => {
		const occurrenceLedger = ledger([entry("a", "unresolved")]);
		// frame is deliberately outside the real catalog's short content version;
		// the full hash must still catch this provenance/applicability drift.
		const changedIssues = realCatalog.issues.map((issue) => issue.id === "R-minor" ? { ...issue, frame: "changed frame" } : issue);
		const changedReal = { version: realCatalogVersion(changedIssues), issues: changedIssues };
		expect(() => scoreDualCatalogQuality({
			ledger: occurrenceLedger,
			realCatalog: changedReal,
			falseCatalog,
			cells: [scoreCell()],
		})).toThrow(/catalog identity differs/);
	});

	it("rejects wrong-task false ids and unsupported false severities", () => {
		const cell = scoreCell();
		expect(() => scoreDualCatalogQuality({
			ledger: ledger([entry("a", "false", ["FP-other"])]), realCatalog, falseCatalog, cells: [cell],
		})).toThrow(/false catalog id belongs to another task/);

		const invalidItems = falseCatalog.items.map((item) => item.id === "FP-minor" ? { ...item, severity: "catastrophic" } : item);
		const invalidFalse = { ...falseCatalog, version: falsePositiveCatalogVersion(invalidItems), items: invalidItems };
		expect(() => scoreDualCatalogQuality({
			ledger: ledger([entry("a", "unresolved")]), realCatalog, falseCatalog: invalidFalse, cells: [cell],
		})).toThrow(/severity must be severe or minor/);
	});

	it("requires unique cells to partition every terminal ledger entry exactly once", () => {
		const first = entry("a", "unresolved");
		const second = { ...entry("b", "invalid-output"), config: "opus-high" };
		const cell = scoreCell();
		expect(() => scoreDualCatalogQuality({
			ledger: ledger([first, second]), realCatalog, falseCatalog, cells: [cell],
		})).toThrow(/belongs to 0 score cells/);
		expect(() => scoreDualCatalogQuality({
			ledger: ledger([first]), realCatalog, falseCatalog, cells: [cell, { ...cell }],
		})).toThrow(/duplicate score cell/);
	});

	it("requires live and excluded ids to exactly partition each task catalog", () => {
		const occurrenceLedger = ledger([entry("a", "unresolved")]);
		expect(() => scoreDualCatalogQuality({
			ledger: occurrenceLedger,
			realCatalog,
			falseCatalog,
			cells: [scoreCell({ liveRealIds: ["R-severe"], excludedRealIds: [] })],
		})).toThrow(/do not partition.*R-minor/);
		expect(() => scoreDualCatalogQuality({
			ledger: occurrenceLedger,
			realCatalog,
			falseCatalog,
			cells: [scoreCell({ excludedRealIds: ["R-severe"] })],
		})).toThrow(/overlap: R-severe/);
		expect(() => scoreDualCatalogQuality({
			ledger: occurrenceLedger,
			realCatalog,
			falseCatalog,
			cells: [scoreCell({ excludedRealIds: ["O-minor"] })],
		})).toThrow(/O-minor: task differs from score cell scheduler/);
	});
});
