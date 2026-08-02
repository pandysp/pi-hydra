import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCapstoneInputManifest, CAPSTONE_INPUTS, renderCapstoneInputManifest } from "./capstone-input-manifest.mjs";

describe("capstone frozen-input manifest", () => {
	it("covers every registered frozen trajectory family and matches the committed manifest", () => {
		const manifest = buildCapstoneInputManifest();
		expect(manifest.files).toHaveLength(CAPSTONE_INPUTS.length);
		expect(new Set(manifest.files.map((file) => file.path)).size).toBe(CAPSTONE_INPUTS.length);
		expect(manifest.files.every((file) => file.bytes > 0 && /^[0-9a-f]{64}$/.test(file.sha256))).toBe(true);
		expect(manifest.files.some((file) => file.path.includes("enum-trajectory"))).toBe(true);
		expect(manifest.files.some((file) => file.path.includes("cross-task-trajectory"))).toBe(true);
		expect(manifest.files.some((file) => file.path.includes("openai-trajectory"))).toBe(true);
		expect(readFileSync("experiments/CAPSTONE-FROZEN-INPUTS.json", "utf8")).toBe(renderCapstoneInputManifest());
	});
});
