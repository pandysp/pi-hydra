import { readFileSync } from "node:fs";
import { sha16 } from "./fingerprints.mjs";

const REAL_TIERS = Object.freeze({ blocking: "severe", harmful: "minor" });
const SEVERITIES = new Set(["severe", "minor"]);
const FALSE_STATUSES = new Set(["active", "retired"]);
const FALSE_PROVENANCE_KINDS = new Set(["golden-rejection", "frozen-judge-agreement"]);

function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, item]) => [key, canonical(item)]),
		);
	}
	return value;
}

function exactKeys(value, expected, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: expected an object`);
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
		throw new Error(`${label}: fields must be exactly ${wanted.join(", ")}`);
	}
}

function nonEmptyString(value, label) {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label}: expected a non-empty string`);
}

function normalizedProposition(item) {
	return `${item.task}\n${item.statement.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US")}`;
}

export function realCatalogVersion(issues) {
	if (!Array.isArray(issues)) throw new Error("real catalog issues must be an array");
	const active = issues
		.filter((issue) => issue?.status === "active")
		.map((issue) => [issue.id, issue.task, issue.statement, issue.tier])
		.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
	return sha16(JSON.stringify(active));
}

export function falsePositiveCatalogVersion(items) {
	if (!Array.isArray(items)) throw new Error("false catalog items must be an array");
	const ordered = [...items].sort((a, b) => String(a?.id ?? "").localeCompare(String(b?.id ?? "")));
	return sha16(JSON.stringify(canonical(ordered)));
}

export function validateRealCatalog(dataset) {
	if (!dataset || typeof dataset !== "object" || !Array.isArray(dataset.issues)) {
		throw new Error("real catalog must be a golden dataset with issues[]");
	}
	nonEmptyString(dataset.version, "real catalog version");
	if (dataset.issues.length === 0) throw new Error("real catalog issues must not be empty");
	const ids = new Set();
	const propositions = new Set();
	for (const issue of dataset.issues) {
		nonEmptyString(issue?.id, "real catalog id");
		if (!/^[A-Z]+-[a-z0-9-]+$/.test(issue.id)) throw new Error(`${issue.id}: invalid real catalog id`);
		if (ids.has(issue.id)) throw new Error(`${issue.id}: duplicate real catalog id`);
		ids.add(issue.id);
		nonEmptyString(issue.task, `${issue.id} task`);
		nonEmptyString(issue.statement, `${issue.id} statement`);
		if (!(issue.tier in REAL_TIERS)) throw new Error(`${issue.id}: tier must be blocking or harmful`);
		if (!FALSE_STATUSES.has(issue.status)) throw new Error(`${issue.id}: status must be active or retired`);
		if (!Array.isArray(issue.provenance) || issue.provenance.length === 0 || issue.provenance.some((entry) => typeof entry !== "string" || !entry)) {
			throw new Error(`${issue.id}: provenance must be a non-empty string array`);
		}
		nonEmptyString(issue.frame, `${issue.id} frame`);
		if (issue.status === "active") {
			const proposition = normalizedProposition(issue);
			if (propositions.has(proposition)) throw new Error(`${issue.id}: duplicate active real proposition`);
			propositions.add(proposition);
		}
	}
	const expected = realCatalogVersion(dataset.issues);
	if (dataset.version !== expected) throw new Error(`real catalog version ${dataset.version} does not match content ${expected}`);
	return dataset;
}

function validateFalseProvenance(item) {
	if (!Array.isArray(item.provenance) || item.provenance.length === 0) {
		throw new Error(`${item.id}: provenance must be a non-empty array`);
	}
	for (const [index, entry] of item.provenance.entries()) {
		exactKeys(entry, ["kind", "artifact", "reference", "reviewers"], `${item.id} provenance[${index}]`);
		if (!FALSE_PROVENANCE_KINDS.has(entry.kind)) throw new Error(`${item.id}: unknown provenance kind ${entry.kind}`);
		nonEmptyString(entry.artifact, `${item.id} provenance artifact`);
		nonEmptyString(entry.reference, `${item.id} provenance reference`);
		if (!Array.isArray(entry.reviewers) || entry.reviewers.length < 2 ||
			entry.reviewers.some((reviewer) => typeof reviewer !== "string" || !reviewer) ||
			new Set(entry.reviewers).size !== entry.reviewers.length) {
			throw new Error(`${item.id}: provenance reviewers must contain at least two unique names`);
		}
	}
}

export function validateFalsePositiveCatalog(catalog, { tasks = null } = {}) {
	exactKeys(catalog, ["schemaVersion", "version", "items"], "false catalog");
	if (catalog.schemaVersion !== 1) throw new Error("false catalog schemaVersion must be 1");
	nonEmptyString(catalog.version, "false catalog version");
	if (!Array.isArray(catalog.items)) throw new Error("false catalog items must be an array");
	const allowedTasks = tasks ? new Set(tasks) : null;
	const ids = new Set();
	const propositions = new Set();
	for (const item of catalog.items) {
		exactKeys(
			item,
			["id", "task", "statement", "severity", "invalidBecause", "applicability", "provenance", "dissent", "status"],
			`false catalog item ${item?.id ?? "?"}`,
		);
		nonEmptyString(item.id, "false catalog id");
		if (!/^FP-[a-z0-9-]+$/.test(item.id)) throw new Error(`${item.id}: invalid false catalog id`);
		if (ids.has(item.id)) throw new Error(`${item.id}: duplicate false catalog id`);
		ids.add(item.id);
		nonEmptyString(item.task, `${item.id} task`);
		if (allowedTasks && !allowedTasks.has(item.task)) throw new Error(`${item.id}: task ${item.task} is absent from the real catalog`);
		nonEmptyString(item.statement, `${item.id} statement`);
		if (!SEVERITIES.has(item.severity)) throw new Error(`${item.id}: severity must be severe or minor`);
		nonEmptyString(item.invalidBecause, `${item.id} invalidBecause`);
		exactKeys(item.applicability, ["codeState", "boundary"], `${item.id} applicability`);
		nonEmptyString(item.applicability.codeState, `${item.id} applicability codeState`);
		nonEmptyString(item.applicability.boundary, `${item.id} applicability boundary`);
		validateFalseProvenance(item);
		if (item.dissent !== null && (typeof item.dissent !== "string" || !item.dissent.trim())) {
			throw new Error(`${item.id}: dissent must be null or a non-empty string`);
		}
		if (!FALSE_STATUSES.has(item.status)) throw new Error(`${item.id}: status must be active or retired`);
		if (item.status === "active") {
			const proposition = normalizedProposition(item);
			if (propositions.has(proposition)) throw new Error(`${item.id}: duplicate active false proposition`);
			propositions.add(proposition);
		}
	}
	const expected = falsePositiveCatalogVersion(catalog.items);
	if (catalog.version !== expected) throw new Error(`false catalog version ${catalog.version} does not match content ${expected}`);
	return catalog;
}

export function loadRealCatalog(path = "experiments/golden-dataset.json") {
	return validateRealCatalog(JSON.parse(readFileSync(path, "utf8")));
}

export function loadFalsePositiveCatalog(path = "experiments/false-positive-catalog.json", options = {}) {
	return validateFalsePositiveCatalog(JSON.parse(readFileSync(path, "utf8")), options);
}

export function buildDualCatalogView(real, falsePositive, task) {
	validateRealCatalog(real);
	const tasks = [...new Set(real.issues.map((issue) => issue.task))];
	validateFalsePositiveCatalog(falsePositive, { tasks });
	if (!tasks.includes(task)) throw new Error(`unknown real-catalog task: ${task}`);
	const realItems = real.issues
		.filter((issue) => issue.status === "active" && issue.task === task)
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((issue, index) => ({
			key: `r${String(index + 1).padStart(2, "0")}`,
			id: issue.id,
			statement: issue.statement,
			severity: REAL_TIERS[issue.tier],
			provenance: issue.provenance,
			applicability: { frame: issue.frame, anchors: issue.anchors ?? null },
			dissent: issue.dissent ?? null,
		}));
	const falseItems = falsePositive.items
		.filter((item) => item.status === "active" && item.task === task)
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((item, index) => ({
			key: `f${String(index + 1).padStart(2, "0")}`,
			id: item.id,
			statement: item.statement,
			severity: item.severity,
			invalidBecause: item.invalidBecause,
			applicability: item.applicability,
			provenance: item.provenance,
			dissent: item.dissent,
		}));
	return {
		task,
		versions: { real: real.version, false: falsePositive.version },
		real: realItems,
		false: falseItems,
	};
}

export function renderedDualCatalog(view) {
	if (!view || typeof view !== "object" || !Array.isArray(view.real) || !Array.isArray(view.false)) {
		throw new Error("rendered dual catalog requires real[] and false[]");
	}
	return {
		real: view.real.map(({ key, statement }) => ({ key, statement })),
		false: view.false.map(({ key, statement }) => ({ key, statement })),
	};
}

export function renderedDualCatalogHash(view) {
	return sha16(JSON.stringify(renderedDualCatalog(view)));
}

export function dualCatalogHashes(real, falsePositive) {
	validateRealCatalog(real);
	const tasks = [...new Set(real.issues.map((issue) => issue.task))].sort();
	validateFalsePositiveCatalog(falsePositive, { tasks });
	const perTask = {};
	for (const task of tasks) {
		const view = buildDualCatalogView(real, falsePositive, task);
		perTask[task] = renderedDualCatalogHash(view);
	}
	return { realVersion: real.version, falseVersion: falsePositive.version, perTask };
}

export function dualCatalogDefinitionSource() {
	return [
		JSON.stringify(REAL_TIERS),
		[...SEVERITIES].join(","),
		[...FALSE_STATUSES].join(","),
		[...FALSE_PROVENANCE_KINDS].join(","),
		canonical.toString(),
		exactKeys.toString(),
		nonEmptyString.toString(),
		normalizedProposition.toString(),
		realCatalogVersion.toString(),
		falsePositiveCatalogVersion.toString(),
		validateRealCatalog.toString(),
		validateFalseProvenance.toString(),
		validateFalsePositiveCatalog.toString(),
		buildDualCatalogView.toString(),
		renderedDualCatalog.toString(),
		renderedDualCatalogHash.toString(),
		dualCatalogHashes.toString(),
	].join("\n<<<DUAL-CATALOG>>>\n");
}

export function dualCatalogDefinitionHash() {
	return sha16(dualCatalogDefinitionSource());
}
