/**
 * Offline invariants for the frozen golden dataset (`golden-dataset.json`).
 * Zero provider calls: this is the guard that runs on every change, so the
 * regression half of the design (GOLDEN-DATASET-DESIGN.md) stays deterministic
 * and free.
 *
 * The invariants are chosen for the ways this set can silently rot: a record
 * missing its tier scores nothing, a duplicate id makes recall ambiguous, an
 * anchor that no longer resolves means liveness cannot be computed, a planted
 * defect quietly dropped by clustering makes every arm look better than it is,
 * and a partial dedup mapping hides a discovered defect from the reference set.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { TRAJECTORY_TASKS } from "./trajectory-cost-tasks.mjs";
import { anchorResolution } from "./golden-dataset-frame-sources.mjs";

const DATASET = JSON.parse(readFileSync(new URL("./golden-dataset.json", import.meta.url), "utf8"));
const FRAME_SOURCES = JSON.parse(gunzipSync(readFileSync(new URL(
	"./artifacts/2026-08-02-golden-dataset-v2/frame-sources.json.gz",
	import.meta.url,
))).toString());
const TIERS = new Set(["blocking", "harmful"]);
const PROVENANCE = new Set(["planted", "reference-review", "code-review", "observer", "promoted"]);
const FRAMES = new Set(["seed", "session"]);
// Records first seen in the v1 build are grandfathered on the fields the v1
// pipeline never wrote (anchors beyond the planted ten, reachable,
// precondition). Everything judged after the audit carries them.
const V1_RUN = "2026-08-02-golden-dataset-v1";

test("every record carries the full schema", () => {
	assert.ok(Array.isArray(DATASET.issues) && DATASET.issues.length > 0, "issues must be a non-empty array");
	for (const issue of DATASET.issues) {
		for (const field of ["id", "task", "statement", "tier", "provenance", "votes", "firstSeen", "status", "frame"]) {
			assert.ok(issue[field] !== undefined && issue[field] !== null, `${issue.id ?? "?"}: missing ${field}`);
		}
		assert.ok(TIERS.has(issue.tier), `${issue.id}: tier ${issue.tier} outside {blocking, harmful}`);
		assert.ok(issue.status === "active" || issue.status === "retired", `${issue.id}: bad status`);
		assert.ok(FRAMES.has(issue.frame), `${issue.id}: frame ${issue.frame} outside {seed, session}`);
		assert.ok(Array.isArray(issue.provenance) && issue.provenance.length > 0, `${issue.id}: provenance must be a non-empty array`);
		for (const source of issue.provenance) assert.ok(PROVENANCE.has(source), `${issue.id}: unknown provenance ${source}`);
		// A record whose tier nobody voted on is an opinion, not a datum.
		for (const participant of ["sol", "opus", "analyst"]) {
			assert.ok(issue.votes[participant], `${issue.id}: no ${participant} vote recorded`);
		}
		assert.ok(String(issue.statement).length > 20, `${issue.id}: statement too short to identify a defect`);
		if (issue.reachable !== undefined) assert.equal(typeof issue.reachable, "boolean", `${issue.id}: reachable must be boolean`);
		if (issue.precondition !== undefined && issue.precondition !== null) {
			assert.equal(typeof issue.precondition, "string", `${issue.id}: precondition must be a string or null`);
		}
		if (issue.firstSeen !== V1_RUN) {
			// The audit showed anchors are what make individuation and liveness
			// mechanically checkable; new records enter with them or not at all.
			assert.ok(issue.anchors?.expression, `${issue.id}: post-v1 record without an anchor expression`);
			assert.ok(issue.anchors?.file, `${issue.id}: post-v1 record without an anchor file`);
			assert.ok(["literal", "regex"].includes(issue.anchors?.match), `${issue.id}: post-v1 record without explicit literal|regex anchor matching`);
			assert.ok(issue.anchors?.state, `${issue.id}: post-v1 record without an anchor state`);
			assert.equal(typeof issue.reachable, "boolean", `${issue.id}: post-v1 record without reachable`);
			assert.ok("precondition" in issue, `${issue.id}: post-v1 record without precondition (use null when none)`);
		}
	}
});

test("rejected records carry their schema and their reasons", () => {
	assert.ok(Array.isArray(DATASET.rejected), "rejected must be an array");
	for (const record of DATASET.rejected) {
		for (const field of ["id", "task", "statement", "members", "provenance", "votes", "firstSeen", "status", "reason", "frame"]) {
			assert.ok(record[field] !== undefined && record[field] !== null, `${record.id ?? "?"}: rejected record missing ${field}`);
		}
		assert.equal(record.status, "retired", `${record.id}: rejected record must be retired`);
		assert.ok(FRAMES.has(record.frame), `${record.id}: frame ${record.frame} outside {seed, session}`);
		assert.match(
			String(record.reason),
			/^consensus: (not a real defect|real, individuated onto [A-Z]+-[a-z0-9-]+ under RULING 2)$/,
			`${record.id}: rejection reason outside the two-value vocabulary`,
		);
	}
});

test("ids are unique and stable-looking", () => {
	const ids = DATASET.issues.map((i) => i.id);
	assert.equal(new Set(ids).size, ids.length, "duplicate issue id");
	for (const id of ids) assert.match(id, /^[A-Z]+-[a-z0-9-]+$/, `${id}: id is not a stable slug`);
});

test("the set version is the content hash of its active records", () => {
	const active = DATASET.issues.filter((i) => i.status === "active");
	const canonical = JSON.stringify(active.map((i) => [i.id, i.task, i.statement, i.tier]).sort());
	assert.equal(DATASET.version, createHash("sha256").update(canonical).digest("hex").slice(0, 16), "version does not match content");
});

test("no planted defect was silently dropped by clustering", () => {
	const planted = TRAJECTORY_TASKS.flatMap((task) => task.defects.map((d) => d.id));
	const covered = new Set(DATASET.issues.flatMap((i) => i.planted ?? []));
	const missing = planted.filter((id) => !covered.has(id));
	// A planted defect absent from the reference set makes every arm's recall
	// look better than it is — the exact failure the seeded half exists to stop.
	assert.deepEqual(missing, [], `planted defects missing from the set: ${missing.join(", ")}`);
});

test("the dedup mapping is total: every source report lands in exactly one record, active or rejected", () => {
	// The v1 audit found the previous form of this test blind in two ways: it
	// walked only the accepted records (a member dropped INTO rejection passed),
	// and it compared against a count field in the same file (a dropped member
	// plus an edited count passed). Totality now spans both arrays and checks
	// both recorded counts.
	const seen = new Map();
	for (const record of [...DATASET.issues, ...DATASET.rejected]) {
		for (const member of record.members ?? []) {
			assert.ok(!seen.has(member), `${member} appears in ${seen.get(member)} and ${record.id}`);
			seen.set(member, record.id);
		}
	}
	assert.equal(seen.size, DATASET.candidateTotal, `mapping covers ${seen.size} of ${DATASET.candidateTotal} pooled reports`);
	const accepted = DATASET.issues.reduce((n, i) => n + (i.members ?? []).length, 0);
	assert.equal(accepted, DATASET.sourceReports, `accepted members ${accepted} != sourceReports ${DATASET.sourceReports}`);
});

test("anchors resolve against their exact file and judged frame", () => {
	for (const issue of DATASET.issues) {
		if (!issue.anchors) continue;
		const resolved = anchorResolution(issue, FRAME_SOURCES);
		assert.ok(resolved.ok, `${issue.id}: ${resolved.reason}`);
	}
});

test("dissent is recorded rather than averaged", () => {
	for (const issue of DATASET.issues) {
		if (issue.consensus === "unresolved") {
			assert.ok(String(issue.dissent ?? "").length > 0, `${issue.id}: unresolved but no dissent recorded`);
		}
	}
});
