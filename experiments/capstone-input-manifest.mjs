#!/usr/bin/env node
/**
 * Deterministic inventory of every frozen artifact and code definition needed
 * to re-score the trajectory program. The manifest intentionally includes the
 * provisional dataset today and must be regenerated after golden v2 freezes.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { argOf } from "./lib.mjs";

export const CAPSTONE_INPUTS = [
	"experiments/artifacts/2026-08-01-trajectory-pilot/payloads.tar.gz",
	"experiments/artifacts/2026-08-01-enum-trajectory/rows.jsonl.gz",
	"experiments/artifacts/2026-08-01-enum-trajectory/adapted.jsonl.gz",
	"experiments/artifacts/2026-08-01-enum-trajectory/confirmations.jsonl.gz",
	"experiments/artifacts/2026-08-01-enum-trajectory/severity.json.gz",
	"experiments/artifacts/2026-08-02-cross-task-trajectory/rows-exporter.jsonl.gz",
	"experiments/artifacts/2026-08-02-cross-task-trajectory/rows-dispatcher.jsonl.gz",
	"experiments/artifacts/2026-08-02-cross-task-trajectory/adapted-exporter.jsonl.gz",
	"experiments/artifacts/2026-08-02-cross-task-trajectory/adapted-dispatcher.jsonl.gz",
	"experiments/artifacts/2026-08-02-cross-task-trajectory/confirmations-exporter.jsonl.gz",
	"experiments/artifacts/2026-08-02-cross-task-trajectory/confirmations-dispatcher.jsonl.gz",
	"experiments/artifacts/2026-08-02-cross-task-trajectory/severity-exporter.json.gz",
	"experiments/artifacts/2026-08-02-cross-task-trajectory/severity-dispatcher.json.gz",
	"experiments/artifacts/2026-08-02-cross-task-trajectory/payloads-2026-08-01.tar.gz",
	"experiments/artifacts/2026-08-02-cross-task-trajectory/payloads-dispatcher-2026-08-02.tar.gz",
	"experiments/artifacts/2026-08-02-openai-trajectory/rows.jsonl.gz",
	"experiments/artifacts/2026-08-02-openai-trajectory/payloads.tar.gz",
	"experiments/artifacts/2026-08-02-openai-trajectory/judge-sol.json.gz",
	"experiments/artifacts/2026-08-03-openai-capstone-producer/rows.jsonl.gz",
	"experiments/artifacts/2026-08-03-openai-capstone-producer/payloads.tar.gz",
	"experiments/artifacts/2026-08-03-openai-capstone-judge-basis/basis.json.gz",
	"experiments/artifacts/2026-08-03-openai-capstone-judge-basis/golden-dataset.json.gz",
	"experiments/artifacts/2026-08-03-openai-capstone-sol/judge-sol.json.gz",
	"experiments/artifacts/2026-08-03-openai-capstone-sol/judgments-sol.jsonl.gz",
	"experiments/artifacts/2026-08-03-openai-capstone-sol/summary.json.gz",
	"experiments/trajectory-cost-tasks.mjs",
	"experiments/trajectory-ground-truth.mjs",
	"experiments/golden-dataset-score.mjs",
	"experiments/BENCHMARK-SPEC.md",
	"experiments/CAPSTONE-JUDGE-SPEC.md",
	"experiments/OPENAI-TRAJECTORY-SOL-PASS.md",
	"experiments/OPENAI-CAPSTONE-PRODUCER-SPEC.md",
	"experiments/OPENAI-CAPSTONE-PRODUCER-RESULTS.md",
	"experiments/OPENAI-CAPSTONE-COMPARISON.json",
	"experiments/capstone-trajectory-judge-protocol.mjs",
	"experiments/capstone-trajectory-judge.mjs",
	"experiments/capstone-consensus-packet.mjs",
	"experiments/openai-capstone-results.mjs",
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function buildCapstoneInputManifest(datasetPath = "experiments/golden-dataset.json") {
	const datasetBytes = readFileSync(datasetPath);
	const dataset = JSON.parse(datasetBytes.toString("utf8"));
	const active = dataset.issues.filter((issue) => issue.status === "active");
	return {
		schemaVersion: 1,
		status: dataset.provisional
			? "provisional-v2; regenerate after consensus and freeze"
			: "valid-v2; freeze identity verified separately",
		dataset: {
			path: datasetPath,
			version: dataset.version,
			sha256: sha256(datasetBytes),
			active: active.length,
			blocking: active.filter((issue) => issue.tier === "blocking").length,
		},
		files: [...CAPSTONE_INPUTS].sort().map((path) => {
			const bytes = readFileSync(path);
			return { path, bytes: statSync(path).size, sha256: sha256(bytes) };
		}),
	};
}

export function renderCapstoneInputManifest(datasetPath) {
	return `${JSON.stringify(buildCapstoneInputManifest(datasetPath), null, 2)}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2);
	const output = argOf(args, "--output", "");
	const rendered = renderCapstoneInputManifest(argOf(args, "--dataset", "experiments/golden-dataset.json"));
	if (output) writeFileSync(output, rendered);
	else process.stdout.write(rendered);
}
