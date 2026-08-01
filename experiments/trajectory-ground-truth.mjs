#!/usr/bin/env node
/**
 * Ground truth for the trajectory benchmark, derived from the bytes the head
 * actually conditioned on (`artifacts/wave8-designs/wave8-quality.md` §2).
 *
 * Anchored on the defective EXPRESSION, never the identifier. `grep -n claimNext`
 * prints the name with none of the defective body; an `ls` reveals the file and
 * nothing about it. Identifier visibility would corrupt both the recall
 * denominator and the latency zero point, so a defect becomes live only when the
 * defective expression itself enters the payload.
 *
 * The same discipline governs the other end of the window. A window closes only
 * on a chunk that shows the defect's own DECLARATION without the defective
 * expression — the region was on screen and the defect was not in it. Closing on
 * the bare identifier would end the window at the first `import { claimNext }`
 * or doc sentence, emptying the live set as soon as the driver opens a second
 * file and manufacturing quiet spans out of ordinary reads.
 *
 * Two derivations, deliberately kept separate:
 *
 *   payload  (PRIMARY)  the last authoritative chunk of the captured provider
 *                       payload that shows the defect's region decides whether
 *                       it is live or fixed at that point. This is what the
 *                       observer saw.
 *   files    (CHECK)    the workspace file-state timeline the runner records at
 *                       every point (`snapshot()` pattern,
 *                       `acting-channel-smoke.mjs:111`). Exact, but it is the
 *                       state of the disk, not of the head's view.
 *
 * They can legitimately disagree: a driver that repairs the defect with a
 * surgical `edit` whose `newText` carries neither the expression nor the anchor
 * leaves the payload's last authoritative chunk stale, while the disk is already
 * fixed. Every disagreement is printed, and the ~10 mandatory manual
 * confirmations (Q0a) are exactly where a human or agent settles them. Nothing
 * here silently picks a winner.
 *
 * Usage:
 *   node experiments/trajectory-ground-truth.mjs --rows rows.jsonl            # table
 *   node experiments/trajectory-ground-truth.mjs --rows rows.jsonl \
 *     --defect sched-claim-toctou --trajectory scheduler --config opus-high   # excerpts
 *   node experiments/trajectory-ground-truth.mjs --rows rows.jsonl \
 *     --record confirmations.jsonl --trajectory scheduler --config opus-high \
 *     --defect sched-claim-toctou --verdict ok --by andreas
 *   node experiments/trajectory-ground-truth.mjs --rows rows.jsonl \
 *     --confirmations confirmations.jsonl                                     # Q0a gate
 *
 * Zero provider calls.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argOf } from "./lib.mjs";
import { defectsOf, taskById } from "./trajectory-cost-tasks.mjs";

/** Mandatory manual confirmations before any judging (spec Q0a). */
export const REQUIRED_CONFIRMATIONS = 10;

export function compileDefect(defect) {
	return {
		...defect,
		regex: new RegExp(defect.expression),
		declarationRegex: new RegExp(defect.declaration),
	};
}

// ---------------------------------------------------------------------------
// Payload chunking.
// ---------------------------------------------------------------------------

function blockText(block) {
	if (typeof block === "string") return block;
	if (block?.type === "text") return block.text ?? "";
	if (block?.type === "thinking") return block.thinking ?? block.text ?? "";
	return "";
}

function toolResultText(block) {
	const content = block?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map(blockText).join("\n");
	return "";
}

/**
 * Flatten an Anthropic payload into decidable chunks.
 *
 * `authoritative` marks a chunk that may decide a defect's state. A tool call's
 * arguments are not authoritative: an `edit` whose `oldText` still carries the
 * defective expression is the driver REMOVING it, and counting that as evidence
 * the defect is live would make every fix look like a re-plant. The replacement
 * text is authoritative, and so is anything the driver read back.
 *
 * `edit` arguments are normalized the way the tool itself normalizes them
 * (`pi-coding-agent/dist/core/tools/edit.js:33-49`): models also send `edits` as
 * a JSON string, and the legacy singular `{oldText, newText}` shape. Those reach
 * the workspace as real edits, so a fix delivered that way has to register here
 * too — otherwise the payload derivation misses exactly the fixes the file-state
 * derivation sees, in the same one-directional way an identifier match does.
 */
export function normalizeEditInput(input) {
	if (!input || typeof input !== "object") return null;
	let edits = input.edits;
	if (typeof edits === "string") {
		try {
			const parsed = JSON.parse(edits);
			edits = Array.isArray(parsed) ? parsed : undefined;
		} catch {
			edits = undefined;
		}
	}
	const normalized = Array.isArray(edits) ? [...edits] : [];
	if (typeof input.oldText === "string" && typeof input.newText === "string") {
		normalized.push({ oldText: input.oldText, newText: input.newText });
	}
	return normalized.length > 0 ? normalized : null;
}

export function payloadChunks(payload) {
	const chunks = [];
	for (const [messageIndex, message] of (payload?.messages ?? []).entries()) {
		const content = Array.isArray(message?.content) ? message.content : [{ type: "text", text: String(message?.content ?? "") }];
		for (const [blockIndex, block] of content.entries()) {
			const base = { messageIndex, blockIndex, role: message?.role ?? "?" };
			if (block?.type === "tool_use") {
				const input = block.input ?? {};
				const edits = block.name === "edit" ? normalizeEditInput(input) : null;
				if (block.name === "write" && typeof input.content === "string") {
					chunks.push({ ...base, kind: "write", authoritative: true, text: input.content });
				} else if (edits) {
					chunks.push({
						...base,
						kind: "edit-new",
						authoritative: true,
						text: edits.map((edit) => edit?.newText ?? "").join("\n"),
					});
					chunks.push({
						...base,
						kind: "edit-old",
						authoritative: false,
						text: edits.map((edit) => edit?.oldText ?? "").join("\n"),
					});
				} else {
					chunks.push({ ...base, kind: "tool-args", authoritative: false, text: JSON.stringify(input) });
				}
			} else if (block?.type === "tool_result") {
				chunks.push({ ...base, kind: "tool-result", authoritative: true, text: toolResultText(block) });
			} else {
				const text = blockText(block);
				if (text) chunks.push({ ...base, kind: block?.type ?? "text", authoritative: true, text });
			}
		}
	}
	return chunks;
}

/**
 * The defect's state as the payload shows it: the LAST authoritative chunk that
 * either carries the defective expression (live) or shows the region without it
 * (fixed). `null` when the payload has never shown the region at all.
 */
export function defectStateInPayload(payload, defect) {
	const regex = defect.regex ?? new RegExp(defect.expression);
	const declarationRegex = defect.declarationRegex ?? new RegExp(defect.declaration);
	let state = null;
	for (const chunk of payloadChunks(payload)) {
		if (!chunk.authoritative) continue;
		if (regex.test(chunk.text)) state = { state: "live", chunk };
		else if (declarationRegex.test(chunk.text)) state = { state: "fixed", chunk };
	}
	return state;
}

export function defectStateInFiles(files, defect) {
	const content = files?.[defect.file];
	if (content === undefined) return { state: "absent", content: null };
	const regex = defect.regex ?? new RegExp(defect.expression);
	return { state: regex.test(content) ? "live" : "fixed", content };
}

// ---------------------------------------------------------------------------
// Row loading.
// ---------------------------------------------------------------------------

export function readRows(path) {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

/**
 * One cell's rows, from the attempt that reached `cell-end`. Partial attempts
 * are dropped whole: a driver run that stopped mid-trajectory has no points
 * after the break and averaging it in would understate every trajectory sum.
 */
export function cellsOf(rows) {
	const complete = new Map();
	for (const row of rows) {
		if (row.kind !== "cell-end") continue;
		const key = `${row.trajectoryId}/${row.config}`;
		complete.set(key, Math.max(complete.get(key) ?? 0, row.attempt));
	}
	const cells = new Map();
	for (const row of rows) {
		const key = `${row.trajectoryId}/${row.config}`;
		if (complete.get(key) !== row.attempt) continue;
		if (!cells.has(key)) {
			cells.set(key, { key, trajectoryId: row.trajectoryId, config: row.config, attempt: row.attempt, rows: [] });
		}
		cells.get(key).rows.push(row);
	}
	return [...cells.values()];
}

export function pointsOf(cell) {
	const byPoint = new Map();
	for (const row of cell.rows) {
		if (row.kind !== "observation" && row.kind !== "file-state") continue;
		if (!byPoint.has(row.pointId)) {
			byPoint.set(row.pointId, {
				pointId: row.pointId,
				pointIndex: row.pointIndex,
				pointKind: row.pointKind,
				runIndex: row.runIndex,
				observations: [],
				files: null,
				payloadPath: null,
			});
		}
		const point = byPoint.get(row.pointId);
		if (row.kind === "observation") {
			point.observations.push(row);
			point.payloadPath = row.capturedPayloadPath;
			point.payloadHash = row.capturedPayloadHash;
			point.prefixTokens = row.prefixTokens;
		} else {
			point.files = row.files;
		}
	}
	return [...byPoint.values()].sort((a, b) => a.pointIndex - b.pointIndex);
}

function loadPayload(point) {
	if (!point.payloadPath || !existsSync(point.payloadPath)) return null;
	return JSON.parse(readFileSync(point.payloadPath, "utf8"));
}

// ---------------------------------------------------------------------------
// Derivation.
// ---------------------------------------------------------------------------

/**
 * `firstVisible` / `firstFixed` per defect, both derivations, plus the quiet
 * spans that follow from the payload derivation. `points` may carry a
 * pre-loaded `payload` (the check does that); otherwise payloads are read from
 * the snapshot files the runner wrote.
 */
export function deriveGroundTruth(points, defects) {
	const compiled = defects.map(compileDefect);
	const perDefect = compiled.map((defect) => {
		const timeline = points.map((point) => {
			const payload = point.payload ?? loadPayload(point);
			return {
				pointIndex: point.pointIndex,
				pointId: point.pointId,
				payload: payload ? defectStateInPayload(payload, defect) : null,
				files: point.files ? defectStateInFiles(point.files, defect) : null,
			};
		});
		const firstIndexWhere = (predicate) => {
			const hit = timeline.find(predicate);
			return hit ? hit.pointIndex : null;
		};
		const firstVisible = firstIndexWhere((entry) => entry.payload?.state === "live");
		const firstFixed =
			firstVisible === null
				? null
				: firstIndexWhere((entry) => entry.pointIndex > firstVisible && entry.payload?.state === "fixed");
		const firstVisibleFiles = firstIndexWhere((entry) => entry.files?.state === "live");
		const firstFixedFiles =
			firstVisibleFiles === null
				? null
				: firstIndexWhere((entry) => entry.pointIndex > firstVisibleFiles && entry.files?.state === "fixed");
		return {
			id: defect.id,
			file: defect.file,
			kind: defect.kind,
			identifier: defect.identifier,
			declaration: defect.declaration,
			expression: defect.expression,
			target: defect.target,
			firstVisible,
			firstFixed,
			firstVisibleFiles,
			firstFixedFiles,
			// Only `firstFixed` is comparable across the two derivations. A planted
			// defect is on disk from point 0 by construction, so `firstVisibleFiles`
			// is 0 for every defect while `firstVisible` is necessarily later —
			// comparing those would mark all ten as disagreeing and drown the one
			// disagreement that carries information (a fix the payload never showed).
			agrees: firstVisibleFiles !== 0 ? firstVisible === firstVisibleFiles && firstFixed === firstFixedFiles : firstFixed === firstFixedFiles,
			livenessWindow: firstVisible === null ? [] : [firstVisible, firstFixed ?? Number.POSITIVE_INFINITY],
			timeline,
		};
	});

	const liveAt = (pointIndex) =>
		perDefect.filter(
			(defect) =>
				defect.firstVisible !== null &&
				pointIndex >= defect.firstVisible &&
				(defect.firstFixed === null || pointIndex < defect.firstFixed),
		);

	const quiet = points.map((point) => ({ pointIndex: point.pointIndex, live: liveAt(point.pointIndex).map((d) => d.id) }));
	const spans = [];
	let open = null;
	for (const entry of quiet) {
		if (entry.live.length === 0) {
			open = open ?? { from: entry.pointIndex, to: entry.pointIndex };
			open.to = entry.pointIndex;
		} else if (open) {
			spans.push(open);
			open = null;
		}
	}
	if (open) spans.push(open);

	return {
		defects: perDefect,
		liveByPoint: quiet,
		quietSpans: spans.map((span) => ({ ...span, length: span.to - span.from + 1 })),
		longestQuietSpan: spans.reduce((longest, span) => Math.max(longest, span.to - span.from + 1), 0),
	};
}

/**
 * Q0a corpus-validity gate, evaluated per cell.
 *
 * The spec's "~10 manual confirmations (one per defect per trajectory)" is a
 * STUDY-scope count: 10 is the size of the whole planted list, spread over three
 * trajectories of 4/3/3. No single cell can reach ten, so the per-cell
 * requirement is that cell's own derived defect count, counted by DISTINCT
 * defect id — confirming one defect ten times is not ten confirmations.
 * `REQUIRED_CONFIRMATIONS` stays as the study-wide roll-up.
 *
 * Every defect must carry a liveness window, not merely one of them: a corpus
 * where the driver never sees half the plants cannot support a recall
 * denominator, and the ids that were never visible are listed so the failure is
 * legible rather than a bare false.
 */
export function corpusValidity(derived, confirmations = []) {
	const withWindow = derived.defects.filter((defect) => defect.firstVisible !== null);
	const confirmedIds = new Set(confirmations.filter((entry) => entry.verdict === "ok").map((entry) => entry.defect));
	const required = derived.defects.length;
	const passed = derived.defects.filter((defect) => confirmedIds.has(defect.id)).length;
	return {
		defectsWithLivenessWindow: withWindow.length,
		defectsNeverVisible: derived.defects.filter((defect) => defect.firstVisible === null).map((defect) => defect.id),
		longestQuietSpan: derived.longestQuietSpan,
		derivationDisagreements: derived.defects.filter((defect) => !defect.agrees).map((defect) => defect.id),
		confirmationsPassed: passed,
		confirmationsRequired: required,
		confirmationsUnconfirmed: derived.defects.filter((defect) => !confirmedIds.has(defect.id)).map((defect) => defect.id),
		studyWideRequired: REQUIRED_CONFIRMATIONS,
		pass: withWindow.length === required && derived.longestQuietSpan >= 3 && passed === required,
	};
}

// ---------------------------------------------------------------------------
// Manual-confirmation helper.
// ---------------------------------------------------------------------------

export function excerptAround(text, regexOrString, radius = 300) {
	if (typeof text !== "string") return "";
	const index =
		typeof regexOrString === "string" ? text.indexOf(regexOrString) : (text.match(regexOrString)?.index ?? -1);
	if (index === -1) return text.slice(0, radius * 2);
	return text.slice(Math.max(0, index - radius), index + radius);
}

function printExcerpts(defect, radius) {
	const compiled = compileDefect(defect.rawDefect ?? defect);
	console.log(`\n=== ${defect.id} (${defect.file}, ${defect.kind})`);
	console.log(`target: ${defect.target}`);
	console.log(`expression: /${defect.expression}/   declaration: /${defect.declaration}/   identifier: ${defect.identifier}`);
	console.log(
		`payload: firstVisible=${defect.firstVisible} firstFixed=${defect.firstFixed}   ` +
			`files: firstVisible=${defect.firstVisibleFiles} firstFixed=${defect.firstFixedFiles}`,
	);
	for (const [label, pointIndex] of [
		["firstVisible", defect.firstVisible],
		["firstFixed", defect.firstFixed],
	]) {
		if (pointIndex === null) {
			console.log(`\n-- ${label}: none derived`);
			continue;
		}
		const entry = defect.timeline.find((item) => item.pointIndex === pointIndex);
		console.log(`\n-- ${label} at point ${pointIndex} (${entry.pointId})`);
		if (entry.payload) {
			console.log(`   deciding chunk: message ${entry.payload.chunk.messageIndex} block ${entry.payload.chunk.blockIndex} (${entry.payload.chunk.kind}, role ${entry.payload.chunk.role})`);
			console.log(indent(excerptAround(entry.payload.chunk.text, compiled.regex, radius)));
		} else {
			console.log("   no payload available for this point");
		}
		if (entry.files) {
			console.log(`   file state: ${entry.files.state}`);
			if (entry.files.content) console.log(indent(excerptAround(entry.files.content, compiled.regex, Math.min(radius, 200))));
		}
	}
	console.log("\nConfirm with: --record <file> --defect " + defect.id + " --verdict ok|wrong --by <name> [--note ...]");
}

function indent(text) {
	return text
		.split("\n")
		.map((line) => `      | ${line}`)
		.join("\n");
}

async function main() {
	const args = process.argv.slice(2);
	const rowsPath = argOf(args, "--rows", "");
	const trajectoryFilter = argOf(args, "--trajectory", "");
	const configFilter = argOf(args, "--config", "");
	const defectFilter = argOf(args, "--defect", "");
	const recordPath = argOf(args, "--record", "");
	const confirmationsPath = argOf(args, "--confirmations", "");
	const verdict = argOf(args, "--verdict", "");
	const by = argOf(args, "--by", "");
	const note = argOf(args, "--note", "");
	const radius = Number.parseInt(argOf(args, "--excerpt-chars", "300"), 10);
	if (!rowsPath) throw new Error("--rows is required");

	const confirmations = confirmationsPath && existsSync(confirmationsPath) ? readRows(confirmationsPath) : [];
	const cells = cellsOf(readRows(rowsPath)).filter(
		(cell) =>
			(!trajectoryFilter || cell.trajectoryId === trajectoryFilter) && (!configFilter || cell.config === configFilter),
	);
	if (cells.length === 0) throw new Error("no completed cells match the filters");

	for (const cell of cells) {
		const points = pointsOf(cell);
		const derived = deriveGroundTruth(points, taskById(cell.trajectoryId).defects);
		const cellConfirmations = confirmations.filter(
			(entry) => entry.trajectoryId === cell.trajectoryId && entry.config === cell.config,
		);
		console.log(`\n## ${cell.key} (attempt ${cell.attempt}, ${points.length} points)`);
		console.log("defect                          kind         payload[vis,fix]  files[vis,fix]  agree");
		for (const defect of derived.defects) {
			console.log(
				`${defect.id.padEnd(32)}${defect.kind.padEnd(13)}` +
					`${`[${defect.firstVisible ?? "-"},${defect.firstFixed ?? "-"}]`.padEnd(18)}` +
					`${`[${defect.firstVisibleFiles ?? "-"},${defect.firstFixedFiles ?? "-"}]`.padEnd(16)}${defect.agrees ? "yes" : "NO"}`,
			);
		}
		console.log(
			`quiet spans: ${derived.quietSpans.map((span) => `${span.from}-${span.to}(${span.length})`).join(" ") || "none"}`,
		);
		const validity = corpusValidity(derived, cellConfirmations);
		console.log(`Q0a: ${JSON.stringify(validity)}`);

		if (defectFilter) {
			const defect = derived.defects.find((item) => item.id === defectFilter);
			if (!defect) throw new Error(`unknown defect for ${cell.key}: ${defectFilter}`);
			const raw = defectsOf(cell.trajectoryId).find((item) => item.id === defectFilter);
			printExcerpts({ ...defect, rawDefect: raw }, radius);
			if (recordPath) {
				if (verdict !== "ok" && verdict !== "wrong") throw new Error("--verdict must be ok or wrong");
				if (!by) throw new Error("--by is required when recording a confirmation");
				// One confirmation per (cell, defect). Without this, re-recording the
				// same defect would count toward the gate every time and a cell could
				// pass on one defect confirmed N times.
				const alreadyRecorded =
					existsSync(recordPath) &&
					readRows(recordPath).some(
						(entry) =>
							entry.trajectoryId === cell.trajectoryId && entry.config === cell.config && entry.defect === defect.id,
					);
				if (alreadyRecorded) {
					throw new Error(
						`${cell.key}/${defect.id} already has a recorded confirmation; edit ${recordPath} by hand to change it`,
					);
				}
				const row = {
					trajectoryId: cell.trajectoryId,
					config: cell.config,
					attempt: cell.attempt,
					defect: defect.id,
					firstVisible: defect.firstVisible,
					firstFixed: defect.firstFixed,
					firstVisibleFiles: defect.firstVisibleFiles,
					firstFixedFiles: defect.firstFixedFiles,
					verdict,
					by,
					note,
					ts: Date.now(),
				};
				appendFileSync(recordPath, `${JSON.stringify(row)}\n`);
				console.log(`recorded confirmation: ${defect.id} ${verdict} by ${by}`);
			}
		}
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
