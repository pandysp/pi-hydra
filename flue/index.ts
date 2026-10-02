/**
 * pi-hydra heads for Flue agents.
 *
 * When a watched agent is about to finish a response, every head reviews it: the agent's last
 * provider request is replayed byte for byte (a cache read) with the agent's final turn and the
 * head's instruction appended, exactly as pi-hydra does in pi. Findings the agent must act on are
 * appended to the response as one `pi-hydra` signal, so the agent continues and corrects before
 * the response settles; notes for people are written to the conversation log.
 *
 * Wiring: `createFlueHydra()` once, `hydra.wrap(provider)` for the agent's model provider, and
 * `hydra.useHydra()` inside the agent function. See ../docs/flue.md.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { instrument, useAgentFinish } from "@flue/runtime";
import type { AgentFinishContext, FlueInstrumentation } from "@flue/runtime";
import type { AssistantMessage, Message, Model, Provider, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { DeliveryLedger } from "../delivery.ts";
import { classifyJudgeResponse, JUDGE_ERROR_DESCRIPTIONS } from "../judge.ts";
import type { JudgeErrorKind } from "../judge.ts";
import {
	buildEnumeratedJudgeObservationEnvelope,
	buildEnumeratedJudgeObservationPrompt,
	headActs,
	headInstructions,
	isAnthropicPayload,
	isOpenAIResponsesPayload,
	mergeObservationPayload,
	mergeOpenAIObservationPayload,
	parseHeadFile,
	usesSplitObservationHandoff,
} from "../utils.ts";
import type { Decision, HeadDefinition, ObservationUsage } from "../utils.ts";

/** What print, steer and interrupt do here; heads are told this instead of pi's behaviour. */
export const FLUE_DELIVERY_GUIDANCE =
	'"print" writes a note to the conversation log for the people watching; the main assistant will not see it. Use "steer" when the main assistant needs the feedback: it reads it before its answer is final and keeps working. "interrupt" is delivered the same way as "steer" here.';

/** Provider APIs whose request shape pi-hydra's merge functions handle. */
const SUPPORTED_APIS = new Set(["anthropic-messages", "openai-codex-responses"]);

export interface FlueHydraOptions {
	/** Paths to pi-hydra head files. Heads must be judges (`tools: []`). */
	heads: string[];
	/** Most `pi-hydra` signals appended to one response; later findings are logged as unresolved. Default 3. */
	maxRounds?: number;
	/** Called once per head check. */
	onRecord?: (record: HydraRecord) => void;
}

export interface HydraRecord {
	conversationId: string;
	head: string;
	/** Which append round of the response this check belongs to (0 = the response's first finish). */
	round: number;
	outcome: "findings" | "none" | "failed";
	findings: Decision[];
	errorKind: JudgeErrorKind | "no-capture" | "unsupported-api" | "unexpected-payload" | "exception" | null;
	error: string | null;
	usage: ObservationUsage | null;
	durationMs: number;
}

export interface FlueHydra {
	/** The same provider, recording each main-conversation request so heads can replay it. */
	wrap(provider: Provider): Provider;
	/** Call inside the agent function: reviews each response before it settles. */
	useHydra(): void;
	/** Removes Hydra's Flue instrumentation and closes the provider sessions it kept open. Call at shutdown. */
	close(): Promise<void>;
}

interface Scope {
	type: string;
	turnId?: string;
	conversationId?: string;
	harness?: string;
	session?: string;
	taskId?: string;
}

interface Capture {
	payload: unknown;
	model: Model<any>;
	provider: Provider;
	apiKey?: string;
	headers?: Record<string, string | null>;
	/** Codex: the driver's provider session and transport, which heads share. */
	sharedSession?: { sessionId: string; transport: "websocket" | "sse" };
}

// Codex routes its cache by provider session, so heads hit the driver's cache dependably only on
// the driver's session. That is safe only while the driver sends its full input every turn; with
// pi-ai's default `auto` (continuation) a head on the same session can break the driver's next
// request. docs/providers.md#session-sharing has the measurements.
const FULL_INPUT_TRANSPORTS = new Set(["websocket", "sse"]);

interface Conversation {
	capture: Capture | null;
	/** The final turn after the captured request: its assistant message and tool results. */
	tail: Message[] | null;
	rounds: number;
	ledger: DeliveryLedger;
}

function loadHead(path: string): HeadDefinition {
	const parsed = parseHeadFile(readFileSync(path, "utf8"));
	if ("error" in parsed) throw new Error(`pi-hydra: invalid head file ${path}: ${parsed.error}`);
	if (headActs(parsed.head.tools)) {
		throw new Error(`pi-hydra: head ${parsed.head.name} (${path}) uses tools; Flue runs judge heads only (set \`tools: []\`).`);
	}
	return parsed.head;
}

// A model call of an agent's own conversation. Subagent tasks and harness scratch prompts run in
// conversations of their own, which no head reviews; skipping them keeps Hydra from holding a copy
// of each of their requests. Compaction shares the conversation and is excluded by turn purpose.
const isMainConversation = (scope: Scope | undefined): scope is Scope & { conversationId: string; turnId: string } =>
	scope?.type === "model" &&
	typeof scope.conversationId === "string" &&
	typeof scope.turnId === "string" &&
	scope.harness === "default" &&
	scope.session === "default" &&
	scope.taskId === undefined;

const usageOf = (usage: AssistantMessage["usage"]): ObservationUsage => ({
	input: usage.input,
	output: usage.output,
	cacheRead: usage.cacheRead,
	cacheWrite: usage.cacheWrite,
	cost: usage.cost.total,
});

const modelMessages = (messages: readonly { role: string }[]): Message[] =>
	messages.filter((message): message is Message => ["user", "assistant", "toolResult"].includes(message.role));

export function createFlueHydra(options: FlueHydraOptions): FlueHydra {
	const heads = options.heads.map(loadHead);
	if (heads.length === 0) throw new Error("pi-hydra: no heads given.");
	const maxRounds = options.maxRounds ?? 3;
	const scope = new AsyncLocalStorage<Scope>();
	// Purpose of each model turn, reported before its provider call: only `agent` turns are the
	// conversation itself (compaction calls share its harness and session).
	const purposes = new Map<string, string>();
	const conversations = new Map<string, Conversation>();
	// Codex sessions whose sockets Hydra kept open by choosing the WebSocket transport; close()
	// releases them so the process can exit.
	const sessions = new Set<string>();

	const conversation = (id: string): Conversation => {
		let state = conversations.get(id);
		if (!state) conversations.set(id, (state = { capture: null, tail: null, rounds: 0, ledger: new DeliveryLedger() }));
		return state;
	};

	const instrumentation: FlueInstrumentation = {
		key: Symbol("pi-hydra"),
		observe(event) {
			if (event.type === "turn_request" && event.turnId) purposes.set(event.turnId, event.purpose);
			if (event.type === "turn_messages" && event.purpose === "agent" && event.conversationId) {
				const state = conversations.get(event.conversationId);
				if (state) state.tail = modelMessages([event.message, ...event.toolResults]);
			}
		},
		interceptor: (operation, ctx, next) =>
			scope.run(
				{
					type: operation.type,
					turnId: operation.type === "model" ? operation.turnId : undefined,
					conversationId: ctx.conversationId,
					harness: ctx.harness,
					session: ctx.session,
					taskId: ctx.taskId,
				},
				next,
			),
		dispose() {
			conversations.clear();
			purposes.clear();
		},
	};
	const uninstall = instrument(instrumentation);

	function wrap(provider: Provider): Provider {
		const record = (model: Model<any>, options: SimpleStreamOptions | undefined): SimpleStreamOptions | undefined => {
			const current = scope.getStore();
			if (!isMainConversation(current)) return options;
			const purpose = purposes.get(current.turnId);
			purposes.delete(current.turnId);
			if (purpose !== "agent") return options;
			const state = conversation(current.conversationId);
			const codex = model.api === "openai-codex-responses";
			// Flue leaves the transport to pi-agent-core, whose default is `auto`; for Codex run the driver on
			// a full-input transport instead, so heads can share its session.
			const transport = codex && (options?.transport === undefined || options.transport === "auto") ? "websocket" : options?.transport;
			let sharedSession: Capture["sharedSession"];
			if (codex) {
				if (!options?.sessionId || !FULL_INPUT_TRANSPORTS.has(transport as string)) {
					throw new Error(`pi-hydra: heads need a Codex session id and a full-input transport (websocket or sse); got ${transport ?? "none"}${options?.sessionId ? "" : " without a session id"}.`);
				}
				sharedSession = { sessionId: options.sessionId, transport: transport as "websocket" | "sse" };
				sessions.add(options.sessionId);
			}
			return {
				...options,
				transport,
				// Record the body actually sent: after any callback the caller passed has replaced or
				// changed it (Flue 2.2.2 passes none).
				onPayload: async (params, model) => {
					const replaced = options?.onPayload ? await options.onPayload(params, model) : undefined;
					state.capture = { payload: structuredClone(replaced ?? params), model, provider, apiKey: options?.apiKey, headers: options?.headers, sharedSession };
					state.tail = null;
					return replaced;
				},
			};
		};
		// Flue sends every model call through streamSimple; a call that bypassed it would show up as a
		// "no recorded request" warning at the response's finish, never as a silent skip.
		return { ...provider, streamSimple: (model, context, options) => provider.streamSimple(model, context, record(model, options)) };
	}

	async function check(head: HeadDefinition, state: Conversation, conversationId: string, signal: AbortSignal): Promise<HydraRecord> {
		const startedAt = Date.now();
		const result = (outcome: HydraRecord["outcome"], fields: Partial<HydraRecord>): HydraRecord => ({
			conversationId, head: head.name, round: state.rounds, outcome, findings: [], errorKind: null, error: null, usage: null,
			durationMs: Date.now() - startedAt, ...fields,
		});
		const capture = state.capture!;
		const api = capture.model.api as string;
		const context = state.ledger.contextFor(head.name);
		const split = usesSplitObservationHandoff(api);
		const prompt = split
			? headInstructions(head.prompt)
			: buildEnumeratedJudgeObservationPrompt(head.name, head.prompt, context, FLUE_DELIVERY_GUIDANCE);
		const envelope = split ? buildEnumeratedJudgeObservationEnvelope(head.name, context, FLUE_DELIVERY_GUIDANCE) : undefined;
		const anthropic = api === "anthropic-messages";
		if (anthropic ? !isAnthropicPayload(capture.payload) : !isOpenAIResponsesPayload(capture.payload)) {
			return result("failed", { errorKind: "unexpected-payload", error: `the recorded ${api} request has an unexpected shape` });
		}
		// pi-ai serializes only the added messages; the merge appends them to the captured request.
		const merge = (built: unknown): unknown => {
			if (anthropic && isAnthropicPayload(built)) return mergeObservationPayload(capture.payload as never, built.messages, envelope);
			if (!anthropic && isOpenAIResponsesPayload(built)) return mergeOpenAIObservationPayload(capture.payload as never, built.input, envelope);
			throw new Error(`pi-ai built an unexpected ${api} request for the head`);
		};
		try {
			const response = await capture.provider
				.streamSimple(
					capture.model,
					normalizeContext({ messages: [...(state.tail ?? []), { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }], tools: [] }),
					{
						apiKey: capture.apiKey,
						headers: capture.headers,
						sessionId: capture.sharedSession?.sessionId,
						transport: capture.sharedSession?.transport,
						signal,
						onPayload: merge,
					},
				)
				.result();
			const judged = classifyJudgeResponse(response);
			const usage = usageOf(response.usage);
			if (judged.errorKind) {
				return result("failed", { errorKind: judged.errorKind, error: judged.parseError ?? response.errorMessage ?? JUDGE_ERROR_DESCRIPTIONS[judged.errorKind], usage });
			}
			const findings = (judged.decisions ?? []).filter((decision) => decision.action !== "noop" && decision.message);
			return result(findings.length ? "findings" : "none", { findings, usage });
		} catch (error) {
			return result("failed", { errorKind: "exception", error: error instanceof Error ? error.message : String(error) });
		}
	}

	async function review(ctx: AgentFinishContext): Promise<void> {
		const current = scope.getStore();
		const conversationId = current?.conversationId;
		const state = conversationId ? conversations.get(conversationId) : undefined;
		const report = (record: HydraRecord) => {
			options.onRecord?.(record);
			if (record.outcome === "failed") ctx.log.warn(`[pi-hydra ${record.head}] check failed: ${record.error}`, { errorKind: record.errorKind });
		};
		const failAll = (id: string, round: number, errorKind: HydraRecord["errorKind"], error: string) => {
			for (const head of heads) report({ conversationId: id, head: head.name, round, outcome: "failed", findings: [], errorKind, error, usage: null, durationMs: 0 });
		};
		if (!conversationId || !state?.capture) {
			failAll(conversationId ?? "unknown", 0, "no-capture", "no recorded request for this response; is the agent's provider wrapped with hydra.wrap()?");
			return;
		}
		if (!SUPPORTED_APIS.has(state.capture.model.api as string)) {
			failAll(conversationId, state.rounds, "unsupported-api", `provider API ${state.capture.model.api} is not supported (anthropic-messages, openai-codex-responses)`);
			conversations.delete(conversationId);
			return;
		}
		const records = await Promise.all(heads.map((head) => check(head, state, conversationId, ctx.signal)));
		const steers: { head: string; decision: Decision }[] = [];
		for (const record of records) {
			report(record);
			for (const decision of record.findings) {
				if (decision.action === "print") {
					ctx.log.info(`[pi-hydra ${record.head}] ${decision.message}`, { head: record.head, reason: decision.reason });
					state.ledger.succeed({ head: record.head, delivery: "print", message: decision.message });
				} else steers.push({ head: record.head, decision });
			}
		}
		if (steers.length === 0) {
			conversations.delete(conversationId);
			return;
		}
		const body = steers.map(({ head, decision }) => `[pi-hydra ${head}] ${decision.message}`).join("\n");
		if (state.rounds >= maxRounds) {
			ctx.log.warn(`[pi-hydra] unresolved after ${maxRounds} rounds of feedback; the response settles with these findings open:\n${body}`);
			conversations.delete(conversationId);
			return;
		}
		ctx.append({ kind: "signal", type: "pi-hydra", tagName: "pi-hydra", body });
		for (const { head, decision } of steers) state.ledger.succeed({ head, delivery: "steer", message: decision.message });
		state.rounds++;
	}

	return {
		wrap,
		useHydra: () => useAgentFinish(review),
		close: async () => {
			await uninstall();
			for (const sessionId of sessions) cleanupSessionResources(sessionId);
		},
	};
}
