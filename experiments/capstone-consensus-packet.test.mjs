import { describe, expect, it } from "vitest";
import { buildCapstoneConsensusPacket } from "./capstone-consensus-packet.mjs";

const commonMetadata = {
	protocol: "capstone-trajectory-claims-v1",
	judgeReasoning: "high",
	judgeBuilderHash: "builder",
	eligibilityPolicy: "semantic-v2",
	expectedFindings: 1,
	datasetVersion: "v2",
	catalogHashes: { scheduler: "catalog" },
	rowsFile: "rows.jsonl.gz",
	rowsSha256: "rows",
	payloadsFile: "payloads.tar.gz",
	payloadsSha256: "payloads",
	datasetFile: "golden-dataset.json",
	datasetSha256: "dataset",
};

const judgment = (judge, claims) => ({
	sourceKey: "run/scheduler/sol-high/point/MAIN-SO2/f0",
	runId: "run",
	pointKey: "run/scheduler/sol-high/point",
	pointId: "point",
	task: "scheduler",
	config: "sol-high",
	arm: "MAIN-SO2",
	findingIndex: 0,
	message: "The lease can expire while work continues.",
	capturedPayloadHash: "payload-short",
	capturedPayloadFile: "point.json",
	pointKind: "piggyback",
	requestIndex: 3,
	runIndex: 0,
	qualitySourceValidity: "valid",
	judge,
	promptHash: "prompt",
	claims,
});

function state(judge, claims, metadata = {}) {
	const one = judgment(judge, claims);
	return {
		status: "complete",
		metadata: {
			...commonMetadata,
			...metadata,
			judge,
			judgeModel: judge === "sol" ? "gpt-5.6-sol" : "opus",
			judgeTransport: judge === "sol" ? "pi" : "claude-cli",
		},
		judgments: { [one.sourceKey]: one },
		unjudgeable: {},
		batches: [{ promptHash: "prompt", sourceKeys: ["run/scheduler/sol-high/point/MAIN-SO2/f0"] }],
		failures: [],
	};
}

describe("capstone consensus analyst packet", () => {
	it("places independently split claims side by side without deciding consensus", () => {
		const sol = state("sol", [{ statement: "lease expires", reasoning: "sol reason", centralSupported: true, unsupportedExtra: false, matches: [{ issueId: "S1" }] }]);
		const opus = state("opus", [
			{ statement: "lease expires", reasoning: "opus reason", centralSupported: true, unsupportedExtra: false, matches: [{ issueId: "S1" }] },
			{ statement: "retry duplicates work", reasoning: "opus second", centralSupported: true, unsupportedExtra: false, matches: [] },
		]);

		const packet = buildCapstoneConsensusPacket(sol, opus);

		expect(packet).toMatchObject({
			schemaVersion: 1,
			status: "awaiting-analyst",
			basis: commonMetadata,
			counts: { findings: 1, solClaims: 1, opusClaims: 2, unjudgeable: 0 },
		});
		expect(packet.findings[0].solClaims[0].claimRef).toMatch(/#sol:c0$/);
		expect(packet.findings[0].opusClaims[1].claimRef).toMatch(/#opus:c1$/);
		expect(packet.findings[0]).not.toHaveProperty("consensus");
	});

	it("refuses input drift before presenting claims", () => {
		const sol = state("sol", []);
		const wrongDataset = state("opus", [], { datasetSha256: "different" });
		expect(() => buildCapstoneConsensusPacket(sol, wrongDataset)).toThrow(/judge input metadata differs/);

		const missing = state("opus", []);
		missing.judgments = {};
		expect(() => buildCapstoneConsensusPacket(sol, missing)).toThrow(/judgment source keys differ/);
	});

	it("requires the same unjudgeable evidence holes from both judges", () => {
		const sol = state("sol", []);
		const opus = state("opus", []);
		sol.status = "complete-with-unjudgeable";
		opus.status = "complete-with-unjudgeable";
		sol.unjudgeable = { missing: { sourceKey: "missing", reason: "unjudgeable-missing-final-assistant" } };
		opus.unjudgeable = { missing: { sourceKey: "missing", reason: "unjudgeable-missing-final-assistant" } };
		expect(buildCapstoneConsensusPacket(sol, opus).counts.unjudgeable).toBe(1);

		opus.unjudgeable.missing.reason = "different";
		expect(() => buildCapstoneConsensusPacket(sol, opus)).toThrow(/unjudgeable records differ/);
	});
});
