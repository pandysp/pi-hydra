import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const scratch = [];

afterEach(() => {
	for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function writeJsonl(path, rows) {
	writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function producerRow(overrides = {}) {
	return {
		provider: "openai-codex",
		model: "terra-medium",
		arm: "C",
		case: "webhook-security-fresh",
		sample: 1,
		completionValid: true,
		formatValid: true,
		delivery: "steer",
		message: "Verify the webhook signature.",
		deliveryCorrect: true,
		deliveryExact: true,
		expectedDelivery: "steer",
		category: "fresh",
		providerCalls: 1,
		recoveryAttempted: false,
		ms: 100,
		usage: { cost: 0.01, cacheRead: 100 },
		hitRatio: 50,
		...overrides,
	};
}

function run(judgments, rows, extraArgs = []) {
	const directory = mkdtempSync(join(tmpdir(), "hydra-summary-"));
	scratch.push(directory);
	const input = join(directory, "producer.jsonl");
	const judges = join(directory, "judges.jsonl");
	writeJsonl(input, rows);
	writeJsonl(judges, judgments);
	return spawnSync(
		process.execPath,
		["experiments/summarize-delivery-context-golden.mjs", "--input", input, "--judges", judges, "--json", ...extraArgs],
		{ cwd: process.cwd(), encoding: "utf8" },
	);
}

function summarize(judgments, rows = [producerRow()], extraArgs = []) {
	const result = run(judgments, rows, extraArgs);
	expect(result.status, result.stderr).toBe(0);
	return JSON.parse(result.stdout);
}

function judgment(judge, metric, overrides = {}) {
	return {
		judge,
		metric,
		sourceKey: "terra-medium/webhook-security-fresh/1/C",
		answer: true,
		...overrides,
	};
}

describe("delivery-context summary judge gate", () => {
	it("does not treat a single judge as sufficient", () => {
		const result = summarize([judgment("sol", "support"), judgment("sol", "target")]);
		const group = result.groups["openai-codex/terra-medium/C"];
		expect(result.requiredJudgeSetComplete).toBe(false);
		expect(group.findingQuality).toBeNull();
		expect(group.judgeCoverage).toBe(0.5);
	});

	it("requires complete positive judgments from Sol and Opus", () => {
		const result = summarize([
			judgment("sol", "support"),
			judgment("sol", "target"),
			judgment("opus", "support"),
			judgment("opus", "target"),
		]);
		const group = result.groups["openai-codex/terra-medium/C"];
		expect(result.requiredJudgeSetComplete).toBe(true);
		expect(group.findingQuality).toBe(1);
		expect(group.judgeCoverage).toBe(1);
		expect(group.judgeAgreement).toBe(1);
	});

	it("counts failed observations in quality, routing, and economics", () => {
		const result = summarize(
			[
				judgment("sol", "support"),
				judgment("sol", "target"),
				judgment("opus", "support"),
				judgment("opus", "target"),
			],
			[
				producerRow(),
				producerRow({
					sample: 2,
					completionValid: false,
					formatValid: false,
					delivery: null,
					message: "",
					deliveryCorrect: false,
					deliveryExact: false,
					ms: 300,
					usage: { cost: 0.03, cacheRead: 100 },
				}),
			],
		);
		const group = result.groups["openai-codex/terra-medium/C"];
		expect(group.valid).toBe(0.5);
		expect(group.findingQuality).toBe(0.5);
		expect(group.deliveryBucketCorrect).toBe(0.5);
		expect(group.observerCostMean).toBe(0.02);
		expect(group.judgeCoverage).toBe(1);
	});

	it("does not count a runtime noop fallback after provider failure as valid or correctly routed", () => {
		const result = summarize([], [
			producerRow({
				completionValid: true,
				formatValid: false,
				delivery: "none",
				message: "",
				deliveryCorrect: true,
				deliveryExact: true,
				expectedDelivery: "none",
				category: "pending-equivalent",
				error: "provider stream error",
			}),
		]);
		const group = result.groups["openai-codex/terra-medium/C"];
		expect(group.valid).toBe(0);
		expect(group.deliveryBucketCorrect).toBe(0);
		expect(group.deliveryExact).toBe(0);
		expect(group.confusion).toEqual({ "none->failed": 1 });
	});

	it("reports waiting restraint from repeat judgments", () => {
		const sourceKey = "terra-medium/webhook-security-pending/1/C";
		const result = summarize(
			[
				judgment("sol", "repeat", { sourceKey, answer: false }),
				judgment("opus", "repeat", { sourceKey, answer: false }),
			],
			[
				producerRow({
					case: "webhook-security-pending",
					category: "pending-equivalent",
					expectedDelivery: "none",
					deliveryCorrect: false,
					deliveryExact: false,
				}),
			],
		);
		const group = result.groups["openai-codex/terra-medium/C"];
		expect(group.waitingRepeatAvoidance).toBe(1);
	});

	it("computes metrics for a single judge when that judge is the required set", () => {
		const result = summarize(
			[judgment("sol", "support"), judgment("sol", "target")],
			[producerRow()],
			["--required-judges", "sol"],
		);
		const group = result.groups["openai-codex/terra-medium/C"];
		expect(result.requiredJudges).toEqual(["sol"]);
		expect(result.requiredJudgeSetComplete).toBe(true);
		expect(group.findingQuality).toBe(1);
		expect(group.judgeCoverage).toBe(1);
		expect(group.judgeAgreement).toBeNull();
	});

	it("declares the latency basis", () => {
		const result = summarize([]);
		expect(result.latencyBasis).toContain("excludes the unmeasured warm call");
	});
});

function supportJudgment(judge, overrides = {}) {
	return {
		judge,
		metric: "support",
		sourceKey: "terra-medium/webhook-security-fresh/1/C",
		centralSupported: true,
		unsupportedExtra: false,
		...overrides,
	};
}

describe("split support judgments", () => {
	it("separates the central finding from unsupported additions", () => {
		const result = summarize([
			supportJudgment("sol", { unsupportedExtra: true }),
			supportJudgment("opus", { unsupportedExtra: true }),
			judgment("sol", "target"),
			judgment("opus", "target"),
		]);
		const group = result.groups["openai-codex/terra-medium/C"];
		expect(group.strictSupportAvailable).toBe(true);
		expect(group.support).toBe(1);
		expect(group.supportStrict).toBe(0);
		expect(group.findingQuality).toBe(1);
		expect(group.findingQualityStrict).toBe(0);
	});

	it("summarizes legacy single-boolean support as the central finding with strict unavailable", () => {
		const result = summarize([
			judgment("sol", "support"),
			judgment("opus", "support"),
			judgment("sol", "target"),
			judgment("opus", "target"),
		]);
		const group = result.groups["openai-codex/terra-medium/C"];
		expect(group.strictSupportAvailable).toBe(false);
		expect(group.support).toBe(1);
		expect(group.supportStrict).toBeNull();
		expect(group.findingQuality).toBe(1);
		expect(group.findingQualityStrict).toBeNull();
	});

	it("measures agreement on the split support field rather than a missing answer", () => {
		const result = summarize([
			supportJudgment("sol", { centralSupported: false }),
			supportJudgment("opus"),
		]);
		const group = result.groups["openai-codex/terra-medium/C"];
		expect(group.judgeAgreement).toBe(0);
		// The row's target judgments are absent, so the judged metrics report
		// null (unjudged) rather than blending "not judged" into a failure rate.
		expect(group.support).toBeNull();
		expect(group.judgedComplete).toBe(false);
		expect(group.unjudgedRows).toBe(1);
	});
});

describe("provider policy refusals", () => {
	const refused = producerRow({
		sample: 2,
		completionValid: false,
		formatValid: false,
		delivery: null,
		message: "",
		deliveryCorrect: false,
		deliveryExact: false,
		error: "Output blocked by the provider content policy",
	});

	it("excludes refusals from quality and routing denominators and reports the rate", () => {
		const result = summarize(
			[
				supportJudgment("sol"),
				supportJudgment("opus"),
				judgment("sol", "target"),
				judgment("opus", "target"),
			],
			[producerRow(), refused],
		);
		const group = result.groups["openai-codex/terra-medium/C"];
		expect(group.n).toBe(2);
		expect(group.scored).toBe(1);
		expect(group.refused).toBe(1);
		expect(group.refusedRate).toBe(0.5);
		expect(group.refusedKeys).toEqual(["terra-medium/webhook-security-fresh/2/C"]);
		expect(group.findingQuality).toBe(1);
		expect(group.deliveryBucketCorrect).toBe(1);
		expect(group.valid).toBe(0.5);
	});

	it("keeps ordinary provider failures inside the denominators", () => {
		const result = summarize([], [producerRow(), { ...refused, error: "provider stream error" }]);
		const group = result.groups["openai-codex/terra-medium/C"];
		expect(group.refused).toBe(0);
		expect(group.deliveryBucketCorrect).toBe(0.5);
	});
});

const fullJudgmentsFor = (rows) =>
	rows.flatMap((row) => {
		const sourceKey = `${row.model}/${row.case}/${row.sample}/${row.arm}`;
		return [
			supportJudgment("sol", { sourceKey }),
			supportJudgment("opus", { sourceKey }),
			judgment("sol", "target", { sourceKey }),
			judgment("opus", "target", { sourceKey }),
		];
	});

describe("gate emitter", () => {
	const baselineRow = (overrides = {}) => producerRow({ arm: "A0", ...overrides });
	const candidateRow = (overrides = {}) => producerRow({ arm: "J", ...overrides });

	// D1: `implementationVariants` was computed and never gated. On legacy rows
	// the provenance check falls back to `promptVariants === heads`, which the
	// frozen arm-C mixture satisfies — two implementations under one label, the
	// right number of prompt variants, gate green.
	it("refuses an arm carrying two implementations under one label, with no contractHash present", () => {
		const usage = { cost: 0.01, input: 100, output: 100, cacheRead: 100 };
		const rows = [
			baselineRow({ case: "a", usage }),
			baselineRow({ case: "b", sample: 2, usage }),
			candidateRow({ case: "a", usage, implementationArm: "screen-json" }),
			candidateRow({ case: "b", sample: 2, usage, implementationArm: "screen-footer" }),
		];
		const result = summarize(fullJudgmentsFor(rows), rows, ["--gates"]);
		const checks = Object.fromEntries(result.gates.perConfig[0].checks.map((check) => [check.rule, check]));
		expect(result.groups["openai-codex/terra-medium/J"].contractVariants).toBeNull();
		expect(checks["provenance"].verdict).toBe("pass");
		expect(checks["implementation identity"].verdict).toBe("fail");
		expect(checks["implementation identity"].actual).toBe(2);
		expect(result.gates.armVerdicts.J.verdict).toBe("refuted");
	});

	it("passes implementation identity when one label means one implementation", () => {
		const usage = { cost: 0.01, input: 100, output: 100, cacheRead: 100 };
		const rows = [baselineRow({ usage }), candidateRow({ usage })];
		const result = summarize(fullJudgmentsFor(rows), rows, ["--gates"]);
		const checks = Object.fromEntries(result.gates.perConfig[0].checks.map((check) => [check.rule, check]));
		expect(checks["implementation identity"].verdict).toBe("pass");
		expect(checks["baseline implementation identity"].verdict).toBe("pass");
	});

	// D2: every comparative threshold is derived from the baseline group, which
	// is never itself a candidate — so before this it received no population
	// check at all and a two-contract baseline certified every candidate.
	it("refuses a contaminated BASELINE, and fails every candidate measured against it", () => {
		const usage = { cost: 0.01, input: 100, output: 100, cacheRead: 100 };
		const rows = [
			baselineRow({ case: "a", usage, contractHash: "1111111111111111" }),
			baselineRow({ case: "b", sample: 2, usage, implementationArm: "main-json", contractHash: "2222222222222222" }),
			candidateRow({ case: "a", usage, contractHash: "3333333333333333" }),
			candidateRow({ case: "b", sample: 2, usage, contractHash: "3333333333333333" }),
		];
		const result = summarize(fullJudgmentsFor(rows), rows, ["--gates"]);
		const checks = Object.fromEntries(result.gates.perConfig[0].checks.map((check) => [check.rule, check]));
		expect(checks["implementation identity"].verdict).toBe("pass");
		expect(checks["baseline implementation identity"].verdict).toBe("fail");
		expect(checks["baseline provenance"].verdict).toBe("fail");
		expect(result.gates.armVerdicts.J.verdict).toBe("refuted");
		expect(result.gates.armVerdicts.J.failed).toContain("openai-codex/terra-medium baseline implementation identity");
	});

	it("fails a candidate that does not clear the routing and design-token thresholds", () => {
		const rows = [
			baselineRow({ usage: { cost: 0.01, input: 100, output: 100, cacheRead: 100 } }),
			candidateRow({ usage: { cost: 0.02, input: 100, output: 200, cacheRead: 100 } }),
		];
		const result = summarize(fullJudgmentsFor(rows), rows, ["--gates"]);
		const checks = Object.fromEntries(
			result.gates.perConfig[0].checks.map((check) => [check.rule, check]),
		);
		expect(result.gates.baseline).toBe("A0");
		expect(checks["R1 bucket"].verdict).toBe("fail");
		expect(checks["R3 design tokens"].verdict).toBe("fail");
		expect(checks["R3 cost (informational)"].verdict).toBe("informational");
		expect(checks["R4 one-call"].verdict).toBe("not applicable");
		expect(checks["R2 quality"].verdict).toBe("pass");
		expect(checks["R4 judge excursion"].verdict).toBe("pass");
		expect(checks["R4 judge excursion"].actual).toBe(0);
		expect(result.gates.armVerdicts.J.verdict).toBe("refuted");
	});

	it("passes a candidate that beats the baseline bucket by eight points at equal design tokens", () => {
		const usage = { cost: 0.01, input: 100, output: 100, cacheRead: 100 };
		const rows = [
			baselineRow({ case: "a", deliveryCorrect: true, usage }),
			baselineRow({ case: "b", sample: 2, deliveryCorrect: false, usage }),
			candidateRow({ case: "a", deliveryCorrect: true, usage }),
			candidateRow({ case: "b", sample: 2, deliveryCorrect: true, usage }),
		];
		const result = summarize(fullJudgmentsFor(rows), rows, ["--gates"]);
		const checks = Object.fromEntries(result.gates.perConfig[0].checks.map((check) => [check.rule, check]));
		expect(checks["R1 bucket"].verdict).toBe("pass");
		expect(checks["R2 quality"].verdict).toBe("pass");
		expect(checks["R3 design tokens"].verdict).toBe("pass");
		expect(result.gates.armVerdicts.J.verdict).toBe("survives");
	});

	it("fails the design-token check when the candidate generates more", () => {
		const result = summarize(
			fullJudgmentsFor([
				baselineRow({ provider: "anthropic", model: "sonnet-medium" }),
				candidateRow({ provider: "anthropic", model: "sonnet-medium" }),
			]),
			[
				baselineRow({ provider: "anthropic", model: "sonnet-medium", usage: { cost: 0.01, input: 50, output: 100, cacheRead: 100 } }),
				candidateRow({ provider: "anthropic", model: "sonnet-medium", usage: { cost: 0.01, input: 50, output: 200, cacheRead: 100 } }),
			],
			["--gates"],
		);
		const checks = Object.fromEntries(result.gates.perConfig[0].checks.map((check) => [check.rule, check]));
		expect(checks["R3 design tokens"].verdict).toBe("fail");
		expect(checks["R3 design tokens"].actual).toBe(250);
	});

	it("refuses to emit gates when a configuration has no baseline arm", () => {
		const result = run([], [producerRow({ arm: "J" })], ["--gates"]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("baseline arm A0 missing");
	});
});

describe("duplicate producer rows", () => {
	const attempt = producerRow({ arm: "A0", usage: { cost: 0.01, input: 100, output: 100, cacheRead: 100 } });
	const retry = producerRow({
		arm: "A0",
		delivery: "queue",
		deliveryCorrect: false,
		deliveryExact: false,
		usage: { cost: 0.02, input: 100, output: 300, cacheRead: 100 },
	});

	it("keeps the last row per model/case/sample/arm and reports the collapse", () => {
		const result = summarize([], [attempt, retry]);
		const group = result.groups["openai-codex/terra-medium/A0"];
		expect(result.rawRows).toBe(2);
		expect(result.rows).toBe(1);
		expect(result.duplicateRows).toBe(1);
		// Last wins: the retry's routing and economics, not a blend of both.
		expect(group.n).toBe(1);
		expect(group.deliveryBucketCorrect).toBe(0);
		expect(group.outputTokenMean).toBe(300);
	});

	it("does not collapse rows that differ in any identity field", () => {
		const result = summarize([], [attempt, producerRow({ arm: "A0", sample: 2 })]);
		expect(result.duplicateRows).toBe(0);
		expect(result.groups["openai-codex/terra-medium/A0"].n).toBe(2);
	});

	it("stops one cell's judgments being counted twice and dropping out of agreement", () => {
		// The retry pass supersedes a failed attempt with a routed one on the same
		// sourceKey. Undeduplicated, both rows draw the same four judgments:
		// judgeCoverage reads 2 and the pair accumulates four answers where
		// agreement wants exactly requiredJudges.length, so it silently vanishes
		// from judgeAgreement — the judge-integrity half of the same defect.
		const failed = producerRow({
			arm: "A0",
			completionValid: false,
			formatValid: false,
			delivery: null,
			message: "",
			deliveryCorrect: false,
			deliveryExact: false,
			error: "provider stream error",
		});
		const succeeded = producerRow({ arm: "A0" });
		const result = summarize(fullJudgmentsFor([succeeded]), [failed, succeeded]);
		const group = result.groups["openai-codex/terra-medium/A0"];
		expect(result.duplicateRows).toBe(1);
		expect(group.judgeCoverage).toBe(1);
		expect(group.judgeAgreement).toBe(1);
		expect(group.judgedComplete).toBe(true);
		expect(group.findingQuality).toBe(1);
	});

	it("refuses to emit gates over a file that was appended to rather than replaced", () => {
		const result = run([], [attempt, retry, producerRow({ arm: "J" })], ["--gates"]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("duplicate producer row");
	});

	it("emits gates once the collapse is acknowledged", () => {
		const rows = [attempt, retry, producerRow({ arm: "J", usage: { cost: 0.01, input: 100, output: 100, cacheRead: 100 } })];
		const result = summarize(fullJudgmentsFor(rows), rows, ["--gates", "--allow-duplicate-rows"]);
		expect(result.duplicateRows).toBe(1);
		expect(result.gates.perConfig).toHaveLength(1);
	});
});

describe("rows that never reached a provider", () => {
	// The producer's outer catch used to write {model, case, sample, arm, error}
	// and nothing else. Legacy artifacts still hold that shape.
	const legacyErrorRow = { model: "terra-medium", case: "webhook-security-fresh", sample: 1, arm: "A0", error: "boom" };
	// The shape the producer writes now: full identity, no provider response.
	const identifiedErrorRow = {
		provider: "openai-codex",
		model: "terra-medium",
		modelId: "gpt-5.6-terra",
		thinking: "medium",
		case: "webhook-security-fresh",
		sample: 2,
		arm: "A0",
		implementationArm: "screen-a0",
		toolSurface: "management-only",
		head: "security",
		category: "fresh",
		expectedDelivery: "steer",
		error: "unknown delivery: escalate",
	};
	const healthy = (overrides = {}) =>
		producerRow({
			arm: "A0",
			head: "security",
			promptHash: "a".repeat(64),
			initialCompletionError: null,
			usage: { cost: 0.01, input: 100, output: 100, cacheRead: 100 },
			...overrides,
		});

	it("keeps a provider-less row out of the configurations and out of gate mode", () => {
		const result = summarize([], [healthy(), legacyErrorRow]);
		expect(result.unknownProviderRows).toBe(1);
		expect(result.groups["unknown/terra-medium/A0"]).toBeDefined();
		const gated = run([], [healthy(), legacyErrorRow], ["--gates"]);
		expect(gated.status).not.toBe(0);
		expect(gated.stderr).toContain("carry no provider");
	});

	it("does not let an identified error row blank the validity guard or the provenance count", () => {
		const result = summarize([], [healthy(), healthy({ sample: 3 }), identifiedErrorRow]);
		const group = result.groups["openai-codex/terra-medium/A0"];
		expect(group.n).toBe(3);
		expect(group.errorRows).toBe(1);
		expect(group.rowsMissingPromptHash).toBe(1);
		// One phantom prompt variant would fail the provenance gate; one missing
		// initialCompletionError would null the validity guard for the group.
		expect(group.promptVariants).toBe(1);
		expect(group.heads).toBe(1);
		expect(group.strictFirstAttempt).toBe(1);
		// The failure is still counted where it belongs: routing and validity.
		expect(group.valid).toBeCloseTo(2 / 3, 3);
		expect(group.deliveryBucketCorrect).toBeCloseTo(2 / 3, 3);
	});

	it("refuses to certify a verdict over a group holding a harness error", () => {
		const gated = run([], [healthy(), identifiedErrorRow, producerRow({ arm: "J" })], ["--gates"]);
		expect(gated.status).not.toBe(0);
		expect(gated.stderr).toContain("never reached a provider response");
	});
});

describe("refusal denominators", () => {
	const scoredRow = producerRow({
		arm: "A0",
		formatValid: true,
		usage: { cost: 0.01, input: 100, output: 400, cacheRead: 100 },
		hitRatio: 50,
		ms: 100,
	});
	const refusedRow = producerRow({
		arm: "A0",
		sample: 2,
		completionValid: false,
		formatValid: false,
		delivery: null,
		message: "",
		deliveryCorrect: false,
		deliveryExact: false,
		error: "Output blocked by the provider content policy",
		usage: { cost: 0.001, input: 100, output: 0, cacheRead: 100 },
		hitRatio: 50,
		ms: 10,
	});

	it("prices, measures and formats over the scored rows only", () => {
		const result = summarize([], [scoredRow, refusedRow]);
		const group = result.groups["openai-codex/terra-medium/A0"];
		expect(group.refused).toBe(1);
		expect(group.scored).toBe(1);
		// A refusal is a very short generation; leaving it in discounts the arm.
		expect(group.outputTokenMean).toBe(400);
		expect(group.uncachedInputMean).toBe(100);
		expect(group.observerCostMean).toBe(0.01);
		expect(group.formatValid).toBe(1);
		expect(group.latencyMedianMs).toBe(100);
	});

	it("reports the refusal-inclusive block beside it rather than instead of it", () => {
		const result = summarize([], [scoredRow, refusedRow]);
		const group = result.groups["openai-codex/terra-medium/A0"];
		expect(group.includingRefusals.outputTokenMean).toBe(200);
		expect(group.includingRefusals.observerCostMean).toBe(0.0055);
		expect(group.includingRefusals.formatValid).toBe(0.5);
		expect(group.includingRefusals.latencyMedianMs).toBe(10);
		// `valid` stays refusal-inclusive: it is how the refusal is visible.
		expect(group.valid).toBe(0.5);
	});

	it("gates the design-token rule on the scored tokens", () => {
		const rows = [
			scoredRow,
			refusedRow,
			producerRow({ arm: "J", usage: { cost: 0.01, input: 100, output: 420, cacheRead: 100 } }),
		];
		const result = summarize(fullJudgmentsFor(rows), rows, ["--gates"]);
		const checks = Object.fromEntries(result.gates.perConfig[0].checks.map((check) => [check.rule, check]));
		// Baseline design tokens are 500 (scored), not 300 (refusal-inclusive):
		// 520 clears 500 + 10% and would fail against 300 + 10%.
		expect(checks["R3 design tokens"].actual).toBe(520);
		expect(checks["R3 design tokens"].threshold).toBe(550);
		expect(checks["R3 design tokens"].verdict).toBe("pass");
	});
});

describe("arm and category vocabulary", () => {
	it("reports rows naming an arm the registry does not know and refuses to gate them", () => {
		const rows = [producerRow({ arm: "A0" }), producerRow({ arm: "screen-print", implementationArm: "screen-print" })];
		const result = summarize([], rows);
		expect(result.unknownArms).toEqual(["screen-print"]);
		expect(result.unknownArmRows).toBe(1);
		const gated = run([], rows, ["--gates"]);
		expect(gated.status).not.toBe(0);
		expect(gated.stderr).toContain("the registry does not know");
	});

	it("derives one-call-by-construction from the registry's fail-open policy", () => {
		expect(summarize([], [producerRow({ arm: "A0", implementationArm: "screen-a0" })])
			.groups["openai-codex/terra-medium/A0"].oneCallByConstruction).toBe(true);
		// Legacy rows carrying only the letter answer the same way.
		expect(summarize([], [producerRow({ arm: "A", implementationArm: undefined })])
			.groups["openai-codex/terra-medium/A"].oneCallByConstruction).toBe(true);
		expect(summarize([], [producerRow({ arm: "F", implementationArm: "screen-footer" })])
			.groups["openai-codex/terra-medium/F"].oneCallByConstruction).toBe(false);
	});

	it("counts rows whose category is in no taxonomy class and refuses to gate them", () => {
		const rows = [
			producerRow({ arm: "A0", category: "fresh" }),
			producerRow({ arm: "A0", sample: 2, category: "print-channel-user-action" }),
		];
		const result = summarize([], rows);
		const group = result.groups["openai-codex/terra-medium/A0"];
		expect(result.unclassifiedCategories).toEqual(["print-channel-user-action"]);
		expect(group.unclassifiedCategoryRows).toBe(1);
		expect(group.unclassifiedCategories).toEqual(["print-channel-user-action"]);
		// A freshly authored family that nobody classified is measured by neither
		// waitingRepeatAvoidance nor followupQuality; certifying over it is the
		// silent-omission failure the two former string sets could not express.
		const gated = run([], rows, ["--gates"]);
		expect(gated.status).not.toBe(0);
		expect(gated.stderr).toContain("outside the declared taxonomy");
	});
});

describe("verdict provenance", () => {
	it("records the invocation that produced the verdict", () => {
		const result = summarize([], [producerRow()], ["--r3-informational", "--baseline", "C"]);
		expect(result.argv).toContain("--r3-informational");
		expect(result.flags.r3Informational).toBe(true);
		expect(result.flags.baselineArm).toBe("C");
		expect(result.flags.gateMode).toBe(false);
		expect(result.flags.requiredJudges).toEqual(["opus", "sol"]);
	});
});

describe("delivery-context summary reporting", () => {
	it("reports explicit-rejection finding quality separately", () => {
		const sourceKey = "terra-medium/webhook-security-rejected/1/C";
		const result = summarize(
			[
				judgment("sol", "support", { sourceKey }),
				judgment("sol", "target", { sourceKey }),
				judgment("opus", "support", { sourceKey }),
				judgment("opus", "target", { sourceKey }),
			],
			[
				producerRow({
					case: "webhook-security-rejected",
					category: "explicit-rejection",
				}),
			],
		);
		const group = result.groups["openai-codex/terra-medium/C"];
		expect(group.rejectionQuality).toBe(1);
	});
});
