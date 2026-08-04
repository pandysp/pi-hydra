import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	EXPANDED_2Q_CARRIER_SHAPES,
	EXPANDED_2Q_INPUTS,
	buildExpanded2QInputManifest,
	renderExpanded2QInputManifest,
} from "./expanded-2q-input-manifest.mjs";

describe("expanded 2Q frozen-input manifest", () => {
	it("freezes unique inputs, the six-stratum sample, and both real carrier members", () => {
		const manifest = buildExpanded2QInputManifest();
		expect(manifest.protocol).toBe("expanded-2q-findings-v1");
		expect(manifest.files).toHaveLength(EXPANDED_2Q_INPUTS.length);
		expect(new Set(manifest.files.map((file) => file.path)).size).toBe(EXPANDED_2Q_INPUTS.length);
		expect(manifest.files.every((file) => file.bytes > 0 && /^[0-9a-f]{64}$/.test(file.sha256))).toBe(true);
		expect(manifest.sample).toMatchObject({ points: 20, findings: 45, strata: 6 });
		expect(manifest.carrierShapes.map((shape) => shape.judge).sort()).toEqual(["opus", "sol"]);
		expect(manifest.carrierShapes).toHaveLength(EXPANDED_2Q_CARRIER_SHAPES.length);
		expect(manifest.carrierShapes.every((shape) => shape.bytes > 0 && /^[0-9a-f]{64}$/.test(shape.sha256))).toBe(true);
	});

	it("matches the committed manifest byte for byte", () => {
		expect(readFileSync("experiments/EXPANDED-2Q-FROZEN-INPUTS.json", "utf8")).toBe(renderExpanded2QInputManifest());
	});
});
