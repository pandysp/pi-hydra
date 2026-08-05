#!/usr/bin/env node
/**
 * Per-arm summary of an OpenAI trajectory run, answering N1/N2/N4 from
 * `ENUM-GENERALISATION-SPEC.md`.
 *
 * Deliberately separate from `summarize-trajectory-cost.mjs`: that summarizer
 * carries Anthropic's M-write composition and its cache gates, which do not
 * apply here (`trajectory-openai.mjs` explains why). Mixing the two would
 * report OpenAI numbers under Anthropic accounting.
 *
 * Usage: node experiments/attic/analyse-openai-trajectory.mjs --rows rows.jsonl
 */

import { readFileSync } from "node:fs";
import { argOf } from "../lib.mjs";
import { findingCount } from "./enum-plus-adapt.mjs";

const round = (value, digits = 1) => (value === null ? null : Number(value.toFixed(digits)));
const mean = (values) => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);

export function summariseCell(rows) {
	const driver = rows.filter((row) => row.kind === "driver-turn" && !row.error);
	const observations = rows.filter((row) => row.kind === "observation");
	const valid = observations.filter((row) => !row.error && row.valid !== false);
	const driverCost = driver.reduce((sum, row) => sum + (row.costTotal ?? 0), 0);

	const arms = [...new Set(observations.map((row) => row.arm))].sort();
	const perArm = arms.map((arm) => {
		const all = observations.filter((row) => row.arm === arm);
		const ok = valid.filter((row) => row.arm === arm);
		const delivered = ok.filter((row) => row.delivery && row.delivery !== "none");
		const reasoning = ok.map((row) => row.reasoning ?? 0);
		const observerCost = ok.reduce((sum, row) => sum + (row.composedCost ?? 0), 0);
		// findings/message is the N4 gate: an ENUM at ~1.00 is not following its
		// contract, and its cost number would then be measuring a different arm.
		const findings = delivered.map((row) => findingCount(row.rawResponseText ?? row.responseText));
		return {
			arm,
			observations: all.length,
			valid: ok.length,
			invalid: all.length - ok.length,
			delivered: delivered.length,
			formatValid: ok.filter((row) => row.formatValid === true).length,
			formatInvalid: ok.filter((row) => row.formatValid === false).length,
			skipRate: `${reasoning.filter((value) => value === 0).length}/${reasoning.length}`,
			meanThinking: round(mean(reasoning) ?? 0, 0),
			rawThinking: reasoning,
			meanOutput: round(mean(ok.map((row) => row.output ?? 0)) ?? 0, 0),
			findingsPerMessage: round(mean(findings) ?? 0, 2),
			observerCost: round(observerCost, 4),
			ratio: driverCost > 0 ? round((observerCost / driverCost) * 100, 1) : null,
			meanHitRatio: round(mean(ok.map((row) => row.hitRatio ?? 0)) ?? 0, 1),
		};
	});
	return { driverTurns: driver.length, driverCost: round(driverCost, 4), points: new Set(observations.map((r) => r.pointId)).size, perArm };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const rows = readFileSync(argOf(process.argv.slice(2), "--rows", ""), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const configs = [...new Set(rows.map((row) => row.config))].filter(Boolean);
	for (const config of configs) {
		const cell = summariseCell(rows.filter((row) => row.config === config));
		console.log(`\n## ${config} — driver $${cell.driverCost} over ${cell.driverTurns} turns, ${cell.points} points`);
		console.log("arm    ratio   obs$      deliv  skip     think  output  find/msg  fmtOK  fmtBAD  hit%");
		for (const a of cell.perArm) {
			console.log(
				`${a.arm.padEnd(6)} ${String(a.ratio ?? "—").padStart(5)}%  $${String(a.observerCost).padEnd(8)} ` +
					`${String(a.delivered).padStart(5)}  ${a.skipRate.padStart(6)}  ${String(a.meanThinking).padStart(5)}  ` +
					`${String(a.meanOutput).padStart(6)}  ${String(a.findingsPerMessage).padStart(8)}  ` +
					`${String(a.formatValid).padStart(5)}  ${String(a.formatInvalid).padStart(6)}  ${String(a.meanHitRatio).padStart(5)}`,
			);
		}
		for (const a of cell.perArm) console.log(`  ${a.arm} raw thinking: ${a.rawThinking.join(" ")}`);
	}
}
