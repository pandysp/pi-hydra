/**
 * Offline invariants for severity-pooling v2. Zero provider calls: the probe's
 * matrix sits behind an entry-point guard, so importing it pulls the pure
 * helpers only.
 *
 * The tests are organised around the three pre-registered fixes, because each
 * one exists to prevent a specific v1 failure and a regression would silently
 * reproduce it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
	HARM_ORDER,
	HARM_WEIGHTS,
	agreementStats,
	blend,
	buildCandidates,
	dedupePrompt,
	extractPrompt,
	judgePrompt,
	parseClaims,
	parseGroups,
	parseJudgments,
	parseMatches,
	plantedMatchPrompt,
	poolMessages,
	scoreArms,
	unionClaims,
} from "./severity-pool-probe-v2.mjs";

const obs = (arm, pointIndex, delivery, responseText, extra = {}) => ({
	kind: "observation",
	arm,
	pointIndex,
	delivery,
	responseText,
	valid: true,
	...extra,
});

// ---------------------------------------------------------------------------
// F1 — the judgment is decomposed; the analyst blends
// ---------------------------------------------------------------------------

test("F1: the judge prompt asks three separate questions and forbids reachability discounting", () => {
	const prompt = judgePrompt([{ statement: "a defect" }], "CODE");
	assert.match(prompt, /harmIfExecuted/);
	assert.match(prompt, /reachable/);
	assert.match(prompt, /inDeliverable/);
	// The v1 failure was an unstated convention. Question 1 must say so.
	assert.match(prompt, /DO NOT discount for whether the path can currently be reached/);
	// And it must never ask for a blended verdict.
	assert.doesNotMatch(prompt, /"severity"/);
});

test("F1: a harmIfExecuted disagreement carries no weight in either blend", () => {
	const result = blend(
		{ harmIfExecuted: "blocking", reachable: "yes", inDeliverable: false },
		{ harmIfExecuted: "minor", reachable: "yes", inDeliverable: false },
	);
	assert.equal(result.agreedHarm, null);
	assert.equal(result.mechanism, null);
	assert.equal(result.practical, null);
});

test("F1: the practical blend downgrades unreachable and upgrades in-deliverable", () => {
	const unreachable = blend(
		{ harmIfExecuted: "serious", reachable: "no", inDeliverable: false },
		{ harmIfExecuted: "serious", reachable: "no", inDeliverable: false },
	);
	assert.equal(unreachable.mechanism, HARM_WEIGHTS.serious);
	assert.equal(unreachable.practicalLevel, "minor");

	const deliverable = blend(
		{ harmIfExecuted: "minor", reachable: "yes", inDeliverable: true },
		{ harmIfExecuted: "minor", reachable: "yes", inDeliverable: true },
	);
	assert.equal(deliverable.mechanism, HARM_WEIGHTS.minor);
	assert.equal(deliverable.practicalLevel, "serious");

	// Both modifiers at once cancel, and the scale never runs off either end.
	const both = blend(
		{ harmIfExecuted: "serious", reachable: "no", inDeliverable: true },
		{ harmIfExecuted: "serious", reachable: "no", inDeliverable: true },
	);
	assert.equal(both.practicalLevel, "serious");
	const floor = blend(
		{ harmIfExecuted: "none", reachable: "no", inDeliverable: false },
		{ harmIfExecuted: "none", reachable: "no", inDeliverable: false },
	);
	assert.equal(floor.practicalLevel, "none");
});

test("F1: a modifier the judges disagree on is not applied — never averaged", () => {
	const result = blend(
		{ harmIfExecuted: "serious", reachable: "no", inDeliverable: false },
		{ harmIfExecuted: "serious", reachable: "yes", inDeliverable: false },
	);
	assert.equal(result.agreedReachable, null);
	assert.equal(result.practicalLevel, "serious", "an unagreed modifier must leave the level alone");
});

test("F1: parseJudgments enforces all three closed fields and the case count", () => {
	const ok = '{"cases":[{"id":"j01","reasoning":"r","harmIfExecuted":"serious","reachable":"yes","inDeliverable":false}]}';
	assert.ok(parseJudgments(ok, 1));
	assert.equal(parseJudgments(ok, 2), null, "a short answer must not be accepted");
	assert.equal(
		parseJudgments('{"cases":[{"id":"j01","reasoning":"r","harmIfExecuted":"catastrophic","reachable":"yes","inDeliverable":false}]}', 1),
		null,
	);
	assert.equal(
		parseJudgments('{"cases":[{"id":"j01","reasoning":"r","harmIfExecuted":"serious","reachable":"maybe","inDeliverable":false}]}', 1),
		null,
	);
	assert.equal(
		parseJudgments('{"cases":[{"id":"j01","reasoning":"r","harmIfExecuted":"serious","reachable":"yes","inDeliverable":"no"}]}', 1),
		null,
		"inDeliverable must be a boolean, not a string",
	);
});

// ---------------------------------------------------------------------------
// F2 — claims, not messages: a multi-defect note credits every defect
// ---------------------------------------------------------------------------

test("F2: the extraction prompt states multi-claim as the norm, not an exception", () => {
	const prompt = extractPrompt([{ id: "m01", text: "a note" }]);
	assert.match(prompt, /MORE THAN ONE distinct defect/);
	assert.match(prompt, /If a note names two defects, emit two claims/);
	// Blind: no arm, no delivery type, no point index.
	assert.doesNotMatch(prompt, /MAIN|steer|queue|pointIndex/);
});

test("F2: a note yielding two claims credits its arm on both issues — the v1 failure", () => {
	// MAIN's p6 shape: one message naming a race AND a state bug.
	const pool = poolMessages([
		obs("MAIN", 6, "queue", '{"action":"queue","reason":"r","message":"claimNext has a check-then-await race, and sweepExpired leaves claimedBy set"}'),
		obs("F2", 6, "steer", "sweepExpired leaves claimedBy set\nDELIVERY: steer"),
	]);
	const claims = unionClaims({
		opus: [
			{ note: pool.find((item) => item.arm === "MAIN").id, statement: "two workers can claim one job" },
			{ note: pool.find((item) => item.arm === "MAIN").id, statement: "swept jobs keep claimedBy" },
			{ note: pool.find((item) => item.arm === "F2").id, statement: "swept jobs keep claimedBy" },
		],
	});
	const groups = [
		{ id: "g01", statement: "the claim race", members: [claims[0].id] },
		{ id: "g02", statement: "the stranded claim", members: [claims[1].id, claims[2].id] },
	];
	const { candidates } = buildCandidates(groups, [], []);
	const blends = candidates.map(() => blend(
		{ harmIfExecuted: "blocking", reachable: "yes", inDeliverable: false },
		{ harmIfExecuted: "blocking", reachable: "yes", inDeliverable: false },
	));
	const scores = scoreArms(pool, claims, candidates, blends);
	const main = scores.mechanism.arms.find((arm) => arm.arm === "MAIN");
	const f2 = scores.mechanism.arms.find((arm) => arm.arm === "F2");
	assert.equal(main.realIssuesFound, 2, "the multi-defect note must credit both issues");
	assert.equal(f2.realIssuesFound, 1);
	assert.equal(main.weightedRecall, 1);
	assert.equal(f2.weightedRecall, 0.5);
});

test("F2: parseClaims rejects a claim attributed to an unknown note", () => {
	assert.ok(parseClaims('{"claims":[{"note":"m01","statement":"s"}]}', ["m01"]));
	assert.equal(parseClaims('{"claims":[{"note":"m09","statement":"s"}]}', ["m01"]), null);
	assert.equal(parseClaims('{"claims":[{"note":"m01","statement":"  "}]}', ["m01"]), null);
	// Zero claims is legitimate: a pure process comment makes no defect claim.
	assert.deepEqual(parseClaims('{"claims":[]}', ["m01"]), []);
});

test("F2: parseGroups refuses a grouping that drops, duplicates or invents a claim", () => {
	const ids = ["c01", "c02"];
	assert.ok(parseGroups('{"groups":[{"id":"g01","statement":"s","members":["c01","c02"]}]}', ids));
	assert.equal(parseGroups('{"groups":[{"id":"g01","statement":"s","members":["c01"]}]}', ids), null, "a dropped claim changes every denominator");
	assert.equal(
		parseGroups('{"groups":[{"id":"g01","statement":"s","members":["c01"]},{"id":"g02","statement":"t","members":["c01","c02"]}]}', ids),
		null,
		"a claim in two groups would double-count its arm",
	);
	assert.equal(parseGroups('{"groups":[{"id":"g01","statement":"s","members":["c03"]}]}', ids), null);
});

// ---------------------------------------------------------------------------
// F3 — the pool is seeded, so a universal miss is scoreable
// ---------------------------------------------------------------------------

test("F3: an unmatched planted defect enters the pool with no members and scores zero for everyone", () => {
	const pool = poolMessages([obs("MAIN", 1, "queue", '{"action":"queue","reason":"r","message":"found one"}')]);
	const claims = unionClaims({ opus: [{ note: "m01", statement: "the found defect" }] });
	const groups = [{ id: "g01", statement: "the found defect", members: [claims[0].id] }];
	const defects = [
		{ id: "planted-found", target: "the found defect" },
		{ id: "planted-missed", target: "the defect nobody described" },
	];
	const matches = [
		{ defect: "p1", candidates: ["g01"] },
		{ defect: "p2", candidates: [] },
	];
	const { candidates } = buildCandidates(groups, defects, matches);
	assert.equal(candidates.length, 2, "the missed defect must still enter the pool");
	const seeded = candidates.find((item) => item.seeded);
	assert.deepEqual(seeded.members, [], "a seeded defect has no members by construction");
	assert.deepEqual(seeded.planted, ["planted-missed"]);
	assert.deepEqual(candidates.find((item) => !item.seeded).planted, ["planted-found"]);

	const blends = candidates.map(() => blend(
		{ harmIfExecuted: "blocking", reachable: "yes", inDeliverable: false },
		{ harmIfExecuted: "blocking", reachable: "yes", inDeliverable: false },
	));
	const scores = scoreArms(pool, claims, candidates, blends);
	// Recall is now over the TRUE defect set, so finding one of two is 50%,
	// not the 100% v1 would have reported over the collectively-found set.
	assert.equal(scores.mechanism.arms.find((arm) => arm.arm === "MAIN").weightedRecall, 0.5);
});

test("F3: the planted-match prompt permits an empty match and forbids downstream-consequence matches", () => {
	const prompt = plantedMatchPrompt([{ target: "a planted defect" }], [{ id: "g01", statement: "a candidate" }]);
	assert.match(prompt, /may match zero candidates/);
	assert.match(prompt, /DOWNSTREAM CONSEQUENCE/);
	// The reference defects must not be shown to the dedupe judge, or grouping
	// is biased toward them; that is why this is a separate pass.
	assert.doesNotMatch(dedupePrompt([{ id: "c01", statement: "s" }]), /REFERENCE DEFECT/);
});

test("F3: parseMatches requires one entry per defect, in order, and rejects unknown candidates", () => {
	const groupIds = ["g01", "g02"];
	assert.ok(parseMatches('{"matches":[{"defect":"p1","candidates":["g01"]},{"defect":"p2","candidates":[]}]}', 2, groupIds));
	assert.equal(parseMatches('{"matches":[{"defect":"p1","candidates":["g01"]}]}', 2, groupIds), null, "a missing defect entry would silently drop it from the pool");
	assert.equal(parseMatches('{"matches":[{"defect":"p2","candidates":[]},{"defect":"p1","candidates":[]}]}', 2, groupIds), null, "out of order would mis-attribute the match");
	assert.equal(parseMatches('{"matches":[{"defect":"p1","candidates":["g09"]},{"defect":"p2","candidates":[]}]}', 2, groupIds), null);
});

// ---------------------------------------------------------------------------
// Agreement statistics
// ---------------------------------------------------------------------------

test("agreementStats separates exact from adjacent on harmIfExecuted and reports the modifiers", () => {
	const sol = [
		{ harmIfExecuted: "blocking", reachable: "yes", inDeliverable: true },
		{ harmIfExecuted: "serious", reachable: "yes", inDeliverable: false },
		{ harmIfExecuted: "blocking", reachable: "no", inDeliverable: false },
	];
	const opus = [
		{ harmIfExecuted: "blocking", reachable: "yes", inDeliverable: true },
		{ harmIfExecuted: "minor", reachable: "unclear", inDeliverable: false },
		{ harmIfExecuted: "minor", reachable: "no", inDeliverable: true },
	];
	const stats = agreementStats(sol, opus);
	assert.equal(stats.exact, 1);
	assert.equal(stats.adjacent, 2, "serious-vs-minor is adjacent; blocking-vs-minor is two steps");
	assert.equal(stats.reachableAgreement, 2 / 3);
	assert.equal(stats.inDeliverableAgreement, 2 / 3);
	assert.deepEqual(stats.disagreements.map((item) => item.distance), [1, 2]);
});

test("the harm scale is ordered worst-last and weighted 9/3/1/0", () => {
	assert.deepEqual(HARM_ORDER, ["none", "minor", "serious", "blocking"]);
	assert.deepEqual(HARM_WEIGHTS, { blocking: 9, serious: 3, minor: 1, none: 0 });
});
