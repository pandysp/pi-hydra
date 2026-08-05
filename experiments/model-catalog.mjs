import { readFileSync } from "node:fs";
import { getModel } from "@earendil-works/pi-ai/compat";

let storedCatalog;
let snapshotCatalog;

function modelsStore() {
	if (storedCatalog !== undefined) return storedCatalog;
	try {
		storedCatalog = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/models-store.json`, "utf8"));
	} catch {
		storedCatalog = {};
	}
	return storedCatalog;
}

/**
 * Committed snapshot of the store records for models the bundled pi-ai catalog
 * does not know (claude-opus-5; captured from the live store 2026-08-05).
 * Without it resolution depends on `pi` having run on the machine, and the
 * offline gates pass or fail by machine — they failed on every CI run while
 * passing locally. The live store still wins when present, so a `pi` catalog
 * refresh reaches runs before the snapshot does.
 */
function snapshotStore() {
	if (snapshotCatalog !== undefined) return snapshotCatalog;
	snapshotCatalog = JSON.parse(readFileSync(new URL("./model-catalog-snapshot.json", import.meta.url), "utf8"));
	return snapshotCatalog;
}

const fromCatalog = (catalog, provider, id) => catalog[provider]?.models?.find((model) => model.id === id);

export function resolveModel(provider, id) {
	return (
		getModel(provider, id) ??
		fromCatalog(modelsStore(), provider, id) ??
		fromCatalog(snapshotStore(), provider, id) ??
		null
	);
}
