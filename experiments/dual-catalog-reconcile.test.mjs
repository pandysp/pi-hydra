import { describe, expect, it } from "vitest";
import { reconcileDualCatalogJudgments as reconcileRaw } from "./dual-catalog-reconcile.mjs";
import { dualCatalogHashes, falsePositiveCatalogVersion, realCatalogVersion } from "./dual-catalog.mjs";

const TEST_BLINDING_KEY = "test-only-private-blinding-key-32-bytes-minimum";
const realIssues = ["REAL-1", "REAL-2"].map((id) => ({
	id,
	task: "scheduler",
	statement: `Real statement ${id}`,
	tier: "harmful",
	status: "active",
	provenance: ["test"],
	frame: "test frame",
}));
const realCatalog = { version: realCatalogVersion(realIssues), issues: realIssues };
const falseItems = ["FP-false-1", "FP-false-2"].map((id) => ({
	id,
	task: "scheduler",
	statement: `False statement ${id}`,
	severity: "minor",
	invalidBecause: "The proposition is invalid in the test frame.",
	applicability: { codeState: "test", boundary: "test frame" },
	provenance: [{ kind: "golden-rejection", artifact: "test", reference: id, reviewers: ["sol", "opus"] }],
	dissent: null,
	status: "active",
}));
const falseCatalog = { schemaVersion: 1, version: falsePositiveCatalogVersion(falseItems), items: falseItems };
const catalogIdentity = dualCatalogHashes(realCatalog, falseCatalog);
const options = (blindingKey = TEST_BLINDING_KEY) => ({ blindingKey, realCatalog, falseCatalog });
const reconcileDualCatalogJudgments = (sol, opus) => reconcileRaw(sol, opus, options());

const commonMetadata = {
	protocol: "expanded-2q-v1",
	judgeBuilderHash: "builder",
	systemHash: "system",
	rowsSha256: "rows",
	realCatalogSha256: "real-catalog",
	falseCatalogSha256: "false-catalog",
	realCatalogVersion: catalogIdentity.realVersion,
	falseCatalogVersion: catalogIdentity.falseVersion,
	catalogHashes: catalogIdentity.perTask,
};

const MATCHED = {
	realMatches: ["REAL-1"],
	falseMatches: [],
	quote: "lease can expire",
	unmatched: null,
	reasoning: "The visible worker never renews it.",
};

const UNMATCHED_REAL = {
	realMatches: [],
	falseMatches: [],
	quote: "lease can expire",
	unmatched: { truth: "real", severity: "severe" },
	reasoning: "This is a new live defect.",
};

const UNCLEAR = {
	realMatches: [],
	falseMatches: [],
	quote: "lease can expire",
	unmatched: { truth: "unclear", severity: null },
	reasoning: "The necessary caller behavior is not visible.",
};

function judgment(judge, outcome, overrides = {}) {
	return {
		sourceKey: "private-run/scheduler/sol-high/private-point/MAIN-SO2/f0",
		runId: "private-run",
		pointKey: "private-run/scheduler/sol-high/private-point",
		pointId: "private-point",
		task: "scheduler",
		config: "sol-high",
		arm: "MAIN-SO2",
		findingIndex: 0,
		message: "The lease can expire while work continues.",
		evidenceHash: "evidence-123",
		capturedPayloadHash: "payload-123",
		evidence: { transcript: "visible transcript", files: "visible files" },
		judge,
		outcome,
		...overrides,
	};
}

function state(judge, outcomes, metadata = {}) {
	const judgments = Object.fromEntries(outcomes.map((outcome, index) => {
		const suffix = index === 0 ? "" : `-${index}`;
		const row = judgment(judge, outcome, suffix ? {
			sourceKey: `private-run/scheduler/sol-high/private-point/MAIN-SO2/f${index}`,
			findingIndex: index,
			message: `Finding ${index}`,
		} : {});
		return [row.sourceKey, row];
	}));
	return {
		status: "complete",
		metadata: {
			...commonMetadata,
			...metadata,
			judge,
			judgeModel: judge === "sol" ? "gpt-5.6-sol" : "claude-opus-5",
			judgeProvider: judge === "sol" ? "openai-codex" : "anthropic",
			shapeSha256: `${judge}-shape`,
			judgeRoute: {
				api: judge === "sol" ? "openai-codex-responses" : "anthropic-messages",
				baseUrl: judge === "sol" ? "https://chatgpt.invalid" : "https://anthropic.invalid",
				packageLockSha256: "runtime-lock",
			},
		},
		judgments,
		unjudgeable: {},
		invalidOutputs: {},
		batches: [],
	};
}

function pair(solOutcome, opusOutcome = solOutcome) {
	return [state("sol", [solOutcome]), state("opus", [opusOutcome])];
}

describe("expanded 2Q reconciliation", () => {
	it("accepts exact match-set agreement independent of array order and preserves private provenance", () => {
		const solOutcome = { ...MATCHED, realMatches: ["REAL-2", "REAL-1"] };
		const opusOutcome = { ...MATCHED, realMatches: ["REAL-1", "REAL-2"], reasoning: "Different original rationale." };
		const result = reconcileDualCatalogJudgments(...pair(solOutcome, opusOutcome));

		expect(result).toMatchObject({
			status: "reconciled",
			counts: { judgeable: 1, agreements: 1, disagreements: 0, catalogGrowth: 0, unresolved: 0 },
		});
		expect(result.agreementCaseIds).toHaveLength(1);
		const decision = Object.values(result.decisions)[0];
		expect(decision).toMatchObject({ status: "matched", outcome: { realMatches: ["REAL-1", "REAL-2"] } });
		expect(decision.judges.opus.reasoning).toBe("Different original rationale.");
		const privateRow = result.privateMapping[decision.caseId];
		expect(privateRow).toMatchObject({ sourceKey: decision.sourceKey, evidenceHashes: { evidenceHash: "evidence-123" } });
	});

	it("routes every outcome disagreement class to the same blinded human queue", () => {
		const cases = [
			["real sets", MATCHED, { ...MATCHED, realMatches: ["REAL-2"] }],
			["false sets", { ...MATCHED, realMatches: [], falseMatches: ["FP-false-1"] }, { ...MATCHED, realMatches: [], falseMatches: ["FP-false-2"] }],
			["matched/unmatched", MATCHED, UNMATCHED_REAL],
			["truth", UNMATCHED_REAL, { ...UNMATCHED_REAL, unmatched: { truth: "false", severity: "severe" } }],
			["severity", UNMATCHED_REAL, { ...UNMATCHED_REAL, unmatched: { truth: "real", severity: "minor" } }],
		];
		for (const [label, solOutcome, opusOutcome] of cases) {
			const result = reconcileDualCatalogJudgments(...pair(solOutcome, opusOutcome));
			expect(result.counts.disagreements, label).toBe(1);
			expect(result.publicQueues.disagreements, label).toHaveLength(1);
			expect(Object.values(result.decisions)[0].status, label).toBe("awaiting-human");
		}
	});

	it("queues agreed settled unmatched findings for catalog growth and keeps agreed unclear unresolved", () => {
		const sol = state("sol", [UNMATCHED_REAL, UNCLEAR]);
		const opus = state("opus", [UNMATCHED_REAL, UNCLEAR]);
		const result = reconcileDualCatalogJudgments(sol, opus);

		expect(result.status).toBe("awaiting-catalog-growth");
		expect(result.counts).toMatchObject({ agreements: 2, catalogGrowth: 1, unresolved: 1 });
		expect(result.publicQueues.catalogGrowth[0].proposedRecord).toMatchObject({ truth: "real", severity: "severe" });
		expect(result.publicQueues.unresolved).toHaveLength(1);
	});

	it("keeps source, arm, config, model, and cost out of public queues", () => {
		const solOutcome = { ...MATCHED, reasoning: "gpt-5.6-sol inspected the visible evidence." };
		const opusOutcome = { ...UNMATCHED_REAL, reasoning: "claude-opus-5 inspected the visible evidence." };
		const [sol, opus] = pair(solOutcome, opusOutcome);
		const secretEvidence = {
			visibleTranscript: "You are pi in /tmp/hydra-traj-scheduler-sol-high-AbC123. Benchmark nonce: private-run. Config sol-high. Docs mention ENUM-SO2 and gpt-5.6-sol.",
			files: "No model identity belongs here.",
		};
		for (const checkpoint of [sol, opus]) Object.values(checkpoint.judgments)[0].evidence = secretEvidence;
		const result = reconcileDualCatalogJudgments(sol, opus);
		const publicText = JSON.stringify(result.publicQueues);
		expect(publicText).not.toContain("private-run");
		expect(publicText).not.toContain("private-point");
		expect(publicText).not.toContain("MAIN-SO2");
		expect(publicText).not.toContain("ENUM-SO2");
		expect(publicText).not.toContain("sol-high");
		expect(publicText).not.toContain("gpt-5.6-sol");
		expect(publicText).not.toContain("claude-opus-5");
		expect(publicText).not.toContain("cost");
		expect(publicText).not.toContain("/tmp/hydra-traj-");
		expect(publicText).toContain("<benchmark-workspace>");
		expect(publicText).toContain("Benchmark nonce: <hidden>");
		expect(result.publicQueues.disagreements[0]).toMatchObject({
			finding: "The lease can expire while work continues.",
			evidenceRef: expect.stringMatching(/^evidence-[0-9a-f]{16}$/),
			judges: [{ label: expect.stringMatching(/^[AB]$/) }, { label: expect.stringMatching(/^[AB]$/) }],
		});
		expect(publicText).not.toContain("evidence-123");
		expect(publicText).not.toContain("payload-123");
	});

	it("uses the private key for unlinkable case ids, evidence refs, and judge permutations", () => {
		const [sol, opus] = pair(MATCHED, UNMATCHED_REAL);
		const first = reconcileRaw(sol, opus, options(TEST_BLINDING_KEY));
		const second = reconcileRaw(sol, opus, options("different-private-blinding-key-with-32-bytes"));
		const firstCase = first.publicQueues.disagreements[0];
		const secondCase = second.publicQueues.disagreements[0];
		expect(first.packetId).not.toBe(second.packetId);
		expect(firstCase.caseId).not.toBe(secondCase.caseId);
		expect(firstCase.evidenceRef).not.toBe(secondCase.evidenceRef);
		expect(() => reconcileRaw(sol, opus, options("too-short"))).toThrow(/at least 32/);
	});

	it("keeps a one-sided terminal invalid output visible and falls back to batch evidence", () => {
		const [sol, opus] = pair(MATCHED);
		const sourceKey = Object.keys(sol.judgments)[0];
		const invalid = { ...sol.judgments[sourceKey], reason: "invalid-output-after-one-correction", firstResponse: "bad", lastResponse: "still bad" };
		delete invalid.outcome;
		delete invalid.evidenceHash;
		delete sol.judgments[sourceKey];
		sol.invalidOutputs[sourceKey] = invalid;
		sol.status = "complete-with-exceptions";
		delete opus.judgments[sourceKey].evidenceHash;
		for (const state of [sol, opus]) {
			state.batches = [{ sourceKeys: [sourceKey], evidenceHash: "evidence-from-batch", payloadHash: "payload-from-batch", evidence: { transcript: "frozen evidence" } }];
		}

		const result = reconcileDualCatalogJudgments(sol, opus);
		expect(result.counts).toMatchObject({ eligible: 1, judgeable: 1, invalidOutput: 1 });
		expect(result.publicQueues.invalidOutputs).toHaveLength(1);
		const decision = Object.values(result.decisions)[0];
		expect(decision).toMatchObject({
			status: "invalid-output",
			evidenceHashes: { evidenceHash: "evidence-from-batch", payloadHash: "payload-from-batch" },
			judges: {
				sol: { terminal: "invalid-output", firstResponse: "bad", lastResponse: "still bad" },
				opus: { outcome: { realMatches: ["REAL-1"] } },
			},
		});
	});

	it("refuses input, finding, evidence, and evidence-hole drift", () => {
		const [sol, opus] = pair(MATCHED);
		opus.metadata.rowsSha256 = "different";
		expect(() => reconcileDualCatalogJudgments(sol, opus)).toThrow(/input metadata differs/);

		const [solIdentity, opusIdentity] = pair(MATCHED);
		Object.values(opusIdentity.judgments)[0].message = "Different finding";
		expect(() => reconcileDualCatalogJudgments(solIdentity, opusIdentity)).toThrow(/finding identity differs/);

		const [solEvidence, opusEvidence] = pair(MATCHED);
		Object.values(opusEvidence.judgments)[0].evidenceHash = "different";
		expect(() => reconcileDualCatalogJudgments(solEvidence, opusEvidence)).toThrow(/evidence hashes differ/);

		const [solHole, opusHole] = pair(MATCHED);
		solHole.status = "complete-with-unjudgeable";
		opusHole.status = "complete-with-unjudgeable";
		solHole.unjudgeable = { missing: { sourceKey: "missing", reason: "missing evidence" } };
		opusHole.unjudgeable = { missing: { sourceKey: "missing", reason: "different" } };
		expect(() => reconcileDualCatalogJudgments(solHole, opusHole)).toThrow(/unjudgeable records differ/);

		const [solCatalog, opusCatalog] = pair(MATCHED);
		const remapped = structuredClone(realCatalog);
		[remapped.issues[0].id, remapped.issues[1].id] = [remapped.issues[1].id, remapped.issues[0].id];
		expect(() => reconcileRaw(solCatalog, opusCatalog, {
			blindingKey: TEST_BLINDING_KEY,
			realCatalog: remapped,
			falseCatalog,
		})).toThrow(/version.*does not match content/);
	});

	it("emits identical evidence holes as private unjudgeable terminal decisions", () => {
		const [sol, opus] = pair(MATCHED);
		const sourceKey = Object.keys(sol.judgments)[0];
		for (const state of [sol, opus]) {
			const record = { ...state.judgments[sourceKey], reason: "unjudgeable-missing-final-assistant" };
			delete record.judge;
			delete record.outcome;
			delete state.judgments[sourceKey];
			state.unjudgeable[sourceKey] = record;
			state.status = "complete-with-exceptions";
		}
		const result = reconcileDualCatalogJudgments(sol, opus);
		expect(result.counts).toMatchObject({ eligible: 1, judgeable: 0, unjudgeable: 1 });
		expect(Object.values(result.decisions)[0]).toMatchObject({ status: "unjudgeable", reason: "unjudgeable-missing-final-assistant" });
		expect(result.publicQueues.unjudgeable).toHaveLength(1);
	});
});
