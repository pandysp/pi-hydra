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

describe("gate emitter", () => {
	const baselineRow = (overrides = {}) => producerRow({ arm: "A0", ...overrides });
	const candidateRow = (overrides = {}) => producerRow({ arm: "J", ...overrides });

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
