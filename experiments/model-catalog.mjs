import { readFileSync } from "node:fs";
import { getModel } from "@earendil-works/pi-ai/compat";

let storedCatalog;

function modelsStore() {
	if (storedCatalog !== undefined) return storedCatalog;
	try {
		storedCatalog = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/models-store.json`, "utf8"));
	} catch {
		storedCatalog = {};
	}
	return storedCatalog;
}

export function resolveModel(provider, id) {
	return (
		getModel(provider, id) ??
		modelsStore()[provider]?.models?.find((model) => model.id === id) ??
		null
	);
}
