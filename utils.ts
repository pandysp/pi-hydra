/**
 * Pure helpers for hydra observations.
 * Extracted for testability; no pi or I/O dependencies.
 */

import type { DeliveryContext } from "./delivery-types";

// Where a head's finding ends up. noop: nowhere. print: shown to the user
// only. queue: waits for the run to end. steer: reaches the agent between
// turns. interrupt: reaches it now, cancelling whatever it was doing.
export const ACTIONS = ["noop", "print", "queue", "steer", "interrupt"] as const;
export type Action = (typeof ACTIONS)[number];
export const OBSERVATION_DELIVERIES = ["none", "print", "queue", "steer", "interrupt"] as const;
export type ObservationDelivery = (typeof OBSERVATION_DELIVERIES)[number];
export const HEAD_OPERATIONS = ["add", "remove"] as const;
export type HeadOperation = (typeof HEAD_OPERATIONS)[number];
export const AFTER_CHANGE_ACTIONS = ["noop", "print"] as const;
export type AfterChangeAction = (typeof AFTER_CHANGE_ACTIONS)[number];

/**
 * A head that decided to interrupt, based on a picture the agent has already
 * moved past, is downgraded to steering instead.
 *
 * The trade is deliberately lopsided. Downgrading when it was not needed costs
 * one turn of delay. Interrupting when it was not needed throws away work the
 * agent is in the middle of.
 */
export function demoteStaleInterrupt(action: Action, staleSnapshot: boolean): Action {
	return action === "interrupt" && staleSnapshot ? "steer" : action;
}

export interface Decision {
	action: Action;
	reason: string;
	message: string;
}

/**
 * Heads say `none`, the internals say `noop`. The two names exist because the
 * internal one came first and the public one reads better; they mean the same
 * thing.
 *
 * The message rules are enforced here rather than merely asked for in the
 * prompt: `none` must carry an empty message, and anything that is actually
 * delivered must carry a real one.
 */
export function decisionFromCompletion(delivery: ObservationDelivery, message: string): Decision {
	if (delivery === "none") {
		if (message !== "") {
			throw new Error('complete_observation with delivery "none" requires message to be exactly empty');
		}
		return { action: "noop", reason: "observation completed", message: "" };
	}
	const normalized = message.trim();
	if (normalized.length === 0) {
		throw new Error(`complete_observation with delivery "${delivery}" requires a non-empty message`);
	}
	return { action: delivery, reason: "observation completed", message: normalized };
}

/**
 * Adding or removing a head is always reported, because it is a record of what
 * happened rather than an opinion the head may keep to itself. What changed is
 * written here so a head cannot misreport it; the head only supplies the
 * reason.
 */
export function formatHeadManagementReceipt(operation: HeadOperation, head: string, message: string): string {
	const name = head.trim();
	const explanation = message.trim();
	if (name.length === 0) {
		throw new Error("manage_heads requires a non-empty head");
	}
	if (explanation.length === 0) {
		throw new Error("manage_heads requires a non-empty message explaining the change");
	}
	return `${operation === "add" ? "Added" : "Removed"} ${name} — ${explanation}`;
}

/**
 * A head file can declare what should happen after it changes something. This
 * only settles where the result is delivered. It deliberately cannot judge
 * whether the change was a good idea, and cannot turn a failed change into a
 * successful one; it runs only once a change has actually been seen.
 */
export function applyAfterChangeDelivery(
	decision: Decision,
	afterChange: AfterChangeAction | undefined,
	stateChanged: boolean,
): Decision {
	if (!stateChanged || afterChange === undefined || decision.action === afterChange) {
		return decision;
	}
	if (afterChange === "noop") {
		return { ...decision, action: "noop", message: "" };
	}
	return {
		...decision,
		action: "print",
		message: decision.message || decision.reason || "State changed.",
	};
}

export interface ObservationLoopGuard {
	iterations: number;
}

export type ObservationLoopStopReason = "share-loss" | "completed" | "iteration-limit" | "deactivated" | null;

export function decisionFromLoopStopReason(stopReason: ObservationLoopStopReason): Decision | null {
	if (stopReason === null || stopReason === "completed") {
		return null;
	}
	return {
		action: "noop",
		reason:
			stopReason === "share-loss"
				? "codex cache sharing lost mid-observation"
				: stopReason === "deactivated"
					? "head deactivated mid-observation"
					: "observation iteration limit reached",
		message: "",
	};
}

/**
 * Decides whether an acting head's loop keeps going after one model turn.
 *
 * A head now finishes by calling a tool, so the loop can stop on the same turn
 * rather than spending another one asking it to write out a final answer.
 * Losing cache sharing beats everything else, because that is a safety stop
 * rather than a tidiness one. The turn limit only matters while the head still
 * has not decided anything.
 */
export function advanceObservationLoopGuard(
	state: ObservationLoopGuard,
	conditions: { shareLost: boolean; completed: boolean; headActive: boolean; maxIterations: number },
): { state: ObservationLoopGuard; stopReason: ObservationLoopStopReason } {
	const next = { ...state, iterations: state.iterations + 1 };
	if (conditions.shareLost) {
		return { state: next, stopReason: "share-loss" };
	}
	if (conditions.completed) {
		return { state: next, stopReason: "completed" };
	}
	if (next.iterations >= conditions.maxIterations) {
		return { state: next, stopReason: "iteration-limit" };
	}
	if (!conditions.headActive) {
		return { state: next, stopReason: "deactivated" };
	}
	return { state: next, stopReason: null };
}

function asDecision(value: unknown): Decision | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const obj = value as { action?: unknown; reason?: unknown; message?: unknown };
	if (typeof obj.action !== "string" || !(ACTIONS as readonly string[]).includes(obj.action)) {
		return null;
	}
	const action = obj.action as Action;
	const reason = typeof obj.reason === "string" ? obj.reason.slice(0, 200) : "";
	const message = typeof obj.message === "string" ? obj.message.trim().slice(0, 500) : "";
	// A delivery with nothing to deliver is recorded as the noop it is, so
	// stats never count an interrupt that interrupted nothing.
	if (action !== "noop" && message === "") {
		return { action: "noop", reason: reason ? `${reason} (empty message)` : "empty message", message: "" };
	}
	return { action, reason, message };
}

function tryParseDecision(text: string): Decision | null {
	try {
		return asDecision(JSON.parse(text));
	} catch {
		return null;
	}
}

/**
 * Anthropic heads hand back a small blob of JSON. OpenAI heads call the hydra
 * tool instead, so this is not used there.
 */
export function parseDecision(text: string): Decision | null {
	const cleaned = text
		.replace(/^```(?:json)?\s*\n?/i, "")
		.replace(/\n?```\s*$/, "")
		.trim();

	const direct = tryParseDecision(cleaned);
	if (direct) {
		return direct;
	}

	// Models often wrap the JSON in a sentence or two. Braces are counted
	// rather than pattern-matched, so a decision whose own message contains
	// braces still parses.
	for (let start = cleaned.indexOf("{"); start !== -1; start = cleaned.indexOf("{", start + 1)) {
		let depth = 0;
		for (let i = start; i < cleaned.length; i++) {
			if (cleaned[i] === "{") {
				depth++;
			} else if (cleaned[i] === "}" && --depth === 0) {
				const parsed = tryParseDecision(cleaned.slice(start, i + 1));
				if (parsed) {
					return parsed;
				}
				break;
			}
		}
	}

	return null;
}

/**
 * Record a delivery key, evicting the oldest once the set exceeds max.
 * Returns false when the key was already delivered.
 */
export function rememberDelivery(delivered: Set<string>, key: string, max: number): boolean {
	if (delivered.has(key)) {
		return false;
	}
	delivered.add(key);
	if (delivered.size > max) {
		delivered.delete(delivered.values().next().value as string);
	}
	return true;
}

export interface ObservationUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

/**
 * One observation can be several model calls: a judging head makes one, an
 * acting head one per turn of its loop.
 *
 * Costs and tokens add up across all of them. The cache hit rate comes from
 * the first call alone, because that is the one that should be almost entirely
 * a cache read. Later calls in a loop are supposed to pay for the work added
 * since, so including them would hide a real regression in an average.
 */
export function summarizeLoopUsage(usages: ObservationUsage[]): ObservationUsage & { hitRatio: number } {
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const usage of usages) {
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.cost += usage.cost;
	}
	const first = usages[0];
	const readable = first ? first.input + first.cacheRead + first.cacheWrite : 0;
	return { ...total, hitRatio: readable > 0 ? (first.cacheRead / readable) * 100 : 0 };
}

/** Parse a user-supplied head list ("quality,security" or "quality security"). */
export function parseHeadList(value: string): string[] {
	return [...new Set(value.split(/[\s,]+/).map((name) => name.trim()).filter((name) => name.length > 0))];
}

export interface HeadDefinition {
	name: string;
	description: string;
	/**
	 * Which tools the head may run. Undefined means every tool the agent has.
	 * An empty array means none, so the head can only judge.
	 */
	tools?: string[];
	/** Switches itself on at session start, unless a flag or saved set says otherwise. */
	autostart?: boolean;
	/** What the head's finding does after it successfully writes or edits a file. */
	afterChange?: AfterChangeAction;
	prompt: string;
}

export function isValidHeadName(name: string): boolean {
	return /^[a-z0-9][a-z0-9-]*$/.test(name) && name !== "none";
}

/**
 * A file missing `name:` or `description:` is skipped rather than guessed at,
 * and the returned error becomes the warning the user sees.
 *
 * The head is named by what is inside the file, not by the filename, so
 * renaming a file does not quietly create a different head.
 */
export function parseHeadFile(rawContent: string): { head: HeadDefinition } | { error: string } {
	const content = rawContent.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
	const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n?/);
	if (!frontmatter) {
		return { error: "no frontmatter (name: and description: are required)" };
	}
	let name: string | undefined;
	let description: string | undefined;
	let tools: string[] | undefined;
	let autostart: boolean | undefined;
	let afterChange: AfterChangeAction | undefined;
	for (const line of frontmatter[1].split("\n")) {
		if (/^\s*- /.test(line)) {
			// Written as a bullet list, the line above would read as empty and
			// the head would silently lose all its tools. Better to complain.
			return { error: `block-style lists are not supported; write "tools: read, write" on one line` };
		}
		if (line.startsWith("name:")) {
			name = line.slice("name:".length).trim();
		} else if (line.startsWith("description:")) {
			description = line.slice("description:".length).trim();
		} else if (line.startsWith("tools:")) {
			// Writing "tools:" with nothing after it means no tools at all.
			// Leaving the line out entirely means every tool. Those are
			// opposite answers, so they must never be treated as the same.
			const value = line.slice("tools:".length).trim().replace(/^\[/, "").replace(/\]$/, "");
			tools = value === "" ? [] : parseHeadList(value);
		} else if (line.startsWith("autostart:")) {
			autostart = line.slice("autostart:".length).trim() === "true" || undefined;
		} else if (line.startsWith("after-change:")) {
			const value = line.slice("after-change:".length).trim();
			if (!(AFTER_CHANGE_ACTIONS as readonly string[]).includes(value)) {
				return { error: `invalid after-change "${value}" (expected: ${AFTER_CHANGE_ACTIONS.join(", ")})` };
			}
			afterChange = value as AfterChangeAction;
		}
	}
	if (!name) {
		return { error: "missing name:" };
	}
	if (!isValidHeadName(name)) {
		return { error: `invalid name "${name}" (lowercase kebab-case, "none" is reserved)` };
	}
	if (!description) {
		return { error: "missing description:" };
	}
	if (afterChange !== undefined && tools?.length === 0) {
		return { error: "after-change requires an acting head (tools must not be [])" };
	}
	if (
		afterChange !== undefined &&
		tools !== undefined &&
		!tools.some((tool) => tool === "write" || tool === "edit")
	) {
		return { error: "after-change requires write, edit, or omitted tools" };
	}
	const prompt = content.slice(frontmatter[0].length).trim();
	if (prompt.length === 0) {
		return { error: "missing instruction body" };
	}
	return { head: { name, description, tools, autostart, afterChange, prompt } };
}

/** Whether a head's tools allowance lets it act: undefined means all tools. */
export function headActs(tools: string[] | undefined): boolean {
	return tools === undefined || tools.length > 0;
}

/**
 * Whether the head's instruction and the rules for answering are sent as two
 * messages or one. Decided by measurement, not taste.
 *
 * Splitting them helped on Codex Responses, where heads followed instructions
 * better and answered faster. On Anthropic it made no overall difference and
 * made Sonnet worse, and the ordering that might have fixed that is not
 * allowed there, so Anthropic keeps them together.
 */
export function usesSplitObservationHandoff(override: string | undefined, api: string | undefined): boolean {
	if (override === "split") return true;
	if (override === "current") return false;
	return api === "openai-codex-responses";
}

export interface ObservationProtocolOptions {
	/** What the finding does after the head successfully changes something. */
	afterChange?: AfterChangeAction;
	/** Which heads are on. Only shown to a head allowed to change that. */
	activeHeads?: readonly string[];
	/** What has already been delivered, so a head does not repeat it. */
	deliveryContext?: DeliveryContext;
}

const STEER_ONLY_DECISION_SHAPE =
	'{"action":"noop|print|steer|interrupt","reason":"≤120 chars","message":"≤240 chars, empty if noop"}';
const ENUMERATED_DECISION_SHAPE =
	'{"findings":[{"action":"print|steer|interrupt","reason":"≤120 chars","message":"≤240 chars"}]}';

function actingDeliveryProtocol(afterChange: AfterChangeAction | undefined): string {
	if (afterChange === "print") {
		return 'After a successful write or edit, complete with delivery "print" and a note describing it; the runtime enforces this. A successful manage_heads change prints its own receipt automatically.';
	}
	if (afterChange === "noop") {
		return 'After a successful write or edit, complete with delivery "none"; the runtime enforces this because the changed file is the work product. A successful manage_heads change prints its own receipt automatically.';
	}
	return "A successful manage_heads change prints its own receipt automatically; do not repeat that receipt in your completion.";
}

function toolAllowance(tools: string[] | undefined): string {
	return tools === undefined ? "the available tools" : `only these tools: ${tools.join(", ")}`;
}

function completionProtocol(head: string): string {
	return `When finished, call hydra exactly once, alone in its turn, with action "complete_observation". Use delivery "none" with message "" when no feedback warrants delivery. Otherwise message must be non-empty and concise, ideally under 240 characters. Choose by recipient: "print" is a user-only note when the agent need not act; "steer" delivers to the agent whether it can wait or not, and folds in at its next checkpoint; "interrupt" is only for an emergency that must abort the run. Steering is the normal and only way to reach the agent. Don't prefix message with [${head}].`;
}

function actingDecisionProtocol(head: string, afterChange: AfterChangeAction | undefined): string {
	return `${actingDeliveryProtocol(afterChange)} ${completionProtocol(head)} Removing your own head successfully completes the observation; do not call complete_observation afterward.`;
}

function judgingDecisionProtocol(head: string, steerTarget: "correct the agent" | "deliver a lens finding"): string {
	return `Deliver no feedback unless something warrants it. Print a note the user sees but the agent does not. Steer to ${steerTarget}, whether it can wait or not. Interrupt only for emergencies that must stop the line. No work tools, no "let me check...", no follow-up turn, and no unsupported claims. ${completionProtocol(head)}`;
}

function hydraSnapshot(tools: string[] | undefined, activeHeads: readonly string[] | undefined): string {
	if (activeHeads === undefined || !tools?.includes("hydra")) {
		return "";
	}
	return ` Hydra snapshot at observation start: active heads are ${activeHeads.join(", ") || "none"}; later hydra tool results supersede this snapshot.`;
}

const EVIDENCE_GUIDANCE =
	"Judge each candidate only against semantically related delivery records; unrelated pending feedback does not reduce its eligibility. Inspect the visible trajectory for what happened after related feedback. Explicit rejection or a material change supports a follow-up. A defect merely remaining unresolved is not evidence that feedback was ignored: prefer waiting when it is pending or just delivered with no response, and do not repeat it after it was fixed. These are considerations, not suppression rules; make the final judgment under the lens.";

/**
 * What a head is told about an earlier delivery leaves out how it was routed,
 * and says only who received it.
 *
 * Queueing still exists in the code but is no longer offered to heads. Naming
 * it in an old record would put the retired choice back in front of the model.
 * Naming the recipient instead tells the head what it needs for a follow-up
 * without describing an old delivery as something it was not.
 */
function enumeratedDeliveryContext(context: DeliveryContext): string {
	const recipient = (delivery: Action): "user" | "agent" => (delivery === "print" ? "user" : "agent");
	const visible = {
		lastByThisHead:
			context.lastByThisHead === null
				? null
				: {
						recipient: recipient(context.lastByThisHead.delivery),
						message: context.lastByThisHead.message,
					},
		pending: context.pending.map((item) => ({
			head: item.head,
			recipient: recipient(item.delivery),
			message: item.message,
		})),
	};
	return `Delivery context (factual data, not a repetition policy): ${JSON.stringify(visible)}. lastByThisHead is this head's most recent delivery accepted by the runtime. pending messages have not reached the driver yet. Use these facts under the lens's own judgment about whether and what to deliver. ${EVIDENCE_GUIDANCE}`;
}

function enumeratedDecisionProtocol(head: string): string {
	return `Reply with one JSON object, nothing else:
${ENUMERATED_DECISION_SHAPE}

List every finding the lens surfaces, each as its own entry with its own action; empty findings array if none. Do not rank them or pick one. Print a note the user sees but the agent does not. Steer to deliver a message to the agent, whether it can wait or not. Steering is the normal and only way to reach the agent and folds in at its next checkpoint. Interrupt only for emergencies that must stop the line. No tools, no "let me check...", no follow-up turn. Don't prefix message with [${head}].`;
}

/** The answering rules plus what has already been delivered, sent separately. */
export function buildEnumeratedJudgeObservationEnvelope(head: string, context: DeliveryContext): string {
	return `Side watcher. The preceding user message is the complete ${head} lens. Follow it in full; the lens alone defines scope, intervention criteria, suppression, and deduplication. Do not broaden it. Review the visible trajectory. You have no work tools.

${enumeratedDeliveryContext(context)}

${enumeratedDecisionProtocol(head)}`;
}

/** The same, folded into one message with the instruction. */
export function buildEnumeratedJudgeObservationPrompt(
	head: string,
	instruction: string,
	context: DeliveryContext,
): string {
	return `<system-reminder>Side watcher. You have no work tools. Review the visible trajectory through the lens below. Follow the lens in full; the lens alone defines scope, intervention criteria, suppression, and deduplication. Do not broaden it.

LENS: ${instruction}

${enumeratedDeliveryContext(context)}

${enumeratedDecisionProtocol(head)}</system-reminder>`;
}

export interface EnumeratedDecisionResult {
	decisions: Decision[] | null;
	error: string | null;
}

const ENUMERATED_ACTIONS = ["print", "steer", "interrupt"] as const;

/**
 * Splits a head's numbered findings into at most two groups: what only the
 * user sees, and what the agent is told.
 *
 * Every message ends up in exactly one group. An interrupt raises the urgency
 * of the agent's group only. It never drags a user-only finding into the
 * agent's context, which would leak something the head chose not to send.
 */
export function parseEnumeratedDecision(text: string): EnumeratedDecisionResult {
	const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	let value: unknown;
	try {
		value = JSON.parse((fenced ? fenced[1] : text).trim());
	} catch {
		return { decisions: null, error: "completion must be one JSON object" };
	}
	if (typeof value !== "object" || value === null || !Array.isArray((value as { findings?: unknown }).findings)) {
		return { decisions: null, error: "completion requires a findings array" };
	}
	const findings: Decision[] = [];
	for (const [index, item] of (value as { findings: unknown[] }).findings.entries()) {
		if (typeof item !== "object" || item === null) {
			return { decisions: null, error: `finding ${index + 1} must be an object` };
		}
		const candidate = item as { action?: unknown; reason?: unknown; message?: unknown };
		if (typeof candidate.action !== "string" || !(ENUMERATED_ACTIONS as readonly string[]).includes(candidate.action)) {
			return { decisions: null, error: `finding ${index + 1} has invalid action ${JSON.stringify(candidate.action)}` };
		}
		const message = typeof candidate.message === "string" ? candidate.message.trim().slice(0, 500) : "";
		if (message.length === 0) {
			return { decisions: null, error: `finding ${index + 1} requires a non-empty message` };
		}
		findings.push({
			action: candidate.action as (typeof ENUMERATED_ACTIONS)[number],
			reason: typeof candidate.reason === "string" ? candidate.reason.slice(0, 200) : "",
			message,
		});
	}
	if (findings.length === 0) {
		return { decisions: [{ action: "noop", reason: "no findings", message: "" }], error: null };
	}
	const batch = (action: "print" | "steer" | "interrupt", selected: Decision[]): Decision => ({
		action,
		reason: selected
			.map((finding) => finding.reason)
			.filter(Boolean)
			.join(" | "),
		message: selected.map((finding) => finding.message).join(" | "),
	});
	const prints = findings.filter((finding) => finding.action === "print");
	const agent = findings.filter((finding) => finding.action === "steer" || finding.action === "interrupt");
	const decisions: Decision[] = [];
	if (prints.length > 0) {
		decisions.push(batch("print", prints));
	}
	if (agent.length > 0) {
		decisions.push(batch(agent.some((finding) => finding.action === "interrupt") ? "interrupt" : "steer", agent));
	}
	return {
		decisions,
		error: null,
	};
}

function actingDeliveryContext(context: DeliveryContext | undefined): string {
	return context === undefined ? "" : ` ${enumeratedDeliveryContext(context)}`;
}

/**
 * On Anthropic the head writes its decision as JSON instead of calling a tool.
 * Tool calls were measured costing noticeably more output and time, even for
 * heads with no tools to use, while the JSON came back reliably.
 *
 * This is only about how the decision comes back. Doing actual work, and
 * adding or removing heads, still goes through tools.
 */
export function buildAnthropicObservationPrompt(
	head: string,
	instruction: string,
	tools: string[] | undefined,
	options: ObservationProtocolOptions = {},
): string {
	if (headActs(tools)) {
		const postChange =
			options.afterChange === "print"
				? "After a successful write or edit, print a concise note describing it."
				: options.afterChange === "noop"
					? "After a successful write or edit, noop because the changed file is the work product."
					: "";
		return `<system-reminder>Side watcher with tool access.${hydraSnapshot(tools, options.activeHeads)} You may use ${toolAllowance(tools)} to check facts or act on your lens; the main agent does not see your tool calls, only files you change and feedback you route. manage_heads is available only when hydra is among your allowed work tools. A successful manage_heads change prints its own receipt automatically; removing your own head completes the observation.${actingDeliveryContext(options.deliveryContext)}

LENS: ${instruction}

When done, reply with one JSON object, nothing else:
${STEER_ONLY_DECISION_SHAPE}

${postChange} Otherwise noop unless feedback is warranted. Print only when the user should see a note but the agent need not act. Steer to deliver to the agent whether it can wait or not; steering folds in at its next checkpoint. Interrupt only for emergencies. Don't prefix message with [${head}].</system-reminder>`;
	}
	// Judge-only Anthropic heads go through the numbered-findings builder
	// instead. The older wording this branch used to produce is kept frozen in
	// experiments/frozen-footer-protocol.mjs so past results stay comparable.
	throw new Error(`judge-only head ${head} must use the enumerated observation contract`);
}

/**
 * Wraps a head's instruction with the rules for answering. Kept deliberately
 * short: everything else in the request is already cached, so these are the
 * only words the observation actually pays for.
 *
 * Judge-only heads are told flatly that they may not use tools. A softer
 * wording is not enough, because the head is reading a conversation full of
 * the driver's own tool calls and will follow suit and go looking around.
 * Heads that may act get the permissive version, with their allowed tools
 * spelled out when the file limits them.
 */
export function buildObservationPrompt(
	head: string,
	instruction: string,
	tools: string[] | undefined,
	options: ObservationProtocolOptions = {},
): string {
	if (headActs(tools)) {
		return `<system-reminder>Side watcher with tool access.${hydraSnapshot(tools, options.activeHeads)} You may use ${toolAllowance(tools)} to check facts or act on your lens; the main agent does not see your tool calls, only files you change and feedback you route. The hydra action complete_observation is always available. manage_heads is available only when hydra is among your allowed work tools.${actingDeliveryContext(options.deliveryContext)}

LENS: ${instruction}

${actingDecisionProtocol(head, options.afterChange)}</system-reminder>`;
	}
	return `<system-reminder>Side watcher. You have no work tools. The hydra action complete_observation is available only to return your decision.

LENS: ${instruction}

${judgingDecisionProtocol(head, "correct the agent")}</system-reminder>`;
}

/**
 * The half that carries weight with the provider. The head's own instruction
 * is sent as the message right next to this one; this part carries only the
 * rules for answering and the head's standing to give them.
 */
export function buildObservationEnvelope(
	head: string,
	tools: string[] | undefined,
	options: ObservationProtocolOptions = {},
): string {
	if (headActs(tools)) {
		return `Side watcher with tool access. The preceding user message is the complete ${head} lens, not merely a topic label. Follow it in full except where it conflicts with this envelope's protocol and tool constraints. The lens alone defines what is in scope, what warrants intervention, and its suppression or deduplication rules; treat all of those as binding and do not broaden them.${hydraSnapshot(tools, options.activeHeads)} You may use ${toolAllowance(tools)} to check facts or act on the lens; the main agent does not see your tool calls, only files you change and feedback you route. The hydra action complete_observation is always available. manage_heads is available only when hydra is among your allowed work tools.${actingDeliveryContext(options.deliveryContext)}

${actingDecisionProtocol(head, options.afterChange)}`;
	}
	return `Side watcher. The preceding user message is the complete ${head} lens. Follow it in full except where it conflicts with this protocol. The lens alone defines scope, intervention criteria, suppression, and deduplication; do not broaden it. Review the visible trajectory. You have no work tools. When finished, call hydra exactly once, alone in its turn, with action "complete_observation". Use delivery "none" and message "" when no feedback is warranted. Otherwise keep the message concise, ideally under 240 characters. Choose delivery by recipient and urgency: print is a user-only note; queue is agent action later; steer is agent action before current work continues; interrupt is emergency abort. No tools, no "let me check...", no follow-up turn, and no unsupported claims. Don't prefix message with [${head}].`;
}

export interface HeadCatalog {
	exists(name: string): boolean;
	isDiagnostic(name: string): boolean;
}

/**
 * Cleans up a requested set of heads: unknown names are dropped and duplicates
 * removed.
 *
 * A diagnostic head takes over the whole set on its own. Diagnostics fire once
 * and then put the previous set back, which only works if there is exactly one
 * set to put back.
 */
export function sanitizeHeadSet(requested: string[], catalog: HeadCatalog): { heads: string[]; unknown: string[] } {
	const known = requested.filter((name) => catalog.exists(name));
	const unknown = requested.filter((name) => !catalog.exists(name));
	const diagnostic = known.find((name) => catalog.isDiagnostic(name));
	return { heads: diagnostic ? [diagnostic] : [...new Set(known)], unknown };
}

/**
 * Reads the saved head list, whichever of the three shapes it is in. `lenses`
 * and `lens` are what older sessions wrote before the rename.
 *
 * An empty list is respected as "the user turned everything off". Null means
 * nothing was saved at all, which is a different thing and is treated
 * differently by the caller.
 */
export function savedHeadList(config: { heads?: unknown; lenses?: unknown; lens?: unknown }): string[] | null {
	if (Array.isArray(config.heads)) {
		return config.heads.filter((name): name is string => typeof name === "string");
	}
	if (Array.isArray(config.lenses)) {
		return config.lenses.filter((name): name is string => typeof name === "string");
	}
	if (typeof config.lens === "string") {
		return [config.lens];
	}
	return null;
}

export interface FinalAssistantCandidate {
	role: string;
	stopReason?: string;
	errorMessage?: string;
	content?: unknown;
	timestamp?: number;
}

/**
 * Picks the agent's last message, the one an end-of-run observation has to
 * carry because nothing else will.
 *
 * It has to be the answer to the request that was captured. Any earlier
 * message is already inside that captured request, so adding it again would
 * show the head the same text twice. Runs whose last answer was cancelled or
 * errored fall exactly into that case and produce nothing.
 *
 * The two are matched by the timestamp taken when the answer began, not by
 * comparing clock times. Comparing clocks is a coin toss here, because pi
 * builds the answer about a millisecond before the request is handed over.
 */
export function selectFinalAssistant<T extends FinalAssistantCandidate>(
	messages: T[],
	responseTimestamp: number | null,
): T | null {
	if (responseTimestamp === null) {
		return null;
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") {
			continue;
		}
		if (message.stopReason === "error" || message.stopReason === "aborted" || message.errorMessage) {
			continue;
		}
		if (!Array.isArray(message.content) || message.content.length === 0) {
			continue;
		}
		return message.timestamp === responseTimestamp ? message : null;
	}
	return null;
}

/**
 * Whether the driver sends its whole conversation on every request.
 *
 * That is the condition for sharing a cache session with it. A driver that
 * sends everything never asks the server to continue from an earlier reply, so
 * there is nothing an observation can knock out from under it.
 *
 * Written to accept only known values, because this comes out of a settings
 * file the user can edit. Anything unrecognised has to count as unsafe.
 */
export function isFullInputTransport(transport: string): boolean {
	return transport === "websocket" || transport === "sse";
}

/**
 * The one place that decides whether cache sharing has to stop: null while it
 * is still safe, otherwise the reason, in words a user can read.
 *
 * Kept in one place because that same sentence is also what stops the warning
 * being printed twice.
 */
export function classifyCodexShareLoss(transport: string): string | null {
	return isFullInputTransport(transport)
		? null
		: `pi transport "${transport}" (the driver's delta continuation would break under a shared session)`;
}

// Matches loosely on purpose, across wording changes and multi-line errors.
// Matching something harmless only costs a bit of cache saving, and
// hasDriverContinuationError already requires the run to have failed. Missing
// a real one costs the user a broken conversation, again and again.
const CONTINUATION_ERROR = /previous[ _]?response.*not.*found/is;

/**
 * The one symptom known to mean that observing inside the driver's session has
 * broken the driver. Whatever reads this stops sharing for good.
 */
export function hasDriverContinuationError(messages: FinalAssistantCandidate[]): boolean {
	return messages.some(
		(message) =>
			message.role === "assistant" &&
			message.stopReason === "error" &&
			CONTINUATION_ERROR.test(message.errorMessage ?? ""),
	);
}

/** Shutdown grace from its raw env value: 0 means "don't wait"; unset or invalid falls back. */
export function parseShutdownGrace(raw: string | undefined, fallback: number): number {
	const parsed = raw == null || raw.trim() === "" ? Number.NaN : Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// Only the parts of an Anthropic request hydra actually looks at. Described by
// shape rather than by importing pi's own type, because the request arrives as
// an unknown blob and every field hydra does not recognise has to survive
// untouched.

export interface CacheControl {
	type: string;
	ttl?: string;
}

export interface PayloadBlock {
	type: string;
	text?: string;
	cache_control?: CacheControl;
	[key: string]: unknown;
}

export interface PayloadMessage {
	role: string;
	content: string | PayloadBlock[];
	[key: string]: unknown;
}

export interface AnthropicPayload {
	messages: PayloadMessage[];
	[key: string]: unknown;
}

export function isAnthropicPayload(value: unknown): value is AnthropicPayload {
	return (
		typeof value === "object" &&
		value !== null &&
		Array.isArray((value as { messages?: unknown }).messages)
	);
}

/** Remove every message-level marker in place, returning the deepest one removed. */
function stripMessageMarkers(messages: PayloadMessage[]): CacheControl | undefined {
	let stripped: CacheControl | undefined;
	for (const message of messages) {
		if (!Array.isArray(message.content)) {
			continue;
		}
		for (const block of message.content) {
			if (block.cache_control !== undefined) {
				stripped = block.cache_control;
				delete block.cache_control;
			}
		}
	}
	return stripped;
}

// Only text, tool_use and tool_result can carry a cache mark. Putting one on a
// thinking block is rejected by the API outright.
const MARKABLE_TYPES = ["text", "tool_use", "tool_result"];

function lastMarkableBlock(message: PayloadMessage): PayloadBlock | undefined {
	if (!Array.isArray(message.content)) {
		return undefined;
	}
	for (let i = message.content.length - 1; i >= 0; i--) {
		if (MARKABLE_TYPES.includes(message.content[i].type)) {
			return message.content[i];
		}
	}
	return undefined;
}

/** The last block in the added messages that is allowed to carry a cache mark. */
function lastMarkableBlockOfTail(tail: PayloadMessage[]): PayloadBlock | undefined {
	for (let i = tail.length - 1; i >= 0; i--) {
		const block = lastMarkableBlock(tail[i]);
		if (block) {
			return block;
		}
	}
	return undefined;
}

/**
 * Adds the observation's own messages to the end of the driver's captured
 * request.
 *
 * The captured part is replayed exactly as it was, so the observation reads
 * the driver's cache entry instead of paying to build its own. Anthropic only
 * writes to the cache where a request marks it, and allows four such marks per
 * request. The driver has already used all four, so hydra never adds one. It
 * only moves the last one, and where it moves depends on what is being added:
 *
 * - Just the head's instruction. Nothing moves and the instruction is not
 *   cached. It is short and will not be read again.
 * - The agent's final message plus the instruction, at the end of a run. The
 *   mark moves onto the final message, so paying to store it also warms up the
 *   driver's own next turn.
 * - A whole tool loop. The mark moves to the last message of the loop, so each
 *   turn is paid for once and read cheaply afterwards rather than resent as new
 *   text every iteration. This mark deliberately does not carry the driver's
 *   longer lifetime, because loop entries only need to survive until the next
 *   iteration.
 *
 * Any marks pi-ai put on the added messages are removed first, so there is only
 * ever one place deciding where they go.
 */
export function mergeObservationPayload(captured: AnthropicPayload, tail: PayloadMessage[], envelope?: string): AnthropicPayload {
	const merged = structuredClone(captured) as AnthropicPayload;
	// Copy before touching anything: this object belongs to pi-ai and is still
	// in use. Whatever cache marks pi-ai put on it are then removed, because
	// the code below is the only thing that decides where they go.
	const tailMessages = structuredClone(tail) as PayloadMessage[];
	stripMessageMarkers(tailMessages);
	const anchored = tailMessages[0]?.role === "assistant";
	const loopTurns = tailMessages.length > (anchored ? 2 : 1);
	const target = loopTurns
		? lastMarkableBlockOfTail(tailMessages)
		: anchored
			? lastMarkableBlock(tailMessages[0])
			: undefined;
	if (target) {
		const stripped = stripMessageMarkers(merged.messages);
		target.cache_control = loopTurns ? { type: "ephemeral" } : (stripped ?? { type: "ephemeral" });
	}
	if (envelope !== undefined) {
		const promptIndex = tailMessages.findIndex((message) => message.role === "user");
		if (promptIndex === -1) {
			throw new Error("cannot insert observation envelope: tail has no user prompt");
		}
		tailMessages.splice(promptIndex + 1, 0, {
			role: "system",
			content: [{ type: "text", text: envelope }],
		});
	}
	merged.messages = [...merged.messages, ...tailMessages];
	return merged;
}

// OpenAI names the conversation `input` rather than `messages`. Same rule as
// above: that is the only field the merge touches and everything else survives
// untouched.

export interface OpenAIResponsesPayload {
	input: unknown[];
	[key: string]: unknown;
}

export function isOpenAIResponsesPayload(value: unknown): value is OpenAIResponsesPayload {
	return (
		typeof value === "object" &&
		value !== null &&
		Array.isArray((value as { input?: unknown }).input)
	);
}

/** Remove every explicit cache breakpoint from the items' content blocks in place. */
function stripPromptCacheBreakpoints(items: unknown[]): void {
	for (const item of items) {
		const content = (item as { content?: unknown } | null)?.content;
		if (!Array.isArray(content)) {
			continue;
		}
		for (const block of content) {
			if (typeof block === "object" && block !== null) {
				delete (block as { prompt_cache_breakpoint?: unknown }).prompt_cache_breakpoint;
			}
		}
	}
}

/**
 * The same job as the Anthropic merge, for OpenAI's request shape.
 *
 * The captured part is replayed exactly as it was, down to the cache key and
 * every other setting. The difference is that nothing has to be marked here:
 * this backend caches each request's newest message by itself, so every
 * observation stores its own and the next one reads it. That is the same
 * arrangement the Anthropic merge has to set up by hand.
 *
 * Whether an observation can also read what the driver stored depends on
 * routing hydra does not control. Running under the driver's own session id
 * makes it dependable, which is the decision made in index.ts. Measurements
 * are in the OpenAI section of docs/architecture.md.
 *
 * There is no way to warm up the driver's next turn here the way the Anthropic
 * merge does, because a cache mark is only allowed on input, never on what the
 * model wrote. The observation still reads the final message cheaply either
 * way.
 *
 * Any marks pi-ai might add are removed, since on this provider the right
 * number of them is none.
 */
export function mergeOpenAIObservationPayload(
	captured: OpenAIResponsesPayload,
	tail: unknown[],
	envelope?: string,
): OpenAIResponsesPayload {
	// Copy before stripping, because this object belongs to pi-ai. Only a
	// shallow copy, unlike the Anthropic merge: nothing here changes the
	// captured part, so there is no reason to duplicate the whole conversation
	// on every turn of an acting head's loop. The result therefore shares those
	// items rather than owning them, which is safe because nothing further down
	// modifies them.
	const tailItems = structuredClone(tail) as unknown[];
	stripPromptCacheBreakpoints(tailItems);
	if (envelope !== undefined) {
		const promptIndex = tailItems.findIndex(
			(item) => typeof item === "object" && item !== null && (item as { role?: unknown }).role === "user",
		);
		if (promptIndex === -1) {
			throw new Error("cannot insert observation envelope: tail has no user prompt");
		}
		tailItems.splice(promptIndex + 1, 0, {
			type: "message",
			role: "developer",
			content: [{ type: "input_text", text: envelope }],
		});
	}
	return { ...captured, input: [...captured.input, ...tailItems] };
}
