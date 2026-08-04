import { describe, expect, it } from "vitest";
import { applyDualCatalogGrowth } from "./dual-catalog-growth.mjs";
import { reconcileDualCatalogJudgments } from "./dual-catalog-reconcile.mjs";
import { scoreDualCatalogQuality } from "./dual-catalog-score.mjs";
import { dualCatalogHashes, falsePositiveCatalogVersion, realCatalogVersion } from "./dual-catalog.mjs";

const metadata = {
	protocol: "expanded-2q-v1",
	judgeBuilderHash: "builder",
	systemHash: "system",
	realCatalogSha256: "real",
	falseCatalogSha256: "false",
};
const blinding = { blindingKey: "test-private-blinding-key-32-bytes-minimum" };

const realIssues = [
	["REAL-1", "blocking"],
	["REAL-2", "harmful"],
	["REAL-new", "harmful"],
	["REAL-a", "harmful"],
	["REAL-b", "harmful"],
	["REAL-final", "harmful"],
	["REAL-after-review", "harmful"],
	["REAL-other", "harmful", "other"],
].map(([id, tier, task = "task"]) => ({ id, task, statement: `Real proposition ${id}`, tier, status: "active", provenance: ["test"], frame: "test frame" }));
const realCatalog = { version: realCatalogVersion(realIssues), issues: realIssues };
const falseItems = [{
	id: "FP-new",
	task: "task",
	statement: "Known invalid proposition",
	severity: "severe",
	invalidBecause: "The proposition is absent in the test frame.",
	applicability: { codeState: "test", boundary: "test frame" },
	provenance: [{ kind: "golden-rejection", artifact: "test", reference: "test", reviewers: ["sol", "opus"] }],
	dissent: null,
	status: "active",
}, {
	id: "FP-other",
	task: "other",
	statement: "Known invalid proposition from another task",
	severity: "severe",
	invalidBecause: "The proposition is absent in the other test frame.",
	applicability: { codeState: "test", boundary: "other test frame" },
	provenance: [{ kind: "golden-rejection", artifact: "test", reference: "other", reviewers: ["sol", "opus"] }],
	dissent: null,
	status: "active",
}];
const falseCatalog = { schemaVersion: 1, version: falsePositiveCatalogVersion(falseItems), items: falseItems };
const catalogIdentity = dualCatalogHashes(realCatalog, falseCatalog);
const growthOptions = (options = {}) => ({ realCatalog, falseCatalog, ...options });

const matched = (id = "REAL-1") => ({
	realMatches: [id], falseMatches: [], quote: "finding", unmatched: null, reasoning: "matched",
});
const unmatched = (truth, severity) => ({
	realMatches: [], falseMatches: [], quote: "finding", unmatched: { truth, severity }, reasoning: "new",
});

function state(judge, outcomes) {
	const judgments = {};
	outcomes.forEach((outcome, index) => {
		const sourceKey = `secret-run/task/secret-config/point/secret-arm/f${index}`;
		judgments[sourceKey] = {
			sourceKey,
			runId: "secret-run",
			task: "task",
			config: "secret-config",
			arm: "secret-arm",
			findingIndex: index,
			message: `finding ${index}`,
			evidenceHash: `evidence-${index}`,
			judge,
			outcome,
		};
	});
	return {
		status: "complete",
		metadata: {
			...metadata,
			realCatalogVersion: catalogIdentity.realVersion,
			falseCatalogVersion: catalogIdentity.falseVersion,
			catalogHashes: catalogIdentity.perTask,
			judge,
			judgeModel: `${judge}-model`,
			shapeSha256: `${judge}-shape`,
		},
		judgments,
		unjudgeable: {},
		invalidOutputs: {},
		batches: [],
	};
}

function reconciliation(solOutcomes, opusOutcomes = solOutcomes) {
	return reconcileDualCatalogJudgments(state("sol", solOutcomes), state("opus", opusOutcomes), { ...blinding, realCatalog, falseCatalog });
}

function byStatus(value, status) {
	return Object.values(value.decisions).find((decision) => decision.status === status);
}

describe("dual-catalog growth and occurrence ledger", () => {
	it("maps every matched and settled unmatched judgeable source exactly once", () => {
		const rec = reconciliation([matched(), unmatched("real", "minor"), unmatched("false", "severe"), unmatched("unclear", null)]);
		const real = Object.values(rec.decisions).find((decision) => decision.outcome?.unmatched?.truth === "real");
		const falseOne = Object.values(rec.decisions).find((decision) => decision.outcome?.unmatched?.truth === "false");
		const result = applyDualCatalogGrowth(rec, growthOptions({
			occurrenceMappings: {
				[real.caseId]: { realCatalogIds: ["REAL-new"] },
				[falseOne.caseId]: { falseCatalogIds: ["FP-new"] },
			},
		}));

		expect(result).toMatchObject({ status: "complete", counts: { judgeable: 4, matched: 1, cataloged: 2, unresolved: 1 } });
		expect(result.entries).toHaveLength(4);
		expect(new Set(result.entries.map((entry) => entry.sourceKey)).size).toBe(4);
		expect(result.catalogIdentity).toMatchObject({ real: { version: realCatalog.version }, false: { version: falseCatalog.version } });
		expect(result.entries.find((entry) => entry.realCatalogIds.includes("REAL-new"))).toMatchObject({ truth: "real", severity: "minor", status: "real", origin: "cataloged", catalogIds: ["REAL-new"] });
		expect(result.entries.find((entry) => entry.falseCatalogIds.includes("FP-new"))).toMatchObject({ truth: "false", severity: "severe", status: "false", origin: "cataloged", catalogIds: ["FP-new"] });
		expect(result.entries.find((entry) => entry.status === "unresolved")).toMatchObject({ truth: "unclear", severity: null, catalogIds: [] });

		const [scored] = scoreDualCatalogQuality({
			ledger: result,
			realCatalog,
			falseCatalog,
			cells: [{
				task: "task",
				config: "secret-config",
				arm: "secret-arm",
				trajectoryCount: 1,
				observationPoints: 4,
				liveRealIds: ["REAL-1", "REAL-new"],
				excludedRealIds: ["REAL-2", "REAL-a", "REAL-b", "REAL-final", "REAL-after-review"],
			}],
		});
		expect(scored).toMatchObject({
			severeRecall: { found: 1, total: 1 },
			minorRecall: { found: 1, total: 1 },
			severeFalseBurden: { occurrences: 1, distinctIds: 1 },
			unresolved: 1,
		});
	});

	it("applies a human match ruling and preserves authority, reason, rationales, and evidence hashes", () => {
		const rec = reconciliation([matched("REAL-a")], [matched("REAL-b")]);
		const pending = byStatus(rec, "awaiting-human");
		const result = applyDualCatalogGrowth(rec, growthOptions({
			rulings: {
				[pending.caseId]: {
					outcome: matched("REAL-final"),
					reason: "The exact behavior is the final catalog record.",
					ruledBy: "Andreas",
				},
			},
		}));

		expect(result.entries[0]).toMatchObject({
			status: "real",
			origin: "matched",
			realCatalogIds: ["REAL-final"],
			catalogIds: ["REAL-final"],
			evidenceHashes: { evidenceHash: "evidence-0" },
			resolution: { kind: "human-ruling", ruledBy: "Andreas", reason: "The exact behavior is the final catalog record." },
		});
		expect(result.entries[0].judges.sol.reasoning).toBe("matched");
		expect(result.entries[0].judges.opus.reasoning).toBe("matched");
	});

	it("requires occurrence mapping after an automatic or human settled unmatched decision", () => {
		const automatic = reconciliation([unmatched("real", "minor")]);
		expect(() => applyDualCatalogGrowth(automatic, growthOptions())).toThrow(/no final catalog mapping/);

		const disputed = reconciliation([matched()], [unmatched("false", "minor")]);
		const pending = byStatus(disputed, "awaiting-human");
		expect(() => applyDualCatalogGrowth(disputed, growthOptions({
			rulings: {
				[pending.caseId]: {
					outcome: unmatched("false", "minor"),
					reason: "Not a defect in this context.",
					ruledBy: "Andreas",
				},
			},
		}))).toThrow(/no final catalog mapping/);
	});

	it("keeps agreed unclear unresolved unless the human elects to settle it", () => {
		const rec = reconciliation([unmatched("unclear", null)]);
		const unclear = byStatus(rec, "unresolved");
		expect(applyDualCatalogGrowth(rec, growthOptions()).entries[0].status).toBe("unresolved");

		const settled = applyDualCatalogGrowth(rec, growthOptions({
			rulings: {
				[unclear.caseId]: {
					outcome: matched("REAL-after-review"),
					reason: "The missing evidence was supplied to the human reviewer.",
					ruledBy: "Andreas",
				},
			},
		}));
		expect(settled.entries[0]).toMatchObject({
			status: "real",
			origin: "matched",
			realCatalogIds: ["REAL-after-review"],
			resolution: { kind: "human-ruling", ruledBy: "Andreas" },
		});
	});

	it("refuses absent human rulings, wrong-lane mappings, and unused inputs", () => {
		const disputed = reconciliation([matched("REAL-a")], [matched("REAL-b")]);
		expect(() => applyDualCatalogGrowth(disputed, growthOptions())).toThrow(/missing human ruling/);

		const rec = reconciliation([unmatched("real", "minor")]);
		const pending = byStatus(rec, "settled-unmatched");
		expect(() => applyDualCatalogGrowth(rec, growthOptions({
			occurrenceMappings: { [pending.caseId]: { falseCatalogIds: ["FP-new"] } },
		}))).toThrow(/real occurrence must map only to real catalog ids/);

		const matchedOnly = reconciliation([matched()]);
		expect(() => applyDualCatalogGrowth(matchedOnly, growthOptions({
			occurrenceMappings: { unknown: { realCatalogIds: ["REAL-missing"] } },
		}))).toThrow(/match no settled unmatched finding/);
	});

	it("binds automatic and human mappings to final catalog lane, task, severity, and version", () => {
		const falseRec = reconciliation([unmatched("false", "severe")]);
		const falseDecision = byStatus(falseRec, "settled-unmatched");
		expect(() => applyDualCatalogGrowth(falseRec, growthOptions({
			occurrenceMappings: { [falseDecision.caseId]: { falseCatalogIds: ["FP-missing"] } },
		}))).toThrow(/not an active false catalog id/);
		expect(() => applyDualCatalogGrowth(falseRec, growthOptions({
			occurrenceMappings: { [falseDecision.caseId]: { falseCatalogIds: ["FP-other"] } },
		}))).toThrow(/belongs to task other/);
		expect(() => applyDualCatalogGrowth(falseRec, growthOptions({
			occurrenceMappings: {
				[falseDecision.caseId]: {
					falseCatalogIds: ["FP-new"],
					catalogVersions: { real: "wrong", false: falseCatalog.version },
				},
			},
		}))).toThrow(/versions differ/);

		const realRec = reconciliation([unmatched("real", "minor")]);
		const realDecision = byStatus(realRec, "settled-unmatched");
		expect(() => applyDualCatalogGrowth(realRec, growthOptions({
			occurrenceMappings: { [realDecision.caseId]: { realCatalogIds: ["REAL-1"] } },
		}))).toThrow(/severity severe differs from settled minor/);

		const disputed = reconciliation([matched("REAL-a")], [matched("REAL-b")]);
		const human = byStatus(disputed, "awaiting-human");
		expect(() => applyDualCatalogGrowth(disputed, growthOptions({
			rulings: {
				[human.caseId]: {
					outcome: matched("REAL-missing"),
					reason: "Human chose a missing record.",
					ruledBy: "Andreas",
				},
			},
		}))).toThrow(/not an active real catalog id/);
	});

	it("carries invalid-output and unjudgeable sources into terminal scorer entries", () => {
		const sol = state("sol", [matched(), matched("REAL-2")]);
		const opus = state("opus", [matched(), matched("REAL-2")]);
		const [invalidKey, unjudgeableKey] = Object.keys(sol.judgments).sort();
		const invalid = { ...sol.judgments[invalidKey], reason: "invalid-output-after-one-correction" };
		delete invalid.outcome;
		delete sol.judgments[invalidKey];
		sol.invalidOutputs[invalidKey] = invalid;
		for (const checkpoint of [sol, opus]) {
			const hole = { ...checkpoint.judgments[unjudgeableKey], reason: "unjudgeable-missing-final-assistant" };
			delete hole.judge;
			delete hole.outcome;
			delete checkpoint.judgments[unjudgeableKey];
			checkpoint.unjudgeable[unjudgeableKey] = hole;
			checkpoint.status = "complete-with-exceptions";
		}

		const result = applyDualCatalogGrowth(reconcileDualCatalogJudgments(sol, opus, { ...blinding, realCatalog, falseCatalog }), growthOptions());
		expect(result.counts).toMatchObject({ eligible: 2, judgeable: 1, invalidOutput: 1, unjudgeable: 1 });
		expect(result.entries.map((entry) => entry.status).sort()).toEqual(["invalid-output", "unjudgeable"]);
		expect(result.entries.every((entry) => entry.catalogIds.length === 0)).toBe(true);
	});
});
