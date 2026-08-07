#!/usr/bin/env node
/**
 * Paired A/B for the review-focused and generalized split envelopes on
 * acting heads. Each arm gets a fresh real workspace and pi's real file tools.
 * The hydra tool is a functional test implementation of the extension's
 * add/remove contract because active-head state only exists inside a live
 * extension instance.
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runAgentLoop, uuidv7 } from "@earendil-works/pi-agent-core";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { getModel } from "@earendil-works/pi-ai/compat";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
	createEditTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { applyAfterChangeDelivery, buildObservationEnvelope, buildObservationPrompt, parseDecision, parseHeadFile } from "../../utils.ts";
import {
	buildActingContractObservationEnvelope,
	buildDeliveryOwnedObservationEnvelope,
	buildEvidenceGatedObservationEnvelope,
	buildEvidenceGatedObservationPrompt,
	buildForwardDeveloperObservationEnvelope,
	buildForwardUserObservationEnvelope,
	buildGeneralObservationEnvelope,
	buildGuardedPolicyObservationEnvelope,
	buildInterventionGatedObservationEnvelope,
	buildPolicyOwnedObservationEnvelope,
	buildProtocolOnlyObservationEnvelope,
} from "./envelope-variants.mjs";
import { argOf } from "../lib.mjs";

const args = process.argv.slice(2);
const outputPath = argOf(args, "--output", "");
const samples = Number.parseInt(argOf(args, "--samples", "3"), 10);
const reasoning = argOf(args, "--thinking", "low");
const requestedModels = argOf(args, "--models", "luna,terra,sol").split(",");
const requestedArms = argOf(args, "--arms", "review,general").split(",");
const requestedCases = argOf(args, "--cases", "").split(",").filter(Boolean);
if (!outputPath) throw new Error("--output is required");
if (!Number.isInteger(samples) || samples < 1) throw new Error("--samples must be a positive integer");
if (requestedArms.some((arm) => !["review", "general", "policy", "delivery", "guarded", "protocol", "intervention", "combined", "developer-head", "developer-user", "acting-contract", "structured-heads", "structured-combined", "structured-typed", "final-candidate", "split-final", "split-final2", "split-final3", "combined-final3", "combined-final3-snapshot", "evidence", "combined-evidence", "combined-clear"].includes(arm))) throw new Error(`unknown arm: ${requestedArms.join(",")}`);

const modelSpecs = {
	sonnet: { provider: "anthropic", id: "claude-sonnet-5" },
	opus: { provider: "anthropic", id: "claude-opus-4-8" },
	fable: { provider: "anthropic", id: "claude-fable-5" },
	luna: { provider: "openai-codex", id: "gpt-5.6-luna" },
	terra: { provider: "openai-codex", id: "gpt-5.6-terra" },
	sol: { provider: "openai-codex", id: "gpt-5.6-sol" },
};
for (const name of requestedModels) {
	if (!(name in modelSpecs)) throw new Error(`unknown model ${name}`);
}

const auth = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/auth.json`, "utf8"));
for (const provider of new Set(requestedModels.map((name) => modelSpecs[name].provider))) {
	if (!auth[provider]?.access || auth[provider].expires < Date.now()) {
		throw new Error(`missing or expired ${provider} login; run pi and log in first`);
	}
}

const docsInstruction = `You maintain docs/notes.md. When the conversation contains a decision,
constraint, or surprise not yet in the file, read it, add the missing
entry, and keep entries one line each. Your decision is usually noop:
the file is your work product. Do not edit anything else.`;

const durableDocsInstruction = `You maintain docs/notes.md as durable project memory. Review only the
driver trajectory; this instruction is policy, not content to record. Add
one one-line entry only when the trajectory establishes new information that
should guide a future session: a decision, constraint, or unexpected fact
that changes future work. Ignore transient execution status, routine
confirmations that existing behavior still works, and information already
present. Your decision is noop: the file is your work product. Do not edit
anything else.`;

const structuredDocsInstruction = `PURPOSE: Maintain docs/notes.md as durable memory for future work.
ACT WHEN: The driver trajectory establishes a new decision, constraint, or
unexpected fact that will materially guide future work and is not already
recorded.
WORK: Read docs/notes.md and add exactly one one-line entry. Edit nothing else.
DELIVER: Noop; the file is the work product.`;

const finalDocsInstruction = `PURPOSE: Maintain docs/notes.md as durable memory for future work.
ACT WHEN: The driver trajectory establishes previously unrecorded information
that a future session must know to make the right implementation or planning
decision.
WORK: Read docs/notes.md and add exactly one one-line entry. Edit nothing else.
DELIVER: Noop; the file is the work product.`;

const narrowDocsInstruction = `PURPOSE: Maintain docs/notes.md as durable memory for future work.
ACT WHEN: The driver trajectory establishes a new project decision or
constraint that is not already recorded.
WORK: Read docs/notes.md and add exactly one one-line entry. Edit nothing else.
DELIVER: Noop; the file is the work product.`;

// The shipped tuner points at the user's global head directory. This
// semantically identical fixture points at the isolated test workspace.
const tunerInstruction = `You maintain the head files in heads/. When the user dismisses,
contradicts, or ignores another head's finding, sharpen that head's file:
narrow its focus, add a boundary, shorten its instruction. When the user
acts on a finding, leave the head alone. Edit one head per observation at
most, and never edit your own file. Print the edit you made; otherwise
noop.`;

const structuredTunerInstruction = `PURPOSE: Improve other heads from the user's reactions to their findings.
ACT WHEN: The user dismisses, contradicts, or ignores another head's finding.
WORK: Sharpen that head's file by narrowing its focus, adding a boundary, or
shortening its instruction. Edit at most one head and never your own.
DONE WHEN: The edited head excludes the kind of finding the user rejected.
DELIVER: Print the edit you made; noop when the act condition is not met.`;

const finalTunerInstruction = `PURPOSE: Maintain the other head files in heads/ from the user's reactions to their findings.
ACT WHEN: The user dismisses, contradicts, or ignores another head's finding.
WORK: Sharpen that head's file by narrowing its focus, adding a boundary, or
shortening its instruction. Edit at most one head and never your own.
DONE WHEN: The edited head excludes the kind of finding the user rejected.
DELIVER: Print the edit you made; noop when the act condition is not met.`;

// Frozen pre-change control; do not read the shipped file or the baseline
// silently turns into the treatment after implementation.
const foremanInstruction = `You manage which heads observe this session. Early in the session, infer
what the work is (designing, implementing, reviewing, debugging) and staff
accordingly: add heads that fit the phase, remove ones that do not, and
write a new head file when no existing head covers a risk you see coming.
When the work shifts phase, re-crew. Print the change and the reason
whenever you re-crew; otherwise noop.`;

const structuredForemanInstruction = `PURPOSE: Keep the active heads matched to the work at hand.
ACT WHEN: The current phase or risks are not fully covered by the active heads.
WORK: Add fitting heads, remove irrelevant heads, and write then activate a new
head when no existing head covers a current risk.
DONE WHEN: The active heads cover every current phase and risk without
irrelevant heads.
DELIVER: Print the crew change and reason after re-crewing; otherwise noop.`;

const cases = [
	{
		id: "docs-new-decision",
		head: "docs-keeper",
		afterChange: "noop",
		instruction: docsInstruction,
		tools: ["read", "write", "edit", "ls"],
		setup(root) {
			write(root, "docs/notes.md", "# Decisions\n");
		},
		trajectory: [
			["user", "Keep API retries at three and use exponential backoff. Please implement that decision."],
			["assistant", "Implemented the retry policy and the integration tests pass."],
		],
		evaluate(run) {
			const notes = run.filesAfter["docs/notes.md"] ?? "";
			const recorded = /three|3/i.test(notes) && /exponential/i.test(notes);
			return {
				correct: recorded && run.changedFiles.join(",") === "docs/notes.md" && run.action === "noop",
				reason: `recorded=${recorded}; changed=${run.changedFiles.join(",") || "none"}; action=${run.action}`,
			};
		},
	},
	{
		id: "docs-duplicate",
		head: "docs-keeper",
		afterChange: "noop",
		instruction: docsInstruction,
		tools: ["read", "write", "edit", "ls"],
		setup(root) {
			write(root, "docs/notes.md", "# Decisions\n- API retries: three with exponential backoff.\n");
		},
		trajectory: [
			["user", "Keep API retries at three and use exponential backoff. Please implement that decision."],
			["assistant", "Implemented the retry policy and the integration tests pass."],
		],
		evaluate(run) {
			return {
				correct: run.changedFiles.length === 0 && run.action === "noop",
				reason: `changed=${run.changedFiles.join(",") || "none"}; action=${run.action}`,
			};
		},
	},
	{
		id: "docs-no-new-information",
		head: "docs-keeper",
		afterChange: "noop",
		instruction: docsInstruction,
		tools: ["read", "write", "edit", "ls"],
		setup(root) {
			write(root, "docs/notes.md", "# Decisions\n- API retries: three with exponential backoff.\n");
		},
		trajectory: [
			["user", "Run the existing retry integration tests."],
			["assistant", "All existing retry integration tests pass; no changes were needed."],
		],
		evaluate(run) {
			return {
				correct: run.changedFiles.length === 0 && run.action === "noop",
				reason: `changed=${run.changedFiles.join(",") || "none"}; action=${run.action}`,
			};
		},
	},
	{
		id: "tuner-dismissed-finding",
		head: "tuner",
		afterChange: "print",
		instruction: tunerInstruction,
		tools: ["read", "write", "edit", "ls"],
		setup(root) {
			write(root, "heads/security.md", "Review security risks including auth, injection, data exposure, and trust boundaries.\n");
			write(root, "heads/tuner.md", tunerInstruction);
		},
		trajectory: [
			["assistant", "[security] Rename parseToken to validateToken; the current name is misleading."],
			["user", "That is not a security issue. Please stop raising naming and style comments from the security head."],
			["assistant", "Understood. I left the implementation unchanged."],
		],
		evaluate(run) {
			const security = run.filesAfter["heads/security.md"] ?? "";
			const narrowed = /naming|style/i.test(security) && /not|do not|avoid|exclude|only/i.test(security);
			return {
				correct: narrowed && run.changedFiles.join(",") === "heads/security.md" && run.action === "print",
				reason: `narrowed=${narrowed}; changed=${run.changedFiles.join(",") || "none"}; action=${run.action}`,
			};
		},
	},
	{
		id: "tuner-accepted-finding",
		head: "tuner",
		afterChange: "print",
		instruction: tunerInstruction,
		tools: ["read", "write", "edit", "ls"],
		setup(root) {
			write(root, "heads/security.md", "Review security risks including auth, injection, data exposure, and trust boundaries.\n");
			write(root, "heads/tuner.md", tunerInstruction);
		},
		trajectory: [
			["assistant", "[security] Compare webhook signatures in constant time to avoid timing leakage."],
			["user", "Good catch. Please fix it."],
			["assistant", "Replaced the equality check with timingSafeEqual and added a regression test."],
		],
		evaluate(run) {
			return {
				correct: run.changedFiles.length === 0 && run.action === "noop",
				reason: `changed=${run.changedFiles.join(",") || "none"}; action=${run.action}`,
			};
		},
	},
	{
		id: "foreman-phase-shift",
		head: "foreman",
		afterChange: "print",
		instruction: foremanInstruction,
		tools: ["hydra", "read", "write"],
		activeHeads: ["quality", "security"],
		availableHeads: ["quality", "security", "api-design", "simplifier"],
		setup(root) {
			for (const name of ["quality", "security", "api-design", "simplifier"]) {
				write(root, `.pi/hydra/${name}.md`, `---
name: ${name}
description: ${name} review
tools: []
---
Review through a ${name} lens.
`);
			}
		},
		trajectory: [
			["user", "Implementation is finished. Before the PR, review API compatibility and simplify the public surface."],
			["assistant", "I am beginning the final review now."],
		],
		evaluate(run) {
			const relevant = run.activeAfter.includes("api-design") && run.activeAfter.includes("simplifier");
			return {
				correct: relevant && run.action === "print",
				reason: `active=${run.activeAfter.join(",")}; action=${run.action}`,
			};
		},
	},
	{
		id: "foreman-stable-crew",
		head: "foreman",
		afterChange: "print",
		instruction: foremanInstruction,
		tools: ["hydra", "read", "write"],
		activeHeads: ["quality", "security"],
		availableHeads: ["quality", "security", "api-design", "simplifier"],
		setup(root) {
			for (const name of ["quality", "security", "api-design", "simplifier"]) {
				write(root, `.pi/hydra/${name}.md`, `---
name: ${name}
description: ${name} review
tools: []
---
Review through a ${name} lens.
`);
			}
		},
		trajectory: [
			["user", "Continue fixing the internal constant-time token comparison and its failure-path tests. There are no public API or contract changes."],
			["assistant", "The internal security fix is in progress; quality and security are the active concerns."],
		],
		evaluate(run) {
			return {
				correct: run.activeAfter.join(",") === "quality,security" && run.action === "noop",
				reason: `active=${run.activeAfter.join(",")}; action=${run.action}`,
			};
		},
	},
	{
		id: "foreman-new-head",
		head: "foreman",
		afterChange: "print",
		instruction: foremanInstruction,
		tools: ["hydra", "read", "write"],
		activeHeads: ["quality", "security"],
		availableHeads: ["quality", "security"],
		setup(root) {
			for (const name of ["quality", "security"]) {
				write(root, `.pi/hydra/${name}.md`, `---
name: ${name}
description: ${name} review
tools: []
---
Review through a ${name} lens.
`);
			}
		},
		trajectory: [
			["user", "Implementation is finished. Before the PR, we discovered that request logs now retain customer IP addresses. Add privacy and retention coverage; none of the available heads covers it."],
			["assistant", "I am beginning the final review now."],
		],
		evaluate(run) {
			const created = run.changedFiles
				.filter((path) => path.startsWith(".pi/hydra/") && run.filesBefore[path] === undefined)
				.map((path) => ({ path, parsed: parseHeadFile(run.filesAfter[path] ?? "") }))
				.filter((entry) => "head" in entry.parsed);
			const relevant = created.find((entry) => {
				const definition = entry.parsed.head;
				return /privacy|retention|personal data|pii/i.test(`${definition.description}\n${definition.prompt}`)
					&& run.activeAfter.includes(definition.name);
			});
			return {
				correct: created.length === 1 && relevant !== undefined && run.action === "print",
				reason: `created=${created.map((entry) => entry.path).join(",") || "none"}; relevant=${relevant?.parsed.head.name ?? "none"}; active=${run.activeAfter.join(",")}; action=${run.action}`,
			};
		},
	},
	// Held-out cases added only after the structured-typed candidate was
	// frozen. They exercise new subject matter and stricter completion, not
	// wording the candidate saw during discovery.
	{
		id: "docs-transient-check",
		head: "docs-keeper",
		afterChange: "noop",
		instruction: docsInstruction,
		tools: ["read", "write", "edit", "ls"],
		setup(root) {
			write(root, "docs/notes.md", "# Decisions\n- Runtime support starts at Node.js 20.\n");
		},
		trajectory: [
			["user", "Run the existing Node.js 20 build and compatibility checks."],
			["assistant", "The existing checks pass; no code or configuration changes were needed."],
		],
		evaluate(run) {
			return {
				correct: run.changedFiles.length === 0 && run.action === "noop",
				reason: `changed=${run.changedFiles.join(",") || "none"}; action=${run.action}`,
			};
		},
	},
	{
		id: "docs-unexpected-durable-fact",
		head: "docs-keeper",
		afterChange: "noop",
		instruction: docsInstruction,
		tools: ["read", "write", "edit", "ls"],
		setup(root) {
			write(root, "docs/notes.md", "# Decisions\n");
		},
		trajectory: [
			["user", "Implement the provider integration."],
			["assistant", "During integration I discovered the provider enforces a 20 requests-per-second limit, so I added a shared rate limiter and tests."],
		],
		evaluate(run) {
			const notes = run.filesAfter["docs/notes.md"] ?? "";
			const recorded = /20|twenty/i.test(notes) && /rate|request/i.test(notes);
			return {
				correct: recorded && run.changedFiles.join(",") === "docs/notes.md" && run.action === "noop",
				reason: `recorded=${recorded}; changed=${run.changedFiles.join(",") || "none"}; action=${run.action}`,
			};
		},
	},
	{
		id: "tuner-dismissed-scope-finding",
		head: "tuner",
		afterChange: "print",
		instruction: tunerInstruction,
		tools: ["read", "write", "edit", "ls"],
		setup(root) {
			write(root, "heads/api-design.md", "Review API contracts, compatibility, consistency, naming, and ergonomics.\n");
			write(root, "heads/tuner.md", tunerInstruction);
		},
		trajectory: [
			["assistant", "[api-design] Rename the private loop variable `i` to `itemIndex` for clarity."],
			["user", "That private implementation detail is not API design. Keep this head to externally visible contracts."],
			["assistant", "Understood. I left the private variable unchanged."],
		],
		evaluate(run) {
			const apiDesign = run.filesAfter["heads/api-design.md"] ?? "";
			const narrowed = /private|internal|externally visible|public/i.test(apiDesign)
				&& /not|do not|avoid|exclude|ignore|only/i.test(apiDesign);
			return {
				correct: narrowed && run.changedFiles.join(",") === "heads/api-design.md" && run.action === "print",
				reason: `narrowed=${narrowed}; changed=${run.changedFiles.join(",") || "none"}; action=${run.action}`,
			};
		},
	},
	{
		id: "foreman-clean-recrew",
		head: "foreman",
		afterChange: "print",
		instruction: foremanInstruction,
		tools: ["hydra", "read", "write"],
		activeHeads: ["quality", "security"],
		availableHeads: ["quality", "security", "api-design", "simplifier"],
		setup(root) {
			for (const name of ["quality", "security", "api-design", "simplifier"]) {
				write(root, `.pi/hydra/${name}.md`, `---\nname: ${name}\ndescription: ${name} review\ntools: []\n---\nReview through a ${name} lens.\n`);
			}
		},
		trajectory: [
			["user", "Coding is complete. Review backward compatibility of the CLI contract and remove unnecessary abstractions before release. The change has no auth, secrets, or data-handling surface."],
			["assistant", "I am starting the release review."],
		],
		evaluate(run) {
			const active = [...run.activeAfter].sort().join(",");
			const expected = ["api-design", "quality", "simplifier"].sort().join(",");
			return {
				correct: active === expected && run.action === "print",
				reason: `active=${run.activeAfter.join(",")}; action=${run.action}`,
			};
		},
	},
	{
		id: "foreman-two-uncovered-risks",
		head: "foreman",
		afterChange: "print",
		instruction: foremanInstruction,
		tools: ["hydra", "read", "write"],
		activeHeads: ["quality"],
		availableHeads: ["quality", "accessibility", "localization"],
		setup(root) {
			for (const name of ["quality", "accessibility", "localization"]) {
				write(root, `.pi/hydra/${name}.md`, `---\nname: ${name}\ndescription: ${name} review\ntools: []\n---\nReview through a ${name} lens.\n`);
			}
		},
		trajectory: [
			["user", "The UI implementation is complete. Before release, review keyboard and screen-reader behavior plus pluralization and string expansion in every locale."],
			["assistant", "I am beginning the final UI review."],
		],
		evaluate(run) {
			const complete = ["accessibility", "localization"].every((name) => run.activeAfter.includes(name));
			return {
				correct: complete && run.action === "print",
				reason: `active=${run.activeAfter.join(",")}; action=${run.action}`,
			};
		},
	},
];
const selectedCases = requestedCases.length === 0 ? cases : cases.filter((testCase) => requestedCases.includes(testCase.id));
if (selectedCases.length !== (requestedCases.length || cases.length)) {
	throw new Error(`unknown case in: ${requestedCases.join(",")}`);
}

function write(root, path, content) {
	const absolute = join(root, path);
	mkdirSync(join(absolute, ".."), { recursive: true });
	writeFileSync(absolute, content);
}

function snapshot(root) {
	const result = {};
	function visit(directory) {
		for (const name of readdirSync(directory)) {
			const absolute = join(directory, name);
			if (statSync(absolute).isDirectory()) visit(absolute);
			else result[relative(root, absolute)] = readFileSync(absolute, "utf8");
		}
	}
	visit(root);
	return result;
}

function assistant(text, model) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function trajectoryMessages(trajectory, model) {
	return trajectory.map(([role, text]) => role === "assistant"
		? assistant(text, model)
		: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
}

function textOf(message) {
	return (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
}

function itemText(item) {
	return (item?.content ?? [])
		.filter((block) => block?.type === "input_text")
		.map((block) => block.text)
		.join("");
}

function refreshAvailableHeads(root, state) {
	const directory = join(root, ".pi/hydra");
	if (!existsSync(directory)) return;
	for (const filename of readdirSync(directory)) {
		if (!filename.endsWith(".md")) continue;
		const parsed = parseHeadFile(readFileSync(join(directory, filename), "utf8"));
		if ("head" in parsed && !state.available.includes(parsed.head.name)) state.available.push(parsed.head.name);
	}
}

function hydraTool(root, state) {
	return {
		name: "hydra",
		label: "Hydra",
		description: `Point hydra heads. Add or remove is idempotent. Heads are markdown files in .pi/hydra with name and description frontmatter, optional tools frontmatter, and an instruction body. Files are re-discovered on every call: write a missing head, then add it. Available heads: ${state.available.join(", ")}.`,
		parameters: Type.Object({
			action: StringEnum(["add", "remove"]),
			head: Type.String(),
		}),
		async execute(_id, params) {
			refreshAvailableHeads(root, state);
			const name = params.head.trim();
			const activeLabel = () => state.active.join(", ") || "none";
			if (!state.available.includes(name)) {
				return { content: [{ type: "text", text: `Unknown head "${name}". Available: ${state.available.join(", ")}.` }], details: {} };
			}
			if (params.action === "add") {
				if (state.active.includes(name)) {
					return { content: [{ type: "text", text: `"${name}" is already active. Observing with: ${activeLabel()}.` }], details: {} };
				}
				state.active.push(name);
			} else {
				if (!state.active.includes(name)) {
					return { content: [{ type: "text", text: `"${name}" is not active. Observing with: ${activeLabel()}.` }], details: {} };
				}
				state.active = state.active.filter((head) => head !== name);
			}
			return { content: [{ type: "text", text: `Observing with: ${activeLabel()}.` }], details: {} };
		},
	};
}

function toolsFor(root, names, state) {
	const tools = [
		createReadTool(root),
		createWriteTool(root),
		createEditTool(root),
		createLsTool(root),
		hydraTool(root, state),
	];
	return tools.filter((tool) => names.includes(tool.name));
}

const completed = new Set();
if (existsSync(outputPath)) {
	for (const line of readFileSync(outputPath, "utf8").trim().split("\n").filter(Boolean)) {
		const row = JSON.parse(line);
		completed.add(`${row.model}/${row.case}/${row.sample}/${row.arm}`);
	}
}

async function runOne(modelName, testCase, sample, arm) {
	const spec = modelSpecs[modelName];
	const model = getModel(spec.provider, spec.id);
	if (!model) throw new Error(`unknown model ${spec.provider}/${spec.id}`);
	const root = mkdtempSync(join(tmpdir(), `hydra-envelope-${modelName}-${testCase.id}-${sample}-${arm}-`));
	testCase.setup(root);
	const filesBefore = snapshot(root);
	const state = {
		active: [...(testCase.activeHeads ?? [])],
		available: [...(testCase.availableHeads ?? [])],
	};
	const rawInstruction = testCase.instruction;
	const structuredInstruction = testCase.head === "docs-keeper"
		? structuredDocsInstruction
		: testCase.head === "tuner"
			? structuredTunerInstruction
			: structuredForemanInstruction;
	const finalInstruction = testCase.head === "tuner" ? finalTunerInstruction : structuredInstruction;
	const finalInstruction2 = testCase.head === "docs-keeper" ? finalDocsInstruction : finalInstruction;
	const finalInstruction3 = testCase.head === "docs-keeper" ? narrowDocsInstruction : finalInstruction;
	const effectiveInstruction = arm === "combined-clear" && testCase.head === "docs-keeper"
		? durableDocsInstruction
		: arm === "split-final3" || arm === "combined-final3" || arm === "combined-final3-snapshot"
			? finalInstruction3
		: arm === "split-final2"
			? finalInstruction2
		: arm === "final-candidate" || arm === "split-final"
			? finalInstruction
		: arm === "structured-heads" || arm === "structured-combined" || arm === "structured-typed"
			? structuredInstruction
			: rawInstruction;
	let promptText = arm === "combined-final3" || arm === "combined-final3-snapshot"
		? buildObservationPrompt(testCase.head, effectiveInstruction, testCase.tools, {
			afterChange: testCase.afterChange,
			activeHeads: arm === "combined-final3-snapshot" ? (testCase.activeHeads ?? []) : undefined,
		})
		: arm === "combined" || arm === "structured-combined" || arm === "structured-typed" || arm === "final-candidate"
			? buildObservationPrompt(testCase.head, effectiveInstruction, testCase.tools)
		: arm === "combined-evidence"
			? buildEvidenceGatedObservationPrompt(testCase.head, rawInstruction, testCase.tools)
		: arm === "combined-clear"
				? buildObservationPrompt(testCase.head, effectiveInstruction, testCase.tools)
				: effectiveInstruction;
	if (arm === "final-candidate" && testCase.tools.includes("hydra")) {
		const lensMarker = `\n\nLENS: ${effectiveInstruction}`;
		if (!promptText.includes(lensMarker)) throw new Error("combined prompt lost its lens marker");
		const active = (testCase.activeHeads ?? []).join(", ") || "none";
		promptText = promptText.replace(
			lensMarker,
			`\n\nHYDRA SNAPSHOT: Active heads when this observation began: ${active}. Later hydra tool results supersede this snapshot.${lensMarker}`,
		);
	}
	const envelope = arm === "general"
		? buildGeneralObservationEnvelope(testCase.head, testCase.tools)
		: arm === "split-final" || arm === "split-final2" || arm === "split-final3"
			? buildObservationEnvelope(testCase.head, testCase.tools, {
				afterChange: testCase.afterChange,
				activeHeads: testCase.activeHeads ?? [],
			})
		: arm === "acting-contract"
			? buildActingContractObservationEnvelope(testCase.head, testCase.tools)
		: arm === "developer-head"
			? buildForwardDeveloperObservationEnvelope(testCase.head, testCase.tools)
		: arm === "developer-user"
			? buildForwardUserObservationEnvelope(testCase.head, testCase.tools)
		: arm === "evidence"
			? buildEvidenceGatedObservationEnvelope(testCase.head, testCase.tools)
		: arm === "policy"
			? buildPolicyOwnedObservationEnvelope(testCase.head, testCase.tools)
			: arm === "delivery"
				? buildDeliveryOwnedObservationEnvelope(testCase.head, testCase.tools)
				: arm === "guarded"
					? buildGuardedPolicyObservationEnvelope(testCase.head, testCase.tools)
					: arm === "protocol"
						? buildProtocolOnlyObservationEnvelope(testCase.head, testCase.tools)
						: arm === "intervention"
							? buildInterventionGatedObservationEnvelope(testCase.head, testCase.tools)
							: buildObservationEnvelope(testCase.head, testCase.tools);
	const prompt = { role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() };
	const events = [];
	const sessionId = spec.provider === "openai-codex" ? uuidv7() : undefined;
	let providerCalls = 0;
	let payloadRoles = [];
	let firstPayloadRoles = [];
	const started = performance.now();
	try {
		const messages = await runAgentLoop(
			[prompt],
			{
				systemPrompt: `You are pi, a coding agent. The working directory is ${root}.`,
				messages: trajectoryMessages(testCase.trajectory, model),
				tools: toolsFor(root, testCase.tools, state),
			},
			{
				model,
				apiKey: auth[spec.provider].access,
				maxTokens: 1600,
				reasoning,
				sessionId,
				transport: spec.provider === "openai-codex" ? "websocket" : undefined,
				convertToLlm: (messages) => messages,
				shouldStopAfterTurn: ({ newMessages }) => newMessages.filter((message) => message.role === "assistant").length >= 8,
				onPayload: (body) => {
					providerCalls++;
					if (spec.provider === "anthropic") {
						if (arm !== "combined-final3" && arm !== "combined-final3-snapshot" && arm !== "combined") {
							throw new Error(`arm ${arm} is not implemented for Anthropic acting-head runs`);
						}
						const messages = body.messages;
						const promptFound = messages.some(
							(message) =>
								message?.role === "user" &&
								(message.content ?? []).some((block) => block?.type === "text" && block.text === promptText),
						);
						if (!promptFound) throw new Error("serialized head instruction not found");
						payloadRoles = messages.slice(-8).map((message) => message?.role ?? "?");
						if (firstPayloadRoles.length === 0) firstPayloadRoles = [...payloadRoles];
						return body;
					}
					const input = structuredClone(body.input);
					const promptIndex = input.findIndex((item) => item?.role === "user" && itemText(item) === promptText);
					if (promptIndex === -1) throw new Error("serialized head instruction not found");
					if (arm === "combined" || arm === "structured-combined" || arm === "structured-typed" || arm === "final-candidate" || arm === "combined-evidence" || arm === "combined-clear") {
						payloadRoles = input.slice(-8).map((item) => item?.role ?? item?.type ?? "?");
						if (firstPayloadRoles.length === 0) firstPayloadRoles = [...payloadRoles];
						return { ...body, input };
					}
					if (arm === "developer-head") {
						const headItem = { ...input[promptIndex], role: "developer" };
						input.splice(
							promptIndex,
							1,
							{
								type: "message",
								role: "developer",
								content: [{ type: "input_text", text: envelope }],
							},
							headItem,
						);
						payloadRoles = input.slice(-8).map((item) => item?.role ?? item?.type ?? "?");
						if (firstPayloadRoles.length === 0) firstPayloadRoles = [...payloadRoles];
						return { ...body, input };
					}
					if (arm === "developer-user") {
						input.splice(promptIndex, 0, {
							type: "message",
							role: "developer",
							content: [{ type: "input_text", text: envelope }],
						});
						payloadRoles = input.slice(-8).map((item) => item?.role ?? item?.type ?? "?");
						if (firstPayloadRoles.length === 0) firstPayloadRoles = [...payloadRoles];
						return { ...body, input };
					}
					input.splice(promptIndex + 1, 0, {
						type: "message",
						role: "developer",
						content: [{ type: "input_text", text: envelope }],
					});
					payloadRoles = input.slice(-8).map((item) => item?.role ?? item?.type ?? "?");
					if (firstPayloadRoles.length === 0) firstPayloadRoles = [...payloadRoles];
					return { ...body, input };
				},
			},
			(event) => {
				if (event.type === "tool_execution_start") {
					events.push({ name: event.toolName, args: event.args });
				}
			},
		);
		const response = [...messages].reverse().find((message) => message.role === "assistant");
		const responseText = textOf(response);
		const decision = parseDecision(responseText);
		const filesAfter = snapshot(root);
		const changedFiles = [...new Set([...Object.keys(filesBefore), ...Object.keys(filesAfter)])]
			.filter((path) => filesBefore[path] !== filesAfter[path])
			.sort();
		const stateChanged = changedFiles.length > 0 || state.active.join(",") !== (testCase.activeHeads ?? []).join(",");
		const deliveredDecision =
			(arm === "structured-typed" || arm === "final-candidate" || arm === "split-final" || arm === "split-final2" || arm === "split-final3" || arm === "combined-final3" || arm === "combined-final3-snapshot") && decision
				? applyAfterChangeDelivery(decision, testCase.afterChange, stateChanged)
				: decision;
		const run = {
			filesBefore,
			filesAfter,
			changedFiles,
			activeAfter: state.active,
			action: deliveredDecision?.action ?? null,
		};
		const evaluation = testCase.evaluate(run);
		const usage = messages
			.filter((message) => message.role === "assistant")
			.reduce((sum, message) => ({
				input: sum.input + (message.usage?.input ?? 0),
				output: sum.output + (message.usage?.output ?? 0),
				cacheRead: sum.cacheRead + (message.usage?.cacheRead ?? 0),
				cacheWrite: sum.cacheWrite + (message.usage?.cacheWrite ?? 0),
				cost: sum.cost + (message.usage?.cost?.total ?? 0),
			}), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
		return {
			model: modelName,
			modelId: model.id,
			provider: spec.provider,
			case: testCase.id,
			head: testCase.head,
			sample,
			arm,
			ms: Math.round(performance.now() - started),
			providerCalls,
			firstRoles: firstPayloadRoles.join(","),
			roles: payloadRoles.join(","),
			stop: response?.stopReason ?? null,
			error: response?.errorMessage ?? null,
			parseValid: decision !== null,
			action: deliveredDecision?.action ?? null,
			rawAction: decision?.action ?? null,
			stateChanged,
			response: responseText,
			toolCalls: events,
			filesBefore,
			filesAfter,
			changedFiles,
			activeBefore: testCase.activeHeads ?? [],
			activeAfter: state.active,
			correct: evaluation.correct,
			evaluation: evaluation.reason,
			usage,
			workdir: root,
		};
	} finally {
		if (sessionId) closeOpenAICodexWebSocketSessions(sessionId);
	}
}

const tasks = [];
for (const model of requestedModels) {
	for (const testCase of selectedCases) {
		for (let sample = 1; sample <= samples; sample++) tasks.push({ model, testCase, sample });
	}
}
for (let i = tasks.length - 1; i > 0; i--) {
	const j = Math.floor(Math.random() * (i + 1));
	[tasks[i], tasks[j]] = [tasks[j], tasks[i]];
}

console.error(`acting envelope sweep: ${tasks.length} cases / ${tasks.length * requestedArms.length} calls; ${completed.size} complete`);
for (const task of tasks) {
	const arms = [...requestedArms].sort(() => Math.random() - 0.5);
	for (const arm of arms) {
		const key = `${task.model}/${task.testCase.id}/${task.sample}/${arm}`;
		if (completed.has(key)) continue;
		try {
			const row = await runOne(task.model, task.testCase, task.sample, arm);
			appendFileSync(outputPath, `${JSON.stringify(row)}\n`);
			console.log(`${key}: ${row.correct ? "PASS" : "FAIL"} ${row.action ?? "INVALID"} ${row.providerCalls} calls ${row.ms}ms`);
		} catch (error) {
			const row = {
				model: task.model,
				case: task.testCase.id,
				head: task.testCase.head,
				sample: task.sample,
				arm,
				error: error instanceof Error ? error.message : String(error),
			};
			appendFileSync(outputPath, `${JSON.stringify(row)}\n`);
			console.error(`${key}: ERROR ${row.error}`);
		}
	}
}
