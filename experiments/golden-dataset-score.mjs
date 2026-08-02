#!/usr/bin/env node
/**
 * Score observer arms against the frozen golden dataset — the REGRESSION mode
 * of `GOLDEN-DATASET-DESIGN.md`: deterministic, no judge calls, no spend.
 *
 * Arm membership is not re-derived here. It comes from the v2 probe's frozen
 * claim chain (candidate -> claims[].note -> pool[].arm), which is the only
 * place a delivered message was read and attributed. Re-deriving it by
 * keyword-matching statements against messages is exactly the mistake commit
 * 96eff06 retracted: the matcher credited an arm for saying "renewLease" while
 * describing a different bug, and credited another for the word "requeues"
 * inside a sentence about the sweep.
 *
 * Consequence worth stating plainly in any output: a golden issue is scored as
 * "found" only if it contains an OBSERVER report. Issues discovered solely by
 * the reference review, the code review or planting were, by construction, not
 * surfaced by any arm — they are the reference set's whole point, and they make
 * every arm's recall lower and more honest than a pool seeded from arms alone.
 */

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { argOf } from "./lib.mjs";

/**
 * Every frozen observer pool, with the id namespace its candidates carry in
 * golden-dataset members: v1's C2 scheduler pool is unprefixed (O-g08 ->
 * "g08"), the cross-task pools are namespaced (O-XE-g01 -> "XE-g01",
 * O-XD-g01 -> "XD-g01") — added for v2, whose records carry cross-task
 * observer members that the C2-only map silently failed to credit.
 */
const OBSERVER_POOLS = [
	{ path: "experiments/artifacts/2026-08-01-severity-probe-v2/out.json.gz", prefix: "" },
	{ path: "experiments/artifacts/2026-08-02-cross-task-trajectory/severity-exporter.json.gz", prefix: "XE-" },
	{ path: "experiments/artifacts/2026-08-02-cross-task-trajectory/severity-dispatcher.json.gz", prefix: "XD-" },
];

/** candidate id (g01, s01, XE-g01, ...) -> the arms whose messages produced its claims. */
export function armsByObserverCandidate(pools = OBSERVER_POOLS) {
	const out = {};
	for (const { path, prefix } of pools) {
		const pool = JSON.parse(gunzipSync(readFileSync(path)).toString());
		const noteArm = Object.fromEntries(pool.pool.map((message) => [message.id, message.arm]));
		const claimNote = Object.fromEntries(pool.claims.map((claim) => [claim.id, claim.note]));
		for (const candidate of pool.candidates) {
			const key = `${prefix}${candidate.id}`;
			if (out[key]) throw new Error(`observer candidate id collision across pools: ${key}`);
			out[key] = new Set((candidate.members ?? []).map((m) => noteArm[claimNote[m]]).filter(Boolean));
		}
	}
	return out;
}

export function scoreArms(dataset, armsByCandidate, arms) {
	const active = dataset.issues.filter((issue) => issue.status === "active");
	const finders = (issue) => {
		const found = new Set();
		for (const member of issue.members ?? []) {
			if (!member.startsWith("O-")) continue;
			for (const arm of armsByCandidate[member.slice(2)] ?? []) found.add(arm);
		}
		return found;
	};
	const rows = active.map((issue) => ({ issue, found: finders(issue) }));
	const tiers = ["blocking", "harmful"];
	const table = {};
	for (const arm of arms) {
		table[arm] = {};
		for (const tier of tiers) {
			const inTier = rows.filter((r) => r.issue.tier === tier);
			table[arm][tier] = { found: inTier.filter((r) => r.found.has(arm)).length, total: inTier.length };
		}
	}
	const unfound = rows.filter((r) => r.found.size === 0);
	return { table, rows, unfound };
}

function main() {
	const args = process.argv.slice(2);
	const datasetPath = argOf(args, "--dataset", "experiments/golden-dataset.json");
	const arms = argOf(args, "--arms", "MAIN,F,F2").split(",").filter(Boolean);
	const dataset = JSON.parse(readFileSync(datasetPath, "utf8"));
	const { table, rows, unfound } = scoreArms(dataset, armsByObserverCandidate(), arms);

	const active = rows.length;
	process.stdout.write(`golden set ${dataset.version} — ${active} active issues (${rows.filter((r) => r.issue.tier === "blocking").length} blocking)\n\n`);
	process.stdout.write(`arm    blocking      harmful\n`);
	for (const arm of arms) {
		const b = table[arm].blocking;
		const h = table[arm].harmful;
		process.stdout.write(
			`${arm.padEnd(6)} ${String(b.found + "/" + b.total).padStart(6)} ${((b.found / (b.total || 1)) * 100).toFixed(0).padStart(4)}%  ` +
			`${String(h.found + "/" + h.total).padStart(6)} ${((h.found / (h.total || 1)) * 100).toFixed(0).padStart(4)}%\n`,
		);
	}
	process.stdout.write(`\nfound by NO arm: ${unfound.length}/${active} (${unfound.filter((r) => r.issue.tier === "blocking").length} of them blocking)\n`);
	for (const row of unfound.filter((r) => r.issue.tier === "blocking")) {
		process.stdout.write(`  ${row.issue.id} [${row.issue.provenance.join("+")}] ${row.issue.statement.slice(0, 92)}\n`);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
