/**
 * Pure helpers for hydra observations.
 * Extracted for testability; no pi runtime or I/O dependencies.
 */
import type { Message } from "@earendil-works/pi-ai";
export declare const ACTIONS: readonly ["noop", "print", "queue", "steer", "interrupt"];
export type Action = (typeof ACTIONS)[number];
export declare const OBSERVATION_DELIVERIES: readonly ["none", "print", "queue", "steer", "interrupt"];
export type ObservationDelivery = (typeof OBSERVATION_DELIVERIES)[number];
export declare const HEAD_OPERATIONS: readonly ["add", "remove"];
export type HeadOperation = (typeof HEAD_OPERATIONS)[number];
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
 * A head that decided to interrupt, based on a picture the agent has already
 * moved past, is downgraded to steering instead.
 *
 * The trade is deliberately lopsided. Downgrading when it was not needed costs
 * one turn of delay. Interrupting when it was not needed throws away work the
 * agent is in the middle of.
 */
export declare function demoteStaleInterrupt(action: Action, staleSnapshot: boolean): Action;
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
export declare function decisionFromCompletion(delivery: ObservationDelivery, message: string): Decision;
/**
 * Adding or removing a head is always reported, because it is a record of what
 * happened rather than an opinion the head may keep to itself. What changed is
 * written here so a head cannot misreport it; the head only supplies the
 * reason.
 */
export declare function formatHeadManagementReceipt(operation: HeadOperation, head: string, message: string): string;
/**
 * Anthropic heads hand back a small blob of JSON. OpenAI heads call the hydra
 * tool instead, so this is not used there.
 */
export declare function parseDecision(text: string): Decision | null;
/**
 * Record a delivery key, evicting the oldest once the set exceeds max.
 * Returns false when the key was already delivered.
 */
export declare function rememberDelivery(delivered: Set<string>, key: string, max: number): boolean;
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
export declare function summarizeLoopUsage(usages: ObservationUsage[]): ObservationUsage & {
    hitRatio: number;
};
/** Parse a user-supplied head list ("quality,security" or "quality security"). */
export declare function parseHeadList(value: string): string[];
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
    prompt: string;
}
/**
 * Written into the session so the active heads come back after a resume or a
 * branch switch. A --hydra-heads flag wins over what was saved, because what
 * the user just typed beats what they wanted last time. Heads marked
 * autostart seed a session that has neither. `lenses` and `lens` are the old
 * names for the same thing, still read so old sessions load.
 */
export interface HydraConfig {
    heads: string[];
    lenses?: string[];
    lens?: string;
}
export declare function isValidHeadName(name: string): boolean;
/**
 * A file missing `name:` or `description:` is skipped rather than guessed at,
 * and the returned error becomes the warning the user sees.
 *
 * The head is named by what is inside the file, not by the filename, so
 * renaming a file does not quietly create a different head.
 */
export declare function parseHeadFile(rawContent: string): {
    head: HeadDefinition;
} | {
    error: string;
};
/** Whether a head's tools allowance lets it act: undefined means all tools. */
export declare function headActs(tools: string[] | undefined): boolean;
/**
 * Whether the head's instruction and the rules for answering are sent as two
 * messages or one. Decided by measurement, not taste.
 *
 * Splitting them helped on Codex Responses, where heads followed instructions
 * better and answered faster. On Anthropic it made no overall difference and
 * made Sonnet worse, and the ordering that might have fixed that is not
 * allowed there, so Anthropic keeps them together.
 */
export declare function usesSplitObservationHandoff(api: string | undefined): boolean;
export interface ObservationProtocolOptions {
    /** Which heads are on. Only shown to a head allowed to change that. */
    activeHeads?: readonly string[];
    /** What has already been delivered, so a head does not repeat it. */
    deliveryContext?: DeliveryContext;
}
export declare const OBSERVER_DELIVERY_GUIDANCE = "\"print\" shows a note only to the user; the main assistant will not see it. Use \"steer\" when the main assistant needs the feedback, even if it can wait. The message reaches it before its next model request without stopping its work. Use \"interrupt\" only for an emergency that must stop the run.";
export declare const OBSERVER_GUIDANCE = "You are reviewing the main assistant's work. You are not the main assistant; it keeps working on its own. Do not continue its task or answer for it. This head's instructions define what to check and how much to report. Follow them. The main assistant may have moved on since this copy of the conversation was taken. Do not repeat its plan or doubts, or suggest work it already plans to do unless the plan itself is the problem. Support each finding with a short quote or exact reference. If evidence is missing, say what is missing; that alone does not prove a problem.";
export declare function headLoopMessages<T extends {
    role: string;
}>(messages: readonly T[], keepSystemNote: boolean, onUnexpected: (role: string) => void): Message[];
export declare function headInstructions(instruction: string): string;
export declare const REPORTING_GUIDANCE = "Report only what the main assistant needs to know or act on, such as a project file you created or changed. Routine work you repeat on every check, such as keeping notes, logs or scores, is not news; don't report it.";
export declare const FOLLOW_UP_GUIDANCE = "Compare feedback about the same issue. Do not repeat feedback still waiting for delivery or a problem that is already fixed. A problem that remains does not prove the feedback was ignored. Follow up only with evidence that the problem still applies after checking the visible response, or with new evidence that changes the finding. Follow this head's rules on repeating feedback too.";
/** The answering rules plus what has already been delivered, sent separately. */
export declare function buildEnumeratedJudgeObservationEnvelope(head: string, context: DeliveryContext, deliveryGuidance?: string): string;
/** The same, folded into one message with the instruction. */
export declare function buildEnumeratedJudgeObservationPrompt(head: string, instruction: string, context: DeliveryContext, deliveryGuidance?: string): string;
export interface EnumeratedDecisionResult {
    decisions: Decision[] | null;
    error: string | null;
}
/**
 * Splits a head's numbered findings into at most two groups: what only the
 * user sees, and what the agent is told.
 *
 * Every message ends up in exactly one group. An interrupt raises the urgency
 * of the agent's group only. It never drags a user-only finding into the
 * agent's context, which would leak something the head chose not to send.
 */
export declare function parseEnumeratedDecision(text: string): EnumeratedDecisionResult;
/**
 * On Anthropic the head writes its decision as JSON instead of calling a tool.
 * Tool calls were measured costing noticeably more output and time, even for
 * heads with no tools to use, while the JSON came back reliably.
 *
 * This is only about how the decision comes back. Doing actual work, and
 * adding or removing heads, still goes through tools.
 */
export declare function buildAnthropicObservationPrompt(head: string, instruction: string, tools: string[] | undefined, options?: ObservationProtocolOptions): string;
/**
 * Sent as a developer message. The head's instructions stay in the adjacent
 * user message; this message explains tools and how to finish.
 */
export declare function buildObservationEnvelope(head: string, tools: string[] | undefined, options?: ObservationProtocolOptions): string;
/** Keep the same completion contract when OpenAI needs one combined user message. */
export declare function buildOpenAIObservationPrompt(head: string, instruction: string, tools: string[] | undefined, options?: ObservationProtocolOptions): string;
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
export declare function sanitizeHeadSet(requested: string[], catalog: HeadCatalog): {
    heads: string[];
    unknown: string[];
};
/**
 * Reads the saved head list, whichever of the three shapes it is in. `lenses`
 * and `lens` are what older sessions wrote before the rename.
 *
 * An empty list is respected as "the user turned everything off". Null means
 * nothing was saved at all, which is a different thing and is treated
 * differently by the caller.
 */
export declare function savedHeadList(config: {
    heads?: unknown;
    lenses?: unknown;
    lens?: unknown;
}): string[] | null;
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
export declare function selectFinalAssistant<T extends FinalAssistantCandidate>(messages: T[], responseTimestamp: number | null): T | null;
/**
 * Whether the driver sends its whole conversation on every request.
 *
 * That is the condition for sharing a cache session with it. A driver that
 * sends everything never asks the server to continue from an earlier reply, so
 * there is nothing an observation can knock out from under it.
 *
 * Written to accept only known values, because this comes out of a settings
 * file the user can edit. Anything unrecognized has to count as unsafe.
 */
export declare function isFullInputTransport(transport: string): boolean;
/**
 * The one place that decides whether cache sharing has to stop: null while it
 * is still safe, otherwise the reason, in words a user can read.
 *
 * Kept in one place because that same sentence is also what stops the warning
 * being printed twice.
 */
export declare function classifyCodexShareLoss(transport: string): string | null;
/**
 * The one symptom known to mean that observing inside the driver's session has
 * broken the driver. Whatever reads this stops sharing for good.
 */
export declare function hasDriverContinuationError(messages: FinalAssistantCandidate[]): boolean;
/** Shutdown grace from its raw env value: 0 means "don't wait"; unset or invalid falls back. */
export declare function parseShutdownGrace(raw: string | undefined, fallback: number): number;
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
export declare function isAnthropicPayload(value: unknown): value is AnthropicPayload;
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
export declare function mergeObservationPayload(captured: AnthropicPayload, tail: PayloadMessage[], envelope?: string): AnthropicPayload;
export interface OpenAIResponsesPayload {
    input: unknown[];
    [key: string]: unknown;
}
export declare function isOpenAIResponsesPayload(value: unknown): value is OpenAIResponsesPayload;
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
 * are in the OpenAI section of docs/providers.md.
 *
 * There is no explicit Anthropic-style pre-warm here: a cache mark is legal
 * only on input, never on what the model wrote. Current Codex accounting still
 * charges a run-end observation for the newest turn plus its own tail; implicit
 * caching and shared-session routing determine what later requests can reuse.
 *
 * Any marks pi-ai might add are removed, since on this provider the right
 * number of them is none.
 */
export declare function mergeOpenAIObservationPayload(captured: OpenAIResponsesPayload, tail: unknown[], envelope?: string): OpenAIResponsesPayload;
