/**
 * Offline invariants for the v3 pairwise severity probe. Zero provider calls:
 * the runner sits behind an entry-point guard, so importing pulls in only pure
 * helpers.
 *
 * The three that matter, each guarding a defect this program has already paid
 * for once:
 *   - membership parsing must accept a message identifying SEVERAL issues (v1's
 *     clustering folded a two-defect message into one and made MAIN's strongest
 *     finding invisible);
 *   - the Bradley-Terry fit must order a known dominance structure correctly,
 *     or the ranking is decoration;
 *   - pair generation must be reproducible from the seed, or the raw
 *     comparisons printed in the results doc cannot be re-derived.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
	agreementRate,
	allPairs,
	bradleyTerry,
	comparisonDesign,
	deliveredMessages,
	parseComparisons,
	parseIssues,
	parseMembership,
	renderTranscript,
	rankWeightedCoverage,
	rng,
	shuffled,
	toolResultText,
	topKHits,
} from "./severity-pairwise-probe.mjs";

test("the seed reproduces pair order and orientation exactly", () => {
	const ids = ["a", "b", "c", "d"];
	const one = shuffled(allPairs(ids), rng(42));
	const two = shuffled(allPairs(ids), rng(42));
	assert.deepEqual(one, two, "same seed must give the same order");
	assert.notDeepEqual(one, shuffled(allPairs(ids), rng(43)));
	assert.equal(allPairs(ids).length, 6, "round robin over 4 ids is 6 pairs");
});

test("reference issues parse and are given stable ids", () => {
	const parsed = parseIssues('prose before {"issues":[{"where":"claimNext","defect":"race"},{"where":"requeue","defect":"resets attempts"}]}', "r");
	assert.deepEqual(parsed.map((i) => i.id), ["r01", "r02"]);
	assert.equal(parsed[1].defect, "resets attempts");
	assert.equal(parseIssues('{"issues":[{"where":"x"}]}', "r"), null, "an issue without a defect line is malformed");
	assert.equal(parseIssues("no json here", "r"), null);
});

test("comparisons parse only with in-order ids and a legal winner", () => {
	const ok = '{"comparisons":[{"id":"c01","reasoning":"x","winner":"A"},{"id":"c02","reasoning":"y","winner":"equal"}]}';
	assert.equal(parseComparisons(ok, 2).length, 2);
	assert.equal(parseComparisons(ok, 3), null, "count mismatch is a parse failure");
	assert.equal(parseComparisons('{"comparisons":[{"id":"c02","reasoning":"x","winner":"A"}]}', 1), null, "out-of-order id");
	assert.equal(parseComparisons('{"comparisons":[{"id":"c01","reasoning":"x","winner":"left"}]}', 1), null, "illegal winner");
});

test("a message identifying TWO issues is preserved — v1's clustering bug", () => {
	const valid = new Set(["r01", "r02", "p01"]);
	const parsed = parseMembership('{"messages":[{"id":"m01","reasoning":"names both","identifies":["r01","p01"]}]}', 1, valid);
	assert.deepEqual(parsed[0].identifies, ["r01", "p01"]);

	const none = parseMembership('{"messages":[{"id":"m01","reasoning":"nothing","identifies":[]}]}', 1, valid);
	assert.deepEqual(none[0].identifies, [], "an empty array is a legal answer");

	assert.equal(
		parseMembership('{"messages":[{"id":"m01","reasoning":"x","identifies":["r99"]}]}', 1, valid),
		null,
		"an id outside the pool is a parse failure, not a silent drop",
	);
});

test("Bradley-Terry orders a known dominance structure", () => {
	const ids = ["top", "mid", "low"];
	const comparisons = [
		{ winner: "top", loser: "mid", tie: false },
		{ winner: "top", loser: "mid", tie: false },
		{ winner: "top", loser: "low", tie: false },
		{ winner: "top", loser: "low", tie: false },
		{ winner: "mid", loser: "low", tie: false },
		{ winner: "mid", loser: "low", tie: false },
	];
	const ranking = bradleyTerry(ids, comparisons);
	assert.deepEqual(ranking.map((r) => r.id), ["top", "mid", "low"]);
	assert.ok(ranking[0].strength > ranking[1].strength);

	const tied = bradleyTerry(["a", "b"], [
		{ winner: "a", loser: "b", tie: true },
		{ winner: "b", loser: "a", tie: true },
	]);
	assert.ok(Math.abs(tied[0].strength - tied[1].strength) < 1e-6, "mutual ties must not separate two issues");
});

test("scoring weights the top of the ranking, and top-k counts only the top k", () => {
	const ranking = [
		{ id: "a", strength: 8 },
		{ id: "b", strength: 1 },
		{ id: "c", strength: 1 },
	];
	const foundTop = rankWeightedCoverage(ranking, new Set(["a"]));
	const foundTail = rankWeightedCoverage(ranking, new Set(["b", "c"]));
	assert.ok(foundTop > foundTail, "one top issue must outweigh two minor ones");
	assert.equal(foundTop, 0.8);

	assert.deepEqual(topKHits(ranking, new Set(["a", "c"]), 2), { hits: 1, of: 2 });
	assert.deepEqual(topKHits(ranking, new Set([]), 3), { hits: 0, of: 3 });
});

test("agreement counts position by position", () => {
	assert.deepEqual(agreementRate(["A", "B", "equal"], ["A", "B", "equal"]), { agree: 3, total: 3, rate: 1 });
	assert.equal(agreementRate(["A", "B"], ["A", "equal"]).rate, 0.5);
	assert.equal(agreementRate([], []).rate, null);
});

test("delivered messages exclude silence in both channel shapes", () => {
	const rows = [
		{ kind: "observation", valid: true, arm: "F", pointIndex: 1, responseText: "a real finding\nDELIVERY: steer" },
		{ kind: "observation", valid: true, arm: "F", pointIndex: 2, responseText: "DELIVERY: none" },
		{ kind: "observation", valid: true, arm: "MAIN", pointIndex: 3, responseText: '{"action":"noop","reason":"nothing","message":""}' },
		{ kind: "observation", valid: true, arm: "MAIN", pointIndex: 4, responseText: '{"action":"queue","reason":"r","message":"the real text"}' },
		{ kind: "observation", valid: false, arm: "F", pointIndex: 5, responseText: "invalid row\nDELIVERY: steer" },
		{ kind: "driver-turn", pointIndex: 6 },
	];
	const delivered = deliveredMessages(rows);
	assert.deepEqual(delivered.map((d) => d.pointIndex), [1, 4], "none, noop, invalid rows and driver turns all drop out");
	assert.equal(delivered[0].text, "a real finding", "the footer is stripped from the message");
	assert.equal(delivered[1].text, "the real text", "the JSON message field is what gets judged");
});

test("tool results render whether the payload stores a string or blocks", () => {
	// The recorded payloads use the string form; an array-shaped result must not
	// crash the renderer either. Getting this wrong empties the transcript the
	// reference reviewer reads, and the reference stage becomes vacuous silently.
	assert.equal(toolResultText({ content: "export function claimNext() {}" }), "export function claimNext() {}");
	assert.equal(toolResultText({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }), "ab");
	assert.equal(toolResultText({}), "");
	assert.equal(toolResultText({ content: null }), "");
});

test("the rendered transcript carries the code the reference must review", () => {
	const payload = {
		messages: [
			{ role: "user", content: [{ type: "text", text: "read src/scheduler.js" }] },
			{ role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "tool_use", name: "read", input: { path: "src/scheduler.js" } }] },
			{ role: "user", content: [{ type: "tool_result", content: "if (job.claimedBy === null) {" }] },
		],
	};
	const rendered = renderTranscript(payload);
	assert.match(rendered, /if \(job\.claimedBy === null\)/, "tool-result code must reach the reviewer");
	assert.match(rendered, /calls read/);
	assert.doesNotMatch(rendered, /hidden/, "thinking blocks are not part of the visible transcript");
});

test("the comparison design stays connected above the round-robin cap", () => {
	const small = ["a", "b", "c"];
	assert.deepEqual(comparisonDesign(small, rng(1)).length, 3, "<=12 issues means full round robin");

	const ids = Array.from({ length: 20 }, (_, i) => `i${i}`);
	const design = comparisonDesign(ids, rng(7));
	assert.ok(design.length < allPairs(ids).length, "above the cap the design must sample, not exhaust");

	// Connectivity is the load-bearing property: Bradley-Terry over a
	// disconnected graph yields strengths that cannot be compared across
	// components, which would render as a ranking and mean nothing.
	const adjacency = new Map(ids.map((id) => [id, []]));
	for (const [a, b] of design) { adjacency.get(a).push(b); adjacency.get(b).push(a); }
	const seen = new Set([ids[0]]);
	const queue = [ids[0]];
	while (queue.length > 0) {
		for (const next of adjacency.get(queue.shift())) if (!seen.has(next)) { seen.add(next); queue.push(next); }
	}
	assert.equal(seen.size, ids.length, "every issue must be reachable in the comparison graph");
	for (const id of ids) assert.ok(adjacency.get(id).length >= 2, `${id} needs at least two comparisons`);
});
