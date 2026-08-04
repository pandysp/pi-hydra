import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildDualCatalogAuditPacket,
	EXPANDED_2Q_AUDIT_SEED_RULE,
	rankDualCatalogAuditCase,
} from "./dual-catalog-audit.mjs";

const MATCHED_REAL = {
	realMatches: ["REAL-1"],
	falseMatches: [],
	unmatched: null,
};
const MATCHED_FALSE = {
	realMatches: [],
	falseMatches: ["FALSE-1"],
	unmatched: null,
};
const UNMATCHED_REAL = {
	realMatches: [],
	falseMatches: [],
	unmatched: { truth: "real", severity: "minor" },
};
const UNMATCHED_FALSE = {
	realMatches: [],
	falseMatches: [],
	unmatched: { truth: "false", severity: "severe" },
};
const UNCLEAR = {
	realMatches: [],
	falseMatches: [],
	unmatched: { truth: "unclear", severity: null },
};

function opaque(index) {
	return `case-${index.toString(16).padStart(16, "0")}`;
}

function decision(caseId, status, outcome) {
	const sourceKey = `private-source/${caseId}`;
	return {
		caseId,
		sourceKey,
		identity: {
			sourceKey,
			arm: "private-arm",
			config: "private-config",
			runId: "private-run",
			pointKey: "private-point-key",
			pointId: "private-point",
		},
		evidenceHashes: { evidenceHash: `raw-evidence-${caseId}` },
		status,
		outcome,
		judges: {
			sol: { outcome, quote: "exact quote", reasoning: "Sol reason." },
			opus: { outcome, quote: "exact quote", reasoning: "Opus reason." },
		},
	};
}

function reviewCase(caseId, outcome, { proposed = false } = {}) {
	const finding = `Public finding for ${caseId}.`;
	return {
		caseId,
		task: "scheduler",
		finding,
		evidenceRef: `evidence-${caseId.slice(-16)}`,
		evidence: {
			transcript: "Public visible evidence.",
			files: "Public file state.",
		},
		judges: [
			{
				label: "A",
				quote: "exact quote",
				reasoning: "First blinded reason.",
				outcome,
			},
			{
				label: "B",
				quote: "exact quote",
				reasoning: "Second blinded reason.",
				outcome,
			},
		],
		...(proposed
			? {
					proposedRecord: {
						proposition: finding,
						truth: outcome.unmatched.truth,
						severity: outcome.unmatched.severity,
					},
				}
			: {}),
	};
}

function fixture() {
	const rows = [
		[opaque(1), "matched", MATCHED_REAL],
		[opaque(2), "matched", MATCHED_FALSE],
		[opaque(3), "matched", MATCHED_REAL],
		[opaque(4), "settled-unmatched", UNMATCHED_REAL],
		[opaque(5), "settled-unmatched", UNMATCHED_FALSE],
		[opaque(6), "unresolved", UNCLEAR],
	];
	const decisions = Object.fromEntries(
		rows.map(([caseId, status, outcome], index) => [
			`private-source-${index}`,
			decision(caseId, status, outcome),
		]),
	);
	decisions["private-disagreement"] = {
		caseId: opaque(7),
		status: "awaiting-human",
	};
	const reviewCases = Object.fromEntries(
		rows.map(([caseId, status, outcome]) => [
			caseId,
			reviewCase(caseId, outcome, { proposed: status === "settled-unmatched" }),
		]),
	);
	return {
		packetId: "packet-0123456789abcdef",
		publicCatalogs: {
			scheduler: {
				real: [{ id: "REAL-1", statement: "The real catalog proposition." }],
				false: [{ id: "FALSE-1", statement: "The known invalid-report proposition." }],
			},
		},
		agreementCaseIds: rows.map(([caseId]) => caseId),
		decisions,
		reviewCases,
	};
}

describe("expanded 2Q deterministic agreement audit", () => {
	it("samples matched agreements and settled catalog misses by the frozen public seed rule", () => {
		const input = fixture();
		const packet = buildDualCatalogAuditPacket(input, {
			matchedCap: 2,
			catalogMissCap: 1,
		});
		expect(packet).toMatchObject({
			schemaVersion: 1,
			seedRule: "expanded-2q-audit-v2-stratified",
			packetId: input.packetId,
			counts: {
				agreementCases: 6,
				matchedAgreements: 3,
				matchedCap: 2,
				matchedSampled: 2,
				catalogMissCandidates: 2,
				catalogMissCap: 1,
				catalogMissSampled: 1,
				unresolvedAgreements: 1,
			},
		});
		expect(packet.samples.matchedAgreements).toHaveLength(2);
		expect(packet.samples.catalogMissCandidates).toHaveLength(1);
		expect(packet.samples.matchedAgreements.some((row) => row.judges[0].outcome.realMatches.length)).toBe(true);
		expect(packet.samples.matchedAgreements.some((row) => row.judges[0].outcome.falseMatches.length)).toBe(true);
		expect(packet.publicCatalogs.scheduler.real[0].statement).toContain("real catalog proposition");
		expect(packet.publicCatalogs.scheduler.false[0].statement).toContain("invalid-report proposition");
		expect(EXPANDED_2Q_AUDIT_SEED_RULE).toBe("expanded-2q-audit-v2-stratified");
		expect(rankDualCatalogAuditCase(input.packetId, opaque(1))).toBe(rankDualCatalogAuditCase(input.packetId, opaque(1)));
	});

	it("is independent of private decision and agreement input ordering", () => {
		const input = fixture();
		const reversed = {
			...input,
			agreementCaseIds: [...input.agreementCaseIds].reverse(),
			decisions: Object.fromEntries(Object.entries(input.decisions).reverse()),
			reviewCases: Object.fromEntries(
				Object.entries(input.reviewCases).reverse(),
			),
		};
		expect(
			buildDualCatalogAuditPacket(reversed, {
				matchedCap: 3,
				catalogMissCap: 2,
			}),
		).toEqual(
			buildDualCatalogAuditPacket(input, { matchedCap: 3, catalogMissCap: 2 }),
		);
	});

	it("emits only public review material, never private decisions or identities", () => {
		const packet = buildDualCatalogAuditPacket(fixture(), {
			matchedCap: 3,
			catalogMissCap: 2,
		});
		const text = JSON.stringify(packet);
		expect(text).not.toContain("private-source");
		expect(text).not.toContain("private-disagreement");
		expect(text).not.toContain("sourceKey");
		expect(text).not.toContain('"arm"');
		expect(text).not.toContain('"config"');
		expect(text).not.toContain('"model"');
		expect(text).not.toContain("Hash");
		expect(text).not.toContain("blinding");
	});

	it("fails closed on missing review cases, non-agreement references, unknown statuses, and false agreement claims", () => {
		const missing = fixture();
		delete missing.reviewCases[missing.agreementCaseIds[0]];
		expect(() =>
			buildDualCatalogAuditPacket(missing, {
				matchedCap: 1,
				catalogMissCap: 1,
			}),
		).toThrow(/review case is missing/);

		const nonAgreement = fixture();
		nonAgreement.agreementCaseIds[0] = opaque(7);
		expect(() =>
			buildDualCatalogAuditPacket(nonAgreement, {
				matchedCap: 1,
				catalogMissCap: 1,
			}),
		).toThrow(/does not exactly cover/);

		const unknown = fixture();
		unknown.decisions["private-disagreement"].status = "future-status";
		expect(() =>
			buildDualCatalogAuditPacket(unknown, {
				matchedCap: 1,
				catalogMissCap: 1,
			}),
		).toThrow(/unknown decision status/);

		const disagreement = fixture();
		const first = disagreement.decisions["private-source-0"];
		first.judges.opus.outcome = MATCHED_FALSE;
		expect(() =>
			buildDualCatalogAuditPacket(disagreement, {
				matchedCap: 1,
				catalogMissCap: 1,
			}),
		).toThrow(/not an exact judge agreement/);

		const omitted = fixture();
		omitted.agreementCaseIds.pop();
		expect(() =>
			buildDualCatalogAuditPacket(omitted, {
				matchedCap: 1,
				catalogMissCap: 1,
			}),
		).toThrow(/does not exactly cover/);

		const noCatalog = fixture();
		delete noCatalog.publicCatalogs.scheduler;
		expect(() => buildDualCatalogAuditPacket(noCatalog, { matchedCap: 1, catalogMissCap: 1 }))
			.toThrow(/no public catalog/);
	});

	it("rejects public cases carrying private fields, model labels, raw hashes, or a blinding key", () => {
		for (const mutate of [
			(row) => {
				row.sourceKey = "private/source";
			},
			(row) => {
				row.judges[0].model = "claude-secret";
			},
			(row) => {
				row.evidence.promptHash = "a".repeat(64);
			},
			(row) => {
				row.evidence.transcript = "Delivered to MAIN-SO2";
			},
			(row) => {
				row.evidence.transcript = "private-blinding-key";
			},
			(row) => {
				row.evidence.transcript = `private-source/${row.caseId}`;
			},
		]) {
			const input = fixture();
			mutate(input.reviewCases[input.agreementCaseIds[0]]);
			expect(() =>
				buildDualCatalogAuditPacket(input, {
					matchedCap: 1,
					catalogMissCap: 1,
				}),
			).toThrow();
		}
	});

	it("validates requested caps", () => {
		expect(() =>
			buildDualCatalogAuditPacket(fixture(), {
				matchedCap: -1,
				catalogMissCap: 1,
			}),
		).toThrow(/non-negative integer/);
		expect(() =>
			buildDualCatalogAuditPacket(fixture(), {
				matchedCap: 1.5,
				catalogMissCap: 1,
			}),
		).toThrow(/non-negative integer/);
		expect(() =>
			buildDualCatalogAuditPacket(fixture(), { matchedCap: 1 }),
		).toThrow(/non-negative integer/);
	});

	it("CLI writes the same public packet without private source identities", () => {
		const dir = mkdtempSync(join(tmpdir(), "dual-catalog-audit-"));
		const inputPath = join(dir, "reconciliation.json");
		const outputPath = join(dir, "audit.json");
		writeFileSync(inputPath, `${JSON.stringify(fixture())}\n`);
		execFileSync(
			"node",
			[
				"experiments/dual-catalog-audit.mjs",
				"--reconciliation",
				inputPath,
				"--output",
				outputPath,
				"--matched-cap",
				"2",
				"--catalog-miss-cap",
				"1",
			],
			{ stdio: "pipe" },
		);
		const packet = JSON.parse(readFileSync(outputPath, "utf8"));
		expect(packet.counts).toMatchObject({
			matchedSampled: 2,
			catalogMissSampled: 1,
		});
		expect(JSON.stringify(packet)).not.toContain("private-source");
	});
});
