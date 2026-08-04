#!/usr/bin/env node
/**
 * A4 (ITERATION1-DATA-PASS): put the old trajectory input on the same
 * eligibility basis as the fresh capstone input — semantic-v2 — and stage
 * exactly what a unified re-judging must cover. Zero provider calls; this
 * script only measures and stages.
 *
 * The two twelves, kept distinct on purpose:
 *  - 12 strict-v1 findings sit at each cell's FINAL run-end point; their
 *    final-assistant evidence is unrecoverable by construction
 *    (`recoverRunEndAssistant` refuses the last run) and both judges
 *    already recorded them unjudgeable. Re-adaptation does not resurrect
 *    them.
 *  - 12 findings are cache-only-invalid rows that strict-v1 excluded and
 *    semantic-v2 admits; these are the actual re-judging delta.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { argOf } from "./lib.mjs";
import { buildFindingItems } from "./capstone-trajectory-judge-protocol.mjs";

const OLD_ROWS = "experiments/artifacts/2026-08-02-openai-trajectory/rows.jsonl.gz";
const OLD_PACKET = "experiments/artifacts/2026-08-04-capstone-consensus/old-packet.json.gz";

export function realignOldInput() {
	const rows = gunzipSync(readFileSync(OLD_ROWS)).toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
	const strict = buildFindingItems(rows, { eligibilityPolicy: "strict-v1" });
	const semantic = buildFindingItems(rows, { eligibilityPolicy: "semantic-v2" });
	const packet = JSON.parse(gunzipSync(readFileSync(OLD_PACKET)).toString("utf8"));
	const packetKeys = new Set(packet.findings.map((finding) => finding.sourceKey));
	// `unjudgeable` is an object keyed by sourceKey in the frozen packet.
	const unjudgeableKeys = new Set(Array.isArray(packet.unjudgeable)
		? packet.unjudgeable.map((entry) => entry.sourceKey ?? entry)
		: Object.keys(packet.unjudgeable ?? {}));

	const strictKeys = new Set(strict.map((item) => item.sourceKey));
	const missingFromPacket = strict.filter((item) => !packetKeys.has(item.sourceKey));
	const cacheOnlyDelta = semantic.filter((item) => !strictKeys.has(item.sourceKey));

	return {
		counts: {
			strict: strict.length,
			semantic: semantic.length,
			packetJudged: packet.findings.length,
			packetUnjudgeable: unjudgeableKeys.size,
			missingFromPacket: missingFromPacket.length,
			cacheOnlyDelta: cacheOnlyDelta.length,
		},
		missingFromPacket,
		missingAllRecordedUnjudgeable:
			unjudgeableKeys.size > 0 && missingFromPacket.every((item) => unjudgeableKeys.has(item.sourceKey)),
		cacheOnlyDelta,
	};
}

function main() {
	const out = argOf(process.argv.slice(2), "--output", "");
	if (!out) throw new Error("--output is required");
	const result = realignOldInput();
	if (result.counts.strict !== 119) throw new Error(`strict-v1 reconstructs ${result.counts.strict}, expected 119`);
	if (result.counts.semantic !== 131) throw new Error(`semantic-v2 reconstructs ${result.counts.semantic}, expected 131`);
	if (result.counts.packetJudged !== 107) throw new Error(`old packet holds ${result.counts.packetJudged}, expected 107`);
	mkdirSync(out, { recursive: true });
	writeFileSync(join(out, "realign-summary.json"), `${JSON.stringify(result.counts, null, 1)}\n`);
	writeFileSync(join(out, "rejudge-points.json"), `${JSON.stringify(result.cacheOnlyDelta.map((item) => item.sourceKey).sort(), null, 1)}\n`);
	writeFileSync(join(out, "unjudgeable-unchanged.json"), `${JSON.stringify(result.missingFromPacket.map((item) => item.sourceKey).sort(), null, 1)}\n`);
	console.log(JSON.stringify(result.counts));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
