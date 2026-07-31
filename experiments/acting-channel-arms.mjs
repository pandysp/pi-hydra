/**
 * The acting-head completion channel arms, their tool surface, and the fixture
 * corpus. Kept out of the runner so the invariant check can import them: the
 * runner parses argv and runs the matrix on import, and every contract
 * assertion here must hold before any provider spend.
 *
 * Three arms, one envelope. The judge screen settled the judge surface on
 * natural text plus a `DELIVERY:` footer under a management-only public schema
 * (`UNIFIED-API-SCREEN-RESULTS.md`); the acting cell was deferred. These arms
 * hold the envelope byte-identical and vary only the completion channel and,
 * with it, the hydra schema the observation advertises:
 *
 *   T  typed completion  wide schema (protocol.ts:12) — the shipped OpenAI path
 *   J  compact JSON      management-only schema
 *   F  DELIVERY footer   management-only schema — full unification with judges
 *
 * The frozen 24-row typed-vs-JSON acting table (`TOOL-FREE-COMPLETION-AB.md`
 * :113-129, rows in `artifacts/2026-07-25-tool-free-acting/`) used the older
 * `buildObservationEnvelope`/`buildToolFreeObservationEnvelope` wording, so it
 * is a sanity anchor for T, never an arm: scoring F against it would confound
 * channel with envelope, which is what F−J isolation exists to prevent.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { createEditTool, createLsTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import {
	decisionFromCompletion,
	formatHeadManagementReceipt,
	parseFooterDecision,
	parseHeadFile,
} from "../utils.ts";
import { hydraToolDescription, hydraToolParameters, validateHydraToolParams } from "../protocol.ts";
import { TOOL_FREE_DECISION_SHAPE, parseToolFreeDecision } from "./tool-free-protocol.mjs";
import {
	SCREEN_FOOTER_GRAMMAR,
	buildScreenActingObservationEnvelope,
	buildScreenActingObservationPrompt,
} from "./delivery-context-evaluation.mjs";

// ---------------------------------------------------------------------------
// The management-only public schema, three keys.
// ---------------------------------------------------------------------------

/**
 * The screen's management-only shape (`delivery-context-evaluation.mjs`
 * MANAGEMENT_ONLY_HYDRA_TOOL), expressed for the runtime. It drops the
 * `action` discriminator that `tool-free-protocol.mjs`'s four-key variant
 * still carried: with only one operation family left there is nothing to
 * discriminate, and the judge screen's public schema already asserts exactly
 * these three keys. The measured 135-token driver saving (`TOOL-FREE:126-134`)
 * was taken on the four-key shape, so it is a lower bound here, not a
 * restatement.
 */
export const actingManagementHydraParameters = Type.Object(
	{
		operation: StringEnum(["add", "remove"], { description: "Add or remove one active head" }),
		head: Type.String({ minLength: 1, description: "The head name" }),
		message: Type.String({
			minLength: 1,
			maxLength: 1000,
			description: "Concisely explain why the change fits the trajectory",
		}),
	},
	{ additionalProperties: false },
);

export function actingManagementHydraDescription(userHeadDir) {
	return [
		"Add or remove one active head idempotently: `operation` is `add` or",
		"`remove`, `head` is the head name, and `message` explains why the change",
		"fits the trajectory. A successful observer-originated change",
		"automatically prints that explanation. Heads are markdown files in",
		`${userHeadDir} (user) and .pi/hydra (project):`,
		"frontmatter `name:` and `description:` are required; `tools:` is omitted",
		"for all tools, `[]` for a judge-only head, or a comma-separated subset;",
		"`autostart: true` joins fresh sessions; heads with write/edit may set",
		"`after-change:` to `noop` or `print`; the body is the head's instruction",
		"(one focus, clear conditions for acting, work, completion, and delivery).",
		"To create or tune a head, write the file with your file tools, then add",
		"it: files are re-discovered on every call. Swap heads when the work",
		"changes phase.",
	].join(" ");
}

export function validateActingManagementParams(value) {
	if (typeof value !== "object" || value === null) {
		throw new Error("hydra arguments must be an object");
	}
	if (Object.keys(value).sort().join(",") !== "head,message,operation") {
		throw new Error("hydra accepts exactly operation, head, and message");
	}
	if (value.operation !== "add" && value.operation !== "remove") {
		throw new Error('operation must be "add" or "remove"');
	}
	if (typeof value.head !== "string" || value.head.trim() === "") {
		throw new Error("head must be a non-empty string");
	}
	if (typeof value.message !== "string" || value.message.trim() === "") {
		throw new Error("message must be a non-empty string");
	}
	if (value.message.length > 1000) throw new Error("message must not exceed 1000 characters");
	return { operation: value.operation, head: value.head, message: value.message };
}

// ---------------------------------------------------------------------------
// Arms.
// ---------------------------------------------------------------------------

/** T: the completion sentence of the shipped typed contract (`utils.ts:393`), routing and prefix ban moved to the shared units. */
export const ACTING_TYPED_GRAMMAR =
	'When finished, call hydra exactly once, alone in its turn, with action "complete_observation". Use delivery "none" with message "" when nothing warrants feedback; otherwise message carries the finding, at most 240 characters.';

/** J: the two-field shape that shipped as `json-minimal` and measured 36/36 valid. */
export const ACTING_JSON_GRAMMAR = `When finished, reply with one JSON object, nothing else:
${TOOL_FREE_DECISION_SHAPE}
Use delivery "none" with message "" when nothing warrants feedback; otherwise message carries the finding, at most 240 characters.`;

export function jsonFormatCorrection(error) {
	return `FORMAT CORRECTION: The preceding completion was rejected: ${error}. Preserve its semantic decision and finding. Reply only with one JSON object and no other text: ${TOOL_FREE_DECISION_SHAPE}`;
}

/**
 * `footerFormatCorrection` (`utils.ts:486`) is the production recovery text,
 * but its middle sentence denies tools — false for an acting head, which may
 * legitimately still hold work tools. The denial is dropped; nothing else is.
 */
export function actingFooterFormatCorrection(error) {
	return `FORMAT CORRECTION: The preceding completion was rejected: ${error}. Preserve its semantic decision and finding. Reply only with either DELIVERY: none as the entire response, or one concise message followed by a final DELIVERY: print|queue|steer|interrupt line.`;
}

/**
 * One object per arm: the schema it advertises, the grammar paragraph it puts
 * in the shared envelope, how its completion is read, and its one recovery
 * text. The typed arm has none — the tool throws and the loop retries, which
 * is its own enforcement mechanism and is counted in providerCalls.
 */
export const ACTING_ARMS = Object.freeze({
	T: Object.freeze({
		id: "T",
		label: "typed-wide",
		schema: "wide",
		channel: "tool",
		grammar: ACTING_TYPED_GRAMMAR,
		parse: null,
		correction: null,
	}),
	J: Object.freeze({
		id: "J",
		label: "json-management",
		schema: "management-only",
		channel: "json",
		grammar: ACTING_JSON_GRAMMAR,
		parse: parseToolFreeDecision,
		correction: jsonFormatCorrection,
	}),
	F: Object.freeze({
		id: "F",
		label: "footer-management",
		schema: "management-only",
		channel: "footer",
		grammar: SCREEN_FOOTER_GRAMMAR,
		parse: parseFooterDecision,
		correction: actingFooterFormatCorrection,
	}),
});

export function actingArm(name) {
	const arm = ACTING_ARMS[name];
	if (!arm) throw new Error(`unknown arm: ${name}`);
	return arm;
}

// ---------------------------------------------------------------------------
// Prompt assembly. One envelope, one grammar slot, two provider packagings.
// ---------------------------------------------------------------------------

/**
 * Anthropic keeps the combined user prompt; OpenAI gets the raw lens as the
 * user message and the envelope as an adjacent developer item. Both placements
 * sit after the lens and inside the replayed tail, so neither mutates a cached
 * prefix. This mirrors `observationHandoffFor` (`index.ts:467-500`).
 */
export function buildActingHandoff(armName, provider, testCase) {
	const arm = actingArm(armName);
	const options = { tools: testCase.tools, activeHeads: testCase.active, afterChange: testCase.afterChange };
	if (provider === "openai-codex") {
		return {
			prompt: testCase.lens,
			envelope: buildScreenActingObservationEnvelope(testCase.head, arm.grammar, options),
		};
	}
	return {
		prompt: buildScreenActingObservationPrompt(testCase.head, testCase.lens, arm.grammar, options),
		envelope: undefined,
	};
}

export function handoffHash(handoff) {
	return createHash("sha256").update(`${handoff.prompt}\n${handoff.envelope ?? ""}`).digest("hex");
}

function textOfItem(item) {
	return (item?.content ?? [])
		.filter((block) => block?.type === "input_text" || block?.type === "text")
		.map((block) => block.text)
		.join("");
}

/**
 * Splice the envelope after the serialized lens. A prompt-less body is the
 * driver-only warm call (the `ba636ad` fix: warming prompt-inclusive would
 * price arm-specific prompt length at cache-read rates, ~10x under
 * production), so it is left untouched rather than treated as an error.
 */
export function actingPayloadTransform(provider, promptText, envelope, roles) {
	return (body) => {
		if (provider !== "openai-codex") {
			roles.value = body.messages.map((message) => message.role).slice(-8).join(",");
			return body;
		}
		const input = structuredClone(body.input);
		const index = input.findIndex((item) => item?.role === "user" && textOfItem(item) === promptText);
		if (index !== -1 && envelope !== undefined) {
			input.splice(index + 1, 0, {
				type: "message",
				role: "developer",
				content: [{ type: "input_text", text: envelope }],
			});
		}
		roles.value = input.slice(-8).map((item) => item?.role ?? item?.type ?? "?").join(",");
		return { ...body, input };
	};
}

// ---------------------------------------------------------------------------
// Tool surface. Real work tools filtered by the head's allowlist, plus exactly
// one hydra tool whose schema is the arm (`index.ts:1298-1345`).
// ---------------------------------------------------------------------------

export function newActingState(testCase) {
	return {
		active: [...testCase.active],
		available: [...testCase.available],
		completion: null,
		receipts: [],
		selfRemoved: false,
		fileStateChanged: false,
	};
}

function refreshAvailable(root, state) {
	const directory = join(root, ".pi/hydra");
	if (!existsSync(directory)) return;
	for (const filename of readdirSync(directory)) {
		if (!filename.endsWith(".md")) continue;
		const parsed = parseHeadFile(readFileSync(join(directory, filename), "utf8"));
		if ("head" in parsed && !state.available.includes(parsed.head.name)) state.available.push(parsed.head.name);
	}
}

function manage(root, state, operation, rawName, message, observingHead) {
	refreshAvailable(root, state);
	const name = rawName.trim();
	const activeLabel = () => state.active.join(", ") || "none";
	if (operation === "add") {
		if (!state.available.includes(name)) throw new Error(`Unknown head "${name}"`);
		if (state.active.includes(name)) {
			return {
				content: [{ type: "text", text: `"${name}" is already active. Observing with: ${activeLabel()}.` }],
				details: { changed: false, operation, head: name },
				terminate: false,
			};
		}
		state.active.push(name);
	} else {
		if (!state.active.includes(name)) {
			return {
				content: [{ type: "text", text: `"${name}" is not active. Observing with: ${activeLabel()}.` }],
				details: { changed: false, operation, head: name },
				terminate: false,
			};
		}
		state.active = state.active.filter((head) => head !== name);
	}
	const receipt = formatHeadManagementReceipt(operation, name, message);
	state.receipts.push(receipt);
	const selfRemoved = operation === "remove" && name === observingHead;
	state.selfRemoved ||= selfRemoved;
	// index.ts:1741: a successful self-removal is terminal by construction,
	// independent of the completion channel. S3 is the falsifier.
	return {
		content: [{ type: "text", text: `${receipt}\nObserving with: ${activeLabel()}.` }],
		details: { changed: true, operation, head: name },
		terminate: selfRemoved,
	};
}

/**
 * The after-change contract, applied where production applies it. The typed
 * path throws a tool error and forces a retry turn (`index.ts:1710-1715`); the
 * JSON path resolves post-hoc (`index.ts:911-913`). Both gate on
 * `fileStateChanged`, never on an active-set change — matching that gate is
 * what keeps the foreman cases from handing J and F a delivery T must earn.
 */
export function afterChangeViolation(state, testCase, action) {
	if (!state.fileStateChanged) return null;
	if (testCase.afterChange === "print" && action !== "print") {
		return 'This head requires delivery "print" with a message after a successful write or edit';
	}
	if (testCase.afterChange === "noop" && action !== "noop") {
		return 'This head requires delivery "none" with message "" after a successful write or edit';
	}
	return null;
}

export function hydraToolFor(root, testCase, state, armName) {
	const arm = actingArm(armName);
	if (arm.schema === "wide") {
		return {
			name: "hydra",
			label: "Hydra",
			// Match the isolated fixture's user-head path; the shared description
			// still names .pi/hydra as the project path.
			description: hydraToolDescription(join(root, "heads")),
			parameters: hydraToolParameters,
			async execute(_id, rawParams) {
				const params = validateHydraToolParams(rawParams);
				if (params.action === "manage_heads") {
					if (!testCase.tools.includes("hydra")) {
						throw new Error(`Head "${testCase.head}" is not allowed to manage heads`);
					}
					return manage(root, state, params.operation, params.head, params.message, testCase.head);
				}
				if (state.completion) throw new Error("complete_observation was already accepted for this observation");
				const decision = decisionFromCompletion(params.delivery, params.message);
				const violation = afterChangeViolation(state, testCase, decision.action);
				if (violation) throw new Error(violation);
				state.completion = decision;
				return {
					content: [{ type: "text", text: "Observation completed." }],
					details: { changed: false },
					terminate: true,
				};
			},
		};
	}
	return {
		name: "hydra",
		label: "Hydra",
		description: actingManagementHydraDescription(join(root, "heads")),
		parameters: actingManagementHydraParameters,
		async execute(_id, rawParams) {
			if (!testCase.tools.includes("hydra")) {
				throw new Error(`Head "${testCase.head}" is not allowed to manage heads`);
			}
			const params = validateActingManagementParams(rawParams);
			return manage(root, state, params.operation, params.head, params.message, testCase.head);
		},
	};
}

export const WORK_TOOL_FACTORIES = [createReadTool, createWriteTool, createEditTool, createLsTool];

export function actingToolsFor(root, testCase, state, armName) {
	const work = WORK_TOOL_FACTORIES.map((factory) => factory(root)).filter((tool) => testCase.tools.includes(tool.name));
	return [...work, hydraToolFor(root, testCase, state, armName)];
}

/**
 * The alone-in-its-turn guard (`index.ts:1176-1191`). Terminality is read from
 * the arm's own shape: the wide schema names the action, the management-only
 * schema has no discriminator and is terminal exactly when the head removes
 * itself — the same rule `manage` enforces.
 */
export function isTerminalHydraCall(armName, args, observingHead) {
	if (typeof args !== "object" || args === null) return false;
	const arm = actingArm(armName);
	if (arm.schema === "wide" && args.action === "complete_observation") return true;
	if (arm.schema === "wide" && args.action !== "manage_heads") return false;
	return args.operation === "remove" && typeof args.head === "string" && args.head.trim() === observingHead;
}

// ---------------------------------------------------------------------------
// Corpus. Four cases verbatim from completion-acting-ab.mjs:140-228 (the
// corpus the channel work used) plus two multi-operation re-crewing cases
// adapted from envelope-acting-ab.mjs:432-481.
// ---------------------------------------------------------------------------

const docsLens = `PURPOSE: Maintain docs/notes.md as durable memory for future work.
ACT WHEN: The trajectory establishes a new project decision or constraint that
is not already recorded.
WORK: Read docs/notes.md and add exactly one one-line entry. Edit nothing else.
DONE WHEN: The decision is recorded once.
DELIVER: The file is the work product; send no feedback.`;

const tunerLens = `PURPOSE: Improve other heads from the user's reactions.
ACT WHEN: The user dismisses, contradicts, or ignores another head's finding.
WORK: Sharpen that head's file by adding one clear boundary. Edit at most one
head and never your own.
DONE WHEN: The edited head excludes the rejected kind of finding.
DELIVER: Print the edit after changing a file; otherwise send no feedback.`;

const foremanLens = `PURPOSE: Keep the active heads matched to the work at hand.
ACT WHEN: The current phase or risks are not fully covered by the active heads,
or the foreman itself is no longer relevant.
WORK: Add fitting heads and remove irrelevant heads. Make the smallest crew
change that covers the trajectory.
DONE WHEN: The active heads cover current risks without irrelevant heads.
DELIVER: Make every real crew change visible with its reason; otherwise send no
feedback.`;

function write(root, path, content) {
	const absolute = join(root, path);
	mkdirSync(join(absolute, ".."), { recursive: true });
	writeFileSync(absolute, content);
}

function installHeads(root, names) {
	for (const name of names) {
		write(
			root,
			`.pi/hydra/${name}.md`,
			`---\nname: ${name}\ndescription: ${name} review\ntools: []\n---\nReview through a ${name} lens.\n`,
		);
	}
}

export const ACTING_CASES = [
	{
		id: "docs-write-none",
		head: "docs-keeper",
		lens: docsLens,
		tools: ["read", "write", "edit", "ls"],
		afterChange: "noop",
		active: ["docs-keeper"],
		available: ["docs-keeper"],
		setup(root) {
			write(root, "docs/notes.md", "# Decisions\n");
		},
		trajectory: [
			["user", "Keep API retries at three and use exponential backoff. Implement that decision."],
			["assistant", "Implemented the retry policy and the integration tests pass."],
		],
		evaluate(run) {
			const notes = run.filesAfter["docs/notes.md"] ?? "";
			return (
				/three|3/i.test(notes) &&
				/exponential/i.test(notes) &&
				run.changedFiles.join(",") === "docs/notes.md" &&
				run.action === "noop"
			);
		},
	},
	{
		id: "tuner-edit-print",
		head: "tuner",
		lens: tunerLens,
		tools: ["read", "write", "edit", "ls"],
		afterChange: "print",
		active: ["tuner"],
		available: ["tuner", "security"],
		setup(root) {
			write(
				root,
				"heads/security.md",
				"Review security risks including auth, injection, data exposure, naming, and style.\n",
			);
			write(root, "heads/tuner.md", tunerLens);
		},
		trajectory: [
			["assistant", "[security] Rename parseToken to validateToken; the current name is misleading."],
			["user", "That is not a security issue. Stop raising naming and style comments from the security head."],
			["assistant", "Understood. I left the implementation unchanged."],
		],
		evaluate(run) {
			const security = run.filesAfter["heads/security.md"] ?? "";
			const narrowed = /naming|style/i.test(security) && /not|never|do not|avoid|exclude|ignore/i.test(security);
			return narrowed && run.changedFiles.join(",") === "heads/security.md" && run.action === "print";
		},
	},
	{
		id: "foreman-add-security",
		head: "foreman",
		lens: foremanLens,
		tools: ["hydra", "read"],
		afterChange: undefined,
		active: ["foreman", "quality"],
		available: ["foreman", "quality", "security", "api-design"],
		setup(root) {
			installHeads(root, ["foreman", "quality", "security", "api-design"]);
		},
		trajectory: [
			[
				"user",
				"Implementation of authentication and session handling starts now. Staff the active risks before coding.",
			],
			["assistant", "I am beginning the authentication implementation."],
		],
		evaluate(run) {
			return (
				run.activeAfter.includes("security") &&
				run.receipts.length >= 1 &&
				(run.action === "noop" || run.action === "print")
			);
		},
	},
	{
		id: "foreman-self-remove",
		head: "foreman",
		lens: foremanLens,
		tools: ["hydra", "read"],
		afterChange: undefined,
		active: ["foreman", "quality"],
		available: ["foreman", "quality", "security"],
		setup(root) {
			installHeads(root, ["foreman", "quality", "security"]);
		},
		trajectory: [
			[
				"user",
				"Staffing is complete. Keep quality active, remove the foreman itself, and make no other crew changes.",
			],
			["assistant", "The implementation phase can continue with quality alone."],
		],
		evaluate(run) {
			return (
				!run.activeAfter.includes("foreman") &&
				run.activeAfter.includes("quality") &&
				run.selfRemoved &&
				run.receipts.length === 1
			);
		},
	},
	// Multi-operation re-crewing: the four-case corpus never asks for an add and
	// a remove in one observation. Delivery is scored as `foreman-add-security`
	// scores it — the envelope tells the head its crew change already prints its
	// own receipt, so demanding a second print would score the head for
	// disobeying the contract under test.
	{
		id: "foreman-clean-recrew",
		head: "foreman",
		lens: foremanLens,
		tools: ["hydra", "read"],
		afterChange: undefined,
		active: ["quality", "security"],
		available: ["quality", "security", "api-design", "simplifier"],
		setup(root) {
			installHeads(root, ["quality", "security", "api-design", "simplifier"]);
		},
		trajectory: [
			[
				"user",
				"Coding is complete. Review backward compatibility of the CLI contract and remove unnecessary abstractions before release. The change has no auth, secrets, or data-handling surface.",
			],
			["assistant", "I am starting the release review."],
		],
		evaluate(run) {
			const active = [...run.activeAfter].sort().join(",");
			return (
				active === ["api-design", "quality", "simplifier"].sort().join(",") &&
				(run.action === "noop" || run.action === "print")
			);
		},
	},
	{
		id: "foreman-two-uncovered-risks",
		head: "foreman",
		lens: foremanLens,
		tools: ["hydra", "read"],
		afterChange: undefined,
		active: ["quality"],
		available: ["quality", "accessibility", "localization"],
		setup(root) {
			installHeads(root, ["quality", "accessibility", "localization"]);
		},
		trajectory: [
			[
				"user",
				"The UI implementation is complete. Before release, review keyboard and screen-reader behavior plus pluralization and string expansion in every locale.",
			],
			["assistant", "I am beginning the final UI review."],
		],
		evaluate(run) {
			return (
				["accessibility", "localization"].every((name) => run.activeAfter.includes(name)) &&
				(run.action === "noop" || run.action === "print")
			);
		},
	},
];

export function selectActingCases(requested) {
	if (requested.length === 0) return ACTING_CASES;
	const selected = ACTING_CASES.filter((testCase) => requested.includes(testCase.id));
	if (selected.length !== requested.length) throw new Error(`unknown case in: ${requested.join(",")}`);
	return selected;
}

function isAfterChangeRetry(event) {
	return event.isError === true && /requires delivery/.test(event.text ?? "");
}

/**
 * An excursion is a tool call the head should not have made: any errored call
 * (an unavailable tool, a denied capability, a rejected argument shape) or a
 * call to a name outside the head's allowlist. This is the metric that
 * discriminates F, because an acting head cannot be told the tools are the
 * driver's — it really has them — and one un-denied observation historically
 * burned nine provider turns (`TOOL-FREE:213-218`).
 *
 * After-change rejections are excluded and counted separately. They are the
 * typed arm's enforcement mechanism, not a wrong turn, and folding them in
 * would inflate T on the exact metric S1 uses to kill F.
 */
export function excursionsOf(events, testCase) {
	const allowed = new Set([...testCase.tools, "hydra"]);
	return events.filter((event) => (event.isError && !isAfterChangeRetry(event)) || !allowed.has(event.name)).length;
}

export function afterChangeRetriesOf(events) {
	return events.filter(isAfterChangeRetry).length;
}

/**
 * Tool-call events must be captured from the loop's emitted
 * tool_execution_start/end pairs, not from the afterToolCall hook: that hook
 * fires only for prepared (non-immediate) executions, so tool-not-found,
 * beforeToolCall blocks, and argument-validation failures never reach it —
 * three of the four excursion classes. emitToolExecutionEnd fires on every
 * branch, including truncation. Joined on toolCallId because the end event
 * carries no args.
 */
export function createToolEventCollector(events) {
	const argsById = new Map();
	return async (event) => {
		if (event?.type === "tool_execution_start") {
			argsById.set(event.toolCallId, event.args);
			return;
		}
		if (event?.type !== "tool_execution_end") return;
		events.push({
			name: event.toolName,
			args: argsById.get(event.toolCallId) ?? {},
			isError: event.isError === true,
			text: (event.result?.content ?? [])
				.filter((block) => block?.type === "text")
				.map((block) => block.text)
				.join(""),
		});
	};
}
