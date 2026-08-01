/**
 * Invariants the unified-API screen arms must satisfy before any provider
 * spend: the byte-equality assertions from the screen spec, the parser
 * contracts of the two candidate channels, and the management-only tool
 * surface. Zero provider calls.
 *
 * Runs under `node --test`; it does not use the vitest globals the rest of
 * the suite uses, because the runner it guards is a script that executes the
 * matrix on import and its arm text therefore lives in a plain module.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { parseDecision, parseFooterDecision } from "../utils.ts";
import { GOLDEN_HEADS } from "./delivery-context-golden-cases.mjs";
import {
	SCREEN_ARMS,
	SCREEN_DEDUP_CLAUSE,
	SCREEN_FOOTER_GRAMMAR,
	SCREEN_JSON_GRAMMAR,
	SCREEN_STEER_CLAUSE,
	buildScreenFooterObservationEnvelope,
	buildScreenFooterObservationPrompt,
	buildScreenJsonObservationEnvelope,
	buildScreenJsonObservationPrompt,
	buildShippedMainObservationEnvelope,
	buildShippedMainObservationPrompt,
	visibleDriverTools,
} from "./delivery-context-evaluation.mjs";
import { GOLDEN_ARMS, armSpec, armVisibleDriverTools, implementationArm } from "./arm-registry.mjs";

const HEAD = "security";
const LENS = GOLDEN_HEADS[HEAD];
// Anchored on the first shared semantic unit, spelled out here rather than
// imported, so a reworded envelope cannot make the assertion vacuous.
const PROTOCOL_ANCHOR = "You have no tools:";

function sharedSuffix(text) {
	const index = text.indexOf(PROTOCOL_ANCHOR);
	assert.notEqual(index, -1, "protocol block anchor missing");
	return text.slice(index).replace(/<\/system-reminder>$/, "");
}

const arms = {
	A0: {
		prompt: buildShippedMainObservationPrompt(HEAD, LENS),
		envelope: buildShippedMainObservationEnvelope(HEAD),
	},
	J: {
		prompt: buildScreenJsonObservationPrompt(HEAD, LENS),
		envelope: buildScreenJsonObservationEnvelope(HEAD),
	},
	F: {
		prompt: buildScreenFooterObservationPrompt(HEAD, LENS),
		envelope: buildScreenFooterObservationEnvelope(HEAD),
	},
};

test("the screen letters map to the screen implementations without disturbing A/B/C", () => {
	assert.deepEqual(
		["A", "B", "C", "A0", "J", "F"].map(implementationArm),
		["main-json", "control", "samehead", "screen-a0", "screen-json", "screen-footer"],
	);
	assert.deepEqual([...SCREEN_ARMS].sort(), ["screen-a0", "screen-footer", "screen-json"]);
});

test("A0 carries b51c157's contract text verbatim", () => {
	assert.equal(
		arms.A0.prompt,
		`<system-reminder>Side watcher. Reply with one JSON object, nothing else:
{"action":"noop|print|queue|steer|interrupt","reason":"≤120 chars","message":"≤240 chars, empty if noop"}

LENS: ${LENS}

Noop unless something warrants feedback. Print a note the user sees but the agent does not. Queue if useful but waitable. Steer to correct the agent between turns. Interrupt only for emergencies that must stop the line. No tools, no "let me check...", no follow-up turn. Don't prefix message with [${HEAD}].</system-reminder>`,
	);
	// The split carrier changes only how the lens is referenced.
	assert.equal(
		arms.A0.envelope,
		arms.A0.prompt
			.replace("<system-reminder>", "")
			.replace("</system-reminder>", "")
			.replace(`LENS: ${LENS}`, `The preceding user message is the complete ${HEAD} lens.`),
	);
	// A0 gains none of the unified envelope's semantics.
	for (const text of [arms.A0.prompt, arms.A0.envelope]) {
		assert.ok(!text.includes(PROTOCOL_ANCHOR));
		assert.ok(!text.includes(SCREEN_STEER_CLAUSE));
		assert.ok(!text.includes(SCREEN_DEDUP_CLAUSE));
	}
});

test("J's protocol block is byte-identical across providers", () => {
	const combined = sharedSuffix(arms.J.prompt);
	assert.equal(combined, sharedSuffix(arms.J.envelope));
	assert.ok(combined.length > 800, "shared block is too short to be meaningful");
	assert.ok(arms.J.prompt.endsWith("</system-reminder>"));

	// Everything before the shared block is the lens unit, and it differs only
	// in how the lens is carried.
	const combinedLens = arms.J.prompt.slice(0, arms.J.prompt.indexOf(PROTOCOL_ANCHOR));
	const splitLens = arms.J.envelope.slice(0, arms.J.envelope.indexOf(PROTOCOL_ANCHOR));
	assert.ok(combinedLens.includes(`LENS: ${LENS}`));
	assert.ok(splitLens.includes(`The preceding user message is the complete ${HEAD} lens`));
	assert.ok(!splitLens.includes(LENS));
	// Once each carrier's own lens reference is removed, the lens unit is the
	// same statement of role and lens authority on both providers.
	const collapse = (text) => text.replace(/\s+/g, " ").trim();
	const residue = collapse(
		combinedLens
			.replace("<system-reminder>", "")
			.replace("Review the visible trajectory through the lens below; follow it in full.", "")
			.replace(`LENS: ${LENS}`, ""),
	);
	assert.equal(
		residue,
		collapse(
			splitLens
				.replace(`The preceding user message is the complete ${HEAD} lens; follow it in full.`, "")
				.replace("Review the visible trajectory.", ""),
		),
	);
	assert.equal(residue, "Side watcher. The lens alone defines scope, intervention criteria, suppression, and deduplication.");
});

test("each causal clause appears verbatim exactly once in J and F", () => {
	for (const arm of ["J", "F"]) {
		for (const text of [arms[arm].prompt, arms[arm].envelope]) {
			for (const clause of [SCREEN_STEER_CLAUSE, SCREEN_DEDUP_CLAUSE]) {
				assert.equal(text.split(clause).length - 1, 1, `${arm}: clause not stated exactly once`);
			}
		}
	}
});

test("F differs from J in the completion-grammar paragraph alone", () => {
	for (const carrier of ["prompt", "envelope"]) {
		const jsonUnits = arms.J[carrier].split("\n\n");
		const footerUnits = arms.F[carrier].split("\n\n");
		assert.equal(jsonUnits.length, footerUnits.length);
		const differing = jsonUnits.flatMap((unit, index) => (unit === footerUnits[index] ? [] : [index]));
		assert.deepEqual(differing.length, 1, `${carrier}: expected exactly one differing unit`);
		assert.equal(jsonUnits[differing[0]], SCREEN_JSON_GRAMMAR);
		assert.equal(footerUnits[differing[0]], SCREEN_FOOTER_GRAMMAR);
	}
});

test("A0 and J parse A-shape JSON leniently", () => {
	const shape = '{"action":"steer","reason":"unverified migration","message":"Run the migration test before merging."}';
	const expected = { action: "steer", reason: "unverified migration", message: "Run the migration test before merging." };
	assert.deepEqual(parseDecision(shape), expected);
	assert.deepEqual(parseDecision("```json\n" + shape + "\n```"), expected);
	assert.deepEqual(parseDecision(`Here is my decision: ${shape} That is all.`), expected);
	assert.deepEqual(parseDecision('{"action":"noop","reason":"nothing warrants feedback","message":""}'), {
		action: "noop",
		reason: "nothing warrants feedback",
		message: "",
	});
	assert.equal(parseDecision("I reviewed the trajectory and found nothing."), null);
});

test("F accepts one exact footer and refuses zero or multiple markers", () => {
	assert.deepEqual(parseFooterDecision("The migration runs without a test.\nDELIVERY: steer"), {
		decision: { action: "steer", reason: "observation completed", message: "The migration runs without a test." },
		error: null,
	});
	assert.deepEqual(parseFooterDecision("DELIVERY: none"), {
		decision: { action: "noop", reason: "observation completed", message: "" },
		error: null,
	});
	assert.deepEqual(parseFooterDecision("Nothing here warrants feedback."), {
		decision: null,
		error: "feedback must end with an exact DELIVERY footer",
	});
	assert.deepEqual(parseFooterDecision("First.\nDELIVERY: queue\nSecond.\nDELIVERY: steer"), {
		decision: null,
		error: "feedback contains multiple DELIVERY markers",
	});
});

// protocol.ts's hydraToolParameters, inlined: the invariants must be checkable
// without the provider SDK installed, before any spend.
const WIDE_HYDRA_SCHEMA = {
	type: "object",
	properties: {
		action: { type: "string", enum: ["manage_heads", "complete_observation"] },
		operation: { type: "string", enum: ["add", "remove"] },
		head: { type: "string", minLength: 1 },
		delivery: { type: "string", enum: ["none", "print", "queue", "steer", "interrupt"] },
		message: { type: "string", maxLength: 1000 },
	},
	additionalProperties: false,
};

test("the screen arms advertise a management-only hydra schema", () => {
	const wide = [{ type: "function", name: "hydra", description: "wide", parameters: WIDE_HYDRA_SCHEMA, strict: false }];
	assert.ok(JSON.stringify(wide).includes("complete_observation"), "fixture must carry the wide schema");

	for (const arm of SCREEN_ARMS) {
		for (const provider of ["anthropic", "openai-codex"]) {
			const tools = visibleDriverTools(provider, arm, wide);
			const serialized = JSON.stringify(tools);
			assert.ok(!serialized.includes("complete_observation"), `${arm}/${provider}: completion action advertised`);
			assert.ok(!serialized.includes("manage_heads"), `${arm}/${provider}: legacy action advertised`);
			assert.ok(!serialized.includes("delivery"), `${arm}/${provider}: delivery enum advertised`);

			const hydra = tools.find((tool) => tool.name === "hydra");
			assert.ok(hydra, `${arm}/${provider}: hydra tool missing`);
			const schema = provider === "anthropic" ? hydra.input_schema : hydra.parameters;
			assert.deepEqual(Object.keys(schema.properties), ["operation", "head", "message"]);
			assert.deepEqual(schema.properties.operation.enum, ["add", "remove"]);
			assert.deepEqual(
				tools.map((tool) => tool.name),
				["read", "bash", "edit", "write", "hydra"],
			);
			if (provider === "anthropic") {
				assert.equal(hydra.parameters, undefined);
			} else {
				assert.equal(hydra.type, "function");
				assert.equal(hydra.strict, false);
			}
		}
	}

	// The existing arms keep the wide schema they were measured with.
	assert.ok(JSON.stringify(visibleDriverTools("openai-codex", "main-json", wide)).includes("complete_observation"));
});

test("the registry's tool surface agrees with the frozen SCREEN_ARMS record", () => {
	const managementOnly = Object.values(GOLDEN_ARMS)
		.filter((entry) => entry.toolSurface === "management-only")
		.map((entry) => entry.id)
		.sort();
	assert.deepEqual(managementOnly, [...SCREEN_ARMS].sort());

	// The producer reaches the serializer through the registry; the arm-keyed
	// shim must stay equivalent for every arm on both providers, or the surface
	// a row was measured with and the surface its label implies diverge.
	const wide = [{ type: "function", name: "hydra", description: "wide", parameters: WIDE_HYDRA_SCHEMA, strict: false }];
	for (const id of Object.keys(GOLDEN_ARMS)) {
		for (const provider of ["anthropic", "openai-codex"]) {
			assert.deepEqual(
				armVisibleDriverTools(id, provider, wide),
				visibleDriverTools(provider, id, wide),
				`${id}/${provider}: registry and shim disagree on the tool surface`,
			);
			assert.equal(armSpec(id).toolSurface, SCREEN_ARMS.has(id) ? "management-only" : "wide");
		}
	}
});
