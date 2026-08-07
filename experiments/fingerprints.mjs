/**
 * Provenance fingerprints for the delivery-context harness (S5).
 *
 * Three orthogonal axes, one hash each, so a wave can prove WHAT contract ran
 * against WHICH cases under WHOSE judge rules:
 *
 *   contract   `promptHash` (unchanged, 64 hex) + `contractHash` (16 hex)
 *   case       `caseHash` per case, `corpusHash` over the corpus file
 *   judge      `judgeBuilderHash` (built in delivery-context-judge-protocol.mjs,
 *              which owns the sources it hashes)
 *   environment `pricesHash` (costing.mjs) + `codeCommit` / `treeDirty`
 *
 * The design is lifted from `trajectory-cost-ab.mjs:114-137` (`sha`, `lensHash`,
 * `contractRegion`, `contractHash`) — the newest code already separates lens
 * from contract; this module generalizes it to the state-carrying golden arms
 * and adds the case and judge axes the audit found hashed nowhere.
 *
 * TWO RULES GOVERN EVERY CALLER, and they are what keep the evidence bank
 * loadable:
 *
 *   1. **`promptHash` is frozen.** `sha256(prompt + "\n" + (envelope ?? ""))`,
 *      full 64 hex, byte-identical to `delivery-context-golden-ab.mjs:591`. 943
 *      frozen rows across four waves reproduce under it; nothing here may move
 *      it. Everything new is a NEW field.
 *   2. **Absent fingerprint ⇒ unverified (warn, proceed). Present and
 *      mismatched ⇒ refuse.** Every frozen row predates this module: no header,
 *      no `caseHash`, no `contractHash`, no `judgeBuilderHash`. A refusal that
 *      fires on absence would brick the evidence bank, so the absence path
 *      always counts and reports instead of aborting.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/** Bumped when a hashed input's DEFINITION changes, so old and new never pool. */
export const FINGERPRINT_VERSION = 1;

export const sha256Hex = (text) => createHash("sha256").update(text).digest("hex");
/** Short form for every new axis; the legacy promptHash stays full-length. */
export const sha16 = (text) => sha256Hex(text).slice(0, 16);

/**
 * The frozen contract+lens identity. Kept here so there is one definition, and
 * asserted byte-identical against the frozen rows in
 * `provenance-invariants.check.mjs`.
 */
export function promptHash(prompt, envelope) {
	return sha256Hex(`${prompt}\n${envelope ?? ""}`);
}

/**
 * Everything the judge actually reads plus everything the summarizer scores on.
 * `id` and `trajectory` are deliberately OUT: a case renamed but unchanged must
 * keep its content identity, and the corpus hash carries ids separately so a
 * rename still surfaces there.
 */
export const CASE_FIELDS = Object.freeze([
	"head",
	"messages",
	"state",
	"findingTarget",
	"expectedDelivery",
	"expectedFinding",
	"category",
	"counterfactual",
	"critical",
]);

export function caseHash(testCase) {
	if (!testCase || typeof testCase !== "object") throw new Error("caseHash: not a case");
	const projected = {};
	for (const field of CASE_FIELDS) projected[field] = testCase[field];
	return sha16(JSON.stringify(projected));
}

/**
 * Corpus identity: ordered `id:caseHash` pairs plus the corpus name and count.
 * Ids are included (the audit's scheme joins hashes alone) because a renamed
 * case breaks every resume key and every frozen join, which is exactly the drift
 * this hash exists to name.
 */
export function corpusHash(corpusName, cases) {
	const body = cases.map((item) => `${item.id}:${caseHash(item)}`).join("\n");
	return sha16(`${corpusName}\n${cases.length}\n${body}`);
}

export function caseHashes(cases) {
	return Object.fromEntries(cases.map((item) => [item.id, caseHash(item)]));
}

export function lensHash(lens) {
	return sha16(lens);
}

// ---------------------------------------------------------------------------
// Contract identity for state-carrying arms.
// ---------------------------------------------------------------------------

/**
 * `trajectory-cost-ab.mjs:126-133` excises the lens and hashes the rest — sound
 * there because its arms are stateless. The golden arms interpolate the case's
 * delivery state into the contract, so lens-only excision varies per case and
 * the invariant the summarizer wants (one contract per arm) could never hold.
 *
 * So the contract is fingerprinted by rendering the arm against a CANONICAL
 * PROBE CASE instead: same builder, fixed head, fixed state. One value per
 * (arm, provider), invariant across the corpus, sensitive to any edit of the
 * builder's text.
 *
 * The probe state deliberately carries pending items from TWO heads. Measured:
 * with a single-head or empty state, `sameHeadDeliveryContext`
 * (`delivery-context-evaluation.mjs:18-23`) renders identically to the
 * unfiltered path, and the frozen arm-C `treatment`/`samehead` mixture — 456 +
 * 36 rows under one arm label — stays invisible. With two heads they separate.
 *
 * The head is FIXED rather than canonicalized: the head id leaks into the
 * contract text verbatim (measured: `Don't prefix the finding with [quality]`
 * vs `[security]`), and blanket string replacement of a common word like
 * "quality" would mask unrelated edits. Fixing it costs nothing — no builder
 * branches on which head it is given.
 *
 * Coverage limit, stated rather than implied: the probe pins ONE branch of the
 * `unseenonly` arm, whose contract also varies on
 * `category === "newly-delivered-no-response"` (`delivery-context-golden-ab.mjs:233-240`).
 */
export const PROBE_HEAD_FALLBACK = "quality";
export const PROBE_OTHER_HEAD_FALLBACK = "security";

export function probeCase(heads) {
	const names = [...heads].sort();
	const head = names[0] ?? PROBE_HEAD_FALLBACK;
	const other = names[1] ?? names[0] ?? PROBE_OTHER_HEAD_FALLBACK;
	return {
		id: "<PROBE>",
		trajectory: "<PROBE>",
		head,
		category: "<PROBE>",
		messages: [{ role: "user", text: "<PROBE>" }],
		state: {
			lastByThisHead: { head, delivery: "steer", message: "<PROBE-LAST>" },
			pending: [
				{ head, delivery: "steer", message: "<PROBE-PENDING-SELF>" },
				{ head: other, delivery: "queue", message: "<PROBE-PENDING-OTHER>" },
			],
		},
		expectedDelivery: "steer",
		expectedFinding: "<PROBE>",
		findingTarget: "<PROBE>",
		counterfactual: false,
		critical: false,
	};
}

/**
 * Hash a rendered handoff with the lens excised. `handoff` is exactly what the
 * producer's `promptFor` returns: `{prompt, envelope?}`.
 */
export function contractHashOf(handoff, lens, toolSurface) {
	const excise = (text) => (typeof text === "string" ? text.split(lens).join("<LENS>") : "");
	// The tool surface is part of the contract, not context around it: `main-json`
	// and `screen-a0` render byte-identical prompts on Anthropic yet advertise
	// different hydra schemas (wide vs management-only), which is a real
	// difference in what the model is shown and a 135-214 token difference in
	// what the driver pays. Hashing the prompt alone collided them on
	// `45d6beaafb39bb24` and would have let one certify as the other.
	return sha16(`${excise(handoff.prompt)}\n${excise(handoff.envelope)}\n${toolSurface ?? "unspecified"}`);
}

// ---------------------------------------------------------------------------
// Environment.
// ---------------------------------------------------------------------------

/**
 * Commit identity of the code that produced the rows. `treeDirty` is not
 * decoration: `delivery-context-golden-ab.mjs` was edited at 20:53 inside the
 * `f6bc73b` window while the wave-9 producer ran at 20:27, so a bare commit sha
 * would have named code that never ran. A dirty tree records the diff's hash.
 */
export function gitProvenance(cwd = process.cwd()) {
	const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	try {
		const codeCommit = git(["rev-parse", "HEAD"]).trim();
		const status = git(["status", "--porcelain"]);
		const treeDirty = status.trim().length > 0;
		return {
			codeCommit,
			codeCommitDate: git(["log", "-1", "--format=%cI", "HEAD"]).trim(),
			branch: git(["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
			treeDirty,
			diffHash: treeDirty ? sha16(git(["diff", "HEAD"])) : null,
		};
	} catch {
		return { codeCommit: null, codeCommitDate: null, branch: null, treeDirty: null, diffHash: null };
	}
}

// ---------------------------------------------------------------------------
// Run header: the first line of every producer output.
// ---------------------------------------------------------------------------

export const RUN_HEADER_KIND = "run-header";

export function buildRunHeader(fields) {
	return {
		kind: RUN_HEADER_KIND,
		fingerprintVersion: FINGERPRINT_VERSION,
		ts: Date.now(),
		...fields,
	};
}

/** Split a JSONL stream into its header (if any) and its data rows. */
export function splitHeader(records) {
	const header = records.length > 0 && records[0]?.kind === RUN_HEADER_KIND ? records[0] : null;
	return { header, rows: records.filter((record) => record?.kind !== RUN_HEADER_KIND) };
}

export function readRunHeader(path) {
	if (!existsSync(path)) return null;
	const first = readFileSync(path, "utf8").split("\n", 1)[0];
	if (!first) return null;
	try {
		const parsed = JSON.parse(first);
		return parsed?.kind === RUN_HEADER_KIND ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Fields whose drift makes a resumed append a DIFFERENT experiment. `arms` is
 * not here: appending a new arm to an existing file is ordinary practice and
 * the per-arm contract hashes already cover what that arm means.
 *
 * `pricesHash` is separated out because it is the one field backed by mutable
 * user state: it resolves through `model-catalog.mjs`, which falls back to
 * `~/.pi/agent/models-store.json`. A `pi` catalog refresh between chunks of a
 * sweep (the chunked pattern `cost-sweep.sh` uses exists precisely so each
 * chunk re-reads auth) changes the hash mid-wave through no act of the
 * operator's. It still belongs in the comparison — every dollar figure depends
 * on it — but clearing it must not require waiving the code, corpus and
 * membership checks, so it has its own escape (`--force-prices`) rather than
 * sharing `--force-mixed`.
 */
export const PRICE_DRIFT_FIELD = "pricesHash";
export const RESUME_DRIFT_FIELDS = Object.freeze(["fingerprintVersion", "codeCommit", "corpusName", "corpusHash", PRICE_DRIFT_FIELD]);

/**
 * Drift between the header a file already carries and the one this process
 * would write. Returns [] when they agree, and one entry per differing field
 * otherwise; `armContractHashes` is compared per arm so the message names the
 * arm whose contract moved rather than "the object differs".
 */
export function headerDrift(previous, current, { fields = RESUME_DRIFT_FIELDS } = {}) {
	if (!previous) return [];
	const drift = [];
	for (const field of fields) {
		if (JSON.stringify(previous[field]) !== JSON.stringify(current[field])) {
			drift.push({ field, previous: previous[field] ?? null, current: current[field] ?? null });
		}
	}
	const before = previous.armContractHashes ?? {};
	const after = current.armContractHashes ?? {};
	for (const arm of Object.keys(after)) {
		if (arm in before && before[arm] !== after[arm]) {
			drift.push({ field: `armContractHashes.${arm}`, previous: before[arm], current: after[arm] });
		}
	}
	return drift;
}

export function describeDrift(drift) {
	return drift.map((item) => `${item.field}: ${item.previous} -> ${item.current}`).join("; ");
}

/**
 * Refusal #2 of six: a row may only be emitted for a case the run header's
 * corpus contains, at the content the header recorded. Fires when a resumed run
 * points at an edited corpus — the header is the earlier process's snapshot.
 */
export function assertCaseMembership(header, testCase, { force = false } = {}) {
	if (!header?.caseHashes) return { verified: false, reason: "no run header" };
	const expected = header.caseHashes[testCase.id];
	const refuse = (reason) => {
		// `force` is the same escape refusal #1 offers, honored here too: a message
		// that tells the operator to pass --force-mixed and then refuses anyway is
		// a dead end, and the only way out would be discarding the partial run.
		if (force) return { verified: false, reason };
		throw new Error(`${reason} — rerun into a fresh --output, or pass --force-mixed --note "<why>"`);
	};
	if (!expected) {
		return refuse(`case ${testCase.id} is not in this file's corpus (${header.corpusName}, ${header.caseCount} cases); appending it would pool two corpora`);
	}
	const actual = caseHash(testCase);
	if (actual !== expected) {
		return refuse(`case ${testCase.id} content changed since this file's header (${expected} -> ${actual})`);
	}
	return { verified: true };
}

/**
 * Pooling check for any consumer reading several producer files at once
 * (refusal #4). Headers that disagree on corpus, code, or an arm's contract are
 * different experiments; files with no header are counted as unverified and
 * never block.
 */
export function poolingConflicts(headers) {
	const present = headers.filter(Boolean);
	const conflicts = [];
	for (const field of ["fingerprintVersion", "corpusHash", "codeCommit"]) {
		const values = [...new Set(present.map((header) => JSON.stringify(header[field] ?? null)))];
		if (values.length > 1) conflicts.push({ field, values: values.map((value) => JSON.parse(value)) });
	}
	const arms = new Set(present.flatMap((header) => Object.keys(header.armContractHashes ?? {})));
	for (const arm of [...arms].sort()) {
		const values = [
			...new Set(
				present.flatMap((header) =>
					header.armContractHashes && arm in header.armContractHashes ? [header.armContractHashes[arm]] : [],
				),
			),
		];
		if (values.length > 1) conflicts.push({ field: `armContractHashes.${arm}`, values });
	}
	return conflicts;
}

/**
 * Refusal #3 of six, first half: judgments already in the output file were made
 * under different judge rules. Pure so the guard is testable without a judge:
 * the caller decides what to do, but the only correct answer for a non-empty
 * `foreign` is to refuse.
 */
export function builderHashConflict(priorJudgments, currentHash) {
	const present = new Set();
	let unfingerprinted = 0;
	for (const judgment of priorJudgments) {
		if (typeof judgment.judgeBuilderHash === "string") present.add(judgment.judgeBuilderHash);
		else unfingerprinted++;
	}
	return { foreign: [...present].filter((hash) => hash !== currentHash), unfingerprinted };
}

/**
 * Refusal #3 of six, second half: rows whose case has been edited since they
 * were produced. `caseOf(id)` resolves the live corpus; rows with no `caseHash`
 * (every frozen row) are counted as unverified.
 */
export function staleCaseRows(rows, caseOf) {
	const stale = new Set();
	let unfingerprinted = 0;
	for (const row of rows) {
		if (typeof row.caseHash !== "string") {
			unfingerprinted++;
			continue;
		}
		const testCase = caseOf(row.case);
		if (!testCase) continue;
		const live = caseHash(testCase);
		if (live !== row.caseHash) stale.add(`${row.case} (row ${row.caseHash}, corpus ${live})`);
	}
	return { stale: [...stale], unfingerprinted };
}

/**
 * Refusal #5 of six: a judgment must have been made about the case content the
 * producer row recorded. Only compares where both sides carry the field, so
 * frozen judgments (which carry none) report as unverified instead of failing.
 */
export function joinConflicts(rows, judgments, { sourceKeyOf }) {
	const byKey = new Map();
	for (const row of rows) byKey.set(sourceKeyOf(row), row);
	const conflicts = [];
	let unverified = 0;
	for (const judgment of judgments) {
		const row = byKey.get(judgment.sourceKey);
		if (!row) continue;
		if (typeof judgment.caseHash !== "string" || typeof row.caseHash !== "string") {
			unverified++;
			continue;
		}
		if (judgment.caseHash !== row.caseHash) {
			conflicts.push({ sourceKey: judgment.sourceKey, judge: judgment.judge, metric: judgment.metric, row: row.caseHash, judgment: judgment.caseHash });
		}
	}
	return { conflicts, unverified };
}
