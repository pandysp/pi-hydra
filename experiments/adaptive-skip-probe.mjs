#!/usr/bin/env node
/**
 * Adaptive-thinking skip probe (`ADAPTIVE-SKIP-SPEC.md`).
 *
 * The phenomenon: on recorded driver prefixes, main's shipped contract emits
 * ZERO reasoning tokens on most observations while the envelope arms think on
 * nearly all of them. pi-ai sends `thinking: {type:"adaptive"}` with no budget
 * for claude-opus-5 (`anthropic-messages.js:753-768`), so the model itself
 * decides whether to think. This probe measures WHICH CONTRACT TEXT flips that
 * decision.
 *
 * Difference from `recorded-payload-cost.mjs`: that instrument replays REGISTERED
 * ARMS. This one replays ARBITRARY PROMPT STRINGS, so a contract variant needs no
 * registry entry, no builder and no test-suite churn — which is what makes a
 * six-way bisection between two contracts affordable to run and cheap to throw
 * away. Everything else is deliberately identical: the same
 * `mergeObservationPayload` production path, the same captured payloads, the same
 * `[prompt]` piggyback tail, so a row here is comparable to a row there.
 *
 * REPORT THE WHOLE DISTRIBUTION per cell: mean, median, skip rate (share at
 * reasoning === 0) AND the raw per-observation values. Skip rate is an
 * additional metric, not the primary one — calling it primary would presume the
 * bimodal reading that this study is testing (spec Rules, corrected before
 * data). The mean did hide the effect twice, so it never travels alone; which
 * metric carries the story is a finding.
 *
 * Cost note, inherited from the C1 instrument: a recorded payload's cache entry
 * is long expired, so the first call at a point pays cache write and later calls
 * read it. Consecutive points from one trajectory are largely nested, so writes
 * amortize across a sweep. Reasoning tokens — the metric — are unaffected.
 *
 * Usage:
 *   node experiments/adaptive-skip-probe.mjs --rows <pilot rows.jsonl> \
 *     --variants variants.json --output rows.jsonl --config opus-high \
 *     --samples 2 [--points all|piggyback] [--point-ids a,b,c] [--nonce]
 *
 * `variants.json` is `{ "<variantId>": "<full prompt string>", ... }`.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { mergeObservationPayload, parseDecision } from "../utils.ts";
import { parseFooterDecision } from "./frozen-footer-protocol.mjs";
import { argOf } from "./lib.mjs";
import { flatUsage, pricesFor, rawCost } from "./costing.mjs";
import { resolveModel } from "./model-catalog.mjs";
import { gitProvenance, sha16 } from "./fingerprints.mjs";

export const MODEL_SPECS = {
	"opus-high": { provider: "anthropic", id: "claude-opus-5", reasoning: "high" },
	"opus-xhigh": { provider: "anthropic", id: "claude-opus-5", reasoning: "xhigh" },
	"opus-medium": { provider: "anthropic", id: "claude-opus-5", reasoning: "medium" },
};

function textOf(message) {
	return (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
}

export function shuffled(values, random = Math.random) {
	const out = [...values];
	for (let index = out.length - 1; index > 0; index -= 1) {
		const swap = Math.floor(random() * (index + 1));
		[out[index], out[swap]] = [out[swap], out[index]];
	}
	return out;
}

/**
 * Observation points of a frozen trajectory run. `pointKinds: "all"` includes
 * run-end payloads: they are distinct captured driver requests, and this probe
 * merges the same `[prompt]` tail into every one of them, so all points are
 * comparable to each other regardless of what production would have appended.
 */
export function pointsFrom(rows, { pointKinds = "piggyback", pointIds = null } = {}) {
	const seen = new Map();
	for (const row of rows) {
		if (row.kind !== "observation") continue;
		if (pointKinds !== "all" && row.pointKind !== pointKinds) continue;
		if (pointIds && !pointIds.includes(row.pointId)) continue;
		if (seen.has(row.pointId)) continue;
		seen.set(row.pointId, {
			pointId: row.pointId,
			pointIndex: row.pointIndex,
			pointKind: row.pointKind,
			prefixTokens: row.prefixTokens,
			capturedPayloadPath: row.capturedPayloadPath,
			capturedPayloadHash: row.capturedPayloadHash,
		});
	}
	return [...seen.values()].sort((a, b) => a.pointIndex - b.pointIndex);
}

export function loadPayload(point) {
	if (!existsSync(point.capturedPayloadPath)) {
		throw new Error(`recorded payload missing: ${point.capturedPayloadPath}`);
	}
	return JSON.parse(readFileSync(point.capturedPayloadPath, "utf8"));
}

/**
 * Q5 needs the routed delivery beside the reasoning count, and the variants
 * deliberately mix grammars (MAIN-family answers in JSON, F2-family with a
 * DELIVERY footer). Try both parsers and normalise: main's `noop` and the
 * footer's `none` are the same routing decision under two names.
 */
export function deliveryOf(text) {
	if (typeof text !== "string" || text.trim() === "") return null;
	// The two parsers differ in shape: the footer one returns {decision, error},
	// the JSON one returns the decision or null.
	const footer = parseFooterDecision(text)?.decision ?? null;
	const action = footer?.action ?? parseDecision(text)?.action ?? null;
	if (!action) return null;
	return action === "noop" ? "none" : action;
}

/** The row a probe call produces. Exported so the check can assert its shape. */
export function buildRow({ header, point, variantId, prompt, sample, usage, response, error, ms, prices, nonce }) {
	const reasoning = usage?.reasoning ?? 0;
	const responseText = response ? textOf(response) : null;
	return {
		...header,
		kind: "skip-probe",
		variantId,
		promptHash: sha16(prompt),
		promptChars: prompt.length,
		pointId: point.pointId,
		pointIndex: point.pointIndex,
		pointKind: point.pointKind,
		prefixTokens: point.prefixTokens,
		capturedPayloadHash: point.capturedPayloadHash,
		sample,
		nonce: nonce ?? null,
		input: usage?.input ?? null,
		output: usage?.output ?? null,
		reasoning: usage ? reasoning : null,
		cacheRead: usage?.cacheRead ?? null,
		cacheWrite: usage?.cacheWrite ?? null,
		cost: usage ? rawCost(usage, prices) : null,
		// `null` on an errored call so a failure never counts as a skip.
		thinkingSkipped: usage ? reasoning === 0 : null,
		// Q5: the routed decision, so skipping can be cross-tabulated against it.
		delivery: deliveryOf(responseText),
		responseText,
		stopReason: response?.stopReason ?? null,
		error,
		ms,
		ts: Date.now(),
	};
}

export async function probe({
	rows,
	variants,
	config,
	output,
	samples = 1,
	pointKinds = "piggyback",
	pointIds = null,
	nonceMode = false,
	apiKey = null,
	streamFn = streamSimple,
	random = Math.random,
}) {
	const spec = MODEL_SPECS[config];
	if (!spec) throw new Error(`unknown config: ${config}`);
	const model = resolveModel(spec.provider, spec.id);
	if (!model) throw new Error(`unresolvable model: ${spec.id}`);
	// Injectable beside streamFn (as in runCell), so the offline checks run
	// without a live login: an expired token must never fail an offline gate.
	if (!apiKey) {
		const auth = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/auth.json`, "utf8"));
		const credential = auth[spec.provider];
		if (!credential?.access || (typeof credential.expires === "number" && credential.expires < Date.now())) {
			throw new Error(`missing or expired ${spec.provider} login; run pi and log in first`);
		}
		apiKey = credential.access;
	}

	const points = pointsFrom(rows, { pointKinds, pointIds });
	if (points.length === 0) throw new Error("no observation points selected");
	const variantIds = Object.keys(variants);
	if (variantIds.length === 0) throw new Error("no variants given");

	const prices = pricesFor(model);
	const header = {
		runId: `skip-${Date.now()}`,
		config,
		model: spec.id,
		thinking: spec.reasoning,
		variants: variantIds,
		variantPromptHashes: Object.fromEntries(variantIds.map((id) => [id, sha16(variants[id])])),
		prices,
		...gitProvenance(),
	};
	appendFileSync(output, `${JSON.stringify({ ...header, kind: "skip-probe-header", points: points.length, samples, ts: Date.now() })}\n`);

	const collected = [];
	for (const point of points) {
		const captured = loadPayload(point);
		for (let sample = 1; sample <= samples; sample += 1) {
			// Variant order is shuffled per (point, sample) so the arm that pays the
			// cache write is not always the same one.
			for (const variantId of shuffled(variantIds, random)) {
				// A nonce makes an otherwise byte-identical request unique, which is
				// what separates "the model decided" from "the backend remembered".
				const nonce = nonceMode ? `${point.pointIndex}-${sample}-${variantId}-${Math.floor(random() * 1e9)}` : null;
				const prompt = nonce ? `${variants[variantId]}\n<!-- probe nonce ${nonce} -->` : variants[variantId];
				const started = Date.now();
				let usage = null;
				let response = null;
				let error = null;
				try {
					response = await streamFn(
						model,
						{ systemPrompt: "", messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }], tools: [] },
						{
							apiKey,
							reasoning: spec.reasoning,
							onPayload: (built) => mergeObservationPayload(captured, built.messages, undefined),
						},
					).result();
					usage = flatUsage(response.usage);
				} catch (caught) {
					error = caught instanceof Error ? caught.message : String(caught);
				}
				const row = buildRow({
					header,
					point,
					variantId,
					prompt,
					sample,
					usage,
					response,
					error,
					ms: Date.now() - started,
					prices,
					nonce,
				});
				appendFileSync(output, `${JSON.stringify(row)}\n`);
				collected.push(row);
				process.stderr.write(
					`${point.pointId} L=${point.prefixTokens} s${sample} ${variantId}: ${error ? `ERR ${error.slice(0, 40)}` : `${row.reasoning}think ${row.output}out ${row.thinkingSkipped ? "SKIP" : "think"}`}\n`,
				);
			}
		}
	}
	return collected;
}

/**
 * The reasoning-token distribution per variant: mean, median, skip rate AND the
 * raw values. Skip rate is one column among several by construction — whether
 * the distribution is bimodal is what the study is testing, so nothing here
 * summarizes it away (spec Rules).
 */
export function distributions(rows) {
	const byVariant = new Map();
	for (const row of rows) {
		if (row.kind !== "skip-probe" || row.error) continue;
		if (!byVariant.has(row.variantId)) byVariant.set(row.variantId, []);
		byVariant.get(row.variantId).push(row);
	}
	return [...byVariant.entries()]
		.map(([variantId, group]) => {
			const ordered = [...group].sort((a, b) => a.pointIndex - b.pointIndex || a.sample - b.sample);
			const reasoning = ordered.map((row) => row.reasoning);
			const sorted = [...reasoning].sort((a, b) => a - b);
			const mid = Math.floor(sorted.length / 2);
			return {
				variantId,
				n: reasoning.length,
				meanReasoning: reasoning.reduce((sum, value) => sum + value, 0) / reasoning.length,
				medianReasoning: sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid],
				minReasoning: sorted[0],
				maxReasoning: sorted[sorted.length - 1],
				skips: reasoning.filter((value) => value === 0).length,
				skipRate: reasoning.filter((value) => value === 0).length / reasoning.length,
				// Raw values, point-ordered. Few enough to print; the spec requires it.
				values: reasoning,
				cost: ordered.reduce((sum, row) => sum + (row.cost ?? 0), 0),
			};
		})
		.sort((a, b) => a.meanReasoning - b.meanReasoning);
}

/**
 * Q5: skipping cross-tabulated against the routed delivery. A CONTINGENCY
 * TABLE, deliberately — not a correlation coefficient. `by` selects the
 * explanator being tested: delivery, prefix bucket, or variant.
 */
export function contingency(rows, { by = "delivery" } = {}) {
	const key = (row) => {
		if (by === "delivery") return row.delivery ?? "unparsed";
		if (by === "prefix") return row.prefixTokens < 10000 ? "short(<10k)" : row.prefixTokens < 30000 ? "mid(10-30k)" : "long(>30k)";
		return row[by] ?? "unknown";
	};
	const cells = new Map();
	for (const row of rows) {
		if (row.kind !== "skip-probe" || row.error) continue;
		const bucket = key(row);
		if (!cells.has(bucket)) cells.set(bucket, { bucket, skipped: 0, thought: 0, reasoning: [] });
		const cell = cells.get(bucket);
		if (row.reasoning === 0) cell.skipped += 1;
		else cell.thought += 1;
		cell.reasoning.push(row.reasoning);
	}
	return [...cells.values()]
		.map((cell) => ({
			...cell,
			n: cell.skipped + cell.thought,
			skipRate: cell.skipped / (cell.skipped + cell.thought),
			meanReasoning: cell.reasoning.reduce((sum, value) => sum + value, 0) / cell.reasoning.length,
		}))
		.sort((a, b) => b.n - a.n);
}

function printContingency(rows, by, label) {
	process.stdout.write(`\n${label}\n`);
	process.stdout.write("  bucket".padEnd(20) + "n     skipped  thought  skipRate  meanThink\n");
	for (const cell of contingency(rows, { by })) {
		process.stdout.write(
			`  ${cell.bucket.padEnd(18)}${String(cell.n).padEnd(6)}${String(cell.skipped).padEnd(9)}${String(cell.thought).padEnd(9)}${(cell.skipRate * 100).toFixed(0).padStart(6)}%  ${cell.meanReasoning.toFixed(0).padStart(9)}\n`,
		);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2);
	const rowsPath = argOf(args, "--rows", "");
	const variantsPath = argOf(args, "--variants", "");
	const output = argOf(args, "--output", "");
	const config = argOf(args, "--config", "opus-high");
	const samples = Number.parseInt(argOf(args, "--samples", "1"), 10);
	const pointKinds = argOf(args, "--points", "piggyback");
	const pointIdsArg = argOf(args, "--point-ids", "");
	const nonceMode = args.includes("--nonce");
	if (!rowsPath) throw new Error("--rows is required (a trajectory-cost run's rows.jsonl)");
	if (!variantsPath) throw new Error("--variants is required (a JSON map of variantId -> prompt string)");
	if (!output) throw new Error("--output is required");
	if (!Number.isInteger(samples) || samples < 1) throw new Error("--samples must be a positive integer");

	const rows = readFileSync(rowsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const variants = JSON.parse(readFileSync(variantsPath, "utf8"));
	const collected = await probe({
		rows,
		variants,
		config,
		output,
		samples,
		pointKinds,
		pointIds: pointIdsArg ? pointIdsArg.split(",").filter(Boolean) : null,
		nonceMode,
	});
	process.stdout.write("\nvariant".padEnd(24) + "n    mean   median  min   max    skip   $\n");
	for (const item of distributions(collected)) {
		process.stdout.write(
			`${item.variantId.padEnd(24)}${String(item.n).padEnd(5)}${item.meanReasoning.toFixed(0).padStart(5)}  ${String(item.medianReasoning).padStart(6)}  ${String(item.minReasoning).padStart(4)}  ${String(item.maxReasoning).padStart(5)}  ${`${item.skips}/${item.n}`.padStart(5)}  $${item.cost.toFixed(4)}\n`,
		);
	}
	process.stdout.write("\nraw reasoning values, point-ordered (the distribution is a finding, not an assumption):\n");
	for (const item of distributions(collected)) {
		process.stdout.write(`  ${item.variantId.padEnd(24)}${item.values.join(" ")}\n`);
	}
	// Q5: the three competing explanators, side by side.
	printContingency(collected, "delivery", "Q5 contingency — skipping x routed delivery:");
	printContingency(collected, "prefix", "Q5 contingency — skipping x prefix length:");
	printContingency(collected, "variantId", "Q5 contingency — skipping x variant:");
	process.stdout.write(`\ntotal spend: $${collected.reduce((sum, row) => sum + (row.cost ?? 0), 0).toFixed(4)} over ${collected.length} calls\n`);
}
