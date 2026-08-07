#!/usr/bin/env node
/** Replay-safe expanded-2Q judging over frozen observer-authored findings. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { argOf } from "./lib.mjs";
import { sha16, sha256Hex } from "./fingerprints.mjs";
import { buildDualCatalogView, dualCatalogHashes, loadFalsePositiveCatalog, loadRealCatalog } from "./dual-catalog.mjs";
import {
	buildDualCatalogJudgePrompt,
	dualCatalogJudgeBuilderHash,
	dualCatalogJudgeSystemHash,
	parseDualCatalogJudgments,
} from "./dual-catalog-judge-protocol.mjs";
import {
	buildFindingItems,
	fileStateFor,
	recoverRunEndAssistant,
	visiblePayload,
	visiblePiAssistant,
} from "./capstone-trajectory-judge-protocol.mjs";
import { PI_REPLAY_TRANSPORT, createPiReplayJudgeTransport, piReplayTransformHash } from "./pi-replay-judge-transport.mjs";

export const DUAL_CATALOG_PROTOCOL = "expanded-2q-findings-v1";
export const DUAL_CATALOG_JUDGES = Object.freeze({
	sol: { provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "high" },
	opus: { provider: "anthropic", model: "claude-opus-5", reasoning: "high" },
});

function atomicWriteJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(temporary, path);
}

function pointGroups(items) {
	const groups = new Map();
	for (const item of items) {
		if (!groups.has(item.pointKey)) groups.set(item.pointKey, []);
		groups.get(item.pointKey).push(item);
	}
	return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function assertMetadata(actual, expected, outputPath) {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(`${outputPath}: checkpoint metadata differs from this run; use fresh output rather than pooling protocols, catalogs, carriers, or inputs`);
	}
}

function accounted(state, sourceKey) {
	return state.judgments[sourceKey] || state.unjudgeable[sourceKey] || state.invalidOutputs[sourceKey];
}

function batchEvidence(rows, payloadDir, pointKey, pending) {
	const payloadFiles = new Set(pending.map((item) => item.capturedPayloadFile));
	const payloadHashes = new Set(pending.map((item) => item.capturedPayloadHash));
	if (payloadFiles.size !== 1 || payloadHashes.size !== 1) throw new Error(`${pointKey}: findings disagree on captured payload`);
	const payloadPath = join(payloadDir, [...payloadFiles][0]);
	const payloadBytes = readFileSync(payloadPath);
	const payloadHash = sha256Hex(payloadBytes).slice(0, 16);
	if (payloadHash !== [...payloadHashes][0]) throw new Error(`${pointKey}: payload hash ${payloadHash} does not match frozen row`);
	const payload = JSON.parse(payloadBytes.toString());
	let visibleTranscript = visiblePayload(payload);
	if (pending[0].pointKind === "run-end") {
		const frozenPoint = rows.find((row) => row.kind === "file-state" && [row.runId, row.trajectoryId, row.config, row.pointId].join("/") === pointKey);
		const nextTurn = rows.find((row) => row.kind === "driver-turn" && row.runId === pending[0].runId &&
			row.trajectoryId === pending[0].task && row.config === pending[0].config && row.requestIndex === pending[0].requestIndex + 1);
		let assistantText = frozenPoint?.assistantMessage ? visiblePiAssistant(frozenPoint.assistantMessage) : "";
		if (!assistantText && nextTurn?.payloadPath) {
			const nextBytes = readFileSync(join(payloadDir, basename(nextTurn.payloadPath)));
			if (sha256Hex(nextBytes).slice(0, 16) !== nextTurn.payloadHash) throw new Error(`${pointKey}: next payload hash mismatch`);
			const assistant = recoverRunEndAssistant(payload, JSON.parse(nextBytes.toString()));
			assistantText = assistant ? visiblePayload({ input: assistant }) : "";
		}
		if (!assistantText) return { payloadHash, visibleTranscript: null, files: null, reason: "unjudgeable-missing-final-assistant" };
		visibleTranscript += `\n\nRUN-END ASSISTANT RESPONSE\n${assistantText}`;
	}
	return { payloadHash, visibleTranscript, files: fileStateFor(rows, pointKey), reason: null };
}

function beginAttempt(state, outputPath, { pointKey, phase, promptHash, sourceKeys }) {
	const attempt = { pointKey, phase, promptHash, sourceKeys, startedAt: new Date().toISOString(), status: "started" };
	state.attempts.push(attempt);
	atomicWriteJson(outputPath, state);
	return attempt;
}

function finishAttempt(state, outputPath, attempt, response) {
	attempt.status = response.error ? "transport-error" : "answered";
	attempt.finishedAt = new Date().toISOString();
	attempt.error = response.error ?? null;
	attempt.response = response.text ?? "";
	attempt.raw = response.raw ?? null;
	attempt.usage = response.usage ?? null;
	attempt.invalid = response.invalid ?? null;
	atomicWriteJson(outputPath, state);
}

async function askTransport(transport, request, prior = null) {
	try {
		return await transport.ask(request, prior);
	} catch (error) {
		return { text: "", error: error instanceof Error ? error.message : String(error), raw: null, usage: null };
	}
}

function sameSourceKeys(left, right) {
	return Array.isArray(left) && Array.isArray(right) && JSON.stringify(left) === JSON.stringify(right);
}

function matchingAttempts(state, { pointKey, phase, promptHash, sourceKeys }) {
	return state.attempts.filter((attempt) => attempt.pointKey === pointKey && attempt.phase === phase &&
		attempt.promptHash === promptHash && sameSourceKeys(attempt.sourceKeys, sourceKeys));
}

function savedResponse(attempt) {
	return {
		text: attempt.response ?? "",
		error: null,
		raw: attempt.raw ?? null,
		usage: attempt.usage ?? null,
		invalid: attempt.invalid ?? null,
	};
}

async function performAttempt(state, outputPath, transport, request, descriptor, prior, retryAmbiguous) {
	const priorAttempts = matchingAttempts(state, descriptor);
	const answered = priorAttempts.findLast((attempt) => attempt.status === "answered");
	if (answered) return { response: savedResponse(answered), reused: true };
	const ambiguous = priorAttempts.findLast((attempt) => attempt.status === "started");
	if (ambiguous && !retryAmbiguous) {
		throw new Error(`${descriptor.pointKey}: ${descriptor.phase} call may have been sent before the crash; rerun with explicit retryAmbiguous authorization`);
	}
	if (ambiguous) {
		ambiguous.status = "abandoned-explicit-retry";
		ambiguous.finishedAt = new Date().toISOString();
		atomicWriteJson(outputPath, state);
	}
	const attempt = beginAttempt(state, outputPath, descriptor);
	const response = await askTransport(transport, request, prior);
	finishAttempt(state, outputPath, attempt, response);
	if (response.error) {
		state.failures.push({ timestamp: new Date().toISOString(), ...descriptor, error: response.error });
		atomicWriteJson(outputPath, state);
		throw new Error(`${descriptor.pointKey}: ${descriptor.phase} transport failed; checkpoint preserved in ${outputPath}`);
	}
	return { response, reused: false };
}

function validateTransport(transport, judgeName, judge) {
	if (transport?.name !== PI_REPLAY_TRANSPORT || transport?.judgeName !== judgeName || transport?.provider !== judge.provider ||
		transport?.model !== judge.model || transport?.reasoning !== judge.reasoning) {
		throw new Error(`${judgeName}: transport identity differs from the registered Pi replay judge`);
	}
	if (transport.transformHash !== piReplayTransformHash()) throw new Error(`${judgeName}: Pi replay transform hash differs from this implementation`);
	const shape = transport.shapeIdentity;
	if (!shape || typeof shape.archive !== "string" || !shape.archive || typeof shape.member !== "string" || !shape.member ||
		!/^[0-9a-f]{64}$/.test(shape.sha256 ?? "")) {
		throw new Error(`${judgeName}: invalid frozen carrier shape identity`);
	}
	if (!transport.routeIdentity || !/^[0-9a-f]{64}$/.test(transport.routeIdentity.packageLockSha256 ?? "") ||
		typeof transport.routeIdentity.api !== "string") {
		throw new Error(`${judgeName}: invalid frozen Pi route identity`);
	}
}

function storeJudgments({ state, built, parsed, catalog, judgeName, promptHash, evidenceHash }) {
	const realByKey = new Map(catalog.real.map((item) => [item.key, item.id]));
	const falseByKey = new Map(catalog.false.map((item) => [item.key, item.id]));
	for (let index = 0; index < built.ordered.length; index++) {
		const source = built.ordered[index];
		const { judgeMessage: _judgeMessage, ...frozenSource } = source;
		const answer = parsed[index];
		state.judgments[source.sourceKey] = {
			...frozenSource,
			judge: judgeName,
			promptHash,
			evidenceHash,
			realMatches: answer.realMatches.map((key) => ({ catalogKey: key, issueId: realByKey.get(key) })),
			falseMatches: answer.falseMatches.map((key) => ({ catalogKey: key, issueId: falseByKey.get(key) })),
			quote: answer.quote,
			unmatched: answer.unmatched,
			reasoning: answer.reasoning,
		};
	}
}

function terminalInvalid(state, built, { judgeName, pointKey, promptHash, evidenceHash, firstResponse, lastResponse, reason }) {
	for (const source of built.ordered) {
		const { judgeMessage: _judgeMessage, ...frozenSource } = source;
		state.invalidOutputs[source.sourceKey] = {
			...frozenSource,
			judge: judgeName,
			promptHash,
			evidenceHash,
			reason,
			firstResponse,
			lastResponse,
			pointKey,
		};
	}
}

export async function executeDualCatalogJudgePass({
	rows,
	realCatalog,
	falseCatalog,
	payloadDir,
	outputPath,
	judgeName,
	transport,
	inputIdentity,
	eligibilityPolicy = "semantic-v2",
	expectedFindings = null,
	pointFilter = null,
	retryAmbiguous = false,
}) {
	const judge = DUAL_CATALOG_JUDGES[judgeName];
	if (!judge) throw new Error(`unknown expanded-2Q judge: ${judgeName}`);
	validateTransport(transport, judgeName, judge);
	if (!inputIdentity || typeof inputIdentity !== "object" || Array.isArray(inputIdentity)) throw new Error("inputIdentity must be an object");
	if (typeof retryAmbiguous !== "boolean") throw new Error("retryAmbiguous must be boolean");
	const items = buildFindingItems(rows, { eligibilityPolicy });
	if (expectedFindings !== null && items.length !== expectedFindings) {
		throw new Error(`expected ${expectedFindings} judgeable findings under ${eligibilityPolicy}, found ${items.length}`);
	}
	const inScope = pointFilter ? items.filter((item) => pointFilter.has(item.pointKey)) : items;
	if (pointFilter && inScope.length === 0) throw new Error("point filter matches no judgeable findings");
	const tasks = [...new Set(items.map((item) => item.task))].sort();
	const catalogs = Object.fromEntries(tasks.map((task) => [task, buildDualCatalogView(realCatalog, falseCatalog, task)]));
	const hashes = dualCatalogHashes(realCatalog, falseCatalog);
	const metadata = {
		protocol: DUAL_CATALOG_PROTOCOL,
		judge: judgeName,
		judgeProvider: judge.provider,
		judgeModel: judge.model,
		judgeReasoning: judge.reasoning,
		judgeTransport: transport.name,
		judgeShape: transport.shapeIdentity,
		judgeRoute: transport.routeIdentity,
		judgeReplayTransformHash: transport.transformHash,
		judgeSystemHash: dualCatalogJudgeSystemHash(),
		judgeBuilderHash: dualCatalogJudgeBuilderHash(),
		eligibilityPolicy,
		expectedFindings,
		realCatalogVersion: hashes.realVersion,
		falseCatalogVersion: hashes.falseVersion,
		catalogHashes: hashes.perTask,
		inputIdentity: structuredClone(inputIdentity),
	};
	const state = existsSync(outputPath)
		? JSON.parse(readFileSync(outputPath, "utf8"))
		: { metadata, status: "in-progress", judgments: {}, unjudgeable: {}, invalidOutputs: {}, batches: [], attempts: [], failures: [], corrections: {} };
	assertMetadata(state.metadata, metadata, outputPath);
	state.unjudgeable ??= {};
	state.invalidOutputs ??= {};
	state.attempts ??= [];
	state.corrections ??= {};

	for (const [pointKey, pointItems] of pointGroups(inScope)) {
		const pending = pointItems.filter((item) => !accounted(state, item.sourceKey));
		if (pending.length === 0) continue;
		const evidence = batchEvidence(rows, payloadDir, pointKey, pending);
		if (evidence.reason) {
			for (const item of pending) state.unjudgeable[item.sourceKey] = { ...item, reason: evidence.reason };
			atomicWriteJson(outputPath, state);
			continue;
		}
		const catalog = catalogs[pending[0].task];
		const built = buildDualCatalogJudgePrompt({ items: pending, visibleTranscript: evidence.visibleTranscript, files: evidence.files, catalog });
		const promptHash = sha16(`${built.systemPrompt}\n<<<USER>>>\n${built.userPrompt}`);
		const evidenceHash = sha16(`${evidence.visibleTranscript}\n${evidence.files}`);
		const request = { systemPrompt: built.systemPrompt, userPrompt: built.userPrompt };
		const sourceKeys = built.ordered.map((item) => item.sourceKey);
		const started = Date.now();

		let response;
		let parsed;
		let recovered = false;
		let firstResponse;
		let invalidReason = null;
		const correction = state.corrections[pointKey];
		if (correction) {
			recovered = true;
			firstResponse = correction.firstResponse;
			({ response } = await performAttempt(
				state, outputPath, transport, request,
				{ pointKey, phase: "format-correction", promptHash, sourceKeys },
				{ text: correction.firstResponse, raw: correction.raw }, retryAmbiguous,
			));
			invalidReason = response.invalid;
			parsed = invalidReason ? null : parseDualCatalogJudgments(response.text, built.ordered, catalog);
		} else {
			({ response } = await performAttempt(
				state, outputPath, transport, request,
				{ pointKey, phase: "initial", promptHash, sourceKeys }, null, retryAmbiguous,
			));
			firstResponse = response.text;
			invalidReason = response.invalid;
			parsed = invalidReason ? null : parseDualCatalogJudgments(response.text, built.ordered, catalog);
			if (!parsed && !invalidReason) {
				state.corrections[pointKey] = { promptHash, sourceKeys, firstResponse: response.text, raw: response.raw };
				atomicWriteJson(outputPath, state);
				recovered = true;
				({ response } = await performAttempt(
					state, outputPath, transport, request,
					{ pointKey, phase: "format-correction", promptHash, sourceKeys },
					{ text: firstResponse, raw: response.raw }, retryAmbiguous,
				));
				invalidReason = response.invalid;
				parsed = invalidReason ? null : parseDualCatalogJudgments(response.text, built.ordered, catalog);
			}
		}

		if (parsed) {
			storeJudgments({ state, built, parsed, catalog, judgeName, promptHash, evidenceHash });
		} else {
			terminalInvalid(state, built, {
				judgeName, pointKey, promptHash, evidenceHash, firstResponse, lastResponse: response.text,
				reason: invalidReason ?? "invalid-output-after-one-correction",
			});
		}
		delete state.corrections[pointKey];
		state.batches.push({
			pointKey, promptHash, evidenceHash, sourceKeys, payloadHash: evidence.payloadHash,
			evidence: { visibleTranscript: evidence.visibleTranscript, files: evidence.files },
			recovered, terminal: parsed ? "judged" : "invalid-output", batchMs: Date.now() - started,
			firstResponse, finalResponse: response.text,
		});
		atomicWriteJson(outputPath, state);
	}

	const total = Object.keys(state.judgments).length + Object.keys(state.unjudgeable).length + Object.keys(state.invalidOutputs).length;
	state.status = total === inScope.length
		? (Object.keys(state.unjudgeable).length || Object.keys(state.invalidOutputs).length ? "complete-with-exceptions" : "complete")
		: "in-progress";
	if (state.status !== "in-progress") state.completedAt ??= new Date().toISOString();
	atomicWriteJson(outputPath, state);
	return state;
}

function rowsGz(path) {
	return gunzipSync(readFileSync(path)).toString().trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function main() {
	const args = process.argv.slice(2);
	const rowsPath = argOf(args, "--rows-gz", "");
	const payloadDir = argOf(args, "--payload-dir", "");
	const payloadsTarPath = argOf(args, "--payloads-tar", "");
	const realPath = argOf(args, "--real-catalog", "experiments/golden-dataset.json");
	const falsePath = argOf(args, "--false-catalog", "experiments/false-positive-catalog.json");
	const outputPath = argOf(args, "--output", "");
	const judgeName = argOf(args, "--judge", "sol");
	const shapePayloadPath = argOf(args, "--shape-payload", "");
	const shapeArchive = argOf(args, "--shape-archive", "");
	const shapeMember = argOf(args, "--shape-member", "");
	const eligibilityPolicy = argOf(args, "--eligibility-policy", "semantic-v2");
	const pointsFilePath = argOf(args, "--points-file", "");
	const expectedArg = argOf(args, "--expected-findings", "");
	const expectedFindings = expectedArg === "" ? null : Number.parseInt(expectedArg, 10);
	if (!rowsPath || !payloadDir || !payloadsTarPath || !outputPath || !shapePayloadPath || !shapeArchive || !shapeMember) {
		throw new Error("--rows-gz, --payload-dir, --payloads-tar, --shape-payload, --shape-archive, --shape-member and --output are required");
	}
	const judge = DUAL_CATALOG_JUDGES[judgeName];
	if (!judge) throw new Error(`unknown expanded-2Q judge: ${judgeName}`);
	if (expectedFindings !== null && (!Number.isInteger(expectedFindings) || expectedFindings < 0)) throw new Error("--expected-findings must be non-negative");
	const rowsBytes = readFileSync(rowsPath);
	const realBytes = readFileSync(realPath);
	const falseBytes = readFileSync(falsePath);
	const payloadsBytes = readFileSync(payloadsTarPath);
	let pointFilter = null;
	const filterIdentity = {};
	if (pointsFilePath) {
		const bytes = readFileSync(pointsFilePath);
		const points = JSON.parse(bytes.toString());
		if (!Array.isArray(points) || points.some((point) => typeof point !== "string")) throw new Error("--points-file must contain pointKey strings");
		pointFilter = new Set(points);
		filterIdentity.pointsFile = basename(pointsFilePath);
		filterIdentity.pointsSha256 = sha256Hex(bytes);
	}
	const transport = await createPiReplayJudgeTransport({ judgeName, ...judge, shapePayloadPath, shapeArchive, shapeMember });
	const state = await executeDualCatalogJudgePass({
		rows: rowsGz(rowsPath),
		realCatalog: loadRealCatalog(realPath),
		falseCatalog: loadFalsePositiveCatalog(falsePath),
		payloadDir, outputPath, judgeName, transport, eligibilityPolicy, expectedFindings, pointFilter,
		retryAmbiguous: args.includes("--retry-ambiguous"),
		inputIdentity: {
			rowsFile: basename(rowsPath), rowsSha256: sha256Hex(rowsBytes),
			payloadsFile: basename(payloadsTarPath), payloadsSha256: sha256Hex(payloadsBytes),
			realCatalogFile: basename(realPath), realCatalogSha256: sha256Hex(realBytes),
			falseCatalogFile: basename(falsePath), falseCatalogSha256: sha256Hex(falseBytes),
			...filterIdentity,
		},
	});
	process.stdout.write(`${state.status}: ${Object.keys(state.judgments).length} judged, ${Object.keys(state.unjudgeable).length} unjudgeable, ${Object.keys(state.invalidOutputs).length} invalid, ${state.batches.length} batches\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
