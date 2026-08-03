#!/usr/bin/env node
/**
 * One entry point for a wave: `produce | judge | summarize | freeze | ledger`.
 *
 * A WRAPPER, NOT A REWRITE. Every subcommand spawns the existing script with
 * the argv it was given, unchanged, and exits with its status. What it adds is
 * the three things every wave shell script re-implemented by hand:
 *
 *   1. **The auth-ensure block.** Lifted from `~/.claude/jobs/4881d0b2/tmp/cost-sweep.sh:10-19`,
 *      where it is copy-pasted into `pilot.sh` and both judge scripts.
 *   2. **Exit codes that survive.** Every wave script piped node through
 *      `tail -N`, which discards the status: a judge run that aborted half-way
 *      still printed `DONE` and the next metric started. Here a nonzero status
 *      from any stage stops the command and becomes this process's status.
 *   3. **The freeze ritual**, previously done by hand every wave with a
 *      different path convention each time.
 *
 * The producer, judge and summarizer all execute at import (top-level argv
 * parsing, top-level await), so they are spawned as child processes rather than
 * imported. That is also what keeps the exit code honest.
 *
 * Usage:
 *   node experiments/hydra-lab.mjs produce --output rows.jsonl --corpus screen --models opus-high --arms A0,J,F
 *   node experiments/hydra-lab.mjs judge --input rows.jsonl --output judgments-sol.jsonl --judge sol --metrics support,target,repeat
 *   node experiments/hydra-lab.mjs summarize --input rows.jsonl --judges judgments-sol.jsonl --gates
 *   node experiments/hydra-lab.mjs freeze --run 2026-08-02-my-wave --source ~/scratch/2026-08-02-hydra-my-wave --doc experiments/MY-RESULTS.md
 *   node experiments/hydra-lab.mjs freeze --verify --all
 *   node experiments/hydra-lab.mjs ledger list | render | verify
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { argOf } from "./lib.mjs";
import { gitProvenance, readRunHeader } from "./fingerprints.mjs";
import { appendEntry, measuredEntry, readLedger, writeMarkdown } from "./run-ledger.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ARTIFACT_ROOT = join(HERE, "artifacts");
export const MIRROR_ROOT = join(homedir(), "dev", "personal", "pi-hydra-frozen-artifacts");

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

/** The legacy producer header or the registered live-trajectory matrix header. */
export function readFreezeHeader(path) {
	const legacy = readRunHeader(path);
	if (legacy) return legacy;
	if (!existsSync(path)) return null;
	const first = readFileSync(path, "utf8").split("\n", 1)[0];
	if (!first) return null;
	try {
		const parsed = JSON.parse(first);
		return parsed?.kind === "trajectory-matrix-header" ? parsed : null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Auth.
// ---------------------------------------------------------------------------

/**
 * Probe models per provider — the cheapest call that forces `pi` to refresh a
 * stored OAuth token. `pi` writes the refreshed token back to auth.json, which
 * is what the producer reads at startup.
 */
const AUTH_PROBES = Object.freeze({
	anthropic: ["--provider", "anthropic", "--model", "claude-sonnet-5"],
	"openai-codex": ["--provider", "openai-codex", "--model", "gpt-5.6-sol"],
});

/**
 * Which providers a `--models` list needs. A projection of `modelSpecs`
 * (`delivery-context-golden-ab.mjs:84-104`); an unrecognized name ensures BOTH
 * rather than guessing, because a missed refresh costs a whole chunk of a wave
 * and an extra probe costs a fraction of a cent.
 */
export function providersFor(models) {
	const providers = new Set();
	for (const name of models) {
		if (/^(sonnet|opus|fable)/.test(name)) providers.add("anthropic");
		else if (/^(terra|luna|sol|gpt)/.test(name)) providers.add("openai-codex");
		else {
			providers.add("anthropic");
			providers.add("openai-codex");
		}
	}
	return [...providers];
}

/** True when the stored token is missing or expires inside the next two minutes. */
export function tokenIsStale(auth, provider, now = Date.now()) {
	const credential = auth?.[provider];
	if (!credential?.access) return true;
	return typeof credential.expires === "number" && credential.expires < now + 120_000;
}

/**
 * Refresh whatever is about to expire, BEFORE a chunk starts, so a long wave
 * does not die halfway on a 401. Chunking a sweep per config exists precisely so
 * each producer start re-reads a fresh token (`cost-sweep.sh:22-31`).
 *
 * This is the ONE place in the harness that makes a call outside a measurement,
 * so it is opt-out (`--no-auth`) and it announces itself.
 */
function ensureAuth(providers, { quiet = false } = {}) {
	const authPath = join(homedir(), ".pi", "agent", "auth.json");
	if (!existsSync(authPath)) throw new Error(`no ${authPath}; run pi and log in first`);
	const auth = JSON.parse(readFileSync(authPath, "utf8"));
	for (const provider of providers) {
		if (!tokenIsStale(auth, provider)) continue;
		const probe = AUTH_PROBES[provider];
		if (!probe) throw new Error(`no auth probe for provider ${provider}`);
		if (!quiet) console.error(`[hydra-lab] ${provider} token stale, probing pi to refresh`);
		const result = spawnSync("pi", ["-p", ...probe, "Reply with the single word ok"], {
			cwd: homedir(),
			stdio: ["ignore", "ignore", "ignore"],
		});
		if (result.status !== 0) {
			throw new Error(`${provider} token is stale and the pi refresh probe failed (status ${result.status}); log in with pi and retry`);
		}
	}
}

// ---------------------------------------------------------------------------
// Spawning.
// ---------------------------------------------------------------------------

function runScript(script, argv) {
	const result = spawnSync(process.execPath, [join(HERE, script), ...argv], { stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.signal) {
		console.error(`[hydra-lab] ${script} killed by ${result.signal}`);
		process.exit(1);
	}
	return result.status ?? 1;
}

/** Run a stage and stop the whole command if it fails — never swallow a status. */
function runOrExit(script, argv) {
	const status = runScript(script, argv);
	if (status !== 0) {
		console.error(`[hydra-lab] ${script} exited ${status}`);
		process.exit(status);
	}
}

// ---------------------------------------------------------------------------
// Manifests.
// ---------------------------------------------------------------------------

/**
 * Two manifests per frozen set, both with BARE RELATIVE NAMES.
 *
 *   SHA256SUMS      hash of the LOGICAL content, named without `.gz`. This is
 *                   the guarantee that survives recompression: it is what four
 *                   of the seven pre-existing manifests already recorded, and
 *                   every one of their hash values is preserved byte-for-byte by
 *                   the 2026-08-01 path repair.
 *   SHA256SUMS.gz   hash of the STORED bytes, named exactly as stored. This one
 *                   verifies in place: `shasum -a 256 -c SHA256SUMS.gz` inside
 *                   the directory passes with no gunzip step (audit item A13).
 *
 * Absolute paths are never written. Four manifests named `~/scratch/...` paths,
 * which auto-prune at 14 days: those sets would have become unverifiable around
 * 2026-08-07 while their gz files sat in the repo.
 */
export const MANIFEST = "SHA256SUMS";
export const ARCHIVE_MANIFEST = "SHA256SUMS.gz";

export function parseManifest(text) {
	return text
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const match = line.match(/^([0-9a-f]{64})\s+(.+)$/);
			if (!match) throw new Error(`unparseable manifest line: ${line}`);
			return { hash: match[1], name: match[2] };
		});
}

export function formatManifest(entries) {
	return `${entries.map((entry) => `${entry.hash}  ${entry.name}`).join("\n")}\n`;
}

/** The logical content of a stored file: gunzipped for `.gz`, raw otherwise. */
export function logicalContent(path) {
	const bytes = readFileSync(path);
	return path.endsWith(".gz") ? gunzipSync(bytes) : bytes;
}

/** Logical name: `rows.jsonl.gz` -> `rows.jsonl`. Archives keep their own name. */
export function logicalName(name) {
	return name.endsWith(".tar.gz") ? name : name.replace(/\.gz$/, "");
}

export function buildManifests(dir) {
	const files = readdirSync(dir)
		.filter((name) => name !== MANIFEST && name !== ARCHIVE_MANIFEST)
		.sort();
	const logical = [];
	const stored = [];
	for (const name of files) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) continue;
		stored.push({ hash: sha256(readFileSync(path)), name });
		// A .tar.gz has no single logical document; its stored hash is the record.
		if (!name.endsWith(".tar.gz")) logical.push({ hash: sha256(logicalContent(path)), name: logicalName(name) });
	}
	return { logical, stored };
}

/**
 * Verify one frozen directory against both manifests. Never throws: it returns
 * what it found, so `--verify --all` reports every set rather than stopping at
 * the first bad one.
 */
export function verifyDir(dir) {
	const report = { dir, manifest: null, archiveManifest: null, ok: 0, mismatch: [], missing: [], unhashed: [], absolutePaths: 0 };
	const files = readdirSync(dir).filter((name) => name !== MANIFEST && name !== ARCHIVE_MANIFEST);
	const manifestPath = join(dir, MANIFEST);
	if (!existsSync(manifestPath)) {
		report.manifest = "absent";
		report.unhashed = files;
		return report;
	}
	report.manifest = "present";
	const entries = parseManifest(readFileSync(manifestPath, "utf8"));
	const named = new Set();
	for (const entry of entries) {
		if (entry.name.startsWith("/") || entry.name.startsWith("~")) report.absolutePaths++;
		const base = basename(entry.name);
		named.add(base);
		const candidates = [join(dir, base), join(dir, `${base}.gz`)];
		const path = candidates.find((candidate) => existsSync(candidate));
		if (!path) {
			report.missing.push(entry.name);
			continue;
		}
		if (sha256(logicalContent(path)) === entry.hash) report.ok++;
		else report.mismatch.push(entry.name);
	}
	report.unhashed = files.filter((name) => !named.has(logicalName(name)) && !name.endsWith(".tar.gz"));
	const archivePath = join(dir, ARCHIVE_MANIFEST);
	if (existsSync(archivePath)) {
		report.archiveManifest = "present";
		for (const entry of parseManifest(readFileSync(archivePath, "utf8"))) {
			const path = join(dir, entry.name);
			if (!existsSync(path)) report.missing.push(`${entry.name} (stored)`);
			else if (sha256(readFileSync(path)) !== entry.hash) report.mismatch.push(`${entry.name} (stored)`);
			else report.ok++;
		}
	} else {
		report.archiveManifest = "absent";
	}
	return report;
}

// ---------------------------------------------------------------------------
// freeze.
// ---------------------------------------------------------------------------

const JUDGMENT_FILE = /judgment/i;

function freeze(args) {
	if (args.includes("--verify")) return freezeVerify(args);

	const runId = argOf(args, "--run", "");
	const source = argOf(args, "--source", "");
	const doc = argOf(args, "--doc", null);
	const note = argOf(args, "--note", null);
	const supersede = argOf(args, "--supersede", null);
	const allowDirty = args.includes("--allow-dirty");
	const dryRun = args.includes("--dry-run");
	if (!runId || !source) throw new Error("freeze needs --run <runId> and --source <dir>");
	if (!existsSync(source)) throw new Error(`source directory does not exist: ${source}`);

	// 1. Refuse a dirty worktree. A commit sha without this is decoration:
	//    delivery-context-golden-ab.mjs was edited at 20:53 inside the f6bc73b
	//    window while wave 9's producer ran at 20:27.
	const git = gitProvenance(HERE);
	if (git.treeDirty && !allowDirty) {
		throw new Error("worktree is dirty — commit first, or pass --allow-dirty to record treeDirty and the diff hash");
	}

	const target = join(ARTIFACT_ROOT, runId);
	if (existsSync(target) && !supersede) {
		throw new Error(`${target} already exists — frozen artifacts are immutable; pass --supersede "<reason>" to record a replacement under a new runId`);
	}

	// 2-4. Reconcile and price BEFORE anything is compressed.
	const files = readdirSync(source)
		.filter((name) => !statSync(join(source, name)).isDirectory())
		.filter((name) => name !== MANIFEST && name !== ARCHIVE_MANIFEST)
		.sort();
	if (files.length === 0) throw new Error(`nothing to freeze in ${source}`);
	const jsonl = files.filter((name) => logicalName(name).endsWith(".jsonl"));
	const rowFiles = jsonl.filter((name) => !JUDGMENT_FILE.test(name)).map((name) => join(source, name));
	const judgmentFiles = jsonl.filter((name) => JUDGMENT_FILE.test(name)).map((name) => join(source, name));
	const header = rowFiles.map((path) => readFreezeHeader(path)).find(Boolean) ?? null;
	if (!header) console.error(`[hydra-lab] no run header in ${runId} — recording headerMissing: true (legacy or pre-S5 run)`);

	const entry = measuredEntry({
		runId,
		date: new Date().toISOString().slice(0, 10),
		script: argOf(args, "--script", "(recorded by hand)"),
		argv: args,
		rowsPaths: rowFiles,
		judgmentPaths: judgmentFiles,
		header,
		artifactPaths: [`experiments/artifacts/${runId}`],
		sha256sumsPath: `experiments/artifacts/${runId}/${MANIFEST}`,
		mirrorPath: join(MIRROR_ROOT, runId),
		distillationDoc: doc,
		note,
		treeDirty: git.treeDirty,
		codeCommit: header?.codeCommit ?? git.codeCommit,
	});
	console.error(`[hydra-lab] ${runId}: ${JSON.stringify(entry.counts)}`);
	console.error(`[hydra-lab] spend (harness basis, every row incl. retries): $${entry.spendUSD}`);
	if (dryRun) {
		console.log(JSON.stringify(entry, null, 2));
		return 0;
	}

	// 5-6. Freeze EVERY file, then both manifests.
	mkdirSync(target, { recursive: true });
	for (const name of files) {
		const path = join(source, name);
		if (name.endsWith(".gz")) copyFileSync(path, join(target, name));
		else writeFileSync(join(target, `${name}.gz`), gzipSync(readFileSync(path), { level: 9 }));
	}
	const manifests = buildManifests(target);
	writeFileSync(join(target, MANIFEST), formatManifest(manifests.logical));
	writeFileSync(join(target, ARCHIVE_MANIFEST), formatManifest(manifests.stored));

	// 7. Mirror the LIVE files, then verify the mirror against the manifest.
	const mirror = join(MIRROR_ROOT, runId);
	mkdirSync(mirror, { recursive: true });
	cpSync(source, mirror, { recursive: true });
	const logicalByName = new Map(manifests.logical.map((item) => [item.name, item.hash]));
	for (const name of readdirSync(mirror)) {
		const expected = logicalByName.get(logicalName(name));
		if (!expected) continue;
		if (sha256(logicalContent(join(mirror, name))) !== expected) {
			throw new Error(`mirror copy of ${name} does not match the manifest — freeze aborted with the mirror in place for inspection`);
		}
	}

	// 8. One ledger line, then re-render the index.
	appendEntry(entry, { supersede });
	writeMarkdown(readLedger());
	const report = verifyDir(target);
	console.error(`[hydra-lab] froze ${files.length} file(s) to ${target}; verified ${report.ok} hash(es); mirror ${mirror}`);
	return report.mismatch.length === 0 && report.missing.length === 0 ? 0 : 1;
}

function freezeVerify(args) {
	const all = args.includes("--all");
	const runId = argOf(args, "--run", "");
	const dirs = all
		? readdirSync(ARTIFACT_ROOT).filter((name) => statSync(join(ARTIFACT_ROOT, name)).isDirectory())
		: [runId].filter(Boolean);
	if (dirs.length === 0) throw new Error("freeze --verify needs --run <runId> or --all");
	let bad = 0;
	for (const dir of dirs.sort()) {
		const report = verifyDir(join(ARTIFACT_ROOT, dir));
		const problems = [
			report.manifest === "absent" ? "NO SHA256SUMS" : null,
			report.archiveManifest === "absent" ? "no SHA256SUMS.gz" : null,
			report.absolutePaths > 0 ? `${report.absolutePaths} absolute path(s) — will not resolve once ~/scratch prunes` : null,
			report.mismatch.length > 0 ? `MISMATCH: ${report.mismatch.join(", ")}` : null,
			report.missing.length > 0 ? `MISSING: ${report.missing.join(", ")}` : null,
			report.unhashed.length > 0 ? `unhashed: ${report.unhashed.join(", ")}` : null,
		].filter(Boolean);
		if (report.mismatch.length > 0 || report.missing.length > 0) bad++;
		console.log(`${dir}: ${report.ok} ok${problems.length > 0 ? ` — ${problems.join("; ")}` : ""}`);
	}
	return bad === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// ledger.
// ---------------------------------------------------------------------------

function ledger(args) {
	const action = args[0] ?? "list";
	const entries = readLedger();
	if (action === "list") {
		for (const entry of entries) {
			console.log(
				`${entry.date}  ${entry.runId.padEnd(34)} ${String(entry.rows ?? "—").padStart(5)} rows  ${String(entry.judgments ?? "—").padStart(5)} judgments  $${entry.spendUSD ?? "—"}  ${entry.provenance}${entry.supersededBy ? ` (superseded by ${entry.supersededBy})` : ""}`,
			);
		}
		return 0;
	}
	if (action === "render") {
		console.error(`[hydra-lab] wrote ${writeMarkdown(entries)}`);
		return 0;
	}
	if (action === "verify") {
		let bad = 0;
		const known = new Set(entries.map((entry) => entry.runId));
		for (const entry of entries) {
			for (const path of entry.artifactPaths) {
				const dir = join(HERE, "..", path);
				if (!existsSync(dir)) {
					console.log(`MISSING ARTIFACT ${entry.runId}: ${path}`);
					bad++;
					continue;
				}
				const report = verifyDir(dir);
				if (report.mismatch.length > 0 || report.missing.length > 0) {
					console.log(`BAD ${entry.runId}: mismatch=${report.mismatch.join(",")} missing=${report.missing.join(",")}`);
					bad++;
				}
			}
		}
		// Waves that exist on disk but in no entry: the gap the ledger is for.
		const unledgered = [];
		if (existsSync(ARTIFACT_ROOT)) {
			// Directories only — the root also holds README.md.
			for (const dir of readdirSync(ARTIFACT_ROOT, { withFileTypes: true })) {
				if (!dir.isDirectory()) continue;
				if (!entries.some((entry) => entry.artifactPaths.some((path) => path.endsWith(dir.name)))) unledgered.push(`repo: ${dir.name}`);
			}
		}
		if (existsSync(MIRROR_ROOT)) {
			for (const dir of readdirSync(MIRROR_ROOT)) {
				if (!entries.some((entry) => (entry.mirrorPath ?? "").includes(dir))) unledgered.push(`mirror: ${dir}`);
			}
		}
		for (const item of unledgered) console.log(`NO LEDGER ENTRY — ${item}`);
		console.log(`${entries.length} entries, ${known.size} distinct runIds, ${bad} artifact problem(s), ${unledgered.length} un-ledgered wave(s)`);
		return bad === 0 ? 0 : 1;
	}
	throw new Error(`unknown ledger action: ${action} (list | render | verify)`);
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

const USAGE = `hydra-lab <command> [args]

  produce   <producer argv>        delivery-context-golden-ab.mjs, auth ensured first
  judge     <judge argv>           delivery-context-golden-judge.mjs; --metrics a,b,c loops them
  summarize <summarizer argv>      summarize-delivery-context-golden.mjs
  freeze    --run <id> --source <dir> [--doc f] [--note s] [--allow-dirty] [--supersede r] [--dry-run]
  freeze    --verify [--all | --run <id>]
  ledger    list | render | verify

  --no-auth   skip the token refresh probe (produce/judge)`;

export function main(argv) {
	const command = argv[0];
	const args = argv.slice(1);
	const noAuth = args.includes("--no-auth");
	const rest = args.filter((arg) => arg !== "--no-auth");

	if (command === "produce") {
		if (!noAuth) ensureAuth(providersFor(argOf(rest, "--models", "").split(",").filter(Boolean)));
		return runScript("delivery-context-golden-ab.mjs", rest);
	}
	if (command === "judge") {
		// Judges run on subscriptions (claude-cli) or a pi provider; ensure both
		// only when a pi-backed judge is selected.
		if (!noAuth && argOf(rest, "--judge", "sol") === "sol") ensureAuth(["openai-codex"]);
		const metrics = argOf(rest, "--metrics", "");
		if (!metrics) return runScript("delivery-context-golden-judge.mjs", rest);
		const base = rest.filter((arg, index) => arg !== "--metrics" && rest[index - 1] !== "--metrics");
		for (const metric of metrics.split(",").filter(Boolean)) {
			console.error(`[hydra-lab] judging metric ${metric}`);
			runOrExit("delivery-context-golden-judge.mjs", [...base, "--metric", metric]);
		}
		return 0;
	}
	if (command === "summarize") return runScript("summarize-delivery-context-golden.mjs", rest);
	if (command === "freeze") return freeze(rest);
	if (command === "ledger") return ledger(rest);
	console.error(USAGE);
	return command ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		process.exit(main(process.argv.slice(2)));
	} catch (error) {
		console.error(`[hydra-lab] ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
