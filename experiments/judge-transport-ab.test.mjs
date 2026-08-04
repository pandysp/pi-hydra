import { describe, expect, it } from "vitest";
import { buildSampleManifest, shardPoints } from "./judge-transport-ab-sample.mjs";
import { comparePasses, findingSummary, mergePassOutputs } from "./judge-transport-ab-compare.mjs";

function observationRow(task, config, pointId, arm, findings) {
	return {
		kind: "observation",
		runId: "run1",
		trajectoryId: task,
		config,
		pointId,
		arm,
		delivery: "steer",
		formatValid: true,
		valid: true,
		responseText: JSON.stringify({ findings: findings.map((message) => ({ message })) }),
		capturedPayloadHash: "0123456789abcdef",
		capturedPayloadPath: `payloads/${pointId}.json`,
		pointKind: "mid-run",
		requestIndex: 1,
		runIndex: 0,
	};
}

function syntheticRows() {
	const rows = [];
	for (const task of ["scheduler", "exporter", "dispatcher"]) {
		for (const config of ["sol-high", "sol-xhigh"]) {
			for (let point = 0; point < 6; point++) {
				rows.push(observationRow(task, config, `p${point}`, "MAIN-SO2", ["finding one", "finding two"]));
			}
		}
	}
	return rows;
}

describe("judge transport A/B sample", () => {
	it("is deterministic and takes whole points until every stratum holds the floor", () => {
		const first = buildSampleManifest(syntheticRows(), "deadbeef");
		const second = buildSampleManifest(syntheticRows(), "deadbeef");
		expect(first).toEqual(second);
		expect(first.points).toEqual([...first.points].sort());
		for (const counts of Object.values(first.strata)) {
			expect(counts.findings).toBeGreaterThanOrEqual(7);
			expect(counts.findings).toBeLessThan(7 + 2);
		}
		expect(first.totalFindings).toBe(Object.values(first.strata).reduce((sum, counts) => sum + counts.findings, 0));
	});

	it("changes with the rows hash and rejects an unreachable floor", () => {
		const first = buildSampleManifest(syntheticRows(), "deadbeef");
		const other = buildSampleManifest(syntheticRows(), "cafecafe");
		expect(other.points).not.toEqual(first.points);
		const tiny = syntheticRows().filter((row) => row.pointId === "p0");
		expect(() => buildSampleManifest(tiny, "deadbeef")).toThrow(/needs 7/);
	});

	it("shards round-robin over the sorted sample and reassembles exactly", () => {
		const points = ["a", "b", "c", "d", "e", "f", "g"];
		const shards = shardPoints(points, 3);
		expect(shards).toEqual([["a", "d", "g"], ["b", "e"], ["c", "f"]]);
		expect(shards.flat().sort()).toEqual(points);
		expect(() => shardPoints(points, 4)).toThrow(/1\.\.3/);
	});
});

function shardState(metadata, judgments) {
	return { metadata, status: "complete", judgments, unjudgeable: {}, batches: Object.keys(judgments).map((key) => ({ pointKey: key, batchMs: 1000, recovered: false })), failures: [] };
}

describe("judge transport A/B merge and compare", () => {
	const metadata = { protocol: "capstone-trajectory-claims-v1", judge: "opus-cli-ab", pointsFile: "shard-0.json", pointsSha256: "x" };

	it("merges disjoint shards and refuses protocol drift or duplicates", () => {
		const merged = mergePassOutputs([
			shardState(metadata, { k1: { claims: [] } }),
			shardState({ ...metadata, pointsFile: "shard-1.json", pointsSha256: "y" }, { k2: { claims: [] } }),
		]);
		expect(Object.keys(merged.judgments).sort()).toEqual(["k1", "k2"]);
		expect(merged.metadata.pointsFile).toBeUndefined();
		expect(() => mergePassOutputs([
			shardState(metadata, { k1: { claims: [] } }),
			shardState({ ...metadata, judge: "opus-pi-ab" }, { k2: { claims: [] } }),
		])).toThrow(/protocols/);
		expect(() => mergePassOutputs([
			shardState(metadata, { k1: { claims: [] } }),
			shardState(metadata, { k1: { claims: [] } }),
		])).toThrow(/duplicate/);
	});

	it("summarises findings on the registered fields", () => {
		const summary = findingSummary({ claims: [
			{ centralSupported: true, unsupportedExtra: false, matches: [{ catalogKey: "k01", issueId: "SCHED-x" }] },
			{ centralSupported: false, unsupportedExtra: true, matches: [{ catalogKey: "k02", issueId: "SCHED-y" }, { catalogKey: "k03", issueId: "SCHED-x" }] },
		] });
		expect(summary).toEqual({ claimCount: 2, anyCentralSupported: true, anyUnsupportedExtra: true, matchedIssues: ["SCHED-x", "SCHED-y"] });
	});

	it("counts discordant findings per metric and demands identical samples", () => {
		const judgment = (supported, issueId) => ({ claims: [{ centralSupported: supported, unsupportedExtra: false, matches: issueId ? [{ catalogKey: "k01", issueId }] : [] }] });
		const passX = shardState(metadata, { k1: judgment(true, "SCHED-x"), k2: judgment(false, null) });
		const passY = shardState(metadata, { k1: judgment(true, "SCHED-y"), k2: judgment(true, null) });
		const result = comparePasses(passX, passY, "A", "B");
		expect(result.findings).toBe(2);
		expect(result.discordant).toEqual({ anyCentralSupported: 1, anyUnsupportedExtra: 0, matchedIssues: 1, claimCount: 0 });
		const passShort = shardState(metadata, { k1: judgment(true, "SCHED-x") });
		expect(() => comparePasses(passX, passShort, "A", "B")).toThrow(/identical sample/);
	});
});
