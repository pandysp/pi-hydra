#!/usr/bin/env node
/**
 * Deterministic sample for the judge transport A/B
 * (JUDGE-TRANSPORT-AB-SPEC.md): stratify observation points by task × config,
 * rank by content hash, take whole points until every stratum holds at least
 * MIN_FINDINGS_PER_STRATUM findings. Same manifest for every pass and shard.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { gunzipSync } from "node:zlib";
import { argOf } from "./lib.mjs";
import { sha256Hex } from "./fingerprints.mjs";
import { buildFindingItems } from "./capstone-trajectory-judge-protocol.mjs";

export const SEED_RULE = "judge-transport-ab-v1";
export const MIN_FINDINGS_PER_STRATUM = 7;

export function buildSampleManifest(rows, rowsSha256, { minFindingsPerStratum = MIN_FINDINGS_PER_STRATUM } = {}) {
	const items = buildFindingItems(rows, { eligibilityPolicy: "semantic-v2" });
	const points = new Map();
	for (const item of items) {
		if (!points.has(item.pointKey)) {
			points.set(item.pointKey, { pointKey: item.pointKey, stratum: `${item.task}/${item.config}`, findings: 0 });
		}
		const point = points.get(item.pointKey);
		if (point.stratum !== `${item.task}/${item.config}`) throw new Error(`${item.pointKey}: stratum drift within one point`);
		point.findings += 1;
	}
	const strata = new Map();
	for (const point of points.values()) {
		if (!strata.has(point.stratum)) strata.set(point.stratum, []);
		strata.get(point.stratum).push(point);
	}
	const sampled = [];
	const strataCounts = {};
	for (const [stratum, stratumPoints] of [...strata.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		const ranked = stratumPoints
			.map((point) => ({ ...point, rank: sha256Hex(`${SEED_RULE}:${rowsSha256}:${point.pointKey}`) }))
			.sort((a, b) => a.rank.localeCompare(b.rank));
		let findings = 0;
		for (const point of ranked) {
			if (findings >= minFindingsPerStratum) break;
			sampled.push(point.pointKey);
			findings += point.findings;
		}
		if (findings < minFindingsPerStratum) throw new Error(`${stratum}: only ${findings} findings available, needs ${minFindingsPerStratum}`);
		strataCounts[stratum] = { points: sampled.filter((key) => points.get(key).stratum === stratum).length, findings };
	}
	sampled.sort((a, b) => a.localeCompare(b));
	const totalFindings = sampled.reduce((sum, key) => sum + points.get(key).findings, 0);
	return {
		seedRule: SEED_RULE,
		rowsSha256,
		minFindingsPerStratum,
		strata: strataCounts,
		points: sampled,
		totalFindings,
		manifestSha256: sha256Hex(JSON.stringify(sampled)),
	};
}

export function shardPoints(points, shards) {
	if (!Number.isInteger(shards) || shards < 1 || shards > 3) throw new Error("shards must be 1..3 (registered ceiling)");
	const out = Array.from({ length: shards }, () => []);
	points.forEach((pointKey, index) => out[index % shards].push(pointKey));
	return out;
}

async function main() {
	const args = process.argv.slice(2);
	const rowsPath = argOf(args, "--rows-gz", "");
	const outputPrefix = argOf(args, "--output-prefix", "");
	const shards = Number.parseInt(argOf(args, "--shards", "3"), 10);
	if (!rowsPath || !outputPrefix) throw new Error("--rows-gz and --output-prefix are required");
	const rowsBytes = readFileSync(rowsPath);
	const rows = gunzipSync(rowsBytes).toString().trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const manifest = buildSampleManifest(rows, sha256Hex(rowsBytes));
	manifest.rowsFile = basename(rowsPath);
	writeFileSync(`${outputPrefix}-manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
	writeFileSync(`${outputPrefix}-points.json`, `${JSON.stringify(manifest.points, null, 1)}\n`);
	for (const [index, shard] of shardPoints(manifest.points, shards).entries()) {
		writeFileSync(`${outputPrefix}-shard-${index}.json`, `${JSON.stringify(shard, null, 1)}\n`);
	}
	console.log(`${manifest.points.length} points / ${manifest.totalFindings} findings sampled (manifest ${manifest.manifestSha256.slice(0, 16)})`);
	for (const [stratum, counts] of Object.entries(manifest.strata)) console.log(`  ${stratum}: ${counts.points} points, ${counts.findings} findings`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
