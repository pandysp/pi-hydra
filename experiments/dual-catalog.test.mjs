import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	buildDualCatalogView,
	dualCatalogDefinitionHash,
	dualCatalogHashes,
	falsePositiveCatalogVersion,
	realCatalogVersion,
	renderedDualCatalog,
	renderedDualCatalogHash,
	validateFalsePositiveCatalog,
	validateRealCatalog,
} from "./dual-catalog.mjs";

const real = JSON.parse(readFileSync("experiments/golden-dataset.json", "utf8"));
const falsePositive = JSON.parse(readFileSync("experiments/false-positive-catalog.json", "utf8"));
const clone = (value) => structuredClone(value);

describe("expanded 2Q catalogs", () => {
	it("validates the real scoring view and the conservative false catalog by content hash", () => {
		expect(validateRealCatalog(real)).toBe(real);
		expect(realCatalogVersion(real.issues)).toBe(real.version);
		expect(validateFalsePositiveCatalog(falsePositive, { tasks: ["scheduler", "exporter", "dispatcher"] })).toBe(falsePositive);
		expect(falsePositiveCatalogVersion(falsePositive.items)).toBe(falsePositive.version);
		expect(falsePositiveCatalogVersion([...falsePositive.items].reverse())).toBe(falsePositive.version);
		expect(falsePositive.items).toHaveLength(3);
		expect(falsePositive.items.map((item) => item.severity).sort()).toEqual(["minor", "minor", "severe"]);
	});

	it("builds stable task-local neutral keys while retaining hidden scoring metadata", () => {
		const exporter = buildDualCatalogView(real, falsePositive, "exporter");
		expect(exporter.versions).toEqual({ real: real.version, false: falsePositive.version });
		expect(exporter.real.length).toBeGreaterThan(0);
		expect(exporter.real.every((item, index) => item.key === `r${String(index + 1).padStart(2, "0")}`)).toBe(true);
		expect(exporter.false.map((item) => item.key)).toEqual(["f01", "f02"]);
		expect(exporter.false.map((item) => item.severity)).toEqual(["severe", "minor"]);
		expect(exporter.real.every((item) => ["severe", "minor"].includes(item.severity))).toBe(true);
		expect(() => buildDualCatalogView(real, falsePositive, "unknown")).toThrow(/unknown real-catalog task/);
	});

	it("hashes every rendered task catalog separately from the two content versions", () => {
		const first = dualCatalogHashes(real, falsePositive);
		const second = dualCatalogHashes(real, falsePositive);
		expect(first).toEqual(second);
		expect(first).toMatchObject({ realVersion: real.version, falseVersion: falsePositive.version });
		expect(Object.keys(first.perTask).sort()).toEqual(["dispatcher", "exporter", "scheduler"]);
		expect(Object.values(first.perTask).every((hash) => /^[0-9a-f]{16}$/.test(hash))).toBe(true);
		const exporter = buildDualCatalogView(real, falsePositive, "exporter");
		expect(first.perTask.exporter).toBe(renderedDualCatalogHash(exporter));
		expect(renderedDualCatalog(exporter).real[0]).toEqual({
			key: exporter.real[0].key,
			statement: exporter.real[0].statement,
		});
		expect(dualCatalogDefinitionHash()).toMatch(/^[0-9a-f]{16}$/);
	});

	it("rejects stale versions, unknown tasks, malformed provenance, and duplicate active propositions", () => {
		const stale = clone(falsePositive);
		stale.items[0].invalidBecause += " changed";
		expect(() => validateFalsePositiveCatalog(stale)).toThrow(/does not match content/);

		const unknownTask = clone(falsePositive);
		unknownTask.items[0].task = "other";
		unknownTask.version = falsePositiveCatalogVersion(unknownTask.items);
		expect(() => validateFalsePositiveCatalog(unknownTask, { tasks: ["exporter", "dispatcher"] })).toThrow(/absent from the real catalog/);

		const badProvenance = clone(falsePositive);
		badProvenance.items[0].provenance[0].reviewers = ["sol"];
		badProvenance.version = falsePositiveCatalogVersion(badProvenance.items);
		expect(() => validateFalsePositiveCatalog(badProvenance)).toThrow(/at least two unique/);

		const duplicate = clone(falsePositive);
		duplicate.items.push({ ...clone(duplicate.items[0]), id: "FP-exporter-duplicate" });
		duplicate.version = falsePositiveCatalogVersion(duplicate.items);
		expect(() => validateFalsePositiveCatalog(duplicate)).toThrow(/duplicate active false proposition/);
	});

	it("rejects false-catalog fields that are not part of the frozen schema", () => {
		const extra = clone(falsePositive);
		extra.items[0].note = "not part of the contract";
		extra.version = falsePositiveCatalogVersion(extra.items);
		expect(() => validateFalsePositiveCatalog(extra)).toThrow(/fields must be exactly/);
	});
});
