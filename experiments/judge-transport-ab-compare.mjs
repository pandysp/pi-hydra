#!/usr/bin/env node
/**
 * Merge sharded pass outputs and compare passes for the judge transport A/B
 * (JUDGE-TRANSPORT-AB-SPEC.md). Finding-level metrics only; claim splitting
 * is judge-side and may legitimately differ between passes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { argOf } from "./lib.mjs";

const SHARD_IDENTITY_FIELDS = new Set(["pointsFile", "pointsSha256"]);

export function mergePassOutputs(states) {
	if (states.length === 0) throw new Error("no shard outputs to merge");
	const stripped = (metadata) => Object.fromEntries(Object.entries(metadata).filter(([key]) => !SHARD_IDENTITY_FIELDS.has(key)));
	const base = stripped(states[0].metadata);
	const merged = { metadata: base, status: "complete", judgments: {}, unjudgeable: {}, batches: [], failures: [] };
	for (const state of states) {
		if (JSON.stringify(stripped(state.metadata)) !== JSON.stringify(base)) {
			throw new Error("shard metadata differs beyond the points identity — refusing to merge different protocols");
		}
		if (state.failures.length > 0) throw new Error("shard carries failures; resolve before merging");
		if (state.status === "in-progress") throw new Error("shard is incomplete; finish it before merging");
		for (const [key, value] of Object.entries(state.judgments)) {
			if (merged.judgments[key]) throw new Error(`duplicate judgment across shards: ${key}`);
			merged.judgments[key] = value;
		}
		for (const [key, value] of Object.entries(state.unjudgeable ?? {})) {
			if (merged.unjudgeable[key]) throw new Error(`duplicate unjudgeable across shards: ${key}`);
			merged.unjudgeable[key] = value;
		}
		merged.batches.push(...state.batches);
	}
	merged.batches.sort((a, b) => a.pointKey.localeCompare(b.pointKey));
	if (Object.keys(merged.unjudgeable).length > 0) merged.status = "complete-with-unjudgeable";
	return merged;
}

export function findingSummary(judgment) {
	const claims = judgment.claims ?? [];
	return {
		claimCount: claims.length,
		anyCentralSupported: claims.some((claim) => claim.centralSupported === true),
		anyUnsupportedExtra: claims.some((claim) => claim.unsupportedExtra === true),
		matchedIssues: [...new Set(claims.flatMap((claim) => claim.matches.map((match) => match.issueId)))].sort(),
	};
}

const METRICS = Object.freeze(["anyCentralSupported", "anyUnsupportedExtra", "matchedIssues", "claimCount"]);

export function comparePasses(passX, passY, labelX, labelY) {
	const keysX = Object.keys(passX.judgments).sort();
	const keysY = Object.keys(passY.judgments).sort();
	if (JSON.stringify(keysX) !== JSON.stringify(keysY)) {
		throw new Error(`${labelX} vs ${labelY}: judged finding sets differ — passes must cover the identical sample`);
	}
	const result = { pair: `${labelX}-vs-${labelY}`, findings: keysX.length, discordant: {}, detail: {} };
	for (const metric of METRICS) {
		result.discordant[metric] = 0;
		result.detail[metric] = [];
	}
	for (const key of keysX) {
		const x = findingSummary(passX.judgments[key]);
		const y = findingSummary(passY.judgments[key]);
		for (const metric of METRICS) {
			const same = metric === "matchedIssues"
				? JSON.stringify(x[metric]) === JSON.stringify(y[metric])
				: x[metric] === y[metric];
			if (!same) {
				result.discordant[metric] += 1;
				result.detail[metric].push({ sourceKey: key, [labelX]: x[metric], [labelY]: y[metric] });
			}
		}
	}
	return result;
}

export function latencySummary(pass) {
	const values = pass.batches.map((batch) => batch.batchMs).sort((a, b) => a - b);
	if (values.length === 0) return null;
	const at = (quantile) => values[Math.min(values.length - 1, Math.floor(quantile * values.length))];
	return { batches: values.length, medianMs: at(0.5), p90Ms: at(0.9), maxMs: values[values.length - 1] };
}

function readPass(pathsCsv) {
	return mergePassOutputs(pathsCsv.split(",").map((path) => JSON.parse(readFileSync(path.trim(), "utf8"))));
}

async function main() {
	const args = process.argv.slice(2);
	const passA = readPass(argOf(args, "--pass-a", ""));
	// The A-repeat noise floor is optional: the operational re-scope compares
	// one pi pass against the production verdicts and escalates to a repeat
	// pass only if disagreement needs explaining.
	const passA2Arg = argOf(args, "--pass-a2", "");
	const passA2 = passA2Arg ? readPass(passA2Arg) : null;
	const passB = readPass(argOf(args, "--pass-b", ""));
	const outputPath = argOf(args, "--output", "");
	if (!outputPath) throw new Error("--output is required");
	const comparison = {
		floor: passA2 ? comparePasses(passA, passA2, "A", "A2") : null,
		aVsB: comparePasses(passA, passB, "A", "B"),
		a2VsB: passA2 ? comparePasses(passA2, passB, "A2", "B") : null,
		latency: { A: latencySummary(passA), A2: passA2 ? latencySummary(passA2) : null, B: latencySummary(passB) },
		recoveredBatches: {
			A: passA.batches.filter((batch) => batch.recovered).length,
			A2: passA2 ? passA2.batches.filter((batch) => batch.recovered).length : null,
			B: passB.batches.filter((batch) => batch.recovered).length,
		},
	};
	writeFileSync(outputPath, `${JSON.stringify(comparison, null, 2)}\n`);
	for (const pair of [comparison.floor, comparison.aVsB, comparison.a2VsB].filter(Boolean)) {
		console.log(`${pair.pair} over ${pair.findings} findings: ${METRICS.map((metric) => `${metric}=${pair.discordant[metric]}`).join(" ")}`);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
