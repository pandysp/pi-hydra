#!/usr/bin/env node
/**
 * Freeze and resolve the exact source frames used by the golden-dataset judges.
 *
 * A dataset anchor is not a repo-wide search hint. It identifies one file in
 * one judged state and declares whether its expression is literal source text
 * or a regular expression. Session-frame records additionally name start, end,
 * or either endpoint because the consensus prompt deliberately showed both.
 * `absent` contains literal strings whose absence is part of a test-gap claim.
 *
 * The generated frame source records the input-row SHA256 and endpoint ids, so
 * the checker remains offline and replayable without depending on ~/scratch.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import { argOf } from "./lib.mjs";
import { TRAJECTORY_TASKS, setupTask } from "./trajectory-cost-tasks.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function walkFiles(root) {
	const files = {};
	const walk = (dir) => {
		for (const entry of readdirSync(dir).sort()) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) {
				if (entry !== "reference") walk(full);
			} else if (/\.(js|md)$/.test(entry)) {
				files[relative(root, full)] = readFileSync(full, "utf8");
			}
		}
	};
	walk(root);
	return files;
}

export function seedFiles(taskId) {
	const task = TRAJECTORY_TASKS.find((candidate) => candidate.id === taskId);
	if (!task) throw new Error(`unknown task ${taskId}`);
	const root = mkdtempSync(join(tmpdir(), `golden-frame-${taskId}-`));
	try {
		setupTask(task, root);
		return walkFiles(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

export function parseRows(path) {
	if (!existsSync(path)) throw new Error(`frame-source rows missing: ${path}`);
	const bytes = readFileSync(path);
	const text = extname(path) === ".gz" ? gunzipSync(bytes).toString() : bytes.toString();
	return {
		fileBytes: bytes,
		contentBytes: Buffer.from(text),
		rows: text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
	};
}

export function sessionEndpoints(rows) {
	const states = rows.filter((row) => row.kind === "file-state").sort((a, b) => a.pointIndex - b.pointIndex);
	if (states.length === 0) throw new Error("session rows contain no file-state records");
	return {
		start: { pointId: states[0].pointId, pointIndex: states[0].pointIndex, files: states[0].files },
		end: { pointId: states.at(-1).pointId, pointIndex: states.at(-1).pointIndex, files: states.at(-1).files },
	};
}

export function buildFrameSources(rowPaths) {
	const tasks = {};
	for (const task of TRAJECTORY_TASKS) {
		const input = parseRows(rowPaths[task.id]);
		tasks[task.id] = {
			seed: { files: seedFiles(task.id) },
			session: {
				rows: rowPaths[task.id],
				rowsFileSha256: sha256(input.fileBytes),
				rowsContentSha256: sha256(input.contentBytes),
				...sessionEndpoints(input.rows),
			},
		};
	}
	return { schemaVersion: 1, tasks };
}

function statesFor(issue, frameSources) {
	const task = frameSources.tasks?.[issue.task];
	if (!task) throw new Error(`${issue.id}: no frame source for task ${issue.task}`);
	const state = issue.anchors?.state;
	if (issue.frame === "seed") {
		if (state !== "seed") throw new Error(`${issue.id}: seed-frame anchor must name state=seed`);
		return [task.seed.files];
	}
	if (issue.frame !== "session") throw new Error(`${issue.id}: unknown frame ${issue.frame}`);
	if (state === "start") return [task.session.start.files];
	if (state === "end") return [task.session.end.files];
	if (state === "either") return [task.session.start.files, task.session.end.files];
	throw new Error(`${issue.id}: session-frame anchor must name state=start|end|either`);
}

export function anchorResolution(issue, frameSources) {
	const anchor = issue.anchors;
	if (!anchor?.file || !anchor.expression || !anchor.match) {
		return { ok: false, reason: "anchor requires file, expression, and match" };
	}
	if (anchor.match !== "literal" && anchor.match !== "regex") {
		return { ok: false, reason: `unknown anchor match mode ${anchor.match}` };
	}
	const files = statesFor(issue, frameSources);
	const bodies = files.map((state) => state[anchor.file]).filter((body) => body !== undefined);
	if (bodies.length === 0) return { ok: false, reason: `${anchor.file} absent from selected state` };
	let present;
	try {
		present = anchor.match === "literal"
			? bodies.some((body) => body.includes(anchor.expression))
			: bodies.some((body) => new RegExp(anchor.expression).test(body));
	} catch (error) {
		return { ok: false, reason: `invalid regex: ${error.message}` };
	}
	if (!present) return { ok: false, reason: `${anchor.match} expression does not resolve in ${anchor.file}` };
	for (const absent of anchor.absent ?? []) {
		if (typeof absent !== "string" || absent.length === 0) return { ok: false, reason: "absent assertions must be non-empty strings" };
		if (bodies.some((body) => body.includes(absent))) return { ok: false, reason: `expected ${JSON.stringify(absent)} to be absent from ${anchor.file}` };
	}
	return { ok: true };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2);
	const rowPaths = {
		scheduler: argOf(args, "--rows-scheduler", `${process.env.HOME}/scratch/2026-08-01-hydra-c2-trajectory/rows.jsonl`),
		exporter: argOf(args, "--rows-exporter", "experiments/artifacts/2026-08-02-cross-task-trajectory/rows-exporter.jsonl.gz"),
		dispatcher: argOf(args, "--rows-dispatcher", "experiments/artifacts/2026-08-02-cross-task-trajectory/rows-dispatcher.jsonl.gz"),
	};
	const out = argOf(args, "--out", "experiments/artifacts/2026-08-02-golden-dataset-v2/frame-sources.json.gz");
	const built = buildFrameSources(rowPaths);
	mkdirSync(dirname(out), { recursive: true });
	const temporary = `${out}.${process.pid}.tmp`;
	writeFileSync(temporary, gzipSync(`${JSON.stringify(built, null, 1)}\n`, { level: 9 }));
	renameSync(temporary, out);
	process.stdout.write(`${out}\n${sha256(readFileSync(out))}  ${out}\n`);
}
