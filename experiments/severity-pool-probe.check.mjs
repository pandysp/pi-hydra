/**
 * Offline invariants for the severity-pooling probe. Zero provider calls: the
 * probe's matrix sits behind an entry-point guard, so importing it pulls in the
 * pure helpers only.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
	SEVERITY_WEIGHTS,
	agreedSeverity,
	agreementStats,
	clusterPrompt,
	codeContext,
	messageTextOf,
	parseClusters,
	parseSeverities,
	poolMessages,
	scoreArms,
	severityPrompt,
} from "./severity-pool-probe.mjs";

const obs = (arm, pointIndex, delivery, responseText, extra = {}) => ({
	kind: "observation",
	arm,
	pointIndex,
	delivery,
	responseText,
	valid: true,
	...extra,
});

test("the pool takes delivered messages only, and never an invalid or silent row", () => {
	const rows = [
		obs("MAIN", 1, "queue", '{"action":"queue","reason":"r","message":"real claim"}'),
		obs("MAIN", 2, "none", "DELIVERY: none"),
		obs("F2", 3, "steer", "a finding\nDELIVERY: steer"),
		obs("F2", 4, "steer", "dropped\nDELIVERY: steer", { valid: false }),
		{ kind: "driver-turn", arm: "MAIN" },
	];
	const pool = poolMessages(rows);
	assert.deepEqual(pool.map((item) => item.id), ["m01", "m02"]);
	assert.deepEqual(pool.map((item) => item.arm), ["F2", "MAIN"]);
	assert.equal(pool.find((item) => item.arm === "MAIN").text, "real claim");
	assert.equal(pool.find((item) => item.arm === "F2").text, "a finding");
});

test("the claim is read from raw text: footer stripped, JSON message extracted", () => {
	assert.equal(messageTextOf({ responseText: "the counter never resets\nDELIVERY: steer" }), "the counter never resets");
	assert.equal(messageTextOf({ responseText: '{"action":"queue","reason":"why","message":"the claim"}' }), "the claim");
	// A malformed body is preserved rather than silently emptied — an empty
	// claim would enter the pool as a phantom issue.
	assert.equal(messageTextOf({ responseText: "not json and no footer" }), "not json and no footer");
});

test("the cluster prompt is blind: no arm, no point, no delivery type", () => {
	const pool = poolMessages([
		obs("MAIN", 7, "queue", '{"action":"queue","reason":"r","message":"claim one"}'),
		obs("F2", 8, "steer", "claim two\nDELIVERY: steer"),
	]);
	const prompt = clusterPrompt(pool);
	assert.ok(prompt.includes("claim one") && prompt.includes("claim two"));
	for (const leak of ["MAIN", "F2", "steer", "queue", "p7", "p8"]) {
		assert.ok(!prompt.includes(leak), `arm/delivery/point leaked into the cluster prompt: ${leak}`);
	}
});

test("the severity prompt shows the neutral statement, never the arm's wording or the member count", () => {
	const clusters = [{ id: "g01", statement: "sweepExpired leaves claimedBy set", members: ["m01", "m02", "m03"] }];
	const prompt = severityPrompt(clusters, "----- src/x.js\ncode here");
	assert.ok(prompt.includes("sweepExpired leaves claimedBy set"));
	assert.ok(prompt.includes("code here"));
	assert.ok(!prompt.includes("m01"), "member ids leaked: the judge could count how many arms raised it");
	assert.ok(!prompt.includes("members"));
	for (const level of Object.keys(SEVERITY_WEIGHTS)) assert.ok(prompt.includes(level), `anchor missing: ${level}`);
});

test("codeContext carries both ends of the trajectory", () => {
	const rows = [
		{ kind: "file-state", pointIndex: 0, files: { "src/a.js": "START BODY" } },
		{ kind: "file-state", pointIndex: 9, files: { "src/a.js": "END BODY" } },
	];
	const code = codeContext(rows);
	assert.ok(code.includes("START BODY") && code.includes("END BODY"));
	assert.ok(code.indexOf("START BODY") < code.indexOf("END BODY"));
	assert.throws(() => codeContext([{ kind: "observation" }]), /no file-state rows/);
});

test("parseClusters refuses a clustering that drops or invents a note", () => {
	const ids = ["m01", "m02"];
	assert.ok(parseClusters('{"groups":[{"id":"g01","statement":"s","members":["m01","m02"]}]}', ids));
	assert.equal(parseClusters('{"groups":[{"id":"g01","statement":"s","members":["m01"]}]}', ids), null, "m02 dropped");
	assert.equal(parseClusters('{"groups":[{"id":"g01","statement":"s","members":["m01","m99"]}]}', ids), null, "invented id");
	assert.equal(parseClusters('{"groups":[]}', ids), null);
	assert.equal(parseClusters("not json", ids), null);
});

test("parseSeverities enforces the closed scale and the case count", () => {
	const ok = '{"cases":[{"id":"j01","reasoning":"r","real":true,"severity":"blocking"}]}';
	assert.ok(parseSeverities(ok, 1));
	assert.ok(parseSeverities("```json\n" + ok + "\n```", 1), "fenced output must parse");
	assert.equal(parseSeverities('{"cases":[{"id":"j01","reasoning":"r","real":true,"severity":"critical"}]}', 1), null, "off-scale level");
	assert.equal(parseSeverities(ok, 2), null, "count mismatch");
	assert.equal(parseSeverities('{"cases":[{"id":"j02","reasoning":"r","real":true,"severity":"minor"}]}', 1), null, "misnumbered");
});

test("a severity disagreement carries no weight — it is never averaged", () => {
	assert.deepEqual(agreedSeverity({ real: true, severity: "blocking" }, { real: true, severity: "blocking" }), {
		real: true,
		severity: "blocking",
		weight: 9,
	});
	// The spec forbids falling back to a mean of two unreliable labels.
	assert.deepEqual(agreedSeverity({ real: true, severity: "blocking" }, { real: true, severity: "minor" }), {
		real: true,
		severity: null,
		weight: null,
	});
	assert.deepEqual(agreedSeverity({ real: true, severity: "serious" }, { real: false, severity: "not-an-issue" }), {
		real: false,
		severity: null,
		weight: 0,
	});
});

test("severity-weighted recall weights a blocking miss nine times a minor miss", () => {
	const pool = [
		{ id: "m01", arm: "A", pointIndex: 1, delivery: "steer", text: "x" },
		{ id: "m02", arm: "B", pointIndex: 1, delivery: "queue", text: "y" },
	];
	const clusters = [
		{ id: "g01", statement: "blocking one", members: ["m01"] },
		{ id: "g02", statement: "minor one", members: ["m02"] },
	];
	const agreed = [
		{ real: true, severity: "blocking", weight: 9 },
		{ real: true, severity: "minor", weight: 1 },
	];
	const scores = scoreArms(pool, clusters, agreed);
	const a = scores.arms.find((item) => item.arm === "A");
	const b = scores.arms.find((item) => item.arm === "B");
	assert.equal(scores.totalWeight, 10);
	assert.equal(a.weightedRecall, 0.9, "finding the blocking issue is worth 90% of the mass");
	assert.equal(b.weightedRecall, 0.1);
	assert.equal(a.topFindingHit, true);
	assert.equal(b.topFindingHit, false);
});

test("raising a not-real issue costs precision but not recall", () => {
	const pool = [
		{ id: "m01", arm: "A", pointIndex: 1, delivery: "steer", text: "x" },
		{ id: "m02", arm: "A", pointIndex: 2, delivery: "steer", text: "noise" },
	];
	const clusters = [
		{ id: "g01", statement: "real", members: ["m01"] },
		{ id: "g02", statement: "noise", members: ["m02"] },
	];
	const agreed = [
		{ real: true, severity: "serious", weight: 3 },
		{ real: false, severity: null, weight: 0 },
	];
	const a = scoreArms(pool, clusters, agreed).arms[0];
	assert.equal(a.weightedRecall, 1, "recall is unaffected by the false positive");
	assert.equal(a.notRealRaised, 1);
	assert.equal(a.weightedPrecision, 0.75, "3 real weight over 3 + 1 penalty");
});

test("agreementStats separates exact from adjacent and lists every disagreement", () => {
	const sol = [
		{ real: true, severity: "blocking" },
		{ real: true, severity: "serious" },
		{ real: true, severity: "minor" },
	];
	const opus = [
		{ real: true, severity: "blocking" },
		{ real: true, severity: "minor" },
		{ real: false, severity: "not-an-issue" },
	];
	const stats = agreementStats(sol, opus);
	assert.equal(stats.n, 3);
	assert.equal(stats.exact, 1);
	assert.equal(stats.adjacent, 3, "serious/minor and minor/not-an-issue are both one step apart");
	assert.equal(stats.disagreements.length, 2);
	assert.equal(Math.round(stats.realAgreement * 100), 67);
});
