#!/usr/bin/env node
/** Fail-closed catalog validation and identity report. */

import { buildDualCatalogView, dualCatalogHashes, loadFalsePositiveCatalog, loadRealCatalog } from "./dual-catalog.mjs";
import { argOf } from "./lib.mjs";

const args = process.argv.slice(2);
const real = loadRealCatalog(argOf(args, "--real-catalog", "experiments/golden-dataset.json"));
const falsePositive = loadFalsePositiveCatalog(argOf(args, "--false-catalog", "experiments/false-positive-catalog.json"), {
	tasks: [...new Set(real.issues.map((issue) => issue.task))],
});
const tasks = [...new Set(real.issues.map((issue) => issue.task))].sort();
const counts = Object.fromEntries(tasks.map((task) => {
	const view = buildDualCatalogView(real, falsePositive, task);
	return [task, { real: view.real.length, false: view.false.length }];
}));
process.stdout.write(`${JSON.stringify({ status: "valid", ...dualCatalogHashes(real, falsePositive), counts }, null, 2)}\n`);
