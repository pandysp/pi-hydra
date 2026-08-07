#!/usr/bin/env node
/** Replay-safe Sol/Opus judging for frozen real-trajectory deliveries. */

import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { argOf } from "./lib.mjs";
import { sha16, sha256Hex } from "./fingerprints.mjs";
import {
	activeCatalog,
	buildCapstoneJudgePrompt,
	buildFindingItems,
	capstoneJudgeBuilderHash,
	catalogHash,
	fileStateFor,
	parseCapstoneJudgments,
	recoverRunEndAssistant,
	visiblePayload,
	visiblePiAssistant,
} from "./capstone-trajectory-judge-protocol.mjs";

const SYSTEM_PROMPT = "You are an independent software-review benchmark judge.";
const CORRECTION =
	"Your output did not match the required JSON schema or finding count. Preserve every judgment and return only the corrected JSON object.";

const JUDGES = Object.freeze({
	sol: { transport: "pi", provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "high" },
	opus: { transport: "claude-cli", model: "opus", reasoning: "high" },
	// Transport A/B diagnostics (JUDGE-TRANSPORT-AB-SPEC.md): same pinned
	// model, different carrier. Never used for the registered columns.
	// opus-pi-ab replays the captured production request shape directly against
	// /v1/messages (verified to draw plan quota where both the compat shim and
	// the pi binary were refused); it requires --shape-payload.
	"opus-cli-ab": { transport: "claude-cli", model: "claude-opus-5", reasoning: "high" },
	"opus-pi-ab": { transport: "oauth-replay", provider: "anthropic", model: "claude-opus-5", reasoning: "high" },
});

function textOf(message) {
	return (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
}

async function piTransport(spec) {
	const [{ streamSimple }, { resolveModel }] = await Promise.all([
		import("@earendil-works/pi-ai/compat"),
		import("./model-catalog.mjs"),
	]);
	const model = resolveModel(spec.provider, spec.model);
	if (!model) throw new Error(`judge model unavailable: ${spec.model}`);
	const auth = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/auth.json`, "utf8"));
	const credential = auth[spec.provider];
	if (!credential?.access || (typeof credential.expires === "number" && credential.expires < Date.now())) {
		throw new Error(`missing or expired ${spec.provider} login; run pi and log in first`);
	}
	const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
	return {
		model: model.id,
		async ask(prompt, prior = null) {
			const messages = prior
				? [user(prompt), prior.raw, user(CORRECTION)]
				: [user(prompt)];
			const result = await streamSimple(
				model,
				{ systemPrompt: SYSTEM_PROMPT, messages, tools: [] },
				{ apiKey: credential.access, reasoning: spec.reasoning, maxTokens: 5000 },
			).result();
			return { text: textOf(result), error: result.errorMessage ?? null, raw: result };
		},
	};
}

function oauthReplayTransport(spec, shapePath) {
	const shape = JSON.parse(readFileSync(shapePath, "utf8"));
	for (const key of ["model", "max_tokens", "stream", "thinking", "system", "tools"]) {
		if (!(key in shape)) throw new Error(`shape payload missing ${key}`);
	}
	if (shape.system?.[0]?.text !== "You are Claude Code, Anthropic's official CLI for Claude.") {
		throw new Error("shape payload lacks the Claude Code identity system block");
	}
	const auth = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/auth.json`, "utf8"));
	const credential = auth[spec.provider];
	if (!credential?.access || (typeof credential.expires === "number" && credential.expires < Date.now())) {
		throw new Error(`missing or expired ${spec.provider} login; run pi and log in first`);
	}
	return {
		model: shape.model,
		async ask(prompt, prior = null) {
			const text = prior ? `${prompt}\n\nYour prior response was structurally invalid:\n${prior.text}\n\n${CORRECTION}` : prompt;
			const body = {
				model: shape.model,
				max_tokens: shape.max_tokens,
				stream: true,
				thinking: shape.thinking,
				...(shape.output_config ? { output_config: shape.output_config } : {}),
				tools: shape.tools,
				system: [shape.system[0], { type: "text", text: SYSTEM_PROMPT }],
				messages: [{ role: "user", content: [{ type: "text", text }] }],
			};
			try {
				const response = await fetch("https://api.anthropic.com/v1/messages", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${credential.access}`,
						"anthropic-version": "2023-06-01",
						"anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14",
						"anthropic-dangerous-direct-browser-access": "true",
					},
					body: JSON.stringify(body),
				});
				const bytes = await response.text();
				if (!response.ok) return { text: "", error: `${response.status} ${bytes.slice(0, 400)}`, raw: bytes };
				let out = "";
				let streamError = null;
				for (const line of bytes.split("\n")) {
					if (!line.startsWith("data:")) continue;
					const payload = line.slice(5).trim();
					if (!payload || payload === "[DONE]") continue;
					let event;
					try {
						event = JSON.parse(payload);
					} catch {
						continue;
					}
					if (event.type === "content_block_delta" && event.delta?.type === "text_delta") out += event.delta.text;
					if (event.type === "error") streamError = event.error?.message ?? "stream error";
				}
				return { text: out, error: streamError, raw: bytes };
			} catch (error) {
				return { text: "", error: String(error), raw: null };
			}
		},
	};
}

function claudeCliTransport(spec, timeoutMs) {
	return {
		model: spec.model,
		async ask(prompt, prior = null) {
			const text = prior ? `${prompt}\n\nYour prior response was structurally invalid:\n${prior.text}\n\n${CORRECTION}` : prompt;
			return new Promise((resolve) => {
				const child = spawn("claude", [
					"-p",
					"--safe-mode",
					"--no-session-persistence",
					"--disable-slash-commands",
					"--tools",
					"",
					"--model",
					spec.model,
					"--effort",
					spec.reasoning,
					"--system-prompt",
					SYSTEM_PROMPT,
					text,
				]);
				let stdout = "";
				let stderr = "";
				const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
				const settle = (error) => {
					clearTimeout(timer);
					resolve({ text: stdout, error });
				};
				child.stdout.on("data", (chunk) => { stdout += chunk; });
				child.stderr.on("data", (chunk) => { stderr += chunk; });
				child.on("error", (error) => settle(error.message));
				child.on("close", (code, signal) => {
					if (signal === "SIGKILL") return settle(`claude killed after ${timeoutMs}ms`);
					settle(code === 0 ? null : stderr.trim() || `claude exited ${code}`);
				});
				child.stdin.end();
			});
		},
	};
}

function atomicWriteJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(temporary, path);
}

function readRowsGz(path) {
	return gunzipSync(readFileSync(path)).toString().trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
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
		throw new Error(`${outputPath}: checkpoint metadata differs from this run; use a fresh output rather than pooling protocols or inputs`);
	}
}

export async function executeCapstoneJudgePass({
	rows,
	dataset,
	payloadDir,
	outputPath,
	judgeName,
	transport,
	inputIdentity,
	eligibilityPolicy = "strict-v1",
	expectedFindings = null,
	pointFilter = null,
}) {
	const judgeSpec = JUDGES[judgeName];
	if (!judgeSpec) throw new Error(`unknown judge: ${judgeName}`);
	const items = buildFindingItems(rows, { eligibilityPolicy });
	if (expectedFindings !== null && items.length !== expectedFindings) {
		throw new Error(`expected ${expectedFindings} judgeable findings under ${eligibilityPolicy}, found ${items.length}`);
	}
	const inScope = pointFilter ? items.filter((item) => pointFilter.has(item.pointKey)) : items;
	if (pointFilter && inScope.length === 0) throw new Error("point filter matches no judgeable findings");
	const catalogs = Object.fromEntries([...new Set(items.map((item) => item.task))].sort().map((task) => [task, activeCatalog(dataset, task)]));
	const metadata = {
		protocol: "capstone-trajectory-claims-v1",
		judge: judgeName,
		judgeModel: transport.model,
		judgeTransport: judgeSpec.transport,
		judgeReasoning: judgeSpec.reasoning,
		judgeBuilderHash: capstoneJudgeBuilderHash(),
		eligibilityPolicy,
		expectedFindings,
		datasetVersion: dataset.version,
		catalogHashes: Object.fromEntries(Object.entries(catalogs).map(([task, catalog]) => [task, catalogHash(dataset.version, catalog)])),
		...inputIdentity,
	};
	const state = existsSync(outputPath)
		? JSON.parse(readFileSync(outputPath, "utf8"))
		: { metadata, status: "in-progress", judgments: {}, unjudgeable: {}, batches: [], failures: [] };
	assertMetadata(state.metadata, metadata, outputPath);
	state.unjudgeable ??= {};

	for (const [pointKey, pointItems] of pointGroups(inScope)) {
		const pending = pointItems.filter((item) => !state.judgments[item.sourceKey] && !state.unjudgeable[item.sourceKey]);
		if (pending.length === 0) continue;
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
			const frozenPoint = rows.find(
				(row) => row.kind === "file-state" && [row.runId, row.trajectoryId, row.config, row.pointId].join("/") === pointKey,
			);
			const nextTurn = rows.find(
				(row) => row.kind === "driver-turn" && row.runId === pending[0].runId &&
					row.trajectoryId === pending[0].task && row.config === pending[0].config && row.requestIndex === pending[0].requestIndex + 1,
			);
			let assistantText = frozenPoint?.assistantMessage ? visiblePiAssistant(frozenPoint.assistantMessage) : "";
			if (!assistantText && nextTurn?.payloadPath) {
				const nextBytes = readFileSync(join(payloadDir, basename(nextTurn.payloadPath)));
				if (sha256Hex(nextBytes).slice(0, 16) !== nextTurn.payloadHash) throw new Error(`${pointKey}: next payload hash mismatch`);
				const assistant = recoverRunEndAssistant(payload, JSON.parse(nextBytes.toString()));
				assistantText = assistant ? visiblePayload({ input: assistant }) : "";
			}
			if (!assistantText) {
				for (const item of pending) {
					state.unjudgeable[item.sourceKey] = {
						...item,
						reason: "unjudgeable-missing-final-assistant",
					};
				}
				atomicWriteJson(outputPath, state);
				process.stderr.write(`${pointKey}: ${pending.length} finding(s) unjudgeable; final assistant message was not frozen\n`);
				continue;
			}
			visibleTranscript += `\n\nRUN-END ASSISTANT RESPONSE\n${assistantText}`;
		}
		const catalog = catalogs[pending[0].task];
		const built = buildCapstoneJudgePrompt({
			items: pending,
			visibleTranscript,
			files: fileStateFor(rows, pointKey),
			catalog,
		});
		const promptHash = sha16(built.prompt);
		const started = Date.now();
		let response = await transport.ask(built.prompt);
		let parsed = !response.error ? parseCapstoneJudgments(response.text, built.ordered.length, catalog.map((issue) => issue.key)) : null;
		let recovered = false;
		const firstResponse = response.text;
		if (!parsed && !response.error) {
			recovered = true;
			response = await transport.ask(built.prompt, response);
			parsed = !response.error ? parseCapstoneJudgments(response.text, built.ordered.length, catalog.map((issue) => issue.key)) : null;
		}
		const batchMs = Date.now() - started;
		if (!parsed) {
			state.failures.push({
				timestamp: new Date().toISOString(),
				pointKey,
				promptHash,
				sourceKeys: built.ordered.map((item) => item.sourceKey),
				recovered,
				firstResponse,
				lastResponse: response.text,
				error: response.error ?? "invalid response schema",
			});
			atomicWriteJson(outputPath, state);
			throw new Error(`${pointKey}: judge failed; checkpoint preserved in ${outputPath}`);
		}
		const catalogByKey = new Map(catalog.map((issue) => [issue.key, issue.issueId]));
		for (let index = 0; index < built.ordered.length; index++) {
			const source = built.ordered[index];
			state.judgments[source.sourceKey] = {
				...source,
				judge: judgeName,
				promptHash,
				claims: parsed[index].claims.map((claim) => ({
					...claim,
					matches: claim.matches.map((key) => ({ catalogKey: key, issueId: catalogByKey.get(key) })),
				})),
			};
		}
		state.batches.push({
			pointKey,
			promptHash,
			sourceKeys: built.ordered.map((item) => item.sourceKey),
			payloadHash,
			evidenceHash: sha16(`${visibleTranscript}\n${fileStateFor(rows, pointKey)}`),
			recovered,
			batchMs,
			firstResponse,
			finalResponse: response.text,
		});
		atomicWriteJson(outputPath, state);
		process.stderr.write(`${pointKey}: ${built.ordered.length} finding(s) judged in ${batchMs}ms${recovered ? " (recovered)" : ""}\n`);
	}
	const accounted = Object.keys(state.judgments).length + Object.keys(state.unjudgeable).length;
	state.status = accounted === inScope.length
		? (Object.keys(state.unjudgeable).length > 0 ? "complete-with-unjudgeable" : "complete")
		: "in-progress";
	if (state.status !== "in-progress") state.completedAt ??= new Date().toISOString();
	atomicWriteJson(outputPath, state);
	return state;
}

async function main() {
	const args = process.argv.slice(2);
	const rowsPath = argOf(args, "--rows-gz", "");
	const payloadDir = argOf(args, "--payload-dir", "");
	const payloadsTarPath = argOf(args, "--payloads-tar", "");
	const datasetPath = argOf(args, "--dataset", "experiments/golden-dataset.json");
	const outputPath = argOf(args, "--output", "");
	const judgeName = argOf(args, "--judge", "sol");
	const timeoutMs = Number.parseInt(argOf(args, "--cli-timeout-ms", "300000"), 10);
	const eligibilityPolicy = argOf(args, "--eligibility-policy", "strict-v1");
	const pointsFilePath = argOf(args, "--points-file", "");
	const expectedFindingsArg = argOf(args, "--expected-findings", "");
	const expectedFindings = expectedFindingsArg === "" ? null : Number.parseInt(expectedFindingsArg, 10);
	if (expectedFindings !== null && (!Number.isInteger(expectedFindings) || expectedFindings < 0)) {
		throw new Error("--expected-findings must be a non-negative integer");
	}
	if (!rowsPath || !payloadDir || !payloadsTarPath || !outputPath) {
		throw new Error("--rows-gz, --payload-dir, --payloads-tar and --output are required");
	}
	const judgeSpec = JUDGES[judgeName];
	if (!judgeSpec) throw new Error(`unknown judge: ${judgeName}`);
	const shapePayloadPath = argOf(args, "--shape-payload", "");
	if (judgeSpec.transport === "oauth-replay" && !shapePayloadPath) {
		throw new Error(`judge ${judgeName} requires --shape-payload <captured production payload>`);
	}
	const transport = judgeSpec.transport === "pi"
		? await piTransport(judgeSpec)
		: judgeSpec.transport === "oauth-replay"
			? oauthReplayTransport(judgeSpec, shapePayloadPath)
			: claudeCliTransport(judgeSpec, timeoutMs);
	const rowsBytes = readFileSync(rowsPath);
	const datasetBytes = readFileSync(datasetPath);
	const payloadsTarBytes = readFileSync(payloadsTarPath);
	let pointFilter = null;
	const filterIdentity = {};
	if (pointsFilePath) {
		const pointsBytes = readFileSync(pointsFilePath);
		const points = JSON.parse(pointsBytes.toString());
		if (!Array.isArray(points) || points.some((key) => typeof key !== "string")) {
			throw new Error("--points-file must contain a JSON array of pointKey strings");
		}
		pointFilter = new Set(points);
		filterIdentity.pointsFile = basename(pointsFilePath);
		filterIdentity.pointsSha256 = sha256Hex(pointsBytes);
	}
	const state = await executeCapstoneJudgePass({
		rows: readRowsGz(rowsPath),
		dataset: JSON.parse(datasetBytes.toString()),
		payloadDir,
		outputPath,
		judgeName,
		transport,
		inputIdentity: {
			rowsFile: basename(rowsPath),
			rowsSha256: sha256Hex(rowsBytes),
			payloadsFile: basename(payloadsTarPath),
			payloadsSha256: sha256Hex(payloadsTarBytes),
			datasetFile: basename(datasetPath),
			datasetSha256: sha256Hex(datasetBytes),
			...filterIdentity,
		},
		eligibilityPolicy,
		expectedFindings,
		pointFilter,
	});
	process.stdout.write(
		`${state.status}: ${Object.keys(state.judgments).length} judged, ${Object.keys(state.unjudgeable).length} unjudgeable, ` +
		`${state.batches.length} batches, ${state.failures.length} failures\n`,
	);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
