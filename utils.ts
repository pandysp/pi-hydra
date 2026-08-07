/**
 * Pure helpers for hydra observations.
 * Extracted for testability; no pi or I/O dependencies.
 */

// A decision names its finding's delivery: noop (nothing anywhere), print
// (TUI only), queue (run end), steer (between turns), interrupt (now,
// aborting the run).
export const ACTIONS = ["noop", "print", "queue", "steer", "interrupt"] as const;
export type Action = (typeof ACTIONS)[number];
export const OBSERVATION_DELIVERIES = ["none", "print", "queue", "steer", "interrupt"] as const;
export type ObservationDelivery = (typeof OBSERVATION_DELIVERIES)[number];
export const HEAD_OPERATIONS = ["add", "remove"] as const;
export type HeadOperation = (typeof HEAD_OPERATIONS)[number];
export const AFTER_CHANGE_ACTIONS = ["noop", "print"] as const;
export type AfterChangeAction = (typeof AFTER_CHANGE_ACTIONS)[number];

export type DeliveryAction = Exclude<Action, "noop">;

export interface DeliveryRecord {
	head: string;
	delivery: DeliveryAction;
	message: string;
}

export interface DeliveryContext {
	lastByThisHead: Omit<DeliveryRecord, "head"> | null;
	pending: DeliveryRecord[];
}

export interface PersistedDelivery extends DeliveryRecord {
	timestamp: number;
}

/**
 * A decision formed on a snapshot the driver has since moved past may not
 * abort the current run: interrupt demotes to steer. The asymmetry favors
 * demotion; a wrong demotion costs one turn of latency, a wrong abort
 * destroys in-flight work.
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
 * Turn the public completion contract into the existing internal routing
 * vocabulary. The public API deliberately says `none`, not the historical
 * implementation term `noop`.
 *
 * Message cardinality is part of the contract rather than prompt advice:
 * `none` carries exactly the empty string, every routed delivery carries
 * non-whitespace feedback.
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
 * Successful head management is provenance, not optional review feedback.
 * The runtime owns the factual prefix; the head supplies only why the change
 * fits the trajectory.
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
 * Apply a head's post-mutation delivery contract to a returned decision.
 * This deliberately cannot decide whether work was warranted or make failed
 * work successful; it only resolves delivery after the runtime observed a
 * state change.
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
 * Advance an observation's stop policy after one model turn. Completion is a
 * tool event now, so a successful completion or self-removal ends the loop at
 * the same turn boundary instead of spending a grace turn asking the model to
 * serialize a final answer. Share loss remains the highest-priority safety
 * stop; the iteration limit applies only while completion is still missing.
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
 * Parse the compact JSON completion used by Anthropic and by the frozen
 * benchmark control. OpenAI uses the typed hydra completion action.
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

	// Embedded in prose: try every balanced {...} span. Brace counting
	// instead of a regex, so a decision whose message itself contains braces
	// still parses.
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
 * Fold the per-iteration usage of one observation (a judging head makes one
 * call, an acting head one per loop iteration) into stats for a single
 * HydraCall. Totals sum across iterations; the hit ratio comes from the first
 * iteration alone, since that is the replay-parity regression signal and
 * later iterations legitimately pay the loop tail as fresh input.
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
	 * Tool names the head may execute. Undefined means every tool the agent
	 * has; an empty array means none (the head judges, never acts).
	 */
	tools?: string[];
	/** Joins the active set at session start when no saved set and no flag exist. */
	autostart?: boolean;
	/** Deterministic delivery after a successful write or edit. */
	afterChange?: AfterChangeAction;
	prompt: string;
}

/**
 * The active head set survives resume and branch navigation as the latest
 * "hydra-config" entry on the branch. An explicit --hydra-heads flag beats
 * the saved set (present intent over recorded intent); heads marked
 * autostart seed sessions that have neither. `lenses`/`lens` are pre-rename
 * field names, still read for old sessions.
 */
export interface HydraConfig {
	heads: string[];
	lenses?: string[];
	lens?: string;
}

export function isValidHeadName(name: string): boolean {
	return /^[a-z0-9][a-z0-9-]*$/.test(name) && name !== "none";
}

/**
 * Parse a head file: `---` frontmatter carrying the head's identity and
 * capabilities, body carrying the instruction. `name` and `description` are
 * required; a file missing either is skipped (with the returned error as the
 * warning). The filename is storage, not identity.
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
			// A YAML block list would silently parse as an empty value above
			// it; reject loudly instead.
			return { error: `block-style lists are not supported; write "tools: read, write" on one line` };
		}
		if (line.startsWith("name:")) {
			name = line.slice("name:".length).trim();
		} else if (line.startsWith("description:")) {
			description = line.slice("description:".length).trim();
		} else if (line.startsWith("tools:")) {
			// A present-but-empty value ("tools:" or "tools: []") means none;
			// an absent key means all. The two must not collapse into each
			// other. Brackets are optional around a non-empty list.
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
 * Provider-level observation handoff selected by the A/B evidence. The
 * product splits only Codex Responses, where it improved adherence and
 * latency. Anthropic keeps the combined user prompt, where the system split
 * was neutral overall and regressed Sonnet without a legal reverse ordering.
 */
export function usesSplitObservationHandoff(api: string | undefined): boolean {
	return api === "openai-codex-responses";
}

export interface ObservationProtocolOptions {
	/** Deterministic delivery after a successful tracked state change. */
	afterChange?: AfterChangeAction;
	/** Active-set snapshot, supplied only to a head that can call hydra. */
	activeHeads?: readonly string[];
	/** Extension-owned delivery facts visible to the observing head. */
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
 * The model-facing delivery record intentionally omits the internal route
 * label. `queue` remains a runtime capability, but an old queued receipt must
 * not reintroduce that retired choice into the steer-only contract. Recipient
 * preserves the fact the head needs for follow-up judgment without relabelling
 * an old delivery as something it was not.
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

/** ENUM-SO2 contract plus factual delivery state in the split OpenAI handoff. */
export function buildEnumeratedJudgeObservationEnvelope(head: string, context: DeliveryContext): string {
	return `Side watcher. The preceding user message is the complete ${head} lens. Follow it in full; the lens alone defines scope, intervention criteria, suppression, and deduplication. Do not broaden it. Review the visible trajectory. You have no work tools.

${enumeratedDeliveryContext(context)}

${enumeratedDecisionProtocol(head)}`;
}

/** ENUM-SO2 contract plus factual delivery state in the combined Anthropic handoff. */
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
 * Parse ENUM-SO2 into at most two recipient-preserving batches: one user-only
 * print and one agent-directed steer/interrupt. Every message survives exactly
 * once. An interrupt escalates only the agent batch; it never pulls a print
 * finding into the agent's context.
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
 * Anthropic completion fallback. Native tool calls were measured adding
 * substantial output and latency even when the head had no work tools, while
 * the JSON return remained structurally reliable. Acting work and head
 * management still use tools; only the final delivery return may be JSON.
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
	// Judge-only Anthropic heads use buildEnumeratedJudgeObservationPrompt;
	// the pre-ENUM judge control this branch once rendered is frozen in
	// experiments/frozen-footer-protocol.mjs.
	throw new Error(`judge-only head ${head} must use the enumerated observation contract`);
}

/**
 * The wrapper around a head's instruction. Kept SHORT: the driver's context
 * is already cached, so this is the only fresh input the observation pays for
 * per call. Judge-only heads (tools: []) get a hard tool ban: the head
 * sits atop a context saturated with driver tool calls, and anything softer
 * leaks into "let me check" excursions. Acting heads get the tool-permitting
 * variant, with the allowance spelled out when the file narrows it.
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
 * Provider-elevated half of the split observation handoff. The complete head
 * instruction is sent separately as the adjacent user message; this envelope
 * supplies only protocol and authority.
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
 * Resolve a requested head set: drop unknown names, collapse to a single
 * diagnostic when one is present (diagnostics never mix with product heads;
 * their one-shot revert needs an unambiguous set to restore), dedupe the rest.
 */
export function sanitizeHeadSet(requested: string[], catalog: HeadCatalog): { heads: string[]; unknown: string[] } {
	const known = requested.filter((name) => catalog.exists(name));
	const unknown = requested.filter((name) => !catalog.exists(name));
	const diagnostic = known.find((name) => catalog.isDiagnostic(name));
	return { heads: diagnostic ? [diagnostic] : [...new Set(known)], unknown };
}

/**
 * Normalize a persisted config's head field: a `heads` array (an explicit
 * empty array means "no heads" and is respected), the pre-rename `lenses`
 * array or `lens` string from older sessions, or null when the entry carries
 * none of them.
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
 * Pick the run's final assistant message M for the run-end fork: the last
 * usable assistant message, required to BE the captured request's own
 * response. Anything else is already serialized inside the captured payload,
 * and appending it again would duplicate it in the observation's context. Runs
 * whose final generation aborted or errored hit exactly that case and select
 * nothing.
 *
 * Identity is matched on the timestamp recorded at the response's own
 * message_start (null when the captured request never started a response).
 * Wall-clock comparison against the capture time is a coin flip: pi
 * constructs the response message ~1ms before before_provider_request fires.
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
 * Whether a pi transport setting means the driver sends its full input on
 * every request. Full-input drivers never send previous_response_id, so
 * there is no server-side continuation reference for an observation under
 * a shared session to evict — the codex sharing precondition. Deliberately
 * typed over plain strings: settings files hold untrusted input, and
 * anything unrecognized must classify as unsafe.
 */
export function isFullInputTransport(transport: string): boolean {
	return transport === "websocket" || transport === "sse";
}

/**
 * The single owner of the codex share-loss decision: null when the
 * transport keeps sharing safe, otherwise the human-readable reason every
 * gate site records into codexShareLostReason (monotonically, via `??=`).
 * One owner because the reason string doubles as the warnOnce dedup key.
 */
export function classifyCodexShareLoss(transport: string): string | null {
	return isFullInputTransport(transport)
		? null
		: `pi transport "${transport}" (the driver's delta continuation would break under a shared session)`;
}

// The codex continuation-failure signature, tolerant of wording variants
// ("previous_response_id", "could not be found") and of multi-line error
// bodies (s flag). False positives are fenced by the stopReason gate in
// hasDriverContinuationError, and cost only cache economics; a false
// negative costs repeated driver breakage, so match generously.
const CONTINUATION_ERROR = /previous[ _]?response.*not.*found/is;

/**
 * Whether a run's messages contain the codex continuation-failure signature
 * on an errored assistant message: the one known driver-breaking symptom of
 * observing under the driver's session. The tripwire that consumes this
 * permanently downgrades codex observations to their own session.
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

// The slice of an Anthropic Messages payload that hydra reads and rewrites.
// Structural on purpose: the payload arrives as `unknown` from pi's
// before_provider_request hook, and hydra must pass through every field it
// does not understand byte-for-byte.

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

// text, tool_use, and tool_result are the marker-eligible block types here;
// cache_control on a thinking block is an API error.
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

/** The deepest markable block across the tail, for the loop-frontier marker. */
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
 * Merge the observation tail (pi-ai's own serialization of `[M?, handoff,
 * ...tool-loop turns]`) onto the captured driver payload.
 *
 * The captured prefix is replayed byte-true so the fork reads the driver's
 * cache entry exactly. Cache writes happen only at explicit breakpoints, and
 * the budget is four per request (the driver's payload already spends all
 * four), so hydra only ever MOVES the deepest message-level marker, by tail
 * shape:
 *
 * - `[prompt]`: a plain observation. Nothing moves; the captured markers
 *   are replayed byte-true and the prompt stays uncached.
 * - `[M, prompt]`: a run-end fork. The driver's marker (TTL included) rides
 *   M's last markable block: the fork's write pre-warms the driver's next
 *   request, which finds the prefix+M entry via breakpoint walk-back.
 * - longer: a tool loop appended observation turns. The marker advances to the
 *   tail's last markable block, so each loop turn is written once and read
 *   thereafter instead of re-paid as input every iteration. A plain
 *   ephemeral marker, deliberately without the driver's TTL: loop entries
 *   only need to survive until the next iteration, and the prefix+M entry
 *   the first call wrote keeps serving the driver bet.
 *
 * Markers pi-ai placed on the tail are dropped before any of this.
 */
export function mergeObservationPayload(captured: AnthropicPayload, tail: PayloadMessage[], envelope?: string): AnthropicPayload {
	const merged = structuredClone(captured) as AnthropicPayload;
	// Clone the tail before touching it: it is pi-ai's own params object, and
	// the marker handling below must not reach back into it. Markers pi-ai
	// placed on the tail are dropped; hydra owns the marker placement.
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

// OpenAI Responses payloads (`input` items instead of `messages`), same
// structural stance: `input` is the one field the merge touches, everything
// else passes through byte-for-byte.

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
 * Merge the observation tail (pi-ai's own serialization of `[M?, handoff,
 * ...tool-loop turns]`) onto the captured driver payload, OpenAI Responses
 * shape.
 *
 * The captured prefix is replayed byte-true — `prompt_cache_key`, `store`,
 * `instructions`, everything. Unlike Anthropic, no marker ever moves:
 * GPT-5.6 caching runs in implicit mode, where the server itself
 * breakpoints each request's latest message, so each observation writes
 * its own frontier and the next one reads it — the economics the Anthropic
 * merge arranges by hand with `cache_control` moves. Whether an
 * observation can also read the entries the DRIVER wrote depends on
 * backend routing hydra does not control; observing under the driver's
 * own session id makes it reliable, which is the transport-gated session
 * strategy decided in index.ts (see the OpenAI section of
 * docs/architecture.md for the measurements).
 *
 * A marker-style run-end pre-warm of the driver has no expressible form
 * here: explicit breakpoints are legal only on input blocks (`input_text`,
 * `input_image`, `input_file`), never on assistant output. The fork still
 * observes M cheaply either way.
 *
 * Explicit breakpoints pi-ai might one day place on the tail are dropped:
 * hydra owns marker placement, and on this provider that means none.
 */
export function mergeOpenAIObservationPayload(
	captured: OpenAIResponsesPayload,
	tail: unknown[],
	envelope?: string,
): OpenAIResponsesPayload {
	// Clone the tail before stripping: it is pi-ai's own request body. The
	// captured prefix is never mutated here (unlike the Anthropic merge,
	// whose deep clone is load-bearing for the marker moves), so a shallow
	// copy suffices and spares re-copying the full context on every
	// acting-loop call. The merged payload therefore aliases the captured
	// items — sound because pi-ai only serializes the body after onPayload;
	// nothing downstream mutates request items.
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
