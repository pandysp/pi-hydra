import { describe, expect, it } from "vitest";
import { comparisonInput, isComparableObservation, judgmentsJsonl, summariseProducer, summariseSolCheckpoint } from "./openai-capstone-results.mjs";

const base = {
	runId: "run",
	trajectoryId: "scheduler",
	config: "sol-high",
	runIndex: 0,
};

const observation = (arm, requestIndex, fields = {}) => ({
	...base,
	kind: "observation",
	pointId: `scheduler/sol-high/a1/r0/${requestIndex}`,
	requestIndex,
	arm,
	valid: true,
	formatValid: true,
	prefixTokens: 2000,
	delivery: "none",
	responseText: arm === "ENUM-SO2" ? '{"findings":[]}' : '{"action":"noop","message":""}',
	costTotal: 0.1,
	...fields,
});

describe("OpenAI capstone results", () => {
	it("separates charged, comparable, and paired costs", () => {
		const rows = [
			{ kind: "trajectory-matrix-header", matrixId: "matrix", matrixHash: "hash", arms: ["MAIN-SO2", "ENUM-SO2"] },
			{ ...base, kind: "driver-turn", requestIndex: 0, costTotal: 1, error: null },
			observation("MAIN-SO2", 0),
			observation("ENUM-SO2", 0, { costTotal: 0.2 }),
			observation("MAIN-SO2", 1, { valid: false, costTotal: 0.3 }),
			observation("ENUM-SO2", 1, { costTotal: 0.4 }),
			{ ...base, kind: "driver-turn", requestIndex: 2, costTotal: 0, error: "WebSocket error" },
			observation("MAIN-SO2", 2, { prefixTokens: 0, costTotal: 0.5 }),
			observation("ENUM-SO2", 2, { prefixTokens: 0, costTotal: 0.6 }),
		];
		const summary = summariseProducer(rows);
		const main = summary.cells[0].arms["MAIN-SO2"];
		const enumeration = summary.cells[0].arms["ENUM-SO2"];
		expect(main).toMatchObject({ observations: 3, comparableObservations: 1, pairedComparableObservations: 1, chargedCost: 0.9, comparableCost: 0.1 });
		expect(enumeration).toMatchObject({ observations: 3, comparableObservations: 2, pairedComparableObservations: 1, chargedCost: 1.2, comparableCost: 0.6, pairedComparableCost: 0.2 });
		expect(summary.armTotals["MAIN-SO2"]).toMatchObject({ observations: 3, comparableObservations: 1, chargedObserverDriverPercent: 90 });
		expect(isComparableObservation(rows.at(-1), new Set(["run/scheduler/sol-high/0/2"]))).toBe(false);
		expect(comparisonInput(summary, "provisional v2").rows).toHaveLength(2);
	});

	it("reports real multi-finding ENUM use", () => {
		const rows = [
			{ kind: "trajectory-matrix-header", matrixId: "matrix", matrixHash: "hash", arms: ["MAIN-SO2", "ENUM-SO2"] },
			{ ...base, kind: "driver-turn", requestIndex: 0, costTotal: 1, error: null },
			observation("MAIN-SO2", 0, { delivery: "steer", responseText: '{"action":"steer","message":"one"}' }),
			observation("ENUM-SO2", 0, { delivery: "steer", responseText: '{"findings":[{"message":"one"},{"message":"two"}]}' }),
		];
		const summary = summariseProducer(rows);
		expect(summary.protocol["MAIN-SO2"]).toMatchObject({ findings: 1, multiFindingResponses: 0 });
		expect(summary.protocol["ENUM-SO2"]).toMatchObject({ findings: 2, multiFindingResponses: 1, maxFindingsInResponse: 2 });
	});

	it("audits accepted raw responses without turning one judge into consensus", () => {
		const state = {
			status: "complete",
			metadata: { judge: "sol", eligibilityPolicy: "semantic-v2", expectedFindings: 1 },
			judgments: { key: { task: "scheduler", config: "sol-high", arm: "MAIN-SO2", claims: [
				{ centralSupported: true, unsupportedExtra: false, matches: [{ issueId: "s1" }] },
			] } },
			unjudgeable: {},
			failures: [{ firstResponse: "", lastResponse: "" }],
			batches: [{ sourceKeys: ["key"], recovered: false, finalResponse: '{"findings":[{"id":"j01","claims":[]}]}' }],
		};
		const summary = summariseSolCheckpoint(state);
		expect(summary).toMatchObject({ judgments: 1, atomicClaims: 1, supportedClaims: 1, supportedMultiMatchClaims: 0, transportFailures: 1, emptyTransportFailures: 1, malformedAcceptedBatches: 0 });
		expect(summary.byArm["MAIN-SO2"]).toMatchObject({ findings: 1, uniqueSupportedCatalogMatches: 1 });
		const exported = judgmentsJsonl(state).trim().split("\n").map((line) => JSON.parse(line));
		expect(exported).toEqual([{ metric: "atomic-claims-v1", task: "scheduler", config: "sol-high", arm: "MAIN-SO2", claims: [
			{ centralSupported: true, unsupportedExtra: false, matches: [{ issueId: "s1" }] },
		] }]);
		expect(summary).not.toHaveProperty("precision");
		expect(summary).not.toHaveProperty("recall");
	});
});
