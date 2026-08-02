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
import { readFileSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRAJECTORY_TASKS, setupTask } from "./trajectory-cost-tasks.mjs";

const DATASET = JSON.parse(readFileSync(new URL("./golden-dataset.json", import.meta.url), "utf8"));
const TIERS = new Set(["blocking", "harmful"]);
const PROVENANCE = new Set(["planted", "reference-review", "code-review", "observer", "promoted"]);

test("every record carries the full schema", () => {
	assert.ok(Array.isArray(DATASET.issues) && DATASET.issues.length > 0, "issues must be a non-empty array");
	for (const issue of DATASET.issues) {
		for (const field of ["id", "task", "statement", "tier", "provenance", "votes", "firstSeen", "status"]) {
			assert.ok(issue[field] !== undefined && issue[field] !== null, `${issue.id ?? "?"}: missing ${field}`);
		}
		assert.ok(TIERS.has(issue.tier), `${issue.id}: tier ${issue.tier} outside {blocking, harmful}`);
		assert.ok(issue.status === "active" || issue.status === "retired", `${issue.id}: bad status`);
		assert.ok(Array.isArray(issue.provenance) && issue.provenance.length > 0, `${issue.id}: provenance must be a non-empty array`);
		for (const source of issue.provenance) assert.ok(PROVENANCE.has(source), `${issue.id}: unknown provenance ${source}`);
		// A record whose tier nobody voted on is an opinion, not a datum.
		for (const participant of ["sol", "opus", "analyst"]) {
			assert.ok(issue.votes[participant], `${issue.id}: no ${participant} vote recorded`);
		}
		assert.ok(String(issue.statement).length > 20, `${issue.id}: statement too short to identify a defect`);
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

test("the dedup mapping is total: every source report lands in exactly one issue", () => {
	const seen = new Map();
	for (const issue of DATASET.issues) {
		for (const member of issue.members ?? []) {
			assert.ok(!seen.has(member), `${member} appears in ${seen.get(member)} and ${issue.id}`);
			seen.set(member, issue.id);
		}
	}
	assert.equal(seen.size, DATASET.sourceReports, `mapping covers ${seen.size} of ${DATASET.sourceReports} source reports`);
});

test("anchors resolve against the seeded code", () => {
	const roots = {};
	for (const task of TRAJECTORY_TASKS) {
		const root = mkdtempSync(join(tmpdir(), `golden-check-${task.id}-`));
		setupTask(task, root);
		roots[task.id] = root;
	}
	const read = (root) => {
		const out = [];
		const walk = (dir) => {
			for (const entry of readdirSync(dir)) {
				const full = join(dir, entry);
				if (statSync(full).isDirectory()) { if (entry !== "reference") walk(full); }
				else if (/\.(js|md)$/.test(entry)) out.push(readFileSync(full, "utf8"));
			}
		};
		walk(root);
		return out.join("\n");
	};
	const bodies = Object.fromEntries(Object.entries(roots).map(([id, root]) => [id, read(root)]));
	for (const issue of DATASET.issues) {
		const expression = issue.anchors?.expression;
		if (!expression) continue;
		// Anchors come from the planted set, which is authored against the seed;
		// an anchor that no longer matches means liveness cannot be computed.
		assert.ok(new RegExp(expression).test(bodies[issue.task]), `${issue.id}: anchor /${expression}/ does not resolve in ${issue.task}`);
	}
});

test("dissent is recorded rather than averaged", () => {
	for (const issue of DATASET.issues) {
		if (issue.consensus === "unresolved") {
			assert.ok(String(issue.dissent ?? "").length > 0, `${issue.id}: unresolved but no dissent recorded`);
		}
	}
});
