#!/usr/bin/env node
/** DRIVER-PROMPT-REALISM-SPEC.md executor: NATIVE vs MINIMAL driver system block. */
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { mergeObservationPayload, parseDecision } from "../../utils.ts";
import { pointsFrom, loadPayload } from "../adaptive-skip-probe.mjs";
import { resolveModel } from "../model-catalog.mjs";
import { ENUM_SO2 } from "../steer-only-variants.mjs";

const HOME = process.env.HOME;
const OUT = `${HOME}/scratch/2026-08-04-native-prompt-probe/realism-rows.jsonl`;
const NATIVE = readFileSync(`${HOME}/scratch/2026-08-04-native-prompt-probe/probe-b-without-block.json`, "utf8");
const nativeSystem = JSON.parse(NATIVE).system[1].text;

const rows = gunzipSync(readFileSync(
	`${HOME}/dev/personal/pi-hydra.piped-discovering-minsky/experiments/artifacts/2026-08-01-trajectory-pilot/rows.jsonl.gz`,
)).toString().split("\n").filter(Boolean).map((line) => JSON.parse(line));

const points = pointsFrom(rows, { pointKinds: "piggyback" })
	.sort((a, b) => {
		const h = (p) => createHash("sha256").update(String(p.pointId ?? p.pointIndex)).digest("hex");
		return h(a).localeCompare(h(b));
	})
	.slice(0, 12);
console.log(`points: ${points.length}`);

const model = resolveModel("anthropic", "claude-opus-5");
const cred = JSON.parse(readFileSync(`${HOME}/.pi/agent/auth.json`, "utf8")).anthropic;
if (!cred?.access) throw new Error("no anthropic login");

async function observe(point, systemText, tag) {
	const captured = structuredClone(loadPayload(point));
	if (systemText) captured.system[1].text = systemText;
	const started = Date.now();
	const result = await streamSimple(
		model,
		{ systemPrompt: "", messages: [{ role: "user", content: [{ type: "text", text: ENUM_SO2 }], timestamp: Date.now() }], tools: [] },
		{
			apiKey: cred.access,
			reasoning: "high",
			onPayload: (built) => mergeObservationPayload(captured, built.messages, undefined),
		},
	).result();
	const text = (result.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
	const usage = result.usage ?? {};
	const row = {
		point: point.pointId ?? point.pointIndex,
		tag,
		error: result.errorMessage ?? null,
		decision: (() => { try { return parseDecision(text)?.delivery ?? null; } catch { return null; } })(),
		thinking: usage.thoughtTokens ?? usage.thinking ?? null,
		output: usage.output ?? usage.outputTokens ?? null,
		ms: Date.now() - started,
		text,
	};
	appendFileSync(OUT, `${JSON.stringify(row)}\n`);
	console.log(`${row.point} ${tag}: decision=${row.decision} thinking=${row.thinking} err=${row.error ? row.error.slice(0, 60) : "no"}`);
	return row;
}

const queue = [];
for (const point of points) {
	queue.push({ point, system: null, tag: "minimal" });
	queue.push({ point, system: nativeSystem, tag: "native" });
}
for (const point of points.slice(0, 3)) queue.push({ point, system: null, tag: "minimal-repeat" });

let failures = 0;
const workers = Array.from({ length: 3 }, async (_, w) => {
	while (queue.length) {
		const job = queue.shift();
		if (!job) break;
		try {
			const row = await observe(job.point, job.system, job.tag);
			if (row.error && /extra usage|quota|rate/i.test(row.error)) { console.log("QUOTA-CLASS ERROR — draining queue"); queue.length = 0; }
		} catch (error) {
			failures += 1;
			appendFileSync(OUT, `${JSON.stringify({ point: job.point.pointId ?? job.point.pointIndex, tag: job.tag, error: String(error).slice(0, 200) })}\n`);
			if (/extra usage|quota/i.test(String(error))) queue.length = 0;
		}
	}
});
await Promise.all(workers);
console.log(`done; failures=${failures}`);
