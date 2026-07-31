/**
 * Invariants the acting-head channel arms must satisfy before any provider
 * spend: the shared-contract byte-equality the unification claim rests on, the
 * per-arm tool surface, the two fail-closed parsers, and a zero-provider-call
 * dry run of prompt assembly for every arm x provider x case.
 *
 * Runs under `node --test`, like `screen-arm-invariants.check.mjs`: the runner
 * it guards is a script that executes the matrix on import, so its arms live in
 * a plain module.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MANAGEMENT_ONLY_HYDRA_TOOL,
	SCREEN_ACTING_CARDINALITY,
	SCREEN_DEDUP_CLAUSE,
	SCREEN_FOOTER_GRAMMAR,
	SCREEN_ROUTING,
	SCREEN_STEER_CLAUSE,
	buildScreenFooterObservationPrompt,
	screenDiscipline,
	screenProtocolBlock,
} from "./delivery-context-evaluation.mjs";
import { TOOL_FREE_DECISION_SHAPE, validateManagementOnlyParams } from "./tool-free-protocol.mjs";
import { applyAfterChangeDelivery } from "../utils.ts";
import {
	ACTING_ARMS,
	ACTING_CASES,
	ACTING_JSON_GRAMMAR,
	ACTING_TYPED_GRAMMAR,
	actingArm,
	actingManagementHydraDescription,
	actingManagementHydraParameters,
	actingPayloadTransform,
	actingToolsFor,
	afterChangeRetriesOf,
	afterChangeViolation,
	buildActingHandoff,
	excursionsOf,
	handoffHash,
	isTerminalHydraCall,
	newActingState,
	selectActingCases,
	validateActingManagementParams,
} from "./acting-channel-arms.mjs";

const ARM_NAMES = ["T", "J", "F"];
const PROVIDERS = ["anthropic", "openai-codex"];
// Anchored on the acting block's first semantic unit, spelled out here rather
// than imported, so a reworded envelope cannot make the assertions vacuous.
const ACTING_ANCHOR = "You may use only these tools:";
const JUDGE_ANCHOR = "You have no tools:";

const CASE = ACTING_CASES.find((testCase) => testCase.id === "foreman-add-security");
const WRITE_CASE = ACTING_CASES.find((testCase) => testCase.id === "tuner-edit-print");

function protocolUnits(text) {
	const index = text.indexOf(ACTING_ANCHOR);
	assert.notEqual(index, -1, "acting protocol anchor missing");
	return text.slice(index).replace(/<\/system-reminder>$/, "").split("\n\n");
}

function handoffs(armName) {
	return Object.fromEntries(PROVIDERS.map((provider) => [provider, buildActingHandoff(armName, provider, CASE)]));
}

function carriers(armName) {
	const built = handoffs(armName);
	return [built.anthropic.prompt, built["openai-codex"].envelope];
}

test("the arm registry is exactly the three channels under test", () => {
	assert.deepEqual(Object.keys(ACTING_ARMS), ARM_NAMES);
	assert.deepEqual(
		ARM_NAMES.map((name) => [ACTING_ARMS[name].schema, ACTING_ARMS[name].channel]),
		[
			["wide", "tool"],
			["management-only", "json"],
			["management-only", "footer"],
		],
	);
	// The typed arm has no text channel to recover, and no parser.
	assert.equal(ACTING_ARMS.T.parse, null);
	assert.equal(ACTING_ARMS.T.correction, null);
	for (const name of ["J", "F"]) {
		assert.equal(typeof ACTING_ARMS[name].parse, "function");
		assert.equal(typeof ACTING_ARMS[name].correction, "function");
	}
	assert.throws(() => actingArm("Q"), /unknown arm/);
});

test("routing and discipline are byte-identical to the judge surface", () => {
	// This is the unification claim: the two clauses the record isolates as
	// causal, and the support constraint, are the same statement for acting
	// heads as for judges, on both providers.
	const judgeUnits = screenProtocolBlock(CASE.head, SCREEN_FOOTER_GRAMMAR).split("\n\n");
	assert.equal(judgeUnits.length, 5);
	for (const armName of ARM_NAMES) {
		for (const carrier of carriers(armName)) {
			const units = protocolUnits(carrier);
			assert.equal(units.length, 5, `${armName}: expected five semantic units`);
			assert.equal(units[3], judgeUnits[3], `${armName}: routing unit diverged`);
			assert.equal(units[3], SCREEN_ROUTING);
			assert.equal(units[4], judgeUnits[4], `${armName}: discipline unit diverged`);
			assert.equal(units[4], screenDiscipline(CASE.head));
		}
	}
});

test("the acting block drops the two judge units that are false for an acting head", () => {
	// wave2-simplicity §4 scopes the head kind to a paragraph: an acting head
	// has tools, and it works across turns. Keeping either judge sentence would
	// make the shared envelope a lie rather than a unification.
	for (const armName of ARM_NAMES) {
		for (const carrier of carriers(armName)) {
			assert.ok(!carrier.includes(JUDGE_ANCHOR), `${armName}: judge tool denial leaked in`);
			assert.ok(!carrier.includes("there is no follow-up turn"), `${armName}: judge cardinality leaked in`);
			const units = protocolUnits(carrier);
			assert.ok(units[0].startsWith(ACTING_ANCHOR));
			assert.equal(units[1], SCREEN_ACTING_CARDINALITY);
		}
	}
});

test("the three arms differ in the completion-grammar unit alone", () => {
	for (const provider of PROVIDERS) {
		const built = ARM_NAMES.map((armName) => {
			const handoff = buildActingHandoff(armName, provider, CASE);
			return protocolUnits(provider === "anthropic" ? handoff.prompt : handoff.envelope);
		});
		for (let index = 0; index < 5; index++) {
			const values = built.map((units) => units[index]);
			if (index === 2) {
				assert.deepEqual(values, [ACTING_TYPED_GRAMMAR, ACTING_JSON_GRAMMAR, SCREEN_FOOTER_GRAMMAR]);
				assert.equal(new Set(values).size, 3, `${provider}: grammars are not distinct`);
			} else {
				assert.equal(new Set(values).size, 1, `${provider}: unit ${index} differs across arms`);
			}
		}
	}
	// F's grammar is the judge's, unchanged — that is what "one contract
	// everywhere" means for the arm the judge screen selected.
	assert.ok(buildScreenFooterObservationPrompt(CASE.head, CASE.lens).includes(SCREEN_FOOTER_GRAMMAR));
	// J carries the two-field shape that shipped as `json-minimal`, not the
	// three-field judge shape the screen refuted.
	assert.ok(ACTING_JSON_GRAMMAR.includes(TOOL_FREE_DECISION_SHAPE));
	assert.ok(!ACTING_JSON_GRAMMAR.includes('"reason"'));
});

test("each causal clause appears verbatim exactly once per arm and provider", () => {
	for (const armName of ARM_NAMES) {
		for (const carrier of carriers(armName)) {
			for (const clause of [SCREEN_STEER_CLAUSE, SCREEN_DEDUP_CLAUSE]) {
				assert.equal(carrier.split(clause).length - 1, 1, `${armName}: clause not stated exactly once`);
			}
		}
	}
});

test("the protocol block is byte-identical across providers; only the lens carrier differs", () => {
	for (const armName of ARM_NAMES) {
		const built = handoffs(armName);
		const combined = built.anthropic;
		const split = built["openai-codex"];
		assert.equal(combined.envelope, undefined, `${armName}: Anthropic must use the combined prompt`);
		assert.equal(split.prompt, CASE.lens, `${armName}: OpenAI must send the raw lens as the user message`);
		assert.ok(combined.prompt.endsWith("</system-reminder>"));

		const combinedBlock = protocolUnits(combined.prompt).join("\n\n");
		assert.equal(combinedBlock, protocolUnits(split.envelope).join("\n\n"));
		assert.ok(combinedBlock.length > 800, "shared block is too short to be meaningful");

		const combinedLens = combined.prompt.slice(0, combined.prompt.indexOf(ACTING_ANCHOR));
		const splitLens = split.envelope.slice(0, split.envelope.indexOf(ACTING_ANCHOR));
		assert.ok(combinedLens.includes(`LENS: ${CASE.lens}`));
		assert.ok(splitLens.includes(`The preceding user message is the complete ${CASE.head} lens`));
		assert.ok(!splitLens.includes(CASE.lens));
		const collapse = (text) => text.replace(/\s+/g, " ").trim();
		const residue = collapse(
			combinedLens
				.replace("<system-reminder>", "")
				.replace("Review the visible trajectory through the lens below; follow it in full.", "")
				.replace(`LENS: ${CASE.lens}`, ""),
		);
		assert.equal(
			residue,
			collapse(
				splitLens
					.replace(`The preceding user message is the complete ${CASE.head} lens; follow it in full.`, "")
					.replace("Review the visible trajectory.", ""),
			),
		);
		assert.equal(
			residue,
			"Side watcher with tool access. The lens alone defines scope, intervention criteria, suppression, and deduplication.",
		);
	}
});

test("the tool-status unit carries the allowance, the snapshot, and the case's after-change rule", () => {
	const [managing] = protocolUnits(buildActingHandoff("F", "anthropic", CASE).prompt);
	assert.ok(managing.includes(`only these tools: ${CASE.tools.join(", ")}`));
	assert.ok(managing.includes(`active heads are ${CASE.active.join(", ")}`));
	// Schema-neutral by design: the wide and management-only shapes spell head
	// management differently, and only the tool description may say so.
	assert.ok(!managing.includes("manage_heads"));

	const [writing] = protocolUnits(buildActingHandoff("F", "anthropic", WRITE_CASE).prompt);
	assert.ok(writing.includes('After a successful write or edit, deliver "print"'));
	assert.ok(!writing.includes("Hydra snapshot"), "a head without hydra gets no crew snapshot");
	const [noop] = protocolUnits(
		buildActingHandoff("F", "anthropic", ACTING_CASES.find((c) => c.id === "docs-write-none")).prompt,
	);
	assert.ok(noop.includes('deliver "none" with an empty message'));
});

test("each arm grants the schema it advertises and only the head's work tools", () => {
	const root = mkdtempSync(join(tmpdir(), "hydra-acting-invariants-"));
	try {
		for (const armName of ARM_NAMES) {
			const tools = actingToolsFor(root, WRITE_CASE, newActingState(WRITE_CASE), armName);
			assert.deepEqual(
				tools.map((tool) => tool.name),
				["read", "write", "edit", "ls", "hydra"],
				`${armName}: work tools are not the head's allowlist plus hydra`,
			);
			assert.equal(tools.filter((tool) => tool.name === "hydra").length, 1);

			const hydra = tools.at(-1);
			const schema = JSON.stringify(hydra.parameters);
			if (armName === "T") {
				assert.ok(schema.includes("complete_observation"), "T must advertise the typed completion action");
				assert.ok(schema.includes("manage_heads"));
				assert.ok(hydra.description.includes("complete_observation"));
			} else {
				assert.ok(!schema.includes("complete_observation"), `${armName}: completion action advertised`);
				assert.ok(!schema.includes("manage_heads"), `${armName}: legacy discriminator advertised`);
				assert.ok(!schema.includes("delivery"), `${armName}: delivery enum advertised`);
				assert.ok(!hydra.description.includes("complete_observation"));
				assert.ok(!hydra.description.includes("manage_heads"));
				assert.deepEqual(Object.keys(hydra.parameters.properties), ["operation", "head", "message"]);
				// The same three keys the judge screen's public schema asserts.
				assert.deepEqual(
					Object.keys(hydra.parameters.properties),
					Object.keys(MANAGEMENT_ONLY_HYDRA_TOOL.parameters.properties),
				);
				assert.deepEqual(hydra.parameters.properties.operation.enum, ["add", "remove"]);
				assert.equal(hydra.parameters.additionalProperties, false);
			}
		}
		// A head whose allowlist is hydra+read gets no file tools at all.
		const managing = actingToolsFor(root, CASE, newActingState(CASE), "J");
		assert.deepEqual(
			managing.map((tool) => tool.name),
			["read", "hydra"],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the management-only validator is three-key and rejects the four-key shape", () => {
	assert.deepEqual(validateActingManagementParams({ operation: "add", head: "security", message: "auth work starts" }), {
		operation: "add",
		head: "security",
		message: "auth work starts",
	});
	assert.throws(
		() => validateActingManagementParams({ action: "manage_heads", operation: "add", head: "s", message: "m" }),
		/exactly operation, head, and message/,
	);
	assert.throws(() => validateActingManagementParams({ operation: "swap", head: "s", message: "m" }), /add/);
	assert.throws(() => validateActingManagementParams({ operation: "add", head: " ", message: "m" }), /non-empty/);
	assert.throws(() => validateActingManagementParams({ operation: "add", head: "s", message: "" }), /non-empty/);
	// The four-key validator is the shape this arm deliberately does not ship.
	assert.throws(() => validateManagementOnlyParams({ operation: "add", head: "s", message: "m" }), /exactly action/);
	assert.equal(Object.keys(actingManagementHydraParameters.properties).length, 3);
	const description = actingManagementHydraDescription("/tmp/heads");
	assert.ok(description.includes("/tmp/heads"));
	assert.ok(!/\baction\b/.test(description));
});

test("terminality is detected from each arm's own shape", () => {
	// index.ts:1741 — self-removal is terminal regardless of channel. Under the
	// management-only schema there is no action key to read it from.
	assert.ok(isTerminalHydraCall("T", { action: "complete_observation", delivery: "none", message: "" }, "foreman"));
	assert.ok(isTerminalHydraCall("T", { action: "manage_heads", operation: "remove", head: "foreman" }, "foreman"));
	assert.ok(!isTerminalHydraCall("T", { action: "manage_heads", operation: "remove", head: "quality" }, "foreman"));
	assert.ok(!isTerminalHydraCall("T", { action: "manage_heads", operation: "add", head: "foreman" }, "foreman"));
	for (const armName of ["J", "F"]) {
		assert.ok(isTerminalHydraCall(armName, { operation: "remove", head: " foreman " }, "foreman"));
		assert.ok(!isTerminalHydraCall(armName, { operation: "remove", head: "quality" }, "foreman"));
		assert.ok(!isTerminalHydraCall(armName, { operation: "add", head: "foreman" }, "foreman"));
		assert.ok(!isTerminalHydraCall(armName, null, "foreman"));
	}
});

test("J and F parse fail-closed on their own contracts", () => {
	const valid = { action: "steer", reason: "observation completed", message: "Run the migration test before merging." };
	assert.deepEqual(ACTING_ARMS.J.parse('{"delivery":"steer","message":"Run the migration test before merging."}'), {
		decision: valid,
		error: null,
	});
	assert.equal(ACTING_ARMS.J.parse('{"action":"complete_observation","delivery":"steer","message":"x"}').decision, null);
	assert.equal(ACTING_ARMS.J.parse('```json\n{"delivery":"none","message":""}\n```').decision, null);
	assert.deepEqual(ACTING_ARMS.J.parse('{"delivery":"none","message":""}').decision, {
		action: "noop",
		reason: "observation completed",
		message: "",
	});

	assert.deepEqual(ACTING_ARMS.F.parse("Run the migration test before merging.\nDELIVERY: steer").decision, valid);
	assert.deepEqual(ACTING_ARMS.F.parse("DELIVERY: none").decision, {
		action: "noop",
		reason: "observation completed",
		message: "",
	});
	assert.equal(ACTING_ARMS.F.parse("I recorded the decision in docs/notes.md.").decision, null);
	assert.equal(ACTING_ARMS.F.parse("First.\nDELIVERY: queue\nSecond.\nDELIVERY: steer").decision, null);
	// The one recovery text each: the footer correction must not deny tools,
	// which is true for a judge and false for an acting head.
	assert.ok(!ACTING_ARMS.F.correction("bad").includes("unavailable to this observation"));
	assert.ok(ACTING_ARMS.J.correction("bad").includes(TOOL_FREE_DECISION_SHAPE));
});

test("prompt assembly for every arm x provider x case is total, and costs nothing", () => {
	for (const testCase of ACTING_CASES) {
		const perCase = new Set();
		for (const armName of ARM_NAMES) {
			for (const provider of PROVIDERS) {
				const handoff = buildActingHandoff(armName, provider, testCase);
				const carrier = provider === "anthropic" ? handoff.prompt : handoff.envelope;
				assert.ok(carrier.length > 0);
				assert.equal(protocolUnits(carrier).length, 5);
				assert.ok(carrier.includes(ACTING_ARMS[armName].grammar));
				assert.ok(carrier.includes(`only these tools: ${testCase.tools.join(", ")}`));
				const combined = provider === "anthropic" ? handoff.prompt : `${handoff.prompt}\n${handoff.envelope}`;
				assert.ok(combined.includes(testCase.lens), `${testCase.id}/${armName}/${provider}: lens missing`);
				const hash = handoffHash(handoff);
				assert.equal(hash, handoffHash(buildActingHandoff(armName, provider, testCase)), "hash is unstable");
				perCase.add(hash);
			}
		}
		assert.equal(perCase.size, ARM_NAMES.length * PROVIDERS.length, `${testCase.id}: arm/provider handoffs collide`);
	}
	// The handoff is a pure function of head, lens, tool allowance, active set,
	// after-change, and the arm's grammar — never of the trajectory. The two
	// foreman cases that share all of those therefore share a prompt hash;
	// asserting it keeps that a stated property rather than a surprise when the
	// rows are grouped by promptHash.
	const byId = (id) => ACTING_CASES.find((testCase) => testCase.id === id);
	assert.equal(
		handoffHash(buildActingHandoff("F", "anthropic", byId("foreman-add-security"))),
		handoffHash(buildActingHandoff("F", "anthropic", byId("foreman-self-remove"))),
	);
	assert.notEqual(
		handoffHash(buildActingHandoff("F", "anthropic", byId("foreman-add-security"))),
		handoffHash(buildActingHandoff("F", "anthropic", byId("foreman-clean-recrew"))),
	);
});

test("the OpenAI payload transform splices once and tolerates the driver-only warm body", () => {
	const handoff = buildActingHandoff("F", "openai-codex", CASE);
	const roles = { value: "" };
	const transform = actingPayloadTransform("openai-codex", handoff.prompt, handoff.envelope, roles);

	const measured = transform({
		input: [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "earlier turn" }] },
			{ type: "message", role: "user", content: [{ type: "input_text", text: handoff.prompt }] },
		],
	});
	assert.equal(measured.input.length, 3);
	assert.equal(measured.input[2].role, "developer");
	assert.equal(measured.input[2].content[0].text, handoff.envelope);
	assert.equal(roles.value, "user,user,developer");

	// The warm call sends the driver context with no observation prompt. It must
	// pass through untouched, not throw: warming prompt-inclusive is what the
	// `ba636ad` fix removed, so this path is load-bearing on every Anthropic row.
	const warm = { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "driver only" }] }] };
	const warmed = transform(warm);
	assert.equal(warmed.input.length, 1);
	assert.ok(!JSON.stringify(warmed).includes("Side watcher"));

	const anthropic = actingPayloadTransform("anthropic", handoff.prompt, undefined, roles);
	const body = { messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] };
	assert.equal(anthropic(body), body, "Anthropic bodies are passed through unmodified");
});

test("the corpus is the four channel cases plus two multi-operation re-crewings", () => {
	assert.deepEqual(
		ACTING_CASES.map((testCase) => testCase.id),
		[
			"docs-write-none",
			"tuner-edit-print",
			"foreman-add-security",
			"foreman-self-remove",
			"foreman-clean-recrew",
			"foreman-two-uncovered-risks",
		],
	);
	for (const testCase of ACTING_CASES) {
		assert.equal(typeof testCase.evaluate, "function");
		assert.ok(testCase.active.every((head) => testCase.available.includes(head)), `${testCase.id}: active ⊄ available`);
		// After-change is declared only where the head can actually write.
		if (testCase.afterChange !== undefined) {
			assert.ok(testCase.tools.includes("write") || testCase.tools.includes("edit"));
		}
	}
	assert.deepEqual(selectActingCases(["foreman-self-remove"]).map((c) => c.id), ["foreman-self-remove"]);
	assert.throws(() => selectActingCases(["nope"]), /unknown case/);

	// Self-removal is scored on terminality, not on a delivery the runtime
	// supplies: S3 must be able to fail.
	const selfRemove = ACTING_CASES.find((testCase) => testCase.id === "foreman-self-remove");
	const base = { filesAfter: {}, changedFiles: [], activeAfter: ["quality"], receipts: ["Removed foreman — done"] };
	assert.ok(selfRemove.evaluate({ ...base, selfRemoved: true, action: "noop" }));
	assert.ok(!selfRemove.evaluate({ ...base, selfRemoved: false, action: "noop" }));
	assert.ok(!selfRemove.evaluate({ ...base, activeAfter: ["foreman", "quality"], selfRemoved: true, action: "noop" }));
});

test("head management terminates on self-removal alone, under every schema", async () => {
	const root = mkdtempSync(join(tmpdir(), "hydra-acting-manage-"));
	try {
		const selfRemove = ACTING_CASES.find((testCase) => testCase.id === "foreman-self-remove");
		selfRemove.setup(root);
		for (const armName of ARM_NAMES) {
			const state = newActingState(selfRemove);
			const hydra = actingToolsFor(root, selfRemove, state, armName).at(-1);
			const call = (params) =>
				hydra.execute("id", armName === "T" ? { action: "manage_heads", ...params } : params);

			const added = await call({ operation: "add", head: "security", message: "auth risk is uncovered" });
			assert.equal(added.terminate, false, `${armName}: a non-self change must not terminate`);
			assert.ok(state.active.includes("security"));
			assert.equal(state.receipts.length, 1);
			assert.ok(added.content[0].text.startsWith("Added security — "));

			const other = await call({ operation: "remove", head: "quality", message: "no longer relevant" });
			assert.equal(other.terminate, false, `${armName}: removing another head must not terminate`);

			// index.ts:1741 — the terminality S3 tests is a property of the runtime,
			// not of the completion channel.
			const self = await call({ operation: "remove", head: "foreman", message: "staffing is complete" });
			assert.equal(self.terminate, true, `${armName}: self-removal must terminate`);
			assert.equal(state.selfRemoved, true);
			assert.ok(!state.active.includes("foreman"));
			assert.equal(state.receipts.length, 3);

			await assert.rejects(() => call({ operation: "add", head: "ghost", message: "unknown" }), /Unknown head/);
		}
		// A head without hydra in its allowlist cannot manage, whatever it sends.
		const docs = ACTING_CASES.find((testCase) => testCase.id === "docs-write-none");
		for (const armName of ARM_NAMES) {
			const hydra = actingToolsFor(root, docs, newActingState(docs), armName).at(-1);
			await assert.rejects(
				() =>
					hydra.execute(
						"id",
						armName === "T"
							? { action: "manage_heads", operation: "add", head: "docs-keeper", message: "m" }
							: { operation: "add", head: "docs-keeper", message: "m" },
					),
				/not allowed to manage heads/,
				`${armName}: capability gate did not fire`,
			);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the typed arm enforces after-change on the same gate the post-hoc path uses", async () => {
	const root = mkdtempSync(join(tmpdir(), "hydra-acting-afterchange-"));
	try {
		WRITE_CASE.setup(root);
		const state = newActingState(WRITE_CASE);
		const hydra = actingToolsFor(root, WRITE_CASE, state, "T").at(-1);

		// Nothing written yet: production gates on fileStateChanged, so the
		// contract is silent and any delivery is accepted.
		assert.equal(afterChangeViolation(state, WRITE_CASE, "noop"), null);
		await hydra.execute("id", { action: "complete_observation", delivery: "none", message: "" });
		assert.equal(state.completion.action, "noop");
		await assert.rejects(
			() => hydra.execute("id", { action: "complete_observation", delivery: "none", message: "" }),
			/already accepted/,
		);

		const written = newActingState(WRITE_CASE);
		written.fileStateChanged = true;
		const writingHydra = actingToolsFor(root, WRITE_CASE, written, "T").at(-1);
		await assert.rejects(
			() => writingHydra.execute("id", { action: "complete_observation", delivery: "none", message: "" }),
			/requires delivery "print"/,
		);
		assert.match(afterChangeViolation(written, WRITE_CASE, "noop"), /requires delivery "print"/);
		assert.equal(afterChangeViolation(written, WRITE_CASE, "print"), null);

		// An active-set change is NOT a file change: the foreman cases must not
		// hand J and F a delivery the typed arm has to produce itself.
		const foreman = newActingState(CASE);
		foreman.active = ["foreman", "quality", "security"];
		assert.equal(afterChangeViolation(foreman, CASE, "noop"), null);
		assert.deepEqual(applyAfterChangeDelivery({ action: "noop", reason: "r", message: "" }, CASE.afterChange, false), {
			action: "noop",
			reason: "r",
			message: "",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("excursions count denied, errored, and out-of-allowlist tool calls", () => {
	const events = [
		{ name: "read", isError: false, text: "ok" },
		{ name: "hydra", isError: false, text: "Added security" },
		{ name: "bash", isError: true, text: "tool not found" },
		{ name: "write", isError: false, text: "written" },
		{ name: "hydra", isError: true, text: 'This head requires delivery "print" with a message after a successful write or edit' },
	];
	// CASE allows hydra and read; write and bash are excursions, as is any error
	// that is not the typed arm's own after-change enforcement.
	assert.equal(excursionsOf(events, CASE), 2);
	assert.equal(excursionsOf(events, WRITE_CASE), 1);
	assert.equal(afterChangeRetriesOf(events), 1);
	assert.equal(afterChangeRetriesOf([{ name: "hydra", isError: false, text: "requires delivery" }]), 0);
	// A denied hydra call is an excursion; the after-change rejection is not.
	assert.equal(excursionsOf([{ name: "hydra", isError: true, text: "is not allowed to manage heads" }], CASE), 1);
});

test("createToolEventCollector captures every execution branch from the emit stream", async () => {
	const { createToolEventCollector } = await import("./acting-channel-arms.mjs");
	const events = [];
	const emit = createToolEventCollector(events);
	await emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
	await emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "not allowed" }] } });
	// tool-not-found path emits end without our start ever carrying args
	await emit({ type: "tool_execution_end", toolCallId: "t2", toolName: "nonexistent", isError: true, result: { content: [] } });
	await emit({ type: "message_start" });
	assert.equal(events.length, 2);
	assert.deepEqual(events[0], { name: "bash", args: { command: "ls" }, isError: true, text: "not allowed" });
	assert.deepEqual(events[1], { name: "nonexistent", args: {}, isError: true, text: "" });
});
