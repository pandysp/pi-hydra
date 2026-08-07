#!/usr/bin/env node
/**
 * The C1 thinking instrument (`ENVELOPE-REPAIR-SPEC.md` step 3): replay a frozen
 * trajectory's recorded observation payloads through one or more arms, measuring
 * reasoning, output and cost per point. No driver runs.
 *
 * Why this exists. The frozen screens measure per-observation cost against ~800
 * token synthetic prefixes; the pilot measured the same arms against a real
 * 3k-38k driver transcript and found the envelope arms engage 10-14x MAIN's
 * adaptive thinking, which is what makes the premium first-order at session
 * scale (`TRAJECTORY-PILOT-RESULTS.md`). Iterating on contract text against the
 * small prefixes would optimize the wrong number. Replaying the pilot's own
 * payloads gives realistic prefixes at ~$0.60 per arm and makes every arm face
 * byte-identical driver context, so a thinking delta is attributable to the
 * contract alone.
 *
 * PIGGYBACK POINTS ONLY, deliberately. A piggyback observation's tail is
 * `[prompt]`, the cache marker does not move, and the whole prefix bills as
 * cache read with zero write (`utils.ts:786-806`) — the clean shape for a
 * per-observation cost comparison. Run-end points need the driver's final
 * assistant message, which the pilot's rows do not carry, and their M-write
 * accounting is the noisy part of the pilot anyway (3 of 4 were invalidated by
 * the reader/writer assertion). The pilot's own T1 fit is piggyback-only for the
 * same reason.
 *
 * The prefix is a recorded payload, so its cache entry is long expired: every
 * arm pays cache WRITE on the first call at that point and cache READ after.
 * That ordering artifact is removed exactly as the pilot removes it — compose
 * each arm's cost from the writer's measured token count (`composeObservationCost`)
 * and randomize arm order per point. Absolute dollars here are therefore a
 * fresh-prefix basis, not the production cache-riding basis; the comparison
 * across arms is what this instrument is for, and reasoning tokens — the C1
 * metric — are unaffected by any of it.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { mergeObservationPayload } from "../utils.ts";
import { argOf } from "./lib.mjs";
import { armHandoff, armSpec, assertDistinctImplementations, isKnownArm } from "./arm-registry.mjs";
import { flatUsage, pricesFor, rawCost } from "./costing.mjs";
import { composeObservationCost, sumUsage } from "./trajectory-cost-ab.mjs";
import { resolveModel } from "./model-catalog.mjs";
import { GOLDEN_HEADS } from "./delivery-context-golden-cases.mjs";
import { gitProvenance, sha16 } from "./fingerprints.mjs";

const MODEL_SPECS = {
	"opus-high": { provider: "anthropic", id: "claude-opus-5", reasoning: "high" },
	"opus-xhigh": { provider: "anthropic", id: "claude-opus-5", reasoning: "xhigh" },
	"opus-medium": { provider: "anthropic", id: "claude-opus-5", reasoning: "medium" },
	"sonnet-high": { provider: "anthropic", id: "claude-sonnet-5", reasoning: "high" },
};

function textOf(message) {
	return (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
}

function shuffled(values) {
	const out = [...values];
	for (let index = out.length - 1; index > 0; index -= 1) {
		const swap = Math.floor(Math.random() * (index + 1));
		[out[index], out[swap]] = [out[swap], out[index]];
	}
	return out;
}

/**
 * The observation points of a frozen trajectory run, one entry per point, with
 * the recorded driver payload each arm must be merged into.
 */
export function recordedPoints(rows, { pointKind = "piggyback" } = {}) {
	const seen = new Map();
	for (const row of rows) {
		if (row.kind !== "observation") continue;
		if (pointKind && row.pointKind !== pointKind) continue;
		if (seen.has(row.pointId)) continue;
		seen.set(row.pointId, {
			pointId: row.pointId,
			pointIndex: row.pointIndex,
			pointKind: row.pointKind,
			runIndex: row.runIndex,
			requestIndex: row.requestIndex,
			prefixTokens: row.prefixTokens,
			capturedPayloadPath: row.capturedPayloadPath,
			capturedPayloadHash: row.capturedPayloadHash,
			head: row.head,
			lens: row.lens,
		});
	}
	return [...seen.values()].sort((a, b) => a.pointIndex - b.pointIndex);
}

export function loadPayload(point) {
	if (!existsSync(point.capturedPayloadPath)) {
		throw new Error(`recorded payload missing: ${point.capturedPayloadPath} (unpack payloads.tar.gz next to the rows)`);
	}
	return JSON.parse(readFileSync(point.capturedPayloadPath, "utf8"));
}

async function runPoint({ point, arms, model, spec, apiKey, prompts, prices, streamFn, output, header }) {
	const captured = loadPayload(point);
	const order = shuffled(arms);
	const measured = [];

	for (const [armOrderIndex, arm] of order.entries()) {
		const started = Date.now();
		const prompt = { role: "user", content: [{ type: "text", text: prompts[arm] }], timestamp: Date.now() };
		const usages = [];
		let providerCalls = 0;
		let error = null;
		let response = null;

		try {
			response = await streamFn(
				model,
				{ systemPrompt: "", messages: [prompt], tools: [] },
				{
					apiKey,
					reasoning: spec.reasoning,
					// index.ts:1013-1027: only what pi-ai built for `messages` is
					// kept; everything else comes from the captured driver payload.
					onPayload: (built) => {
						providerCalls += 1;
						return mergeObservationPayload(captured, built.messages, undefined);
					},
				},
			).result();
			usages.push(flatUsage(response.usage));
		} catch (caught) {
			error = caught instanceof Error ? caught.message : String(caught);
		}

		measured.push({
			arm,
			armOrderIndex,
			usage: sumUsage(usages),
			providerCalls,
			responseText: response ? textOf(response) : null,
			stopReason: response?.stopReason ?? null,
			error,
			ms: Date.now() - started,
		});
	}

	// The writer is whichever arm went first at this point; the others read what
	// it wrote. Charging every arm the writer's token count removes the ordering
	// artifact without a warm call.
	const writer = measured.find((item) => item.armOrderIndex === 0);
	const mTokens = writer?.usage.cacheWrite ?? 0;
	const m1hTokens = writer?.usage.cacheWrite1h ?? 0;

	for (const item of measured) {
		const row = {
			...header,
			kind: "recorded-observation",
			pointId: point.pointId,
			pointIndex: point.pointIndex,
			pointKind: point.pointKind,
			runIndex: point.runIndex,
			requestIndex: point.requestIndex,
			prefixTokens: point.prefixTokens,
			capturedPayloadHash: point.capturedPayloadHash,
			arm: item.arm,
			armOrderIndex: item.armOrderIndex,
			implementationArm: armSpec(item.arm).id,
			...item.usage,
			rawCost: rawCost(item.usage, prices),
			composedCost: composeObservationCost(item.usage, { mTokens, isWriter: item.armOrderIndex === 0, m1hTokens }, prices),
			mTokens,
			providerCalls: item.providerCalls,
			responseText: item.responseText,
			stopReason: item.stopReason,
			error: item.error,
			ms: item.ms,
			ts: Date.now(),
		};
		appendFileSync(output, `${JSON.stringify(row)}\n`);
	}

	return measured;
}

export async function replay({ rows, arms, config, output, apiKey = null, streamFn = streamSimple, limit = null, head, lens }) {
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

	const points = limit ? recordedPoints(rows).slice(0, limit) : recordedPoints(rows);
	if (points.length === 0) throw new Error("no piggyback observation points in these rows");
	const observerHead = head ?? points[0].head;
	const observerLens = lens ?? GOLDEN_HEADS[observerHead];
	if (!observerLens) throw new Error(`no lens for head ${observerHead}`);

	// One rendered prompt per arm, reused at every point: the observation
	// handoff is a pure function of (arm, head, lens), and pinning it here is
	// what makes the per-point comparison a contract comparison.
	const prompts = Object.fromEntries(
		arms.map((arm) => [arm, armHandoff(arm, spec.provider, { head: observerHead, lens: observerLens }).prompt]),
	);
	const prices = pricesFor(model);
	const header = {
		runId: `replay-${Date.now()}`,
		config,
		model: spec.id,
		thinking: spec.reasoning,
		head: observerHead,
		lensHash: sha16(observerLens),
		arms,
		armPromptHashes: Object.fromEntries(arms.map((arm) => [arm, sha16(prompts[arm])])),
		prices,
		...gitProvenance(),
	};
	appendFileSync(output, `${JSON.stringify({ ...header, kind: "replay-header", points: points.length, ts: Date.now() })}\n`);

	const results = [];
	for (const point of points) {
		const measured = await runPoint({
			point,
			arms,
			model,
			spec,
			apiKey,
			prompts,
			prices,
			streamFn,
			output,
			header,
		});
		results.push({ point, measured });
		const summary = measured
			.map((item) => `${item.arm}:${item.error ? "ERR" : `${item.usage.reasoning}think/${item.usage.output}out`}`)
			.join(" ");
		process.stderr.write(`${point.pointId} L=${point.prefixTokens} ${summary}\n`);
	}
	return results;
}

export function summarize(results) {
	const byArm = new Map();
	for (const { measured } of results) {
		for (const item of measured) {
			if (item.error) continue;
			if (!byArm.has(item.arm)) byArm.set(item.arm, []);
			byArm.get(item.arm).push(item.usage);
		}
	}
	const mean = (values) => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);
	return [...byArm.entries()].map(([arm, usages]) => ({
		arm,
		n: usages.length,
		reasoning: mean(usages.map((usage) => usage.reasoning)),
		output: mean(usages.map((usage) => usage.output)),
		answerTokens: mean(usages.map((usage) => usage.output - usage.reasoning)),
	}));
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2);
	const rowsPath = argOf(args, "--rows", "");
	const output = argOf(args, "--output", "");
	const config = argOf(args, "--config", "opus-high");
	const arms = argOf(args, "--arms", "MAIN,F0,F1,F2").split(",").filter(Boolean);
	const limitArg = argOf(args, "--limit", "");
	if (!rowsPath) throw new Error("--rows is required (a trajectory-cost run's rows.jsonl)");
	if (!output) throw new Error("--output is required");
	for (const arm of arms) if (!isKnownArm(arm)) throw new Error(`unknown arm: ${arm}`);
	assertDistinctImplementations(arms);
	const rows = readFileSync(rowsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const results = await replay({
		rows,
		arms,
		config,
		output,
		limit: limitArg ? Number.parseInt(limitArg, 10) : null,
	});
	for (const item of summarize(results)) {
		process.stdout.write(
			`${item.arm.padEnd(6)} n=${item.n} thinking=${item.reasoning?.toFixed(0)} output=${item.output?.toFixed(0)} answer=${item.answerTokens?.toFixed(0)}\n`,
		);
	}
}
