/**
 * Invariants for the provenance layer: fingerprints (S5), the six refusal call
 * sites, the run ledger, the shared costing module, and the frozen-artifact
 * manifests.
 *
 * Runs under `node --test`, like the other `*.check.mjs` guards, and makes ZERO
 * provider calls. The producer and the judge are never spawned here — both make
 * real calls once their guards pass — so every refusal they implement lives as a
 * pure function in `fingerprints.mjs` and is asserted directly. The summarizer
 * IS spawned: it only reads files.
 *
 * The rule under test throughout: ABSENT FINGERPRINT MEANS UNVERIFIED (count it,
 * report it, proceed); PRESENT AND MISMATCHED MEANS REFUSE. A guard that fired
 * on absence would make every frozen artifact unloadable, which is the one
 * outcome worse than the drift it is trying to catch.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";

import {
	assertCaseMembership,
	builderHashConflict,
	buildRunHeader,
	caseHash,
	caseHashes,
	contractHashOf,
	corpusHash,
	describeDrift,
	gitProvenance,
	headerDrift,
	joinConflicts,
	lensHash,
	poolingConflicts,
	probeCase,
	promptHash,
	readRunHeader,
	sha16,
	splitHeader,
	staleCaseRows,
} from "./fingerprints.mjs";
import { armContractHash, armContractHashes, armSpec, GOLDEN_ARMS, goldenHandoff, headLens } from "./arm-registry.mjs";
import { judgeBuilderHash, judgeBuilderSource } from "./delivery-context-judge-protocol.mjs";
import {
	DRIVER_TOKEN_SCOPES,
	FIXTURE_PRICES,
	HARNESS_BASIS,
	PRODUCTION_BASIS,
	driverTokensByCase,
	flatUsage,
	priceRow,
	priceTable,
	pricesFor,
	pricesHash,
	productionCost,
	rawCost,
} from "./costing.mjs";
import { appendEntry, harnessSpend, ledgerEntry, readLedger, reconcile, renderMarkdown, validateEntry } from "./run-ledger.mjs";
import { ARTIFACT_ROOT, buildManifests, formatManifest, logicalName, parseManifest, providersFor, tokenIsStale, verifyDir } from "./hydra-lab.mjs";
import { GOLDEN_CASES, GOLDEN_HEADS } from "./delivery-context-golden-cases.mjs";
import { SCREEN_CASES } from "./delivery-context-screen-cases.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const scratchDirs = [];
function scratch() {
	const dir = mkdtempSync(join(tmpdir(), "hydra-provenance-"));
	scratchDirs.push(dir);
	return dir;
}
process.on("exit", () => {
	for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. The frozen promptHash definition may never move.
// ---------------------------------------------------------------------------

test("promptHash reproduces the definition frozen rows carry", () => {
	// Byte-identical to delivery-context-golden-ab.mjs's inline expression:
	// sha256(prompt + "\n" + (envelope ?? "")), full 64 hex, not shortened.
	assert.equal(promptHash("PROMPT", "ENVELOPE").length, 64);
	assert.equal(promptHash("PROMPT", undefined), promptHash("PROMPT", ""));
	assert.notEqual(promptHash("PROMPT", "A"), promptHash("PROMPT", "B"));
});

test("frozen producer rows still reproduce their own promptHash at HEAD", () => {
	// The 943-row reproduction the audit ran, kept as a standing check on one
	// wave: if a builder edit ever moves the contract text, this fails here
	// rather than in a verdict six weeks later.
	const path = join(ARTIFACT_ROOT, "2026-07-31-xhigh-screen", "producer.jsonl.gz");
	const rows = gunzipSync(readFileSync(path))
		.toString("utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.ok(rows.length > 0);
	let checked = 0;
	for (const row of rows) {
		if (row.error || !row.promptHash) continue;
		const testCase = [...GOLDEN_CASES, ...SCREEN_CASES].find((item) => item.id === row.case);
		if (!testCase) continue;
		const handoff = goldenHandoff(row.arm, row.provider, testCase);
		assert.equal(promptHash(handoff.prompt, handoff.envelope), row.promptHash, `${row.case}/${row.arm}`);
		checked++;
	}
	assert.ok(checked > 50, `expected to check many rows, checked ${checked}`);
});

// ---------------------------------------------------------------------------
// 2. Case and corpus identity.
// ---------------------------------------------------------------------------

test("caseHash covers what the judge reads and ignores what it does not", () => {
	const [base] = GOLDEN_CASES;
	assert.equal(caseHash(base), caseHash({ ...base }));
	// Renaming a case does not change its content identity...
	assert.equal(caseHash({ ...base, id: "renamed" }), caseHash(base));
	// ...but every field the judge or the summarizer reads does.
	for (const [field, value] of [
		["messages", [{ role: "user", text: "different" }]],
		["state", { lastByThisHead: { head: "quality", delivery: "steer", message: "injected" }, pending: [{ head: "security", delivery: "queue", message: "injected" }] }],
		["findingTarget", "something else"],
		["expectedDelivery", "interrupt"],
		["category", "fresh-different"],
		["critical", !base.critical],
	]) {
		assert.notEqual(caseHash({ ...base, [field]: value }), caseHash(base), `${field} must be inside caseHash`);
	}
});

test("corpusHash moves on a case edit, a rename, and a reorder", () => {
	const base = corpusHash("golden", GOLDEN_CASES);
	assert.equal(base.length, 16);
	assert.equal(corpusHash("golden", GOLDEN_CASES), base);
	assert.notEqual(corpusHash("screen", GOLDEN_CASES), base, "the corpus name is part of its identity");
	assert.notEqual(corpusHash("golden", GOLDEN_CASES.slice(0, -1)), base, "the case count is part of its identity");
	const renamed = [{ ...GOLDEN_CASES[0], id: "renamed" }, ...GOLDEN_CASES.slice(1)];
	assert.notEqual(corpusHash("golden", renamed), base, "a rename breaks every resume key, so it must surface");
	const reordered = [GOLDEN_CASES[1], GOLDEN_CASES[0], ...GOLDEN_CASES.slice(2)];
	assert.notEqual(corpusHash("golden", reordered), base);
});

// ---------------------------------------------------------------------------
// 3. Contract identity per arm (the invariant the provenance gate states).
// ---------------------------------------------------------------------------

test("an arm's contractHash is invariant across the whole corpus", () => {
	// This is what makes "distinct contractHash within an arm equals 1" a
	// statable gate. promptHash cannot do it: the state-carrying arms vary it
	// per case by design.
	for (const arm of ["control", "samehead", "unseenonly", "screen-footer"]) {
		const expected = armContractHash(arm, "anthropic");
		for (const testCase of GOLDEN_CASES) {
			const handoff = goldenHandoff(arm, "anthropic", testCase);
			const perCase = contractHashOf(handoff, headLens(testCase.head));
			// The per-case rendering is NOT the fingerprint; assert only that the
			// fingerprint itself does not depend on the case.
			assert.equal(armContractHash(arm, "anthropic"), expected);
			assert.equal(typeof perCase, "string");
		}
	}
	const stateCarrying = new Set(GOLDEN_CASES.map((testCase) => contractHashOf(goldenHandoff("control", "anthropic", testCase), headLens(testCase.head))));
	assert.ok(stateCarrying.size > 1, "a state-carrying arm must vary per case — which is why the probe exists");
});

test("contractHash separates implementations that share an arm label", () => {
	// The frozen arm C is 456 rows of `treatment` plus 36 of `samehead` under one
	// letter. These three differ only in which delivery state they project.
	const hashes = ["control", "samehead", "unseenonly"].map((arm) => armContractHash(arm, "anthropic"));
	assert.equal(new Set(hashes).size, 3);
	// And on OpenAI too, where the state rides in the envelope instead.
	assert.equal(new Set(["control", "samehead", "unseenonly"].map((arm) => armContractHash(arm, "openai-codex"))).size, 3);
});

test("every registered arm has a stable per-provider contract hash", () => {
	for (const provider of ["anthropic", "openai-codex"]) {
		const hashes = armContractHashes(Object.keys(GOLDEN_ARMS), provider);
		for (const [arm, hash] of Object.entries(hashes)) {
			assert.match(hash, /^[0-9a-f]{16}$/, arm);
			assert.equal(hash, armContractHash(arm, provider));
		}
		// main-json and screen-a0 render byte-identical PROMPTS on Anthropic
		// (both build the shipped main text) and differ on OpenAI, where the
		// screen arm splits lens from envelope. They are still different
		// contracts on both: `wide` advertises the full hydra schema,
		// `management-only` does not, which is a real difference in what the
		// model is shown and 135-214 tokens on every driver request. Hashing
		// text alone collided them on 45d6beaafb39bb24 and would have let one
		// certify as the other, so the tool surface is hashed with the text.
		assert.equal(armSpec("main-json").toolSurface, "wide");
		assert.equal(armSpec("screen-a0").toolSurface, "management-only");
		assert.notEqual(hashes["main-json"], hashes["screen-a0"]);
	}
});

test("the probe state carries two heads, or the samehead filter is invisible", () => {
	const probe = probeCase(Object.keys(GOLDEN_HEADS));
	assert.equal(new Set(probe.state.pending.map((item) => item.head)).size, 2);
	assert.ok(probe.state.lastByThisHead, "an empty lastByThisHead would hide the unseenonly projection");
	assert.equal(lensHash(headLens(probe.head)).length, 16);
});

// ---------------------------------------------------------------------------
// 4. The six refusals.
// ---------------------------------------------------------------------------

function header(overrides = {}) {
	return buildRunHeader({
		script: "test",
		argv: [],
		codeCommit: "aaaa111",
		treeDirty: false,
		corpusName: "screen",
		corpusHash: corpusHash("screen", SCREEN_CASES),
		caseCount: SCREEN_CASES.length,
		caseHashes: caseHashes(SCREEN_CASES),
		arms: ["A0", "F"],
		armContractHashes: { "anthropic/A0": "1111111111111111", "anthropic/F": "2222222222222222" },
		pricesHash: "3333333333333333",
		...overrides,
	});
}

test("refusal 1: producer resume aborts on environment drift, and only on drift", () => {
	const current = header();
	assert.deepEqual(headerDrift(header(), current), []);
	assert.deepEqual(headerDrift(null, current), [], "no previous header is unverified, not a conflict");

	const commitDrift = headerDrift(header({ codeCommit: "bbbb222" }), current);
	assert.equal(commitDrift.length, 1);
	assert.equal(commitDrift[0].field, "codeCommit");
	assert.match(describeDrift(commitDrift), /codeCommit: bbbb222 -> aaaa111/);

	assert.equal(headerDrift(header({ corpusHash: "deadbeefdeadbeef" }), current)[0].field, "corpusHash");
	assert.equal(headerDrift(header({ pricesHash: "9999999999999999" }), current)[0].field, "pricesHash");
	// An arm whose contract moved is named by arm, not as "the object differs".
	const armed = headerDrift(header({ armContractHashes: { "anthropic/A0": "1111111111111111", "anthropic/F": "ffffffffffffffff" } }), current);
	assert.deepEqual(armed.map((item) => item.field), ["armContractHashes.anthropic/F"]);
	// Adding an arm to an existing file is ordinary practice, not drift.
	assert.deepEqual(headerDrift(header({ armContractHashes: { "anthropic/A0": "1111111111111111" } }), current), []);
});

test("refusal 2: a row may only be written for a case the header's corpus holds", () => {
	const head = header();
	const [known] = SCREEN_CASES;
	assert.deepEqual(assertCaseMembership(head, known), { verified: true });
	assert.throws(() => assertCaseMembership(head, { ...known, id: "not-in-this-corpus" }), /not in this file's corpus/);
	assert.throws(() => assertCaseMembership(head, { ...known, findingTarget: "edited after the fact" }), /content changed since this file's header/);
	// Legacy file, no header: unverified rather than refused.
	assert.deepEqual(assertCaseMembership(null, known), { verified: false, reason: "no run header" });

	// The escape the message offers must actually work. It did not: refusal 1
	// honored --force-mixed and this one threw regardless, so an operator who
	// followed the error text hit the same error again with no way forward.
	const forced = assertCaseMembership(head, { ...known, findingTarget: "edited" }, { force: true });
	assert.equal(forced.verified, false);
	assert.match(forced.reason, /content changed since this file's header/);
	assert.equal(assertCaseMembership(head, { ...known, id: "absent" }, { force: true }).verified, false);
});

test("refusal 3: the judge refuses a foreign ruleset and tolerates an unfingerprinted one", () => {
	const current = judgeBuilderHash();
	assert.match(current, /^[0-9a-f]{16}$/);
	assert.equal(judgeBuilderHash(), current, "the hash must be stable across calls");
	// Sensitive to the policy text and to every builder it hashes.
	assert.notEqual(sha16(judgeBuilderSource().replace("Support requires evidence", "Support requires vibes")), current);
	for (const marker of ["Evidence policy for this benchmark", "centralSupported", "TARGET ISSUE", "Return exactly one JSON object"]) {
		assert.ok(judgeBuilderSource().includes(marker), `judgeBuilderSource must cover ${marker}`);
	}

	const same = builderHashConflict([{ judgeBuilderHash: current }], current);
	assert.deepEqual(same, { foreign: [], unfingerprinted: 0 });
	const foreign = builderHashConflict([{ judgeBuilderHash: "0000000000000000" }], current);
	assert.deepEqual(foreign.foreign, ["0000000000000000"]);
	const legacy = builderHashConflict([{ judge: "sol", metric: "support" }], current);
	assert.deepEqual(legacy, { foreign: [], unfingerprinted: 1 }, "frozen judgments must stay appendable");
});

test("refusal 3: the judge refuses rows whose case content moved under them", () => {
	const [testCase] = SCREEN_CASES;
	const live = new Map([[testCase.id, testCase]]);
	const caseOf = (id) => live.get(id);
	assert.deepEqual(staleCaseRows([{ case: testCase.id, caseHash: caseHash(testCase) }], caseOf), { stale: [], unfingerprinted: 0 });
	const drifted = staleCaseRows([{ case: testCase.id, caseHash: "0000000000000000" }], caseOf);
	assert.equal(drifted.stale.length, 1);
	assert.match(drifted.stale[0], new RegExp(testCase.id));
	assert.deepEqual(staleCaseRows([{ case: testCase.id }], caseOf), { stale: [], unfingerprinted: 1 });
});

test("refusal 4: pooling conflicts are found per field and per arm, never on absence", () => {
	const a = header();
	assert.deepEqual(poolingConflicts([a, header()]), []);
	assert.deepEqual(poolingConflicts([a, null, null]), [], "headerless inputs are unverified, not conflicting");
	assert.deepEqual(poolingConflicts([null, null]), []);
	const corpora = poolingConflicts([a, header({ corpusHash: "cccccccccccccccc" })]);
	assert.deepEqual(corpora.map((item) => item.field), ["corpusHash"]);
	const arms = poolingConflicts([a, header({ armContractHashes: { "anthropic/A0": "eeeeeeeeeeeeeeee" } })]);
	assert.deepEqual(arms.map((item) => item.field), ["armContractHashes.anthropic/A0"]);
});

test("refusal 5: the judgment join is checked only where both sides carry a hash", () => {
	const sourceKeyOf = (row) => `${row.model}/${row.case}/${row.sample}/${row.arm}`;
	const row = { model: "opus-high", case: "c1", sample: 1, arm: "F", caseHash: "1111111111111111" };
	const agree = joinConflicts([row], [{ sourceKey: sourceKeyOf(row), judge: "sol", metric: "support", caseHash: "1111111111111111" }], { sourceKeyOf });
	assert.deepEqual(agree, { conflicts: [], unverified: 0 });
	const disagree = joinConflicts([row], [{ sourceKey: sourceKeyOf(row), judge: "sol", metric: "support", caseHash: "2222222222222222" }], { sourceKeyOf });
	assert.equal(disagree.conflicts.length, 1);
	const legacy = joinConflicts([{ ...row, caseHash: undefined }], [{ sourceKey: sourceKeyOf(row), judge: "sol", metric: "support" }], { sourceKeyOf });
	assert.deepEqual(legacy, { conflicts: [], unverified: 1 });
});

test("run headers split out of the row stream and read back off disk", () => {
	const dir = scratch();
	const path = join(dir, "rows.jsonl");
	const written = header();
	writeFileSync(path, `${JSON.stringify(written)}\n${JSON.stringify({ model: "m", case: "c" })}\n`);
	const read = readRunHeader(path);
	assert.equal(read.corpusHash, written.corpusHash);
	const { header: split, rows } = splitHeader([written, { model: "m" }, { model: "n" }]);
	assert.equal(split.kind, "run-header");
	assert.equal(rows.length, 2);
	// A legacy file: first line is a row, not a header.
	writeFileSync(path, `${JSON.stringify({ model: "m", case: "c" })}\n`);
	assert.equal(readRunHeader(path), null);
	assert.equal(splitHeader([{ model: "m" }]).header, null);
});

test("git provenance records the commit and whether the tree was dirty", () => {
	const git = gitProvenance(HERE);
	assert.match(git.codeCommit ?? "", /^[0-9a-f]{40}$/);
	assert.equal(typeof git.treeDirty, "boolean");
	assert.equal(git.treeDirty, git.diffHash !== null, "a dirty tree must carry its diff hash and a clean one must not");
	// Never throws outside a repository.
	assert.equal(gitProvenance(tmpdir()).codeCommit, null);
});

// ---------------------------------------------------------------------------
// 5. Refusals 4-6 end to end, through the summarizer.
// ---------------------------------------------------------------------------

function producerRow(overrides = {}) {
	return {
		provider: "anthropic",
		model: "opus-high",
		modelId: "claude-opus-5",
		arm: "A0",
		implementationArm: "screen-a0",
		case: "c1",
		sample: 1,
		head: "quality",
		category: "fresh",
		completionValid: true,
		formatValid: true,
		delivery: "steer",
		message: "A finding.",
		deliveryCorrect: true,
		deliveryExact: true,
		expectedDelivery: "steer",
		providerCalls: 1,
		recoveryAttempted: false,
		ms: 100,
		usage: { cost: 0.01, input: 10, output: 20, cacheRead: 100, cacheWrite: 0 },
		hitRatio: 50,
		promptHash: "a".repeat(64),
		...overrides,
	};
}

function summarize({ inputs, judgments = [], args = [] }) {
	const dir = scratch();
	const inputPaths = inputs.map((rows, index) => {
		const path = join(dir, `rows-${index}.jsonl`);
		writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
		return path;
	});
	const judgePath = join(dir, "judgments.jsonl");
	writeFileSync(judgePath, `${judgments.map((row) => JSON.stringify(row)).join("\n")}\n`);
	return spawnSync(
		process.execPath,
		[join(HERE, "summarize-delivery-context-golden.mjs"), "--input", inputPaths.join(","), "--judges", judgePath, "--json", ...args],
		{ encoding: "utf8" },
	);
}

test("summarizer refuses to pool inputs whose headers disagree", () => {
	const a = header({ corpusHash: "1111111111111111" });
	const b = header({ corpusHash: "2222222222222222" });
	const conflict = summarize({ inputs: [[a, producerRow()], [b, producerRow({ sample: 2 })]] });
	assert.notEqual(conflict.status, 0);
	assert.match(conflict.stderr, /refusing to pool/);
	assert.match(conflict.stderr, /corpusHash/);

	const agreeing = summarize({ inputs: [[a, producerRow()], [a, producerRow({ sample: 2 })]] });
	assert.equal(agreeing.status, 0, agreeing.stderr);
	const result = JSON.parse(agreeing.stdout);
	assert.equal(result.rows, 2, "the header line must never be counted as an observation");
	assert.equal(result.provenance.runHeaders.length, 2);
	assert.equal(result.provenance.unverified.inputsWithoutHeader, 0);
});

test("summarizer pools headerless legacy inputs and reports them as unverified", () => {
	const legacy = summarize({ inputs: [[producerRow()], [producerRow({ sample: 2 })]] });
	assert.equal(legacy.status, 0, legacy.stderr);
	const result = JSON.parse(legacy.stdout);
	assert.equal(result.rows, 2);
	assert.equal(result.provenance.unverified.inputsWithoutHeader, 2);
	assert.equal(result.provenance.unverified.rowsWithoutCaseHash, 2);
	assert.equal(result.provenance.unverified.rowsWithoutContractHash, 2);
});

test("summarizer refuses a judgment bound to different case content", () => {
	const row = producerRow({ caseHash: "1111111111111111" });
	const judgment = { judge: "sol", metric: "support", sourceKey: "opus-high/c1/1/A0", centralSupported: true, caseHash: "2222222222222222" };
	const conflict = summarize({ inputs: [[row]], judgments: [judgment] });
	assert.notEqual(conflict.status, 0);
	assert.match(conflict.stderr, /different case content/);

	const agreeing = summarize({ inputs: [[row]], judgments: [{ ...judgment, caseHash: "1111111111111111" }] });
	assert.equal(agreeing.status, 0, agreeing.stderr);
});

test("summarizer refuses two judge rulesets in one pool", () => {
	const row = producerRow();
	const key = "opus-high/c1/1/A0";
	const mixed = summarize({
		inputs: [[row]],
		judgments: [
			{ judge: "sol", metric: "support", sourceKey: key, centralSupported: true, judgeBuilderHash: "1111111111111111" },
			{ judge: "opus", metric: "support", sourceKey: key, centralSupported: true, judgeBuilderHash: "2222222222222222" },
		],
	});
	assert.notEqual(mixed.status, 0);
	assert.match(mixed.stderr, /distinct judgeBuilderHash/);
});

test("the provenance gate states one contract per arm, and keeps the legacy form for frozen rows", () => {
	// Modern rows: two contract hashes inside one arm is the arm-C failure.
	const mixedArm = summarize({
		inputs: [[producerRow({ contractHash: "1111111111111111" }), producerRow({ sample: 2, contractHash: "2222222222222222" })]],
	});
	assert.equal(mixedArm.status, 0, mixedArm.stderr);
	const groups = JSON.parse(mixedArm.stdout).groups;
	assert.equal(groups["anthropic/opus-high/A0"].contractVariants, 2);

	// Legacy rows: no contractHash anywhere, so the metric is null and the gate
	// falls back to the promptHash form the frozen verdicts were computed under.
	const legacy = summarize({ inputs: [[producerRow(), producerRow({ sample: 2 })]] });
	assert.equal(JSON.parse(legacy.stdout).groups["anthropic/opus-high/A0"].contractVariants, null);
});

// ---------------------------------------------------------------------------
// 6. Costing: both bases named, one implementation.
// ---------------------------------------------------------------------------

test("the harness basis and the production basis price the same row differently", () => {
	// One synthetic observation: a 10k-token driver prefix the arm rode, 500
	// tokens of its own contract billed uncached, 200 tokens out.
	const row = producerRow({ usage: { input: 500, output: 200, cacheRead: 10_000, cacheWrite: 0, cost: 0.0123 } });
	const prices = { "claude-opus-5": FIXTURE_PRICES };
	const usage = flatUsage(row.usage);

	const harness = priceRow(row, { basis: HARNESS_BASIS, prices });
	assert.equal(harness, rawCost(usage, FIXTURE_PRICES));
	// 10000*0.5 + 500*5 + 200*25 = 5000 + 2500 + 5000 µ$ = $0.0125
	assert.equal(Number(harness.toFixed(6)), 0.0125);

	const production = priceRow(row, { basis: PRODUCTION_BASIS, prices, driverTokens: 10_000 });
	// driver 10000*0.5 + own (10500-10000)=500*5 + 200*25 — same here because the
	// prefix already rode the cache; the bases diverge on a cache WRITE.
	assert.equal(Number(production.toFixed(6)), 0.0125);

	const written = producerRow({ usage: { input: 2, output: 200, cacheRead: 0, cacheWrite: 10_500, cost: 0.07 } });
	const harnessWritten = priceRow(written, { basis: HARNESS_BASIS, prices });
	const productionWritten = priceRow(written, { basis: PRODUCTION_BASIS, prices, driverTokens: 10_000 });
	assert.ok(
		harnessWritten > productionWritten * 1.5,
		`the harness basis bills the prefix at cache-write rates and must overstate production (${harnessWritten} vs ${productionWritten})`,
	);
	assert.equal(priceRow(written, { basis: PRODUCTION_BASIS, prices: {}, driverTokens: 10_000 }), null, "an unpriced model reports null, never zero");
});

test("productionCost charges the driver prefix at cache-read and the contract at input", () => {
	assert.equal(productionCost({ input: 0, output: 0, cacheRead: 1000, cacheWrite: 0 }, FIXTURE_PRICES, 1000), 0.0005);
	assert.equal(productionCost({ input: 0, output: 0, cacheRead: 1000, cacheWrite: 0 }, FIXTURE_PRICES, 0), 0.005, "with no driver prefix everything is uncached input");
	// A driver-token estimate above what the call actually read never goes negative.
	assert.ok(productionCost({ input: 0, output: 0, cacheRead: 10, cacheWrite: 0 }, FIXTURE_PRICES, 1000) >= 0);
});

test("driver-token scope is an explicit choice, because the two readings disagree", () => {
	const rows = [
		{ case: "c1", model: "sonnet-medium", usage: { cacheRead: 0 } },
		{ case: "c1", model: "opus-medium", usage: { cacheRead: 9000 } },
		{ case: "c1", model: "sonnet-medium", usage: { cacheRead: 5 }, error: "ignored" },
	];
	assert.deepEqual([...DRIVER_TOKEN_SCOPES], ["all-models", "per-model"]);
	assert.equal(driverTokensByCase(rows).tokensFor(rows[0]), 9000, "the default imports the cross-model max, as the published table did");
	assert.equal(driverTokensByCase(rows, { scope: "per-model" }).tokensFor(rows[0]), 0);
	assert.throws(() => driverTokensByCase(rows, { scope: "invented" }), /unknown driver-token scope/);
});

test("prices are captured and hashed per run", () => {
	const table = priceTable([{ provider: "anthropic", id: "claude-opus-5" }], () => ({ cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } }));
	assert.deepEqual(table["claude-opus-5"], FIXTURE_PRICES);
	assert.match(pricesHash(table), /^[0-9a-f]{16}$/);
	assert.equal(pricesHash(table), pricesHash({ "claude-opus-5": FIXTURE_PRICES }));
	// A price change must move the hash — that is the whole point of capturing it.
	assert.notEqual(pricesHash({ "claude-opus-5": { ...FIXTURE_PRICES, output: 30 } }), pricesHash(table));
	// An unresolvable model is recorded as unpriced, not silently dropped.
	assert.deepEqual(priceTable([{ provider: "x", id: "y" }], () => null), { y: null });
	assert.notEqual(pricesHash({ y: null }), pricesHash({}));
	assert.throws(() => pricesFor(null), /no cost table/);
	assert.equal(pricesFor(null, { strict: false }), null);
});

// ---------------------------------------------------------------------------
// 7. The ledger.
// ---------------------------------------------------------------------------

test("ledger append is idempotent-refusing and supersede-aware", () => {
	const dir = scratch();
	const path = join(dir, "RUN-LEDGER.jsonl");
	const fields = { runId: "2026-08-02-test", date: "2026-08-02", script: "x.mjs", provenance: "measured", spendUSD: 1.5, rows: 10 };
	appendEntry(fields, { path });
	assert.equal(readLedger(path).length, 1);
	assert.throws(() => appendEntry(fields, { path }), /already in the ledger/);
	appendEntry(fields, { path, supersede: "rerun after the corpus fix" });
	const entries = readLedger(path);
	assert.equal(entries.length, 2);
	assert.match(entries[1].note, /supersedes earlier entry: rerun after the corpus fix/);
	assert.equal(readLedger(join(dir, "absent.jsonl")).length, 0);
});

test("ledger entries must carry an identity, a date and a provenance kind", () => {
	assert.throws(() => validateEntry(ledgerEntry({ date: "2026-08-02", script: "x", provenance: "measured" })), /missing runId/);
	assert.throws(() => validateEntry(ledgerEntry({ runId: "r", date: "2026-08-02", script: "x", provenance: "guessed" })), /provenance must be one of/);
	assert.throws(() => validateEntry(ledgerEntry({ runId: "r", date: "aug 2", script: "x", provenance: "measured" })), /date must be YYYY-MM-DD/);
});

test("reconcile answers every count the audit had to reconstruct by hand", () => {
	const rows = [
		{ model: "m", case: "c1", sample: 1, arm: "A0", usage: { cost: 1 } },
		{ model: "m", case: "c1", sample: 1, arm: "A0", error: "boom", usage: { cost: 0.5 } },
		{ model: "m", case: "c2", sample: 1, arm: "A0", error: "final", usage: { cost: 0.25 } },
	];
	const judgments = [
		{ judge: "sol", metric: "support", sourceKey: "m/c1/1/A0" },
		{ judge: "sol", metric: "support", sourceKey: "m/c1/1/A0" },
		{ judge: "sol", metric: "support", sourceKey: "m/absent/1/A0" },
	];
	const counts = reconcile(rows, judgments);
	assert.equal(counts.rows, 3);
	assert.equal(counts.uniqueCells, 2);
	assert.equal(counts.duplicateRows, 1);
	assert.equal(counts.errorRows, 2);
	assert.equal(counts.finalErrorCells, 2, "last row per cell wins, so the retried cell counts by its LAST attempt");
	assert.equal(counts.duplicateJudgments, 1);
	assert.equal(counts.orphanJudgments, 1);
	assert.deepEqual(counts.judgmentsByJudge, { sol: 3 });
	// Spend is money spent: retries and error rows included.
	assert.equal(harnessSpend(rows), 1.75);
});

test("the seeded ledger loads, validates, and renders", () => {
	const entries = readLedger();
	assert.ok(entries.length >= 14, `expected the seeded waves, found ${entries.length}`);
	for (const entry of entries) validateEntry(entry);
	const markdown = renderMarkdown(entries);
	assert.match(markdown, /# Run ledger/);
	assert.match(markdown, /Program totals/);
	// The mirror-only waves must stay visibly unfrozen rather than reading as filed.
	const orphaned = entries.filter((entry) => entry.artifactPaths.length === 0);
	assert.ok(orphaned.length >= 4, "the waves with no repo artifact are the point of the ledger");
	assert.ok(entries.some((entry) => entry.supersededBy), "the pre-repair matrix must record what superseded it");
});

// ---------------------------------------------------------------------------
// 8. Frozen-artifact manifests.
// ---------------------------------------------------------------------------

test("manifests round-trip and cover both the logical and the stored bytes", () => {
	const dir = scratch();
	writeFileSync(join(dir, "rows.jsonl"), '{"a":1}\n');
	const { logical, stored } = buildManifests(dir);
	assert.deepEqual(logical.map((item) => item.name), ["rows.jsonl"]);
	assert.deepEqual(stored.map((item) => item.name), ["rows.jsonl"]);
	assert.deepEqual(parseManifest(formatManifest(logical)), logical);
	assert.throws(() => parseManifest("not a manifest line"), /unparseable manifest line/);
	assert.equal(logicalName("rows.jsonl.gz"), "rows.jsonl");
	assert.equal(logicalName("payloads.tar.gz"), "payloads.tar.gz", "an archive has no single logical document");
});

test("every frozen artifact set verifies, with relative paths only", () => {
	// Wave directories only: the root also holds README.md, whose PROVENANCE
	// section records the 2026-08-01 manifest repair.
	const dirs = readdirSync(ARTIFACT_ROOT, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
	assert.ok(dirs.length >= 9);
	for (const dir of dirs) {
		const report = verifyDir(join(ARTIFACT_ROOT, dir));
		assert.deepEqual(report.mismatch, [], `${dir} content mismatch`);
		assert.deepEqual(report.missing, [], `${dir} missing files`);
		assert.equal(report.manifest, "present", `${dir} has no SHA256SUMS`);
		assert.equal(report.archiveManifest, "present", `${dir} has no SHA256SUMS.gz`);
		assert.equal(report.absolutePaths, 0, `${dir} still names absolute paths, which stop resolving when ~/scratch prunes`);
		assert.deepEqual(report.unhashed, [], `${dir} holds files no manifest covers`);
		assert.ok(report.ok > 0);
	}
});

test("verifyDir reports rather than throws on a damaged set", () => {
	const dir = scratch();
	writeFileSync(join(dir, "rows.jsonl"), '{"a":1}\n');
	const { logical, stored } = buildManifests(dir);
	writeFileSync(join(dir, "SHA256SUMS"), formatManifest(logical));
	writeFileSync(join(dir, "SHA256SUMS.gz"), formatManifest(stored));
	assert.equal(verifyDir(dir).mismatch.length, 0);
	writeFileSync(join(dir, "rows.jsonl"), '{"a":2}\n');
	const damaged = verifyDir(dir);
	assert.equal(damaged.mismatch.length, 2, "both the logical and the stored hash must fail");
	const empty = scratch();
	assert.equal(verifyDir(empty).manifest, "absent");
});

// ---------------------------------------------------------------------------
// 9. CLI helpers (no provider calls: the auth probe is never invoked here).
// ---------------------------------------------------------------------------

test("auth-ensure decides staleness from the stored expiry alone", () => {
	const now = 1_000_000;
	assert.equal(tokenIsStale({}, "anthropic", now), true, "a missing credential is stale");
	assert.equal(tokenIsStale({ anthropic: { access: "t" } }, "anthropic", now), false, "no expiry means nothing to refresh");
	assert.equal(tokenIsStale({ anthropic: { access: "t", expires: now + 30_000 } }, "anthropic", now), true, "expiring inside the run window");
	assert.equal(tokenIsStale({ anthropic: { access: "t", expires: now + 600_000 } }, "anthropic", now), false);
});

test("provider inference errs toward refreshing both", () => {
	assert.deepEqual(providersFor(["opus-high", "fable-medium"]), ["anthropic"]);
	assert.deepEqual(providersFor(["terra-medium"]), ["openai-codex"]);
	assert.deepEqual(providersFor(["opus-high", "luna-medium"]).sort(), ["anthropic", "openai-codex"]);
	assert.deepEqual(providersFor(["something-new"]).sort(), ["anthropic", "openai-codex"], "an unknown model must not silently skip a refresh");
});
