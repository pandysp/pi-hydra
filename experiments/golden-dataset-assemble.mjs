#!/usr/bin/env node
/**
 * Golden dataset v1, stage 3: assemble `golden-dataset.json` from the frozen
 * consensus state. Deterministic — no judge calls, no randomness, so the same
 * state directory always yields the same file and the same content-hash
 * version. Assembly decisions, all visible in the output rather than silent:
 *
 * - ACCEPTED = final-round `anyHarm` unanimous true, or 2-1 with the majority
 *   true. A 2-1 record carries `consensus: "unresolved"` and the minority
 *   position VERBATIM in `dissent` — recorded, never averaged, per
 *   CONSENSUS-SPEC. Majority-false and unanimous-false go to `rejected` with
 *   their members and votes, not deleted (GOLDEN-DATASET-DESIGN, build step 4).
 * - TIER = `blocking` on unanimous blocking, else `harmful`; a 2-1 blocking
 *   split records the majority tier plus the dissent. RULING 1 and 2 were in
 *   the rubric, so labels were produced under them.
 * - IDS are stable slugs derived from each cluster's primary member (planted
 *   id first, else the lowest reference/code-review/observer id), prefixed by
 *   task. They never encode the tier, so a re-judged tier does not move the id.
 * - ANCHORS come from the planted set only (authored against the seed); the
 *   check file resolves them against `setupTask` output.
 *
 * Usage: node experiments/golden-dataset-assemble.mjs --state <dir> [--out experiments/golden-dataset.json]
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { argOf } from "./lib.mjs";
import { TRAJECTORY_TASKS } from "./trajectory-cost-tasks.mjs";

const PREFIX = { scheduler: "SCHED", exporter: "EXP", dispatcher: "DISP" };
const SOURCE = { P: "planted", R: "reference-review", C: "code-review", O: "observer" };

const plantedAnchors = Object.fromEntries(
	TRAJECTORY_TASKS.flatMap((task) => task.defects.map((d) => [
		d.id,
		{ expression: d.expression, declaration: d.declaration, identifier: d.identifier },
	])),
);

export function slugFor(issue) {
	const planted = (issue.members ?? []).find((m) => m.startsWith("P-"));
	if (planted) {
		return `${PREFIX[issue.task]}-${planted.slice(2).replace(/^(sched|exp|retry)-/, "")}`;
	}
	const primary = [...(issue.members ?? [])].sort()[0];
	return `${PREFIX[issue.task]}-${primary.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function finalPositions(stateDir) {
	const state = JSON.parse(readFileSync(`${stateDir}/consensus.json`, "utf8"));
	const rounds = Object.keys(state.rounds).map(Number).sort((a, b) => a - b);
	const finalRound = rounds[rounds.length - 1];
	return { finalRound, positions: state.rounds[finalRound].positions, converged: state.rounds[finalRound].converged };
}

/**
 * `seedStateDir` carries the separate seed-frame protocol (RULING 3 repair):
 * for its issue ids, ITS final positions are authoritative and the main run's
 * are discarded — they were judged against the wrong source.
 */
export function assemble(stateDir, seedStateDir = null, runId = "2026-08-02-golden-dataset-v1") {
	const issues = JSON.parse(readFileSync(`${stateDir}/issues.json`, "utf8")).issues;
	const main = finalPositions(stateDir);
	const participants = ["sol", "opus", "analyst"];
	const positions = { sol: { ...main.positions.sol }, opus: { ...main.positions.opus }, analyst: { ...main.positions.analyst } };
	let seed = null;
	if (seedStateDir) {
		seed = finalPositions(seedStateDir);
		const seedIds = JSON.parse(readFileSync(`${seedStateDir}/issues.json`, "utf8")).issues.map((i) => i.id);
		for (const p of participants) for (const id of seedIds) positions[p][id] = seed.positions[p][id];
	}
	const finalRound = main.finalRound;

	const accepted = [];
	const rejected = [];
	for (const issue of issues) {
		const votes = Object.fromEntries(participants.map((p) => [p, positions[p][issue.id]]));
		const axis = (name) => participants.map((p) => votes[p][name] === true);
		const majority = (flags) => flags.filter(Boolean).length >= 2;
		const unanimous = (flags) => flags.every(Boolean) || flags.every((f) => !f);
		const harmFlags = axis("anyHarm");
		const blockFlags = axis("blocking");
		const dissenters = (name, majorityValue) =>
			participants.filter((p) => (votes[p][name] === true) !== majorityValue)
				.map((p) => `${p} holds ${name}=${votes[p][name]}: ${votes[p].reason}`);

		const record = {
			id: slugFor(issue),
			task: issue.task,
			statement: issue.statement,
			members: issue.members ?? [],
			provenance: [...new Set((issue.members ?? []).map((m) => SOURCE[m[0]]))].sort(),
			votes,
			firstSeen: runId,
			status: "active",
		};
		// Fields the audit added to the schema: the frame the issue was judged
		// under, and the RULING 1/4 metadata recorded by the analyst on the
		// issue before assembly (source facts, not judge outputs).
		if (issue.frame) record.frame = issue.frame;
		if (issue.reachable !== undefined) record.reachable = issue.reachable;
		if (issue.precondition !== undefined) record.precondition = issue.precondition;
		const planted = (issue.members ?? []).filter((m) => m.startsWith("P-")).map((m) => m.slice(2));
		if (planted.length > 0) {
			record.planted = planted;
			record.anchors = plantedAnchors[planted[0]];
		}
		if (issue.anchors && !record.anchors) record.anchors = issue.anchors;

		if (!majority(harmFlags)) {
			// Two-value rejection vocabulary (v1 audit): a claim rejected because
			// its content already lives on another record is not "not real".
			const reason = issue.individuatedInto
				? `consensus: real, individuated onto ${issue.individuatedInto} under RULING 2`
				: "consensus: not a real defect";
			rejected.push({ ...record, status: "retired", reason, ...(unanimous(harmFlags) ? {} : { dissent: dissenters("anyHarm", false).join(" | ") }) });
			continue;
		}
		record.tier = majority(blockFlags) ? "blocking" : "harmful";
		const splits = [];
		if (!unanimous(harmFlags)) splits.push(...dissenters("anyHarm", true));
		if (!unanimous(blockFlags)) splits.push(...dissenters("blocking", majority(blockFlags)));
		if (splits.length > 0) {
			record.consensus = "unresolved";
			record.dissent = splits.join(" | ");
		} else {
			record.consensus = "unanimous";
		}
		accepted.push(record);
	}

	const canonical = JSON.stringify(accepted.filter((i) => i.status === "active").map((i) => [i.id, i.task, i.statement, i.tier]).sort());
	const agreedNow = issues.filter((issue) => {
		const held = participants.map((p) => positions[p][issue.id]);
		return ["blocking", "anyHarm"].every((axis) => held.every((h) => h[axis] === held[0][axis]));
	}).length;
	return {
		version: createHash("sha256").update(canonical).digest("hex").slice(0, 16),
		builtFrom: {
			stateDir: stateDir.replace(process.env.HOME, "~"),
			seedStateDir: seedStateDir ? seedStateDir.replace(process.env.HOME, "~") : null,
			finalRound,
			converged: agreedNow,
			total: issues.length,
		},
		sourceReports: accepted.reduce((n, i) => n + i.members.length, 0),
		candidateTotal: issues.reduce((n, i) => n + (i.members ?? []).length, 0),
		issues: accepted,
		rejected,
	};
}

/**
 * Merge a newly assembled batch (and/or an edits file) onto an existing
 * dataset — the v2+ path: base records pass through with explicit, visible
 * edits; new records append; version and counts recompute. Edits shape:
 *   { patch: {id: {field: value, ...}},      // field overwrites, incl. status
 *     remove: [id, ...],                     // record replaced by a re-judge
 *     addMembers: {id: [srcId, ...]} }       // coverage credit from the pool
 * Nothing here judges anything: every tier/status entering through `patch`
 * must come from a consensus state, and the edits file is committed evidence.
 */
export function mergeDatasets(base, addition, edits = {}) {
	const patch = edits.patch ?? {};
	const remove = new Set(edits.remove ?? []);
	const addMembers = edits.addMembers ?? {};
	const apply = (record) => {
		const out = { ...record, ...(patch[record.id] ?? {}) };
		if (addMembers[record.id]) {
			out.members = [...(out.members ?? []), ...addMembers[record.id]];
			out.provenance = [...new Set([...(out.provenance ?? []), ...addMembers[record.id].map((m) => SOURCE[m[0]])])].sort();
		}
		return out;
	};
	const carried = [...base.issues, ...base.rejected].filter((r) => !remove.has(r.id)).map(apply);
	const appended = [...(addition?.issues ?? []), ...(addition?.rejected ?? [])];
	const all = [...carried, ...appended];
	const ids = all.map((r) => r.id);
	const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
	if (dupes.length > 0) throw new Error(`id collision in merge: ${[...new Set(dupes)].join(", ")}`);
	const unknownEdits = [...Object.keys(patch), ...remove, ...Object.keys(addMembers)].filter(
		(id) => ![...base.issues, ...base.rejected].some((r) => r.id === id),
	);
	if (unknownEdits.length > 0) throw new Error(`edits reference unknown ids: ${[...new Set(unknownEdits)].join(", ")}`);
	const issues = all.filter((r) => r.status === "active");
	const rejected = all.filter((r) => r.status !== "active");
	const canonical = JSON.stringify(issues.map((i) => [i.id, i.task, i.statement, i.tier]).sort());
	return {
		version: createHash("sha256").update(canonical).digest("hex").slice(0, 16),
		builtFrom: {
			base: base.version,
			addition: addition?.builtFrom ?? null,
			edits: { patched: Object.keys(patch).length, removed: remove.size, credited: Object.keys(addMembers).length },
		},
		sourceReports: issues.reduce((n, i) => n + (i.members ?? []).length, 0),
		candidateTotal: all.reduce((n, i) => n + (i.members ?? []).length, 0),
		issues,
		rejected,
	};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2);
	const stateDir = argOf(args, "--state", "");
	const seedStateDir = argOf(args, "--seed-state", "") || null;
	const runId = argOf(args, "--run-id", "2026-08-02-golden-dataset-v1");
	const basePath = argOf(args, "--base", "");
	const editsPath = argOf(args, "--edits", "");
	const out = argOf(args, "--out", "experiments/golden-dataset.json");
	if (!stateDir && !basePath) throw new Error("--state <dir> is required (or --base for a merge)");
	let dataset = stateDir ? assemble(stateDir, seedStateDir, runId) : null;
	if (basePath) {
		const base = JSON.parse(readFileSync(basePath, "utf8"));
		const edits = editsPath ? JSON.parse(readFileSync(editsPath, "utf8")) : {};
		dataset = mergeDatasets(base, dataset, edits);
	}
	writeFileSync(out, `${JSON.stringify(dataset, null, 1)}\n`);
	const tiers = { blocking: 0, harmful: 0 };
	for (const i of dataset.issues) tiers[i.tier] += 1;
	process.stdout.write(`version ${dataset.version} — ${dataset.issues.length} active (${tiers.blocking} blocking, ${tiers.harmful} harmful), ${dataset.rejected.length} rejected, ${dataset.sourceReports}/${dataset.candidateTotal} source reports in accepted records\n`);
	const unresolved = dataset.issues.filter((i) => i.consensus === "unresolved");
	for (const i of unresolved) process.stdout.write(`UNRESOLVED ${i.id} [${i.tier}]: ${i.dissent}\n`);
}
