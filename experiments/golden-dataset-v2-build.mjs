#!/usr/bin/env node
/**
 * Stage B final assembly: novel batch + rejudge batch + base edits -> golden
 * dataset v2. Every tier/status entering here comes from a frozen consensus
 * state; this script only routes outcomes, per the assemble contract.
 * It fails closed below the registered 95% consensus bar. The explicit
 * `--allow-provisional` escape hatch exists only to repair and validate an
 * interrupted checkpoint; it marks the output provisional in-band.
 * `--adopt-decision A` builds final under GOLDEN-V2-PROTOCOL-DECISION.md and
 * refuses to run until that memo carries an `ADOPTED: Option A` line.
 * `--dry-run` writes only to a temp dir — no repo or state change.
 */
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assemble, mergeDatasets } from "./golden-dataset-assemble.mjs";
import { TRAJECTORY_TASKS } from "./trajectory-cost-tasks.mjs";
import { argOf } from "./lib.mjs";

const args = process.argv.slice(2);
const REPO = argOf(args, "--repo", resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const P = argOf(args, "--state-root", `${process.env.HOME}/scratch/2026-08-02-golden-v2`);
const ALLOW_PROVISIONAL = args.includes("--allow-provisional");
const ADOPT_DECISION = argOf(args, "--adopt-decision", null);
const DRY_RUN = args.includes("--dry-run");
if (ADOPT_DECISION !== null && ADOPT_DECISION !== "A") throw new Error(`unknown protocol decision "${ADOPT_DECISION}": only Option A has a registered execution path`);
if (ADOPT_DECISION && ALLOW_PROVISIONAL) throw new Error("--adopt-decision builds final; it cannot combine with --allow-provisional");
const DECISION_DOC = "experiments/GOLDEN-V2-PROTOCOL-DECISION.md";
// The terminated stable dissents Option A carries, registered in the memo.
// CL38 is V2-I38's precision replacement; the other three were repair-ineligible.
const OPTION_A_TERMINATED = Object.freeze(["CL38", "V2-I02", "V2-I04", "V2-I05"]);
const RUN_ID = "2026-08-02-golden-dataset-v2";
// 7eedc8b is v1 after the audit-mandated frame/schema repairs. Its active
// content version intentionally remains the original v1 hash.
const BASE_COMMIT = "7eedc8b14ecc85e9dd2871c32e01d7ec39a99f9a";
const BASE_VERSION = "4ea27b0018705940";
const SOURCE = { P: "planted", R: "reference-review", C: "code-review", O: "observer" };

const novel = assemble(`${P}/consensus-novel`, null, RUN_ID);
const rejudge = assemble(`${P}/consensus-rejudge`, null, RUN_ID);
const novelState = JSON.parse(readFileSync(`${P}/consensus-novel/issues.json`, "utf8")).issues;
const precisionStateDir = `${P}/consensus-precision`;
const precision = existsSync(`${precisionStateDir}/consensus.json`)
	? assemble(precisionStateDir, null, RUN_ID)
	: null;
const novelConsensus = JSON.parse(readFileSync(`${P}/consensus-novel/consensus.json`, "utf8"));
const novelOpen = new Set(novelConsensus.rounds[novel.builtFrom.finalRound].open);

const sameSet = (a, b) => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");
let precisionReplaced = new Set();
let precisionFinalOpen = [];
if (precision) {
	const precisionIssues = JSON.parse(readFileSync(`${precisionStateDir}/issues.json`, "utf8")).issues;
	if (precisionIssues.length !== 2 || precision.builtFrom.total !== 2) throw new Error("precision state must contain exactly the registered CL38 and CL52 questions");
	if (precisionIssues.map((issue) => issue.id).sort().join(",") !== "CL38,CL52") throw new Error("precision state ids drifted from CL38,CL52");
	for (const repaired of precisionIssues) {
		const original = novelState.find((issue) => issue.id === repaired.replaces);
		if (!original) throw new Error(`${repaired.id}: replacement target ${repaired.replaces} is absent from the novel state`);
		if (!novelOpen.has(repaired.replaces)) throw new Error(`${repaired.id}: replacement target ${repaired.replaces} was not an unresolved original question`);
		const oldRecord = [...novel.issues, ...novel.rejected].find((record) => sameSet(record.members ?? [], original.members ?? []));
		const newRecord = [...precision.issues, ...precision.rejected].find((record) => sameSet(record.members ?? [], repaired.members ?? []));
		if (!oldRecord || !newRecord) throw new Error(`${repaired.id}: could not route precision replacement by frozen members`);
		novel.issues = novel.issues.filter((record) => record !== oldRecord);
		novel.rejected = novel.rejected.filter((record) => record !== oldRecord);
		newRecord.precisionRepair = {
			replaces: repaired.replaces,
			previousStatement: oldRecord.statement,
			stateDir: precisionStateDir.replace(process.env.HOME, "~"),
		};
		(newRecord.status === "active" ? novel.issues : novel.rejected).push(newRecord);
	}
	precisionReplaced = new Set(precisionIssues.map((issue) => issue.replaces));
	const precisionConsensus = JSON.parse(readFileSync(`${precisionStateDir}/consensus.json`, "utf8"));
	precisionFinalOpen = precisionConsensus.rounds[precision.builtFrom.finalRound].open ?? [];
}

const precisionConverged = precision?.builtFrom.converged ?? 0;
const convergence = {
	novel: {
		converged: novel.builtFrom.converged + precisionConverged,
		total: novel.builtFrom.total,
		baseConverged: novel.builtFrom.converged,
		precisionConverged,
	},
	rejudge: { converged: rejudge.builtFrom.converged, total: rejudge.builtFrom.total },
};
const rejudgeConsensus = JSON.parse(readFileSync(`${P}/consensus-rejudge/consensus.json`, "utf8"));
const rejudgeRound = rejudgeConsensus.rounds[rejudge.builtFrom.finalRound];
if (JSON.stringify(rejudgeRound.open) !== JSON.stringify(["RD04"])) {
	throw new Error(`rejudge termination changed: expected stable RD04 dissent, got ${(rejudgeRound.open ?? []).join(",")}`);
}
const belowBar = convergence.novel.converged / convergence.novel.total < 0.95;
let decision = null;
if (ADOPT_DECISION === "A") {
	if (!precision) throw new Error("Option A requires the completed precision consensus state");
	const adoptedLine = readFileSync(`${REPO}/${DECISION_DOC}`, "utf8")
		.split("\n").find((line) => /^ADOPTED: Option A\b/.test(line));
	if (!adoptedLine && !DRY_RUN) throw new Error(`refusing --adopt-decision A: ${DECISION_DOC} carries no "ADOPTED: Option A" line — the decision is Andreas's, not this script's`);
	// Restated gate (memo rule): every novel cluster must be ADDRESSED —
	// converged, or terminated as a stable recorded dissent after the maximum
	// rounds. The terminated ids are pinned; any drift refuses the build.
	const terminated = [...precisionFinalOpen, ...[...novelOpen].filter((id) => !precisionReplaced.has(id))].sort();
	if (terminated.join(",") !== [...OPTION_A_TERMINATED].sort().join(",")) {
		throw new Error(`terminated set drifted from the registered Option A list: got ${terminated.join(",")}`);
	}
	if (convergence.novel.converged + terminated.length !== convergence.novel.total) {
		throw new Error(`addressed count broken: ${convergence.novel.converged} converged + ${terminated.length} terminated != ${convergence.novel.total}`);
	}
	decision = {
		doc: DECISION_DOC,
		option: "A",
		adopted: adoptedLine ? adoptedLine.trim() : "DRY RUN — NOT ADOPTED, output is a projection",
		terminated,
		rawConvergence: `${convergence.novel.converged}/${convergence.novel.total}`,
	};
} else if (belowBar && !ALLOW_PROVISIONAL) {
	throw new Error(`refusing final v2 build below the registered 95% novel-consensus bar: ${convergence.novel.converged}/${convergence.novel.total} (use --allow-provisional only for recovery/checker work)`);
}

// inheritCredit: the removed EXP-c-12's five pool credits re-route onto the
// split replacements (rejudge.json is the routing evidence).
const rj = JSON.parse(readFileSync(`${P}/pool/rejudge.json`, "utf8"));
for (const rec of [...rejudge.issues, ...rejudge.rejected]) {
	// records were built from issues whose id (C12A...) differs from the slug; match by member
	const srcId = rec.members?.[0];
	const item = rj.issues.find((i) => (i.members ?? [])[0] === srcId);
	const credit = item?.inheritCredit;
	if (!credit) continue;
	rec.members = [...rec.members, ...credit];
	rec.provenance = [...new Set([...(rec.provenance ?? []), ...credit.map((m) => SOURCE[m[0]])])].sort();
}

// RULING 2 repair for the clusterer's under-merge (triaged harness-bug): the
// judges rate each statement as stated per the rubric, so cross-record
// individuation lands here, visibly. I57+I58 fold into I59's suite-level
// record; I62+I63+I64 fold into one boundary-coverage record.
const byIssueId = (issueId) => {
	const members = novelState.find((i) => i.id === issueId)?.members ?? [];
	return novel.issues.find((r) => sameSet(r.members ?? [], members));
};
const fold = (hostIssueId, absorbedIssueIds, mergedStatement) => {
	const host = byIssueId(hostIssueId);
	if (!host) throw new Error(`fold host ${hostIssueId} not in accepted set`);
	for (const aid of absorbedIssueIds) {
		const rec = byIssueId(aid);
		if (!rec) throw new Error(`fold member ${aid} not in accepted set`);
		if (rec.tier !== host.tier) throw new Error(`fold tier mismatch ${aid} (${rec.tier}) vs ${hostIssueId} (${host.tier})`);
		host.members = [...host.members, ...rec.members];
		novel.issues = novel.issues.filter((r) => r !== rec);
	}
	host.provenance = [...new Set(host.members.map((m) => SOURCE[m[0]]))].sort();
	if (mergedStatement) host.statement = mergedStatement;
	host.ruling2Merge = `folded ${absorbedIssueIds.join("+")} into this record 2026-08-02: one issue per defective expression — the pool clusterer under-merged; every folded member was independently judged ${host.tier} through the full protocol`;
};
fold("V2-I59", ["V2-I57", "V2-I58"], null);
fold("V2-I62", ["V2-I63", "V2-I64"],
	"maskEmail/redactLine boundary and integration coverage is absent from test/redact.test.js: trailing punctuation, uppercase local parts, TLD-less strings, digit-only-local ordering, and the dispatcher's actual attempt-line shape are all unpinned by any assertion.");

// The live dataset is the OUTPUT of this script. Reading it as the base made a
// second invocation merge v2 onto itself. Pin the immutable v1 Git object and
// assert its content version before any output is written.
const base = JSON.parse(execFileSync(
	"git",
	["show", `${BASE_COMMIT}:experiments/golden-dataset.json`],
	{ cwd: REPO, encoding: "utf8" },
));
if (base.version !== BASE_VERSION) throw new Error(`base ${BASE_COMMIT} is ${base.version}, expected ${BASE_VERSION}`);
const baseAll = [...base.issues, ...base.rejected];
const rec = (id) => baseAll.find((r) => r.id === id);

// r-d23 / r-d14 reason trims (audit editorial): drop driver-era clauses from
// seed-era records' recorded reasons; trims logged, never silent.
const trimVotes = (id, patterns) => {
	const r = rec(id);
	const votes = JSON.parse(JSON.stringify(r.votes));
	const trimmed = [];
	for (const p of Object.keys(votes)) {
		for (const pat of patterns) {
			if (pat.test(votes[p].reason)) {
				votes[p].reason = votes[p].reason.replace(pat, "").replace(/\s+([,.])/g, "$1").replace(/,\s*$/, ".").trim();
				trimmed.push(p);
			}
		}
	}
	return { votes, note: `reasons trimmed 2026-08-02 (v1 audit: driver-era clauses on a seed-era record): ${[...new Set(trimmed)].join(", ")}` };
};
const d23 = trimVotes("SCHED-r-d23", [/,?\s*and both `?sweepExpired`? and `?stats`?[^.]*\./i, /,?\s*`?stats`? uses the exact complement[^,.]*(,[^,.]*)?/i]);
const d14 = trimVotes("SCHED-r-d14", [/,?\s*and on the last attempt dead-letters a job that actually succeeded/i]);

const ed = JSON.parse(readFileSync(`${P}/pool/editorial.json`, "utf8")).proposals[0];
const oldDissent = (id) => rec(id).dissent;

const edits = {
	remove: ["EXP-c-12", "SCHED-r-d22", "SCHED-r-d04", "SCHED-r-d36"],
	patch: {
		"SCHED-r-d20": {
			tier: "blocking", consensus: "unanimous",
			dissent: `RESOLVED 2026-08-02: RULING 4 confirmation deliberation (state consensus-ruling4), unanimous blocking — the caller-side discount the stall rested on is now ruled. Original stall: ${oldDissent("SCHED-r-d20")}`,
		},
		"SCHED-r-d37": {
			tier: "blocking", consensus: "unanimous",
			dissent: `RESOLVED 2026-08-02: RULING 4 confirmation deliberation (state consensus-ruling4), unanimous blocking — same ground as SCHED-r-d20. Original stall: ${oldDissent("SCHED-r-d37")}`,
		},
		"SCHED-o-g02": {
			statement: ed.proposedStatement,
			anchors: ed.proposedAnchors,
			ratified: "2026-08-02 statement narrowing, unanimous (state consensus-editorial): all v1 votes rested on the sweepExpired JSDoc, not docs/scheduling.md",
		},
		"SCHED-r-d23": { votes: d23.votes, reasonTrimmed: d23.note },
		"SCHED-r-d14": { votes: d14.votes, reasonTrimmed: d14.note },
		"EXP-c-04": {
			matchedAgain: "R-BE3-08 independently re-raised the same tenant-filter claim; the reviewed pool mapping credited its provenance here and explicitly kept the v1 rejection",
		},
	},
	addMembers: {},
};
const creditFile = JSON.parse(readFileSync(`${P}/pool/credit.json`, "utf8"));
if (creditFile.baseVersion !== base.version) throw new Error(`credit.json built against ${creditFile.baseVersion}, base is ${base.version}`);
if (!creditFile.credit || Object.keys(creditFile.credit).length === 0) throw new Error("credit.json carries no credit map");
for (const [target, srcs] of Object.entries(creditFile.credit)) {
	if (target === "EXP-c-12") continue; // re-routed via inheritCredit
	edits.addMembers[target] = srcs;
}
if (Object.keys(edits.addMembers).length === 0) throw new Error("addMembers empty after routing — expected ~11 credited records");

const addition = {
	builtFrom: { novel: novel.builtFrom, precision: precision?.builtFrom ?? null, rejudge: rejudge.builtFrom, runId: RUN_ID },
	issues: [...novel.issues, ...rejudge.issues],
	rejected: [...novel.rejected, ...rejudge.rejected],
};
const merged = mergeDatasets(base, addition, edits);
merged.builtFrom.baseCommit = BASE_COMMIT;
merged.builtFrom.consensus = convergence;
if (decision) {
	merged.builtFrom.protocolDecision = decision;
} else if (belowBar) {
	merged.provisional = {
		reason: "below the registered 95% consensus bar",
		convergence,
	};
}
merged.builtFrom.stableDissent = decision
	? { novel: decision.terminated, rejudge: ["RD04"] }
	: { rejudge: ["RD04"] };

// Schema repair is editorial source metadata only: it changes no statement,
// vote, tier, status, or dataset content version. Every anchor names its exact
// file, matching semantics, and judged endpoint. Test-gap anchors also record
// the literal source strings whose absence is the claim.
const plantedAnchors = Object.fromEntries(TRAJECTORY_TASKS.flatMap((task) => task.defects.map((defect) => [
	defect.id,
	{
		expression: defect.expression,
		declaration: defect.declaration,
		identifier: defect.identifier,
		file: defect.file,
		match: "regex",
		state: "seed",
	},
])));
for (const issue of merged.issues) {
	const planted = issue.planted?.[0];
	if (planted) {
		issue.anchors = { ...plantedAnchors[planted], state: issue.frame === "seed" ? "seed" : "start" };
	} else if (issue.anchors) {
		issue.anchors.match ??= "literal";
		issue.anchors.state ??= issue.frame === "seed" ? "seed" : "end";
	}
}
const narrowedDocRecord = merged.issues.find((candidate) => candidate.id === "SCHED-o-g02");
if (!narrowedDocRecord) throw new Error("SCHED-o-g02 missing after merge");
Object.assign(narrowedDocRecord.anchors, { file: "src/scheduler.js", match: "literal", state: "seed" });

const anchorPatches = {
	"EXP-o-xe-g14": {
		expression: "import { csvField, csvRow } from \"../src/csv.js\";",
		absent: ["exportOrders", "since"],
	},
	"EXP-o-xe-g19": {
		expression: "import { csvField, csvRow } from \"../src/csv.js\";",
		absent: ["exportOrders"],
	},
	"DISP-o-xd-g20": {
		expression: "import { maskCard, maskEmail, redactLine } from \"../src/redact.js\";",
		absent: ["withRetries", "dispatchCharge"],
	},
	"DISP-o-xd-g26": {
		expression: "test(\"maskEmail keeps the first character and the domain\"",
		absent: ["a@x.com", "ADA@EXAMPLE.COM", "ada@localhost", "123@example.com"],
	},
	"EXP-c-12a": {
		expression: "return /[\",\\n]/.test(text) ?",
		file: "src/csv.js",
		match: "literal",
		state: "seed",
	},
};
for (const [id, anchors] of Object.entries(anchorPatches)) {
	const issue = merged.issues.find((candidate) => candidate.id === id);
	if (!issue) throw new Error(`anchor patch references missing active record ${id}`);
	issue.anchors = { ...issue.anchors, ...anchors };
}

const preconditions = {
	"EXP-r-be1-04": "a stored monetary amount falls on a decimal midpoint that binary floating point cannot represent exactly",
	"EXP-c-ru08": "an order references a customer id absent from the customer table",
	"EXP-o-xe-g21": "a negative amount falls on a half-cent boundary where Math.round and toFixed disagree",
	"EXP-o-xe-g14": null,
	"EXP-o-xe-g19": null,
	"EXP-o-xe-g17": null,
	"SCHED-c-ru13a": "the pending backlog is large enough for the full sort to dominate each claim tick",
	"SCHED-c-ru13b": "logSummary runs frequently over a large job map",
	"DISP-o-xd-g11": null,
	"DISP-o-xd-g20": null,
	"DISP-o-xd-g26": null,
	"DISP-c-ru10": null,
};
for (const issue of merged.issues.filter((candidate) => candidate.firstSeen !== "2026-08-02-golden-dataset-v1")) {
	if (!("precondition" in issue) && !(issue.id in preconditions)) throw new Error(`${issue.id}: missing explicit precondition repair`);
	if (!("precondition" in issue)) issue.precondition = preconditions[issue.id];
	if (!issue.anchors?.file || !issue.anchors?.match || !issue.anchors?.state) throw new Error(`${issue.id}: incomplete repaired anchor`);
}
const atomicWrite = (path, body) => {
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, body);
	renameSync(temporary, path);
};
const outDir = DRY_RUN ? mkdtempSync(join(tmpdir(), "golden-v2-dry-run-")) : null;
if (DRY_RUN) console.log(`DRY RUN — nothing written to the repo or state root; projection in ${outDir}`);
atomicWrite(DRY_RUN ? `${outDir}/edits-v2.json` : `${P}/edits-v2.json`, `${JSON.stringify(edits, null, 1)}\n`);
atomicWrite(DRY_RUN ? `${outDir}/golden-dataset.json` : `${REPO}/experiments/golden-dataset.json`, `${JSON.stringify(merged, null, 1)}\n`);

const tiers = { blocking: 0, harmful: 0 };
const byTask = {};
for (const i of merged.issues) {
	tiers[i.tier] += 1;
	byTask[i.task] = byTask[i.task] ?? { blocking: 0, harmful: 0 };
	byTask[i.task][i.tier] += 1;
}
console.log(`v2 version ${merged.version} — ${merged.issues.length} active (${tiers.blocking} blocking, ${tiers.harmful} harmful), ${merged.rejected.length} rejected`);
for (const [t, c] of Object.entries(byTask)) console.log(`  ${t}: ${c.blocking} blocking + ${c.harmful} harmful`);
for (const i of merged.issues.filter((x) => x.consensus === "unresolved")) console.log(`DISSENT ${i.id} [${i.tier}]: ${i.dissent.slice(0, 160)}`);
console.log(`novel: ${novel.issues.length} accepted / ${novel.rejected.length} rejected; rejudge: ${rejudge.issues.length} / ${rejudge.rejected.length}`);
