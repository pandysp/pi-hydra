/**
 * The run ledger: one append-only line per wave, plus a rendered index.
 *
 * What it is for, stated as the failures it would have caught. The audit chased
 * four discrepancies through frozen files by hand — 1,094 published judgments
 * against 1,116 on disk; 399 rows against 384 cells against 372 completed; 12
 * fable blocks against 15 erroring cells; 150 against 157 judgments — and every
 * one of them is a field here, reconciled at freeze time instead of a month
 * later. Two waves ($21.85 of spend and the whole ABC verdict) exist only in an
 * ungitted mirror; they have entries here with empty `artifactPaths`, which is
 * the honest record rather than an invented path.
 *
 * `provenance` is the load-bearing field:
 *   "measured"       written by `hydra-lab freeze` from the run's own files
 *   "reconstructed"  inferred after the fact from SHA256SUMS, `git log`, file
 *                    mtimes, row contents and the results docs. Commits are the
 *                    FREEZE commit, not necessarily the code that produced the
 *                    rows; spend is Σ usage.cost, the HARNESS basis (see
 *                    costing.mjs), not production-priced.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const LEDGER_PATH = join(HERE, "RUN-LEDGER.jsonl");
export const LEDGER_MARKDOWN_PATH = join(HERE, "RUN-LEDGER.md");

export const REQUIRED_FIELDS = Object.freeze(["runId", "date", "script", "provenance"]);
export const PROVENANCE_KINDS = Object.freeze(["measured", "reconstructed"]);

/**
 * The full shape, with defaults, so every entry has every key and a reader never
 * has to distinguish "absent" from "not applicable".
 */
export function ledgerEntry(fields) {
	return {
		runId: null,
		date: null,
		script: null,
		argv: [],
		codeCommit: null,
		treeDirty: null,
		corpusName: null,
		corpusHash: null,
		armFingerprints: {},
		pricesHash: null,
		counts: {},
		rows: null,
		judgments: null,
		errors: null,
		spendUSD: null,
		spendBasis: "harness",
		artifactPaths: [],
		mirrorPath: null,
		sha256sumsPath: null,
		distillationDoc: null,
		note: null,
		supersededBy: null,
		provenance: null,
		...fields,
	};
}

export function validateEntry(entry) {
	for (const field of REQUIRED_FIELDS) {
		if (entry[field] === null || entry[field] === undefined || entry[field] === "") {
			throw new Error(`ledger entry is missing ${field}`);
		}
	}
	if (!PROVENANCE_KINDS.includes(entry.provenance)) {
		throw new Error(`ledger entry ${entry.runId}: provenance must be one of ${PROVENANCE_KINDS.join(", ")}`);
	}
	if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
		throw new Error(`ledger entry ${entry.runId}: date must be YYYY-MM-DD`);
	}
	return entry;
}

export function readLedger(path = LEDGER_PATH) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

/**
 * Append one entry. Refuses a runId that already exists unless `supersede` gives
 * a reason, in which case the earlier entry keeps its line and gains a
 * `supersededBy` back-reference in the new one. This is what
 * `2026-07-28-hydra-abc-matrix/pre-samehead-repair/` should have been: today it
 * is a sibling directory with identical filenames and no recorded relationship.
 */
export function appendEntry(fields, { path = LEDGER_PATH, supersede = null } = {}) {
	const entry = validateEntry(ledgerEntry(fields));
	const existing = readLedger(path);
	const clash = existing.filter((item) => item.runId === entry.runId);
	if (clash.length > 0) {
		if (!supersede) {
			throw new Error(
				`runId ${entry.runId} is already in the ledger (${clash.length} entry/entries) — pass --supersede "<reason>" to record a replacement`,
			);
		}
		entry.supersededBy = null;
		entry.note = entry.note ? `${entry.note}; supersedes earlier entry: ${supersede}` : `supersedes earlier entry: ${supersede}`;
	}
	appendFileSync(path, `${JSON.stringify(entry)}\n`);
	return entry;
}

// ---------------------------------------------------------------------------
// Measured entries.
// ---------------------------------------------------------------------------

const readJsonl = (path) =>
	readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));

/**
 * Freeze-spec step 3: reconcile a run's own files before anything is compressed.
 * Every count here is one the audit had to reconstruct by hand.
 *
 * `rows` are producer rows with the run header already stripped; `judgments` the
 * concatenation of every judgment file.
 */
export function reconcile(rows, judgments) {
	const cellKey = (row) => `${row.model}/${row.case}/${row.sample}/${row.arm}`;
	const lastByCell = new Map();
	for (const row of rows) lastByCell.set(cellKey(row), row);
	const errorRows = rows.filter((row) => row.error).length;
	const finalErrorCells = [...lastByCell.values()].filter((row) => row.error).length;
	const judgmentKeys = new Map();
	for (const judgment of judgments) {
		const key = `${judgment.judge}/${judgment.metric}/${judgment.sourceKey}`;
		judgmentKeys.set(key, (judgmentKeys.get(key) ?? 0) + 1);
	}
	const sourceKeys = new Set([...lastByCell.keys()]);
	const byJudge = {};
	for (const judgment of judgments) {
		byJudge[judgment.judge] = (byJudge[judgment.judge] ?? 0) + 1;
	}
	return {
		rows: rows.length,
		uniqueCells: lastByCell.size,
		duplicateRows: rows.length - lastByCell.size,
		errorRows,
		finalErrorCells,
		judgments: judgments.length,
		judgmentsByJudge: byJudge,
		duplicateJudgments: judgments.length - judgmentKeys.size,
		orphanJudgments: judgments.filter((judgment) => !sourceKeys.has(judgment.sourceKey)).length,
	};
}

/**
 * Σ usage.cost over EVERY row — the HARNESS basis (costing.mjs), and money
 * actually spent. Retries and error rows are summed in deliberately: the
 * analysis deduplicates them (last row per cell wins), but the provider billed
 * for both attempts. Measured on the frozen sweep the two differ by $0.15
 * ($5.1196 all rows against $4.9723 deduped).
 */
export function harnessSpend(rows) {
	let total = 0;
	for (const row of rows) {
		// Producer rows nest usage; replay-shaped rows (recorded-payload-cost,
		// adaptive-skip-probe) spread usage flat and carry the priced figure at
		// the top level. Reading only the nested shape silently ledgered a $1.36
		// study as $0, which is exactly the drift the ledger exists to prevent.
		const cost = row.usage?.cost ?? row.rawCost ?? row.cost;
		if (typeof cost === "number") total += cost;
	}
	return Number(total.toFixed(4));
}

/**
 * Build a measured entry from a run's own files. `header` is the producer's
 * run-header line when it has one; legacy runs pass null and the entry records
 * `headerMissing`.
 */
export function measuredEntry({ runId, date, script, argv, rowsPaths = [], judgmentPaths = [], header = null, ...rest }) {
	const rows = rowsPaths.flatMap((path) => readJsonl(path)).filter((row) => row?.kind !== "run-header");
	const judgments = judgmentPaths.flatMap((path) => readJsonl(path));
	const counts = reconcile(rows, judgments);
	return ledgerEntry({
		runId,
		date,
		script,
		argv: argv ?? [],
		codeCommit: header?.codeCommit ?? null,
		treeDirty: header?.treeDirty ?? null,
		corpusName: header?.corpusName ?? null,
		corpusHash: header?.corpusHash ?? null,
		armFingerprints: header?.armContractHashes ?? {},
		pricesHash: header?.pricesHash ?? null,
		counts: { ...counts, headerMissing: header === null },
		rows: counts.rows,
		judgments: counts.judgments,
		errors: counts.finalErrorCells,
		spendUSD: harnessSpend(rows),
		spendBasis: "harness",
		provenance: "measured",
		...rest,
	});
}

// ---------------------------------------------------------------------------
// Rendered index.
// ---------------------------------------------------------------------------

const cell = (value) => (value === null || value === undefined || value === "" ? "—" : String(value).replace(/\|/g, "\\|"));

export function renderMarkdown(entries) {
	const lines = [
		"# Run ledger",
		"",
		"Generated by `node experiments/hydra-lab.mjs ledger render` — edit `RUN-LEDGER.jsonl`, never this file.",
		"",
		"`provenance: measured` entries were written by `hydra-lab freeze` from the run's own files.",
		"`reconstructed` entries were inferred after the fact (wave-9 provenance audit, 2026-08-01): the",
		"commit is the FREEZE commit rather than necessarily the code that produced the rows, and spend is",
		"Σ `usage.cost` — the HARNESS basis (`costing.mjs`), cache-write inflated, not production-priced.",
		"",
		"| # | Date | runId | Script | Commit | Corpus | Rows | Judgments | Spend (harness Σ) | Repo artifacts | Mirror | Distillation | Provenance |",
		"|---|---|---|---|---|---|---:|---:|---:|---|---|---|---|",
	];
	entries.forEach((entry, index) => {
		lines.push(
			`| ${index + 1} | ${cell(entry.date)} | \`${cell(entry.runId)}\` | ${cell(entry.script)} | ${cell(entry.codeCommit)}${entry.treeDirty ? " (dirty)" : ""} | ${cell(entry.corpusName)} | ${cell(entry.rows)} | ${cell(entry.judgments)} | ${entry.spendUSD === null ? "—" : `$${entry.spendUSD}`} | ${entry.artifactPaths.length > 0 ? entry.artifactPaths.map((path) => `\`${path}\``).join(", ") : "**none**"} | ${cell(entry.mirrorPath)} | ${cell(entry.distillationDoc)} | ${cell(entry.provenance)} |`,
		);
	});
	const sum = (list, field) => list.reduce((total, entry) => total + (entry[field] ?? 0), 0);
	const live = entries.filter((entry) => !entry.supersededBy);
	const superseded = entries.filter((entry) => entry.supersededBy);
	lines.push(
		"",
		`**Program totals: ${sum(live, "rows")} producer rows, ${sum(live, "judgments")} judgments, $${sum(live, "spendUSD").toFixed(2)} spent (harness basis)** — plus $${sum(superseded, "spendUSD").toFixed(2)} on ${superseded.length} superseded run(s), money spent on evidence no verdict rests on. Total metered: $${sum(entries, "spendUSD").toFixed(2)}.`,
		"",
		"Waves present in `~/dev/personal/pi-hydra-frozen-artifacts/` with no entry here are listed by",
		"`node experiments/hydra-lab.mjs ledger verify`, which also re-checks every frozen manifest.",
		"",
		"## Notes",
		"",
	);
	for (const entry of entries) {
		if (entry.note) lines.push(`- \`${entry.runId}\`: ${entry.note}`);
	}
	lines.push(
		"",
		"## Reading the frozen evidence",
		"",
		"- **167 frozen rows across 14 mirror files no longer reproduce their `promptHash` under ANY",
		"  code version** (95 case-content drift + 72 naming case ids absent from all corpora), all in",
		"  the 2026-07-27/28 waves. Proven pre-existing by a HEAD-vs-new both-fail decomposition during",
		"  the wave-10 verification: it is corpus drift from before the fingerprint scheme existed, NOT",
		"  a code regression introduced by the arm registry. 10,352 of 10,519 rows do reproduce.",
		"- Spend is the HARNESS basis (provider-reported `usage.cost` against a synthetic prefix billed",
		"  at cache-write rates), not production pricing, and not what Andreas was billed: pi's Anthropic",
		"  OAuth rides Claude-Code identity headers, so Anthropic waves consumed plan quota rather than",
		"  metered API credit. Treat these as list-price equivalents.",
		"- `usage.cost` appears in two shapes across vintages — a number on producer rows, an object with",
		"  `.total` on judge rows of the 2026-07-27 waves. A scan handling only one shape understates",
		"  spend (it read $1.43 instead of $3.45 on `2026-07-27-hydra-feedback-judgment`).",
		"",
	);
	return lines.join("\n");
}

export function writeMarkdown(entries, path = LEDGER_MARKDOWN_PATH) {
	writeFileSync(path, renderMarkdown(entries));
	return resolve(path);
}
