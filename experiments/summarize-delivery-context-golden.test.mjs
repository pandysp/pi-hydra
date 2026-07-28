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

function summarize(judgments, rows = [producerRow()]) {
	const directory = mkdtempSync(join(tmpdir(), "hydra-summary-"));
	scratch.push(directory);
	const input = join(directory, "producer.jsonl");
	const judges = join(directory, "judges.jsonl");
	writeJsonl(input, rows);
	writeJsonl(judges, judgments);
	const result = spawnSync(
		process.execPath,
		["experiments/summarize-delivery-context-golden.mjs", "--input", input, "--judges", judges, "--json"],
		{ cwd: process.cwd(), encoding: "utf8" },
	);
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
				error: "provider refusal",
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
