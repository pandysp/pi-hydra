/**
 * Offline invariants for the severity consensus protocol. Zero provider calls:
 * the module's round runner sits behind an entry-point guard, so importing it
 * pulls in the pure helpers only.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { AXES, PARTICIPANTS, agreed, classifyRevision, majority, parseLabels } from "./severity-consensus.mjs";

const pos = (blocking, anyHarm, reason = "r") => ({ blocking, anyHarm, reason });

test("the protocol uses only the two axes v4 established as reliable", () => {
	assert.deepEqual(AXES, ["blocking", "anyHarm"]);
	assert.deepEqual(PARTICIPANTS, ["sol", "opus", "analyst"]);
});

test("agreement requires all three participants on both axes", () => {
	const all = { sol: { g1: pos(true, true) }, opus: { g1: pos(true, true) }, analyst: { g1: pos(true, true) } };
	assert.equal(agreed(all, "g1"), true);

	const blockingSplit = { sol: { g1: pos(true, true) }, opus: { g1: pos(false, true) }, analyst: { g1: pos(true, true) } };
	assert.equal(agreed(blockingSplit, "g1"), false);

	// A split on the SECOND axis must also block convergence — agreeing on
	// `blocking` while disagreeing on `anyHarm` is not agreement.
	const harmSplit = { sol: { g1: pos(false, true) }, opus: { g1: pos(false, false) }, analyst: { g1: pos(false, true) } };
	assert.equal(agreed(harmSplit, "g1"), false);

	const missing = { sol: { g1: pos(true, true) }, opus: {}, analyst: { g1: pos(true, true) } };
	assert.equal(agreed(missing, "g1"), false, "a missing participant is not agreement");
});

test("majority is used only for unresolved issues and never averages", () => {
	const p = { sol: { g1: pos(true, true) }, opus: { g1: pos(false, true) }, analyst: { g1: pos(true, true) } };
	assert.equal(majority(p, "g1", "blocking"), true);
	assert.equal(majority(p, "g1", "anyHarm"), true);
	const flipped = { sol: { g1: pos(false, true) }, opus: { g1: pos(false, true) }, analyst: { g1: pos(true, true) } };
	assert.equal(majority(flipped, "g1", "blocking"), false);
});

test("revision reasons classify as evidence or authority, mixed counts as authority", () => {
	assert.equal(classifyRevision("claimNext checks claimedBy === null then awaits saveJob, so two workers both pass."), "evidence");
	assert.equal(classifyRevision("Another reviewer is right; I defer."), "authority");
	// The dangerous case: a reason that cites the artefact AND the other
	// reviewer. Counting it as evidence would hide capitulation behind a
	// plausible-looking citation, so it is charged to authority.
	assert.equal(classifyRevision("Another reviewer points at src/worker.js and I agree."), "authority");
	assert.equal(classifyRevision("Changed my mind."), "unclassified");
});

test("parseLabels demands booleans on both axes for every requested id", () => {
	const good = '{"judgments":[{"id":"g1","blocking":true,"anyHarm":true,"reason":"x"},{"id":"g2","blocking":false,"anyHarm":true,"reason":"y"}]}';
	const parsed = parseLabels(good, ["g1", "g2"]);
	assert.equal(parsed.g1.blocking, true);
	assert.equal(parsed.g2.anyHarm, true);

	assert.throws(() => parseLabels(good, ["g1", "g3"]), /omitted g3/);
	assert.throws(
		() => parseLabels('{"judgments":[{"id":"g1","blocking":"yes","anyHarm":true}]}', ["g1"]),
		/must be booleans/,
		"a string verdict must not be coerced into a label",
	);
	assert.throws(() => parseLabels("no json here", ["g1"]), /no JSON object/);
});

test("prose around the JSON does not break parsing", () => {
	const noisy = 'Here are my judgments:\n{"judgments":[{"id":"g1","blocking":false,"anyHarm":false,"reason":"not real"}]}\nHope that helps.';
	assert.equal(parseLabels(noisy, ["g1"]).g1.anyHarm, false);
});
