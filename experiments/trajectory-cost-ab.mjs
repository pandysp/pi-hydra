#!/usr/bin/env node
/**
 * Trajectory cost benchmark: what one observer head costs across a whole
 * trajectory, as a percent of the driver's cost, jointly with what it says.
 * Pre-registered in `TRAJECTORY-COST-SPEC.md`; architecture in
 * `artifacts/wave8-designs/wave8-benchmark.md`.
 *
 * LIVE FORK, no replay, no warm calls (wave8-benchmark.md:14-27). One real
 * `runAgentLoop` driver per (trajectory, config) in a seeded mkdtemp workspace;
 * at production's observation points the three arms fire against the cache
 * entry the driver's own request just committed. Every arm call goes through
 * the production merge path — `mergeObservationPayload` (`utils.ts:810`) with
 * `tools: []` and an empty system prompt, exactly `index.ts:1013-1027` — so the
 * bytes on the wire are production's, not a harness splice.
 *
 * Deviations from production, each forced and each visible in the rows:
 *
 * 1. **Arms fire at `message_end`, not `message_start`.** Production's
 *    `pi.on("message_start")` (`index.ts:1553`) schedules onto a background
 *    runner. Here the only handle on the loop is `runAgentLoop`'s awaited emit
 *    callback, and `message_start` is emitted from inside
 *    `for await (const event of response)` (`agent-loop.js:196`): awaiting three
 *    opus calls there would stop draining the driver's SSE socket for minutes
 *    while its own response is still streaming. `message_end` is emitted in the
 *    `done` branch after `await response.result()` (`agent-loop.js:224-231`) —
 *    after the driver's response is fully received, before its tool calls run,
 *    before its next request. Cache state, payload bytes and point enumeration
 *    are identical; only wall clock moves, which wave8-benchmark.md:20 licenses.
 *    The observer still never sees the assistant message that just streamed: a
 *    piggyback tail is `[prompt]` on the captured request payload.
 * 2. **`failOpenJsonDecision` is re-stated here** rather than imported from
 *    `delivery-context-golden-ab.mjs:388-397`: that module parses argv and runs
 *    its matrix on import. The text is the same policy, cited at the site.
 * 3. **Driver `maxTokens` is pinned** (`--driver-max-tokens`, default 8000) to
 *    bound a runaway turn. Recorded in the header row; observations pass no
 *    maxTokens, exactly as `index.ts:1019-1026` does not.
 *
 * Arms are stateless per point (spec amendment: no own-delivery history is
 * threaded), one frozen generic MECE lens for all of them, judge-only head.
 *
 * UNTESTED UNTIL FIRST SPEND: F's format-recovery branch below. The scripted
 * provider in the check always returns a parseable decision, so the recovery
 * turn's second merge — a `[M, prompt, response, correction]` tail, whose loop
 * turns move the marker to the tail frontier — has unit coverage in
 * `composeObservationCost` but has never run end to end. Watch it on the pilot.
 *
 * Usage:
 *   node experiments/trajectory-cost-invariants.check.mjs   # zero spend, first
 *   node experiments/trajectory-cost-ab.mjs --output rows.jsonl \
 *     --payload-dir payloads --trajectories scheduler --configs opus-high
 *   node experiments/trajectory-cost-ab.mjs --output rows.jsonl \
 *     --payload-dir payloads --concurrency 2
 *
 * Resume is at (trajectory, config) granularity: a cell that did not reach its
 * `cell-end` row is re-run whole under a fresh `attempt`, and the summarizer
 * reads only attempts that completed. A partial driver run cannot be resumed
 * mid-trajectory — its points are gone.
 */

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgentLoop, uuidv7 } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { createEditTool, createGrepTool, createLsTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import {
	footerFormatCorrection,
	mergeObservationPayload,
	parseDecision,
	parseFooterDecision,
	selectFinalAssistant,
} from "../utils.ts";
import { hydraToolDescription, hydraToolParameters } from "../protocol.ts";
import { GOLDEN_HEADS } from "./delivery-context-golden-cases.mjs";
import {
	buildScreenFooterObservationPrompt,
	buildScreenJsonObservationPrompt,
	buildShippedMainObservationPrompt,
} from "./delivery-context-evaluation.mjs";
import { argOf } from "./lib.mjs";
import { resolveModel } from "./model-catalog.mjs";
import { selectTrajectories, setupTask, taskSeedHash } from "./trajectory-cost-tasks.mjs";

// ---------------------------------------------------------------------------
// Arms, head, lens. Frozen for the whole study.
// ---------------------------------------------------------------------------

/** One frozen generic MECE head; the lens names no defect (wave8-quality.md:15). */
export const OBSERVER_HEAD = "quality";
export const OBSERVER_LENS = GOLDEN_HEADS[OBSERVER_HEAD];

/**
 * MAIN is main's shipped judge contract re-benchmarked inside this harness —
 * the baseline the spec insists on, not the ~30% field prior and not the
 * screens' harmonized A0. J and F are the two unified-envelope candidates.
 * Anthropic carries the whole handoff in one combined user message, so no arm
 * uses a separate envelope (`delivery-context-golden-ab.mjs:247-261`).
 */
export const ARM_PROMPTS = Object.freeze({
	MAIN: buildShippedMainObservationPrompt(OBSERVER_HEAD, OBSERVER_LENS),
	J: buildScreenJsonObservationPrompt(OBSERVER_HEAD, OBSERVER_LENS),
	F: buildScreenFooterObservationPrompt(OBSERVER_HEAD, OBSERVER_LENS),
});

export const ARMS = Object.freeze(Object.keys(ARM_PROMPTS));

export const CONFIGS = Object.freeze({
	"opus-high": { provider: "anthropic", id: "claude-opus-5", reasoning: "high" },
	"opus-xhigh": { provider: "anthropic", id: "claude-opus-5", reasoning: "xhigh" },
});

const sha = (text) => createHash("sha256").update(text).digest("hex");

export function lensHash() {
	return sha(OBSERVER_LENS).slice(0, 16);
}

/**
 * The contract region: the arm's handoff with the lens excised. Hashing the two
 * separately is the pre-spend invariant that the arms vary the contract and
 * nothing else (wave8-benchmark.md:121).
 */
export function contractRegion(arm) {
	const prompt = ARM_PROMPTS[arm];
	if (!prompt) throw new Error(`unknown arm: ${arm}`);
	return prompt.split(OBSERVER_LENS).join("<LENS>");
}

export function contractHash(arm) {
	return sha(contractRegion(arm)).slice(0, 16);
}

export function promptHash(arm) {
	return sha(ARM_PROMPTS[arm]).slice(0, 16);
}

// ---------------------------------------------------------------------------
// Prices and cost composition.
// ---------------------------------------------------------------------------

/**
 * µ$ per token, from the resolved model's own cost table (opus-5: 5 / 25 / 0.5
 * / 6.25 per Mtok, no `cost.tiers`, so flat). `cacheWrite1h` is not in the
 * table: Anthropic prices a 1h write at 2x input where the 5m write is 1.25x,
 * and `usage.cacheWrite1h` is a SUBSET of `usage.cacheWrite`
 * (`pi-ai/dist/types.d.ts:256`). The merge preserves whatever TTL the driver's
 * marker carried (`utils.ts:826`), so a 1h driver marker would bill the run-end
 * M write at the higher rate; splitting the term here keeps that from silently
 * corrupting every dollar figure.
 */
export function pricesFor(model) {
	const cost = model?.cost;
	if (!cost || typeof cost.input !== "number") throw new Error("model has no cost table");
	return {
		input: cost.input,
		output: cost.output,
		cacheRead: cost.cacheRead,
		cacheWrite: cost.cacheWrite,
		cacheWrite1h: cost.input * 2,
	};
}

/** Flatten a pi-ai usage object to the fields this study prices and asserts on. */
export function flatUsage(usage) {
	return {
		input: usage?.input ?? 0,
		output: usage?.output ?? 0,
		reasoning: usage?.reasoning ?? 0,
		cacheRead: usage?.cacheRead ?? 0,
		cacheWrite: usage?.cacheWrite ?? 0,
		cacheWrite1h: usage?.cacheWrite1h ?? 0,
		cost: usage?.cost?.total ?? 0,
	};
}

export function sumUsage(usages) {
	return usages.reduce(
		(total, usage) => ({
			input: total.input + usage.input,
			output: total.output + usage.output,
			reasoning: total.reasoning + usage.reasoning,
			cacheRead: total.cacheRead + usage.cacheRead,
			cacheWrite: total.cacheWrite + usage.cacheWrite,
			cacheWrite1h: total.cacheWrite1h + usage.cacheWrite1h,
			cost: total.cost + usage.cost,
		}),
		{ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cost: 0 },
	);
}

/** Straight price of a measured usage, in dollars. */
export function rawCost(usage, prices) {
	const write5m = Math.max(0, usage.cacheWrite - usage.cacheWrite1h);
	return (
		(usage.cacheRead * prices.cacheRead +
			write5m * prices.cacheWrite +
			usage.cacheWrite1h * prices.cacheWrite1h +
			usage.input * prices.input +
			usage.output * prices.output) /
		1e6
	);
}

/**
 * Production's single-head economics for one arm at one point
 * (wave8-benchmark.md:29-38). At a run-end point all three arms send the same
 * prefix+M key; whichever fires first writes M and the other two read it. That
 * is an artifact of forking three arms off one driver, not something a user
 * pays, so every arm is charged one M write and credited the M tokens it read:
 *
 *   composedCost = (cacheRead - mTokens if reader) * cacheRead price
 *                + mTokens * write price
 *                + input * input price + output * output price
 *
 * `usage` must be the arm's FIRST provider call. F's format-recovery turn sends
 * `[M, prompt, response, correction]`, whose tail has loop turns, so the merge
 * moves the marker to the tail frontier (`utils.ts:817-827`) and that call
 * writes the tail: it is priced raw and added, never folded into mTokens.
 */
export function composeObservationCost(usage, { mTokens, isWriter, m1hTokens = 0 }, prices, extraUsage = null) {
	const chargedRead = usage.cacheRead - (isWriter ? 0 : mTokens);
	const write5m = Math.max(0, mTokens - m1hTokens);
	const composed =
		(chargedRead * prices.cacheRead +
			write5m * prices.cacheWrite +
			m1hTokens * prices.cacheWrite1h +
			usage.input * prices.input +
			usage.output * prices.output) /
		1e6;
	return composed + (extraUsage ? rawCost(extraUsage, prices) : 0);
}

// ---------------------------------------------------------------------------
// Observation-point enumeration: production's rules, as a state machine.
// ---------------------------------------------------------------------------

/**
 * Mirrors `index.ts` exactly:
 *   agent_start            arms the first-response gate (`index.ts:1480`)
 *   before_provider_request captures the payload (`index.ts:1516`)
 *   assistant message      one piggyback EXCEPT the run's first (`:1560-1564`)
 *   agent_end              one run-end, M selected by timestamp identity
 *                          (`:1595-1604`, `selectFinalAssistant` in utils.ts)
 * Pure and exported so the pre-spend check can drive it from a recorded event
 * log instead of trusting the runner's inline wiring.
 */
export function createPointScheduler() {
	let awaitingFirstResponseOfRun = true;
	let capturedThisRun = false;
	let responseTimestamp = null;
	let hasCapture = false;
	return {
		onAgentStart() {
			awaitingFirstResponseOfRun = true;
			capturedThisRun = false;
		},
		onCapture() {
			hasCapture = true;
			responseTimestamp = null;
			capturedThisRun = true;
		},
		onAssistantMessage(message) {
			if (hasCapture && responseTimestamp === null) {
				responseTimestamp = message?.timestamp ?? null;
			}
			if (!hasCapture) return null;
			if (awaitingFirstResponseOfRun) {
				awaitingFirstResponseOfRun = false;
				return null;
			}
			return { kind: "piggyback", assistant: null };
		},
		onAgentEnd(messages) {
			if (!hasCapture || !capturedThisRun) return null;
			const assistant = selectFinalAssistant(messages ?? [], responseTimestamp);
			return assistant ? { kind: "run-end", assistant } : null;
		},
	};
}

/** Replay a recorded loop event log through the scheduler (used by the check). */
export function enumerateObservationPoints(events) {
	const scheduler = createPointScheduler();
	const points = [];
	for (const [index, event] of events.entries()) {
		if (event.type === "agent_start") scheduler.onAgentStart();
		else if (event.type === "capture") scheduler.onCapture();
		else if (event.type === "message_end" && event.message?.role === "assistant") {
			const point = scheduler.onAssistantMessage(event.message);
			if (point) points.push({ ...point, eventIndex: index });
		} else if (event.type === "agent_end") {
			const point = scheduler.onAgentEnd(event.messages);
			if (point) points.push({ ...point, eventIndex: index });
		}
	}
	return points;
}

// ---------------------------------------------------------------------------
// Live assertions (wave8-benchmark.md:123-127). They fail the ROW, loudly; they
// never silently absorb, and they never abort the trajectory — a run thrown
// away mid-flight loses every point after it.
// ---------------------------------------------------------------------------

export function checkObservationRow(row, { driverPayloadHash, driverUsed1h }) {
	const failures = [];
	if (row.capturedPayloadHash !== driverPayloadHash) {
		failures.push(`payload hash ${row.capturedPayloadHash} != driver ${driverPayloadHash}`);
	}
	// The cache floor applies to every point kind. wave8-benchmark.md:123-127
	// specifies it for piggyback only, but the bound holds a fortiori at run-end:
	// the writer reads the prefix and the readers read prefix+M, so a run-end row
	// below the floor is the same cache miss that makes every dollar figure after
	// it meaningless — and run-end is one point in four, invisible to Q0c without
	// this.
	if (row.cacheRead < 0.95 * row.prefixTokens) {
		failures.push(`cacheRead ${row.cacheRead} below 0.95 x prefix ${row.prefixTokens}`);
	}
	if (row.pointKind === "piggyback") {
		if (row.cacheWrite !== 0) failures.push(`piggyback wrote ${row.cacheWrite} cache tokens`);
	} else {
		if (row.armOrderIndex === 0) {
			if (row.cacheWrite <= 0) failures.push("run-end writer wrote nothing");
		} else if (row.cacheWrite !== 0) {
			failures.push(`run-end reader wrote ${row.cacheWrite} cache tokens`);
		}
		// Pre-registered as exact equality; the delta is recorded as a number so a
		// tolerance decision, if one is ever needed, comes from data.
		if (row.mDelta !== null && row.mDelta !== 0) {
			failures.push(`reader-writer cacheRead delta ${row.mDelta} != mTokens`);
		}
	}
	if (!driverUsed1h && row.cacheWrite1h !== 0) {
		failures.push(`unexpected 1h write ${row.cacheWrite1h} (driver used no 1h marker)`);
	}
	return failures;
}

// ---------------------------------------------------------------------------
// Parse chain, verbatim policy from the golden runner.
// ---------------------------------------------------------------------------

/**
 * A's lenient parse with A's failure policy: an unparseable reply is a warned
 * noop, never a recovery turn (`delivery-context-golden-ab.mjs:383-397`). MAIN
 * and J spend exactly one provider call; F is the only arm with a recovery
 * budget, matching how the screen rows were produced.
 */
function failOpenJsonDecision(text, error) {
	const legacy = parseDecision(text);
	return {
		decision: legacy ?? { action: "noop", reason: "unparseable response", message: "" },
		error: legacy ? null : error,
		formatValid: legacy !== null,
	};
}

function parseArmResponse(arm, text) {
	if (arm === "MAIN" || arm === "J") {
		return failOpenJsonDecision(text, "unparseable JSON; the JSON contract falls back to noop");
	}
	const parsed = parseFooterDecision(text);
	return { ...parsed, formatValid: parsed.decision !== null };
}

function textOf(message) {
	return (message?.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

// ---------------------------------------------------------------------------
// Workspace file-state timeline (`acting-channel-smoke.mjs:111`), restricted to
// the authored files: the seeded reference subtree is read-only mass and would
// multiply the artifact by two orders of magnitude for no signal.
// ---------------------------------------------------------------------------

export function snapshotWorkspace(root, skipPrefixes = ["reference/"]) {
	const files = {};
	function visit(directory) {
		for (const name of readdirSync(directory)) {
			const absolute = join(directory, name);
			const path = relative(root, absolute);
			if (skipPrefixes.some((prefix) => path.startsWith(prefix))) continue;
			if (statSync(absolute).isDirectory()) visit(absolute);
			else files[path] = readFileSync(absolute, "utf8");
		}
	}
	visit(root);
	return files;
}

// ---------------------------------------------------------------------------
// Driver tool surface.
// ---------------------------------------------------------------------------

/**
 * `WORK_TOOL_FACTORIES` (`acting-channel-arms.mjs:365`) plus grep, so the driver
 * behaves like an agent instead of slurping whole files (wave8-benchmark.md:65),
 * plus the shipped wide hydra schema the production driver advertises. The
 * schema is what a real driver pays for on every request and what the arms
 * replay through the merge; a driver that calls it gets an error and the call is
 * recorded, since head management is not part of this benchmark.
 */
export function driverTools(root, calls) {
	const work = [createReadTool, createWriteTool, createEditTool, createLsTool, createGrepTool].map((factory) => factory(root));
	return [
		...work,
		{
			name: "hydra",
			label: "Hydra",
			description: hydraToolDescription(join(root, ".pi", "hydra")),
			parameters: hydraToolParameters,
			async execute(_id, rawParams) {
				calls.push(rawParams);
				throw new Error("Head management is unavailable in this benchmark workspace");
			},
		},
	];
}

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------

function shuffled(values) {
	const copy = [...values];
	for (let index = copy.length - 1; index > 0; index--) {
		const other = Math.floor(Math.random() * (index + 1));
		[copy[index], copy[other]] = [copy[other], copy[index]];
	}
	return copy;
}

async function main() {
	const args = process.argv.slice(2);
	const outputPath = argOf(args, "--output", "");
	const payloadDir = argOf(args, "--payload-dir", "");
	const requestedConfigs = argOf(args, "--configs", "opus-high,opus-xhigh").split(",").filter(Boolean);
	const requestedTrajectories = argOf(args, "--trajectories", "").split(",").filter(Boolean);
	const requestedArms = argOf(args, "--arms", ARMS.join(",")).split(",").filter(Boolean);
	const concurrency = Number.parseInt(argOf(args, "--concurrency", "1"), 10);
	const maxTurnsPerRun = Number.parseInt(argOf(args, "--max-turns", "8"), 10);
	const driverMaxTokens = Number.parseInt(argOf(args, "--driver-max-tokens", "8000"), 10);

	if (!outputPath) throw new Error("--output is required");
	if (!payloadDir) throw new Error("--payload-dir is required (payload snapshots are the study's re-run insurance)");
	for (const config of requestedConfigs) if (!(config in CONFIGS)) throw new Error(`unknown config: ${config}`);
	for (const arm of requestedArms) if (!ARMS.includes(arm)) throw new Error(`unknown arm: ${arm}`);
	if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--concurrency must be a positive integer");
	if (!Number.isInteger(maxTurnsPerRun) || maxTurnsPerRun < 1) throw new Error("--max-turns must be a positive integer");

	const tasks = selectTrajectories(requestedTrajectories);
	mkdirSync(payloadDir, { recursive: true });

	const auth = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/auth.json`, "utf8"));
	const credential = auth.anthropic;
	if (!credential?.access || (typeof credential.expires === "number" && credential.expires < Date.now())) {
		throw new Error("missing or expired anthropic login; run pi and log in first");
	}

	// Resume: only cells that reached their cell-end row are complete; anything
	// else is re-run whole under the next attempt number.
	const completedCells = new Set();
	const attempts = new Map();
	if (existsSync(outputPath)) {
		for (const line of readFileSync(outputPath, "utf8").trim().split("\n").filter(Boolean)) {
			const row = JSON.parse(line);
			const key = `${row.trajectoryId}/${row.config}`;
			attempts.set(key, Math.max(attempts.get(key) ?? 0, row.attempt ?? 0));
			if (row.kind === "cell-end") completedCells.add(key);
		}
	}

	const cells = [];
	for (const task of tasks) {
		for (const config of requestedConfigs) {
			const key = `${task.id}/${config}`;
			if (completedCells.has(key)) continue;
			cells.push({ task, config, key, attempt: (attempts.get(key) ?? 0) + 1 });
		}
	}

	console.error(
		`trajectory cost: ${cells.length} cells (${tasks.map((task) => task.id).join(",")} x ${requestedConfigs.join(",")}), ` +
			`arms ${requestedArms.join(",")}, concurrency ${concurrency}, ${completedCells.size} already complete`,
	);

	let cursor = 0;
	async function worker() {
		while (cursor < cells.length) {
			const cell = cells[cursor++];
			try {
				await runCell({ ...cell, outputPath, payloadDir, requestedArms, maxTurnsPerRun, driverMaxTokens, apiKey: credential.access });
			} catch (error) {
				const row = {
					kind: "cell-error",
					trajectoryId: cell.task.id,
					config: cell.config,
					attempt: cell.attempt,
					ts: Date.now(),
					error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error),
				};
				appendFileSync(outputPath, `${JSON.stringify(row)}\n`);
				console.error(`${cell.key}: CELL ERROR ${row.error}`);
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, cells.length) }, () => worker()));
}

/**
 * One (trajectory, config) cell: a real driver run with the arms forked at every
 * production observation point.
 *
 * `streamFn` exists so the whole live path — emit wiring, point enumeration in
 * the real loop, row assembly, the composed accounting, the live assertions —
 * can be exercised end to end against a scripted provider at zero spend, which
 * is what `trajectory-cost-invariants.check.mjs` does. It is deliberately NOT
 * reachable from argv: rows produced by a fake must never be creatable from the
 * command line that writes the real ones.
 */
export async function runCell({ task, config, attempt, outputPath, payloadDir, requestedArms, maxTurnsPerRun, driverMaxTokens, apiKey, streamFn = streamSimple }) {
	const spec = CONFIGS[config];
	const model = resolveModel(spec.provider, spec.id);
	if (!model) throw new Error(`unknown model ${spec.provider}/${spec.id}`);
	const prices = pricesFor(model);

	mkdirSync(payloadDir, { recursive: true });
	const root = mkdtempSync(join(tmpdir(), `hydra-traj-${task.id}-${config}-`));
	const { seedManifest, trackedPaths } = setupTask(task, root);
	const runId = uuidv7();
	const header = {
		runId,
		trajectoryId: task.id,
		config,
		attempt,
		model: model.id,
		thinking: spec.reasoning,
		taskSeed: taskSeedHash(task),
		lensHash: lensHash(),
		head: OBSERVER_HEAD,
	};
	const append = (row) => appendFileSync(outputPath, `${JSON.stringify({ ...header, ...row, ts: Date.now() })}\n`);

	const hydraCalls = [];
	const systemPrompt =
		`You are pi, a coding agent working in ${root}. Make the requested change directly with your tools; ` +
		`keep edits minimal and explain briefly what you changed. Benchmark nonce: ${runId}.`;
	let context = { systemPrompt, messages: [], tools: driverTools(root, hydraCalls) };

	append({
		kind: "cell-start",
		workspace: root,
		seedManifest,
		trackedPaths,
		prompts: task.prompts,
		arms: requestedArms,
		armPromptHashes: Object.fromEntries(requestedArms.map((arm) => [arm, promptHash(arm)])),
		armContractHashes: Object.fromEntries(requestedArms.map((arm) => [arm, contractHash(arm)])),
		prices,
		systemPromptHash: sha(systemPrompt).slice(0, 16),
		driverMaxTokens,
		maxTurnsPerRun,
		defects: task.defects.map((defect) => defect.id),
	});

	const driver = {
		captured: null,
		capturedHash: null,
		capturedPath: null,
		requestIndex: 0,
		firstOfRun: true,
		used1h: false,
	};
	let pointIndex = 0;
	let runIndex = 0;
	let turnIndex = 0;
	const scheduler = createPointScheduler();

	const options = {
		model,
		apiKey,
		reasoning: spec.reasoning,
		maxTokens: driverMaxTokens,
		onPayload: (body) => {
			driver.captured = structuredClone(body);
			const serialized = JSON.stringify(driver.captured);
			driver.capturedHash = sha(serialized).slice(0, 16);
			driver.capturedPath = join(payloadDir, `${task.id}-${config}-a${attempt}-r${runIndex}-q${driver.requestIndex}.json`);
			writeFileSync(driver.capturedPath, serialized);
			driver.firstOfRun = driver.newRun === true;
			driver.newRun = false;
			driver.requestIndex++;
			scheduler.onCapture();
			return body;
		},
	};

	/** One observation point: the three arms, sequential, randomized order. */
	async function runPoint(point) {
		const captured = driver.captured;
		const capturedHash = driver.capturedHash;
		const capturedPath = driver.capturedPath;
		const prefixTokens = driver.prefixTokens ?? 0;
		const pointId = `${task.id}/${config}/a${attempt}/r${runIndex}/${pointIndex}`;
		const order = shuffled(requestedArms);
		const measured = [];

		for (const [armOrderIndex, arm] of order.entries()) {
			const started = performance.now();
			const prompt = { role: "user", content: [{ type: "text", text: ARM_PROMPTS[arm] }], timestamp: Date.now() };
			const baseMessages = point.assistant ? [point.assistant] : [];
			const usages = [];
			let providerCalls = 0;
			let error = null;
			let response = null;
			let decision = null;
			let recoveryAttempted = false;
			let formatValid = null;
			let parseError = null;

			// index.ts:1013-1027 verbatim: empty system prompt, no tools, and the
			// merge is the only thing kept from what pi-ai built.
			const call = async (messages) => {
				const result = await streamFn(
					model,
					{ systemPrompt: "", messages, tools: [] },
					{
						apiKey,
						reasoning: spec.reasoning,
						onPayload: (built) => {
							providerCalls++;
							return mergeObservationPayload(captured, built.messages, undefined);
						},
					},
				).result();
				usages.push(flatUsage(result.usage));
				return result;
			};

			try {
				response = await call([...baseMessages, prompt]);
				const parsed = parseArmResponse(arm, textOf(response));
				decision = parsed.decision;
				formatValid = parsed.formatValid;
				parseError = parsed.error ?? null;
				// F is the only arm with a recovery budget (index.ts:1046-1060,
				// delivery-context-golden-ab.mjs:472-504).
				if (!decision && !response.errorMessage && providerCalls < 2) {
					recoveryAttempted = true;
					const correction = {
						role: "user",
						content: [{ type: "text", text: footerFormatCorrection(parseError ?? "invalid completion") }],
						timestamp: Date.now(),
					};
					response = await call([...baseMessages, prompt, response, correction]);
					const recovered = parseArmResponse(arm, textOf(response));
					decision = recovered.decision;
					formatValid = recovered.formatValid;
					parseError = recovered.error ?? null;
				}
			} catch (caught) {
				error = caught instanceof Error ? caught.message : String(caught);
			}

			measured.push({
				arm,
				armOrderIndex,
				usages,
				usage0: usages[0] ?? flatUsage(null),
				extra: usages.length > 1 ? sumUsage(usages.slice(1)) : null,
				providerCalls,
				recoveryAttempted,
				decision,
				formatValid,
				parseError,
				responseText: response ? textOf(response) : "",
				stopReason: response?.stopReason ?? null,
				error: error ?? response?.errorMessage ?? null,
				ms: Math.round(performance.now() - started),
			});
		}

		// mTokens is the FIRST-fired arm's measured write, never max() over the
		// arms: max() would absorb exactly the ordering failure the assertion
		// exists to catch (wave8-benchmark.md:32).
		const writer = measured.find((item) => item.armOrderIndex === 0);
		const mTokens = point.kind === "run-end" ? (writer?.usage0.cacheWrite ?? 0) : 0;
		const m1hTokens = point.kind === "run-end" ? (writer?.usage0.cacheWrite1h ?? 0) : 0;
		if (m1hTokens > 0) driver.used1h = true;

		for (const item of measured) {
			const isWriter = item.armOrderIndex === 0;
			const usage = item.usage0;
			const mDelta =
				point.kind === "run-end" && writer && !isWriter ? usage.cacheRead - writer.usage0.cacheRead - mTokens : null;
			const readable = usage.input + usage.cacheRead + usage.cacheWrite;
			const row = {
				kind: "observation",
				pointId,
				pointIndex,
				pointKind: point.kind,
				runIndex,
				requestIndex: driver.requestIndex - 1,
				arm: item.arm,
				armOrderIndex: item.armOrderIndex,
				lens: OBSERVER_HEAD,
				promptHash: promptHash(item.arm),
				contractHash: contractHash(item.arm),
				capturedPayloadHash: capturedHash,
				capturedPayloadPath: capturedPath,
				prefixTokens,
				input: usage.input,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				cacheWrite1h: usage.cacheWrite1h,
				output: usage.output,
				reasoning: usage.reasoning,
				costTotal: item.usages.reduce((sum, one) => sum + one.cost, 0),
				rawCost: rawCost(sumUsage(item.usages), prices),
				mTokens,
				mDelta,
				isMWriter: isWriter,
				composedCost: composeObservationCost(usage, { mTokens, isWriter, m1hTokens }, prices, item.extra),
				extraUsage: item.extra,
				hitRatio: readable > 0 ? (usage.cacheRead / readable) * 100 : 0,
				providerCalls: item.providerCalls,
				recoveryAttempted: item.recoveryAttempted,
				decision: item.decision,
				delivery: item.decision ? (item.decision.action === "noop" ? "none" : item.decision.action) : null,
				formatValid: item.formatValid,
				parseError: item.parseError,
				responseText: item.responseText,
				stopReason: item.stopReason,
				error: item.error,
				ms: item.ms,
			};
			row.assertionFailures = row.error
				? ["arm call failed"]
				: checkObservationRow(row, { driverPayloadHash: capturedHash, driverUsed1h: driver.used1h });
			row.valid = row.assertionFailures.length === 0;
			if (!row.valid) {
				console.error(`!! ${pointId} ${item.arm}: ${row.assertionFailures.join("; ")}`);
			}
			append(row);
		}

		append({
			kind: "file-state",
			pointId,
			pointIndex,
			pointKind: point.kind,
			runIndex,
			files: snapshotWorkspace(root),
		});

		const summary = measured
			.map((item) => `${item.arm}=${item.decision ? (item.decision.action === "noop" ? "none" : item.decision.action) : "ERR"}`)
			.join(" ");
		console.log(
			`${pointId} ${point.kind} L=${prefixTokens} ${summary} ` +
				`$${measured.reduce((sum, item) => sum + composeObservationCost(item.usage0, { mTokens, isWriter: item.armOrderIndex === 0, m1hTokens }, prices, item.extra), 0).toFixed(4)}`,
		);
		pointIndex++;
	}

	const emit = async (event) => {
		if (event.type === "agent_start") {
			scheduler.onAgentStart();
			driver.newRun = true;
		} else if (event.type === "turn_start") {
			turnIndex++;
		} else if (event.type === "message_end" && event.message?.role === "assistant") {
			const message = event.message;
			const usage = flatUsage(message.usage);
			if (usage.cacheWrite1h > 0) driver.used1h = true;
			driver.prefixTokens = usage.input + usage.cacheRead + usage.cacheWrite;
			append({
				kind: "driver-turn",
				runIndex,
				requestIndex: driver.requestIndex - 1,
				turnIndex,
				firstRequestOfRun: driver.firstOfRun,
				prefixTokens: driver.prefixTokens,
				input: usage.input,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				cacheWrite1h: usage.cacheWrite1h,
				output: usage.output,
				reasoning: usage.reasoning,
				costTotal: usage.cost,
				costComputed: rawCost(usage, prices),
				toolCalls: message.content.filter((block) => block.type === "toolCall").map((block) => block.name),
				stopReason: message.stopReason ?? null,
				error: message.errorMessage ?? null,
				payloadHash: driver.capturedHash,
				payloadPath: driver.capturedPath,
			});
			const point = scheduler.onAssistantMessage(message);
			if (point) await runPoint(point);
		} else if (event.type === "agent_end") {
			const point = scheduler.onAgentEnd(event.messages);
			if (point) await runPoint(point);
		}
	};

	const loopOptions = {
		...options,
		convertToLlm: (messages) => messages,
		shouldStopAfterTurn: ({ newMessages }) =>
			newMessages.filter((message) => message.role === "assistant").length >= maxTurnsPerRun,
	};

	for (const [index, text] of task.prompts.entries()) {
		runIndex = index;
		const prompt = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
		const produced = await runAgentLoop([prompt], context, loopOptions, emit, undefined, streamFn);
		context = { ...context, messages: [...context.messages, ...produced] };
	}

	append({
		kind: "cell-end",
		workspace: root,
		points: pointIndex,
		driverRequests: driver.requestIndex,
		hydraToolCalls: hydraCalls.length,
		finalFiles: snapshotWorkspace(root),
	});
	console.error(`${task.id}/${config}: ${pointIndex} points, ${driver.requestIndex} driver requests, workspace ${root}`);
}

// Only run the matrix when executed directly: the pre-spend invariant check
// imports the pure helpers above, and importing a module must never spend.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
