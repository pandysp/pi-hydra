#!/usr/bin/env node
/** Validate two capstone judge columns and render a neutral analyst work packet. */

import { readFileSync, writeFileSync } from "node:fs";
import { argOf } from "./lib.mjs";

const COMPLETE = new Set(["complete", "complete-with-unjudgeable"]);
const JUDGE_METADATA = new Set(["judge", "judgeModel", "judgeTransport"]);
const FINDING_IDENTITY = [
	"sourceKey",
	"runId",
	"pointKey",
	"pointId",
	"task",
	"config",
	"arm",
	"findingIndex",
	"message",
	"capturedPayloadHash",
	"capturedPayloadFile",
	"pointKind",
	"requestIndex",
	"runIndex",
	"qualitySourceValidity",
	"promptHash",
];

function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, item]) => [key, canonical(item)]),
		);
	}
	return value;
}

const stable = (value) => JSON.stringify(canonical(value));
const sortedKeys = (value) => Object.keys(value ?? {}).sort();

function basisOf(metadata) {
	return Object.fromEntries(Object.entries(metadata ?? {}).filter(([key]) => !JUDGE_METADATA.has(key)));
}

function identityOf(judgment) {
	return Object.fromEntries(FINDING_IDENTITY.map((key) => [key, judgment?.[key]]));
}

function claimRows(sourceKey, judge, claims) {
	if (!Array.isArray(claims)) throw new Error(`${judge} ${sourceKey}: claims must be an array`);
	return claims.map((claim, claimIndex) => ({
		claimRef: `${sourceKey}#${judge}:c${claimIndex}`,
		claimIndex,
		...claim,
	}));
}

function validateState(state, judge) {
	if (!COMPLETE.has(state?.status)) throw new Error(`${judge} checkpoint is not complete`);
	if (state?.metadata?.judge !== judge) throw new Error(`expected ${judge} checkpoint, got ${state?.metadata?.judge ?? "none"}`);
	for (const [key, judgment] of Object.entries(state.judgments ?? {})) {
		if (judgment?.sourceKey !== key) throw new Error(`${judge} judgment key disagrees with sourceKey: ${key}`);
	}
}

export function buildCapstoneConsensusPacket(sol, opus) {
	validateState(sol, "sol");
	validateState(opus, "opus");
	const basis = basisOf(sol.metadata);
	if (stable(basis) !== stable(basisOf(opus.metadata))) {
		throw new Error("judge input metadata differs; do not combine non-identical questions");
	}

	const solKeys = sortedKeys(sol.judgments);
	const opusKeys = sortedKeys(opus.judgments);
	if (stable(solKeys) !== stable(opusKeys)) {
		throw new Error("judgment source keys differ; both judges must answer the same findings");
	}

	const solUnjudgeable = Object.fromEntries(sortedKeys(sol.unjudgeable).map((key) => [key, sol.unjudgeable[key]]));
	const opusUnjudgeable = Object.fromEntries(sortedKeys(opus.unjudgeable).map((key) => [key, opus.unjudgeable[key]]));
	if (stable(solUnjudgeable) !== stable(opusUnjudgeable)) {
		throw new Error("unjudgeable records differ; evidence holes must be identical across judges");
	}

	const findings = solKeys.map((sourceKey) => {
		const solJudgment = sol.judgments[sourceKey];
		const opusJudgment = opus.judgments[sourceKey];
		const identity = identityOf(solJudgment);
		if (stable(identity) !== stable(identityOf(opusJudgment))) {
			throw new Error(`${sourceKey}: finding identity differs between judges`);
		}
		return {
			...identity,
			solClaims: claimRows(sourceKey, "sol", solJudgment.claims),
			opusClaims: claimRows(sourceKey, "opus", opusJudgment.claims),
		};
	});

	return {
		schemaVersion: 1,
		status: "awaiting-analyst",
		basis,
		counts: {
			findings: findings.length,
			solClaims: findings.reduce((sum, finding) => sum + finding.solClaims.length, 0),
			opusClaims: findings.reduce((sum, finding) => sum + finding.opusClaims.length, 0),
			unjudgeable: Object.keys(solUnjudgeable).length,
		},
		instructions: [
			"Read every original finding, both claim lists, and both raw judge responses before grouping.",
			"Group claims by the same underlying wrong behavior; do not infer agreement from wording or counts.",
			"Only a defect supported by both judges can count as real or cover a catalog issue.",
			"Preserve disagreement and route genuinely new issues through dataset promotion before rescoring.",
		],
		findings,
		unjudgeable: solUnjudgeable,
	};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2);
	const solPath = argOf(args, "--sol", "");
	const opusPath = argOf(args, "--opus", "");
	const outputPath = argOf(args, "--output", "");
	if (!solPath || !opusPath) throw new Error("--sol and --opus are required");
	const packet = buildCapstoneConsensusPacket(
		JSON.parse(readFileSync(solPath, "utf8")),
		JSON.parse(readFileSync(opusPath, "utf8")),
	);
	const body = `${JSON.stringify(packet, null, 2)}\n`;
	if (outputPath) writeFileSync(outputPath, body);
	else process.stdout.write(body);
}
