#!/usr/bin/env node
/** Deterministic identity of the frozen inputs and definitions for expanded 2Q. */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { argOf } from "./lib.mjs";

export const EXPANDED_2Q_INPUTS = [
	// package-lock.json carries the dependency-resolution identity; package.json
	// scripts do not and its edits kept forcing regens, so it is not hashed.
	"package-lock.json",
	"experiments/artifacts/2026-08-01-trajectory-pilot/payloads.tar.gz",
	"experiments/artifacts/2026-08-03-openai-capstone-producer/rows.jsonl.gz",
	"experiments/artifacts/2026-08-03-openai-capstone-producer/payloads.tar.gz",
	"experiments/golden-dataset.json",
	"experiments/false-positive-catalog.json",
	"experiments/JUDGE-TRANSPORT-AB-SAMPLE.json",
	// Prose specs are deliberately NOT hashed: status edits must never change
	// the frozen-input identity. Data and code inputs only.
	"experiments/lib.mjs",
	"experiments/fingerprints.mjs",
	"experiments/model-catalog.mjs",
	"experiments/model-catalog-snapshot.json",
	"experiments/delivery-context-judge-protocol.mjs",
	"experiments/capstone-trajectory-judge-protocol.mjs",
	"experiments/expanded-2q-input-manifest.mjs",
	"experiments/dual-catalog.mjs",
	"experiments/dual-catalog.check.mjs",
	"experiments/dual-catalog-judge-protocol.mjs",
	"experiments/pi-replay-judge-transport.mjs",
	"experiments/dual-catalog-judge.mjs",
	"experiments/dual-catalog-reconcile.mjs",
	"experiments/dual-catalog-growth.mjs",
	"experiments/dual-catalog-score.mjs",
	"experiments/dual-catalog-audit.mjs",
	"experiments/judge-transport-ab-sample.mjs",
];

export const EXPANDED_2Q_CARRIER_SHAPES = Object.freeze([
	{
		judge: "opus",
		archive: "experiments/artifacts/2026-08-01-trajectory-pilot/payloads.tar.gz",
		member: "payloads/scheduler-opus-high-a1-r1-q5.json",
	},
	{
		judge: "sol",
		archive: "experiments/artifacts/2026-08-03-openai-capstone-producer/payloads.tar.gz",
		member: "payloads/dispatcher-sol-high-a1-r0-q4.json",
	},
]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fileIdentity(path) {
	const bytes = readFileSync(path);
	return { path, bytes: statSync(path).size, sha256: sha256(bytes) };
}

function carrierIdentity(shape) {
	const bytes = execFileSync("tar", ["-xOf", shape.archive, shape.member]);
	JSON.parse(bytes.toString());
	return { ...shape, bytes: bytes.length, sha256: sha256(bytes) };
}

export function buildExpanded2QInputManifest() {
	const sample = JSON.parse(readFileSync("experiments/JUDGE-TRANSPORT-AB-SAMPLE.json", "utf8"));
	return {
		schemaVersion: 1,
		protocol: "expanded-2q-findings-v1",
		status: "frozen inputs; full judgment ledger pending",
		sample: {
			path: "experiments/JUDGE-TRANSPORT-AB-SAMPLE.json",
			manifestSha256: sample.manifestSha256,
			points: sample.points.length,
			findings: sample.totalFindings,
			strata: Object.keys(sample.strata).length,
		},
		carrierShapes: EXPANDED_2Q_CARRIER_SHAPES.map(carrierIdentity),
		files: [...EXPANDED_2Q_INPUTS].sort().map(fileIdentity),
	};
}

export function renderExpanded2QInputManifest() {
	return `${JSON.stringify(buildExpanded2QInputManifest(), null, 2)}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const output = argOf(process.argv.slice(2), "--output", "");
	const rendered = renderExpanded2QInputManifest();
	if (output) writeFileSync(output, rendered);
	else process.stdout.write(rendered);
}
