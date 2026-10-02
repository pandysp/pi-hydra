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
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { DeliveryLedger } from "../delivery.js";
import { classifyJudgeResponse, JUDGE_ERROR_DESCRIPTIONS } from "../judge.js";
import { buildEnumeratedJudgeObservationEnvelope, buildEnumeratedJudgeObservationPrompt, headActs, headInstructions, isAnthropicPayload, isOpenAIResponsesPayload, mergeObservationPayload, mergeOpenAIObservationPayload, parseHeadFile, usesSplitObservationHandoff, } from "../utils.js";
/** What print, steer and interrupt do here; heads are told this instead of pi's behaviour. */
export const FLUE_DELIVERY_GUIDANCE = '"print" writes a note to the conversation log for the people watching; the main assistant will not see it. Use "steer" when the main assistant needs the feedback: it reads it before its answer is final and keeps working. "interrupt" is delivered the same way as "steer" here.';
/** Provider APIs whose request shape pi-hydra's merge functions handle. */
const SUPPORTED_APIS = new Set(["anthropic-messages", "openai-codex-responses"]);
// Codex routes its cache by provider session, so heads hit the driver's cache dependably only on
// the driver's session. That is safe only while the driver sends its full input every turn; with
// pi-ai's default `auto` (continuation) a head on the same session can break the driver's next
// request. docs/providers.md#session-sharing has the measurements.
const FULL_INPUT_TRANSPORTS = new Set(["websocket", "sse"]);
function loadHead(path) {
    const parsed = parseHeadFile(readFileSync(path, "utf8"));
    if ("error" in parsed)
        throw new Error(`pi-hydra: invalid head file ${path}: ${parsed.error}`);
    if (headActs(parsed.head.tools)) {
        throw new Error(`pi-hydra: head ${parsed.head.name} (${path}) uses tools; Flue runs judge heads only (set \`tools: []\`).`);
    }
    return parsed.head;
}
// A model call of an agent's own conversation. Subagent tasks and harness scratch prompts run in
// conversations of their own, which no head reviews; skipping them keeps Hydra from holding a copy
// of each of their requests. Compaction shares the conversation and is excluded by turn purpose.
const isMainConversation = (scope) => scope?.type === "model" &&
    typeof scope.conversationId === "string" &&
    typeof scope.turnId === "string" &&
    scope.harness === "default" &&
    scope.session === "default" &&
    scope.taskId === undefined;
const usageOf = (usage) => ({
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cost: usage.cost.total,
});
const modelMessages = (messages) => messages.filter((message) => ["user", "assistant", "toolResult"].includes(message.role));
export function createFlueHydra(options) {
    const heads = options.heads.map(loadHead);
    if (heads.length === 0)
        throw new Error("pi-hydra: no heads given.");
    const maxRounds = options.maxRounds ?? 3;
    const scope = new AsyncLocalStorage();
    // Purpose of each model turn, reported before its provider call: only `agent` turns are the
    // conversation itself (compaction calls share its harness and session).
    const purposes = new Map();
    const conversations = new Map();
    // Codex sessions whose sockets Hydra kept open by choosing the WebSocket transport; close()
    // releases them so the process can exit.
    const sessions = new Set();
    const conversation = (id) => {
        let state = conversations.get(id);
        if (!state)
            conversations.set(id, (state = { capture: null, tail: null, rounds: 0, ledger: new DeliveryLedger() }));
        return state;
    };
    const instrumentation = {
        key: Symbol("pi-hydra"),
        observe(event) {
            if (event.type === "turn_request" && event.turnId)
                purposes.set(event.turnId, event.purpose);
            if (event.type === "turn_messages" && event.purpose === "agent" && event.conversationId) {
                const state = conversations.get(event.conversationId);
                if (state)
                    state.tail = modelMessages([event.message, ...event.toolResults]);
            }
        },
        interceptor: (operation, ctx, next) => scope.run({
            type: operation.type,
            turnId: operation.type === "model" ? operation.turnId : undefined,
            conversationId: ctx.conversationId,
            harness: ctx.harness,
            session: ctx.session,
            taskId: ctx.taskId,
        }, next),
        dispose() {
            conversations.clear();
            purposes.clear();
        },
    };
    const uninstall = instrument(instrumentation);
    function wrap(provider) {
        const record = (model, options) => {
            const current = scope.getStore();
            if (!isMainConversation(current))
                return options;
            const purpose = purposes.get(current.turnId);
            purposes.delete(current.turnId);
            if (purpose !== "agent")
                return options;
            const state = conversation(current.conversationId);
            const codex = model.api === "openai-codex-responses";
            // Flue leaves the transport to pi-agent-core, whose default is `auto`; for Codex run the driver on
            // a full-input transport instead, so heads can share its session.
            const transport = codex && (options?.transport === undefined || options.transport === "auto") ? "websocket" : options?.transport;
            let sharedSession;
            if (codex) {
                if (!options?.sessionId || !FULL_INPUT_TRANSPORTS.has(transport)) {
                    throw new Error(`pi-hydra: heads need a Codex session id and a full-input transport (websocket or sse); got ${transport ?? "none"}${options?.sessionId ? "" : " without a session id"}.`);
                }
                sharedSession = { sessionId: options.sessionId, transport: transport };
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
    async function check(head, state, conversationId, signal) {
        const startedAt = Date.now();
        const result = (outcome, fields) => ({
            conversationId, head: head.name, round: state.rounds, outcome, findings: [], errorKind: null, error: null, usage: null,
            durationMs: Date.now() - startedAt, ...fields,
        });
        const capture = state.capture;
        const api = capture.model.api;
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
        const merge = (built) => {
            if (anthropic && isAnthropicPayload(built))
                return mergeObservationPayload(capture.payload, built.messages, envelope);
            if (!anthropic && isOpenAIResponsesPayload(built))
                return mergeOpenAIObservationPayload(capture.payload, built.input, envelope);
            throw new Error(`pi-ai built an unexpected ${api} request for the head`);
        };
        try {
            const response = await capture.provider
                .streamSimple(capture.model, normalizeContext({ messages: [...(state.tail ?? []), { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }], tools: [] }), {
                apiKey: capture.apiKey,
                headers: capture.headers,
                sessionId: capture.sharedSession?.sessionId,
                transport: capture.sharedSession?.transport,
                signal,
                onPayload: merge,
            })
                .result();
            const judged = classifyJudgeResponse(response);
            const usage = usageOf(response.usage);
            if (judged.errorKind) {
                return result("failed", { errorKind: judged.errorKind, error: judged.parseError ?? response.errorMessage ?? JUDGE_ERROR_DESCRIPTIONS[judged.errorKind], usage });
            }
            const findings = (judged.decisions ?? []).filter((decision) => decision.action !== "noop" && decision.message);
            return result(findings.length ? "findings" : "none", { findings, usage });
        }
        catch (error) {
            return result("failed", { errorKind: "exception", error: error instanceof Error ? error.message : String(error) });
        }
    }
    async function review(ctx) {
        const current = scope.getStore();
        const conversationId = current?.conversationId;
        const state = conversationId ? conversations.get(conversationId) : undefined;
        const report = (record) => {
            options.onRecord?.(record);
            if (record.outcome === "failed")
                ctx.log.warn(`[pi-hydra ${record.head}] check failed: ${record.error}`, { errorKind: record.errorKind });
        };
        const failAll = (id, round, errorKind, error) => {
            for (const head of heads)
                report({ conversationId: id, head: head.name, round, outcome: "failed", findings: [], errorKind, error, usage: null, durationMs: 0 });
        };
        if (!conversationId || !state?.capture) {
            failAll(conversationId ?? "unknown", 0, "no-capture", "no recorded request for this response; is the agent's provider wrapped with hydra.wrap()?");
            return;
        }
        if (!SUPPORTED_APIS.has(state.capture.model.api)) {
            failAll(conversationId, state.rounds, "unsupported-api", `provider API ${state.capture.model.api} is not supported (anthropic-messages, openai-codex-responses)`);
            conversations.delete(conversationId);
            return;
        }
        const records = await Promise.all(heads.map((head) => check(head, state, conversationId, ctx.signal)));
        const steers = [];
        for (const record of records) {
            report(record);
            for (const decision of record.findings) {
                if (decision.action === "print") {
                    ctx.log.info(`[pi-hydra ${record.head}] ${decision.message}`, { head: record.head, reason: decision.reason });
                    state.ledger.succeed({ head: record.head, delivery: "print", message: decision.message });
                }
                else
                    steers.push({ head: record.head, decision });
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
        for (const { head, decision } of steers)
            state.ledger.succeed({ head, delivery: "steer", message: decision.message });
        state.rounds++;
    }
    return {
        wrap,
        useHydra: () => useAgentFinish(review),
        close: async () => {
            await uninstall();
            for (const sessionId of sessions)
                cleanupSessionResources(sessionId);
        },
    };
}
