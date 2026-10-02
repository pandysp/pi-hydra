import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore, Type } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { streamSimple as nativeAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as nativeOpenAI } from "@earendil-works/pi-ai/api/openai-responses";
import type { AssistantMessage, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ExtensionError } from "@earendil-works/pi-coding-agent";
import hydraExtension from "./index.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

// A real Anthropic SSE response, consumed by pi-ai's own serializer/parser.
// No network server: only the fetch boundary is replaced.
function response(content: AssistantMessage["content"], largeUsage = false): Response {
	const events: unknown[] = [{ type: "message_start", message: {
		id: "msg_fixture", type: "message", role: "assistant", model: "fixture", content: [], stop_reason: null, stop_sequence: null,
		usage: { input_tokens: largeUsage ? 10000 : 10, output_tokens: 0, cache_read_input_tokens: largeUsage ? 0 : 90, cache_creation_input_tokens: 0 },
	} }];
	for (const [index, block] of content.entries()) {
		if (block.type === "toolCall") {
			events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
			events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.arguments) } });
		} else if (block.type === "text") {
			events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
			events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
		} else throw new Error("Unsupported fixture block");
		events.push({ type: "content_block_stop", index });
	}
	events.push({ type: "message_delta", delta: { stop_reason: content.some(b => b.type === "toolCall") ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
	events.push({ type: "message_stop" });
	return new Response(events.map(event => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

async function delayedResponse(content: AssistantMessage["content"], largeUsage = false): Promise<Response> {
	const encoded = await response(content, largeUsage).text();
	const split = encoded.indexOf("\n\n") + 2;
	const encoder = new TextEncoder();
	return new Response(new ReadableStream({
		async start(controller) {
			controller.enqueue(encoder.encode(encoded.slice(0, split)));
			await new Promise(resolve => setTimeout(resolve, 1400));
			controller.enqueue(encoder.encode(encoded.slice(split)));
			controller.close();
		},
	}), { headers: { "content-type": "text/event-stream" } });
}

function openaiResponse(text: string, largeUsage = false): Response {
	const item = { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
	const events = [
		{ type: "response.created", response: { id: "resp_fixture" } },
		{ type: "response.output_item.added", output_index: 0, item },
		{ type: "response.output_text.delta", output_index: 0, delta: text },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { id: "resp_fixture", model: "gpt-6.1-sol", status: "completed", output: [item], usage: { input_tokens: largeUsage ? 10000 : 100, output_tokens: 10, total_tokens: largeUsage ? 10010 : 110, input_tokens_details: { cached_tokens: 0 } } } },
	];
	return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}

async function delayedOpenaiResponse(text: string, largeUsage = false): Promise<Response> {
	const encoded = await openaiResponse(text, largeUsage).text();
	const split = encoded.indexOf("\n\n") + 2;
	const encoder = new TextEncoder();
	return new Response(new ReadableStream({
		async start(controller) {
			controller.enqueue(encoder.encode(encoded.slice(0, split)));
			await new Promise(resolve => setTimeout(resolve, 1400));
			controller.enqueue(encoder.encode(encoded.slice(split)));
			controller.close();
		},
	}), { headers: { "content-type": "text/event-stream" } });
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

interface CaptureProbe {
	slowHeaders?: boolean;
	earlierAsyncCallback?: boolean;
	lateWarmHook?: boolean;
	finalTransform?: boolean;
	driverOutputCap?: number;
	directApi?: boolean;
}

interface ConsumerOptions {
  busy?: boolean;
  firstObserverResponse?: AssistantMessage["content"];
  headTools?: string;
  apiKey?: string;
  slowFinalResponse?: boolean;
  warmDecision?: "warm" | "stop" | "default";
  highEconomics?: boolean;
  delayTurnEnd?: boolean;
  openai?: boolean;
  delayNextRequest?: boolean;
  /** The first real request fails as overloaded; Pi retries it after this delay. */
  retryAfterMs?: number;
  probe?: CaptureProbe;
}

async function consumer(options: ConsumerOptions = {}) {
  const { busy = false, firstObserverResponse, headTools = "[]", apiKey = "fixture-key", slowFinalResponse = false,
    warmDecision = "warm", highEconomics = false, delayTurnEnd = false, openai = false, delayNextRequest = false,
    retryAfterMs, probe = {} } = options;
	const cwd = mkdtempSync(join(process.cwd(), ".consumer-test-"));
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, ".pi", "hydra"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "hydra", "critic.md"), `---\nname: critic\ndescription: Fixture\ntools: ${headTools}\nautostart: true\n---\nCheck the visible work.\n`);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_OFFLINE", "1");
	initTheme("dark", false);
	// Keep Hydra's headless warnings out of the test output.
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	const settingsManager = SettingsManager.inMemory({ transport: "websocket", cacheWarming: "streaming", compaction: { enabled: false }, retry: retryAfterMs === undefined ? { enabled: false } : { enabled: true, maxRetries: 1, baseDelayMs: retryAfterMs } });
	const credentials = new InMemoryCredentialStore();
	if (openai) await credentials.modify("openai", async () => ({ type: "oauth", access: "fixture-oauth-token", refresh: "fixture-refresh", expires: Date.now() + 86400000 }));
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false });
	const driverPayloads: any[] = [];
	const observerPayloads: any[] = [];
	const foregroundPayloads: any[] = [];
	let activeContext: ExtensionContext | undefined;
	const warmEntered = deferred();
	const resumeWarm = deferred();
	const lateWarmDelivered = deferred();
	const thirdPrepared = deferred();
	const timeline: string[] = [];
	const hold = deferred();
	const entered = deferred();
	const finalDriver = deferred();
	let pauseFinalDriver = false;
	let repeatFailure = false;
	let observerHold: Promise<void> | null = null;
	const fetchFixture = vi.fn(async (input: string | URL | Request, init?: RequestInit, foreground = false) => {
		const request = new Request(input, init);
		const payload = await request.json();
		const observing = JSON.stringify(payload.messages ?? payload.input).includes("You are reviewing the main assistant's work");
		if (foreground && !observing) foregroundPayloads.push(payload);
		if (!observing) timeline.push(foreground ? "driver" : "warm");
		if (openai) {
			if (observing) {
				observerPayloads.push(payload);
				return openaiResponse('{"findings":[]}', highEconomics);
			}
			driverPayloads.push(payload);
			return slowFinalResponse && driverPayloads.length === 1
				? delayedOpenaiResponse("Driver done.", highEconomics)
				: openaiResponse("Driver done.", highEconomics);
		}
		if (observing) {
			observerPayloads.push(payload);
			await observerHold;
			if (highEconomics) return response([{ type: "text", text: '{"findings":[]}' }]);
			if (observerPayloads.length === 1 && firstObserverResponse) return response(firstObserverResponse);
			if (observerPayloads.length === 1 || repeatFailure) return response([{ type: "toolCall", id: "blocked-write", name: "write", arguments: { path: "observer.txt", content: "PRIVATE-ARGUMENT" } }]);
			return response([{ type: "text", text: '{"findings":[]}' }]);
		}
		driverPayloads.push(payload);
		const realRequestCount = foregroundPayloads.length;
		const finalRequest = (busy ? 3 : 1) + (retryAfterMs === undefined ? 0 : 1);
		if (retryAfterMs !== undefined && foreground && realRequestCount === 1) {
			return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status: 529, headers: { "content-type": "application/json" } });
		}
		if (busy && foreground && realRequestCount <= 2) return response([{ type: "toolCall", id: `checkpoint-${realRequestCount}`, name: "checkpoint", arguments: {} }], highEconomics);
		if (foreground && realRequestCount === finalRequest) {
			thirdPrepared.resolve();
			if (pauseFinalDriver) await finalDriver.promise;
			if (probe.slowHeaders) await new Promise(resolve => setTimeout(resolve, 1400));
		}
		return slowFinalResponse && foreground && realRequestCount === finalRequest
			? delayedResponse([{ type: "text", text: "Driver done." }], highEconomics)
			: response([{ type: "text", text: "Driver done." }], highEconomics);
	});
	function requestFixture(model: Model<any>, context: any, options?: SimpleStreamOptions) {
		// Test oracle, not a Hydra rule: the agent loop's requests carry the run's
		// abort signal; Pi's warmer uses its own.
		const driver = options?.signal !== undefined && options.signal === activeContext?.signal && options.sessionId === sm.getSessionId();
		const prepared = { ...options, fetch: (input: string | URL | Request, init?: RequestInit) => fetchFixture(input, init, driver) };
		if (probe.directApi) return openai ? nativeOpenAI(model, context, prepared) : nativeAnthropic(model, context, prepared);
		return streamSimple(model, context, prepared);
	}
	if (openai) modelRuntime.registerProvider("openai", {
		api: "openai-responses",
		streamSimple: requestFixture,
	});
	else modelRuntime.registerProvider("anthropic", {
		api: "anthropic-messages", apiKey, baseUrl: "https://fixture.invalid",
		streamSimple: requestFixture,
		models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: highEconomics ? { input: 12, output: 12, cacheRead: 1, cacheWrite: 15 } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096, promptCache: { short: 11, long: 11 } }],
	});
	const model = openai
		? { ...modelRuntime.getModel("openai", "gpt-6.1-sol")!, promptCache: { short: 11, long: 11 }, cost: highEconomics ? { input: 12, output: 12, cacheRead: 1, cacheWrite: 0 } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Model<"openai-responses">
		: modelRuntime.getModel("anthropic", "fixture") as Model<"anthropic-messages">;
	const modelBefore = JSON.stringify(modelRuntime.getModels(openai ? "openai" : "anthropic"));
	let pi!: ExtensionAPI;
	let checkpoints = 0;
	const loader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		systemPrompt: "Fixture driver.",
		extensionFactories: [(api) => {
			pi = api;
			vi.spyOn(pi, "sendMessage");
			vi.spyOn(pi, "sendUserMessage");
			api.on("agent_start", (_event, ctx) => { activeContext = ctx; });
			api.on("turn_start", () => { timeline.push("turn"); });
			api.on("before_provider_request", async (event) => {
				if (probe.earlierAsyncCallback) await new Promise(resolve => setTimeout(resolve, 1));
				if (probe.driverOutputCap !== undefined && (event.payload as any).max_tokens !== 1) {
					return { ...(event.payload as any), max_tokens: probe.driverOutputCap };
				}
				if (probe.lateWarmHook && (event.payload as any).max_tokens === 1) {
					warmEntered.resolve();
					await resumeWarm.promise;
				}
			});
			hydraExtension(pi);
			api.on("before_provider_request", (event) => {
				if (probe.lateWarmHook && (event.payload as any).max_tokens === 1) lateWarmDelivered.resolve();
				if (probe.finalTransform) return { ...(event.payload as any), metadata: { user_id: "last-handler" } };
			});
			api.on("cache_warming_decision", (event) => {
				return warmDecision === "default" ? undefined : { action: warmDecision };
			});
			if (delayTurnEnd) api.on("turn_end", async () => { await new Promise(resolve => setTimeout(resolve, 1400)); });
			if (delayNextRequest) {
				let contextCalls = 0;
				api.on("context", async () => {
					contextCalls++;
					if (contextCalls === 2) await new Promise(resolve => setTimeout(resolve, 1400));
				});
			}
			api.registerTool({ name: "checkpoint", label: "Checkpoint", description: "Test checkpoint", parameters: Type.Object({}),
				execute: async () => {
					checkpoints++;
					if (checkpoints === 2) { entered.resolve(); await hold.promise; }
					return { content: [{ type: "text", text: "Continue" }], details: {} };
				},
			});
		}],
	});
	await loader.reload();
	const sm = SessionManager.create(cwd, join(cwd, "sessions"));
	const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model, settingsManager, sessionManager: sm, resourceLoader: loader, tools: ["checkpoint", "write", "hydra"], thinkingLevel: "off" });
	const errors: ExtensionError[] = [];
	await session.bindExtensions({ onError: error => errors.push(error) });
	expect(errors).toEqual([]);
	cleanups.push(async () => {
		hold.resolve();
		finalDriver.resolve();
		resumeWarm.resolve();
		await session.waitForIdle();
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
		await modelRuntime.refresh({ allowNetwork: false });
		rmSync(cwd, { recursive: true, force: true });
	});
	const entries = (type: string) => sm.getBranch().filter(e => (e.type === "custom" || e.type === "custom_message") && e.customType === type);
	return { cwd, pi, session, sm, modelRuntime, model, modelBefore, driverPayloads, observerPayloads, foregroundPayloads, timeline, hold, entered, errors, entries, warmEntered, resumeWarm, lateWarmDelivered, thirdPrepared,
		repeatFailure: () => { repeatFailure = true; },
		holdObserver: (until: Promise<void>) => { observerHold = until; },
		holdFinalDriver: () => { pauseFinalDriver = true; return finalDriver; },
	};
}

const NOTICE = "automatic notice: A head without tools";
const saved = (h: { sm: SessionManager }, phrase: string) =>
	h.sm.getBranch().filter(e => e.type === "message" && e.message.role === "user" && JSON.stringify(e.message.content).includes(phrase));
const seenIn = (payload: any, phrase: string) =>
	payload.messages.filter((message: any) => message.role === "user" && JSON.stringify(message.content).includes(phrase));

describe("Pi consumer context and session", () => {
	it("a busy error notice is a head steer: saved and read by the next model request", async () => {
		const h = await consumer({ busy: true });
		const running = h.session.prompt("Work through checkpoints.");
		await h.entered.promise;
		await vi.waitFor(() => expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(1));
		expect(h.pi.sendUserMessage).toHaveBeenCalledWith(expect.stringMatching(/^\[pi-hydra critic\] automatic notice: /), { deliverAs: "steer" });
		expect(h.session.isStreaming).toBe(true);
		expect(h.driverPayloads).toHaveLength(2);
		h.hold.resolve();
		await running;
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(h.observerPayloads[0].tools).toEqual(h.driverPayloads[1].tools);
		expect(h.observerPayloads[0].tool_choice).toEqual(h.driverPayloads[1].tool_choice);
		expect(seenIn(h.driverPayloads[2], NOTICE)).toHaveLength(1);
		expect(JSON.stringify(h.driverPayloads[2])).not.toContain("PRIVATE-ARGUMENT");
		// The head's next check reads the notice, so it can correct itself.
		expect(h.observerPayloads.length).toBeGreaterThan(1);
		expect(JSON.stringify(h.observerPayloads.slice(1))).toContain(NOTICE);
		expect(existsSync(join(h.cwd, "observer.txt"))).toBe(false);
		const restored = SessionManager.open(h.sm.getSessionFile()!);
		expect(JSON.stringify(restored.buildSessionContext().messages)).toContain(NOTICE);
		expect(h.errors).toEqual([]);
	});

	it("a late error notice wakes the idle main assistant once; the repeat is not sent", async () => {
		const h = await consumer({});
		h.repeatFailure();
		const gate = deferred();
		h.holdObserver(gate.promise);
		await h.session.prompt("Finish now.");
		await vi.waitFor(() => expect(h.observerPayloads).toHaveLength(1));
		expect(h.session.isIdle).toBe(true);
		gate.resolve();
		await vi.waitFor(() => expect(h.driverPayloads, JSON.stringify({ messages: h.session.messages, errors: h.errors })).toHaveLength(2));
		expect(seenIn(h.driverPayloads[1], NOTICE)).toHaveLength(1);
		expect(JSON.stringify(h.driverPayloads[1])).not.toContain("PRIVATE-ARGUMENT");
		// The woken run ends with its own check, which fails the same way.
		await vi.waitFor(() => expect(h.entries("hydra-call")).toHaveLength(2));
		await h.session.waitForIdle();
		expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(saved(h, NOTICE)).toHaveLength(1);
		expect(h.driverPayloads).toHaveLength(2);
		expect(h.errors).toEqual([]);
	});

	it("an error notice during the final response is read on one additional model call", async () => {
		const h = await consumer({ busy: true });
		const observer = deferred();
		h.holdObserver(observer.promise);
		const driver = h.holdFinalDriver();
		const running = h.session.prompt("Work through checkpoints.");
		try {
			await h.entered.promise;
			h.hold.resolve();
			await vi.waitFor(() => expect(h.driverPayloads).toHaveLength(3));
			observer.resolve();
			await vi.waitFor(() => expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(1));
			expect(h.session.isStreaming).toBe(true);
		} finally {
			observer.resolve();
			driver.resolve();
		}
		await running;
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(h.driverPayloads).toHaveLength(4);
		expect(seenIn(h.driverPayloads[3], NOTICE)).toHaveLength(1);
		expect(saved(h, NOTICE)).toHaveLength(1);
		expect(h.errors).toEqual([]);
	});

	it("a head with tools can use them under a subscription login, where Pi renames tools", async () => {
		// Pi sends Claude Code tool names ("Write") for OAuth keys and maps replies
		// back using the tool list it declares in a system message.
		const h = await consumer({ firstObserverResponse: [{ type: "toolCall", id: "cc-write", name: "Write", arguments: { path: "made-by-head.txt", content: "HEAD" } }], headTools: "write", apiKey: "sk-ant-oat01-fixture" });
		await h.session.prompt("Finish now.");
		await vi.waitFor(() => expect(h.entries("hydra-call")).toHaveLength(1));
		await h.session.waitForIdle();
		expect(existsSync(join(h.cwd, "made-by-head.txt"))).toBe(true);
	});

	it("deliberate observer steering resumes a fully idle main assistant without a user message", async () => {
		const h = await consumer({ firstObserverResponse: [{ type: "text", text: '{"findings":[{"action":"steer","reason":"check","message":"DELIBERATE-STEER"}]}' }] });
		const gate = deferred();
		h.holdObserver(gate.promise);
		await h.session.prompt("Finish now.");
		await vi.waitFor(() => expect(h.observerPayloads).toHaveLength(1));
		expect(h.session.isIdle).toBe(true);
		gate.resolve();
		await vi.waitFor(() => expect(h.driverPayloads, JSON.stringify({ messages: h.session.messages, errors: h.errors })).toHaveLength(2));
		expect(h.pi.sendUserMessage).toHaveBeenCalledWith("[pi-hydra critic] DELIBERATE-STEER", undefined);
		expect(seenIn(h.driverPayloads[1], "DELIBERATE-STEER")).toHaveLength(1);
		await vi.waitFor(() => expect(h.entries("hydra-call")).toHaveLength(2));
		await h.session.waitForIdle();
		expect(h.driverPayloads).toHaveLength(2);
		expect(h.entries("hydra-delivery")).toHaveLength(1);
		expect(h.errors).toEqual([]);
	});

	it("an error notice finishing during shutdown is saved without a main assistant turn", async () => {
		const h = await consumer({});
		const gate = deferred();
		h.holdObserver(gate.promise);
		await h.session.prompt("Finish now.");
		await vi.waitFor(() => expect(h.observerPayloads).toHaveLength(1));
		const shutdown = h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		gate.resolve();
		await shutdown;
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(JSON.stringify(h.entries("hydra-feedback"))).toContain(NOTICE);
		expect(h.driverPayloads).toHaveLength(1);
		expect(h.session.isIdle).toBe(true);
		expect(h.errors).toEqual([]);
	});

	it("does not carry a queued error notice into another branch after abort", async () => {
		const h = await consumer({ busy: true });
		const running = h.session.prompt("Work through checkpoints.");
		await h.entered.promise;
		await vi.waitFor(() => expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(1));
		const aborted = h.session.abort();
		h.hold.resolve();
		await Promise.all([running, aborted]);
		const firstUser = h.sm.getBranch().find(e => e.type === "message" && e.message.role === "user")!;
		await h.session.navigateTree(firstUser.id);
		await h.session.prompt("New branch.");
		await h.session.waitForIdle();
		expect(JSON.stringify(h.driverPayloads.slice(2))).not.toContain(NOTICE);
		expect(saved(h, NOTICE)).toHaveLength(0);
		expect(h.errors).toEqual([]);
	});

	it("Pi reports a rejected steer as an extension error", async () => {
		const h = await consumer({});
		vi.spyOn(h.session, "sendUserMessage").mockRejectedValueOnce(new Error("asynchronous host failure"));
		await h.session.prompt("Finish now.");
		await vi.waitFor(() => expect(h.errors).toContainEqual(expect.objectContaining({ error: "asynchronous host failure" })));
	});

	it("a head removing itself is saved and read by the woken main assistant", async () => {
		const h = await consumer({ firstObserverResponse: [{ type: "toolCall", id: "leave", name: "hydra", arguments: { action: "manage_heads", operation: "remove", head: "critic", message: "WHY-IT-FITS" } }], headTools: "hydra" });
		await h.session.prompt("Finish now.");
		await vi.waitFor(() => expect(h.driverPayloads, JSON.stringify({ messages: h.session.messages, errors: h.errors })).toHaveLength(2));
		expect(seenIn(h.driverPayloads[1], "WHY-IT-FITS")).toHaveLength(1);
		await h.session.waitForIdle();
		expect(saved(h, "WHY-IT-FITS")).toHaveLength(1);
		expect(h.errors).toEqual([]);
	});

	it("a vanished active head is saved and read within the next run", async () => {
		const h = await consumer({ firstObserverResponse: [{ type: "text", text: '{"findings":[]}' }] });
		await h.session.prompt("Finish now.");
		await vi.waitFor(() => expect(h.entries("hydra-call")).toHaveLength(1));
		await h.session.waitForIdle();
		rmSync(join(h.cwd, ".pi", "hydra", "critic.md"));
		await h.session.prompt("Next task.");
		await h.session.waitForIdle();
		const gone = "automatic notice: this head's file is missing or invalid";
		expect(h.driverPayloads.slice(1).some(p => seenIn(p, gone).length === 1)).toBe(true);
		expect(saved(h, gone)).toHaveLength(1);
		expect(h.errors).toEqual([]);
	});
});

const withoutMarkers = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => key === "cache_control" ? undefined : item));
const wireText = (message: any) => typeof message.content === "string" ? message.content
	: message.content.filter((block: any) => block.type === "text" || block.type === "output_text").map((block: any) => block.text).join("\n");
function expectLatestAnswerInHead(h: Awaited<ReturnType<typeof consumer>>, openai = false) {
	const actual = h.session.messages.filter(message => message.role === "assistant").at(-1)!;
	const driver = h.foregroundPayloads.at(-1);
	const head = h.observerPayloads.at(-1);
	const prefix = openai ? driver.input : driver.messages;
	const sent = openai ? head.input : head.messages;
	const answers = sent.slice(prefix.length).filter((message: any) => message.role === "assistant");
	expect(wireText(actual)).toBe("Driver done.");
	expect(answers).toHaveLength(1);
	expect(wireText(answers[0])).toBe(wireText(actual));
}

describe("Hydra-only capture feasibility", () => {
	const warmBetweenTurnAndDriver = (h: Awaited<ReturnType<typeof consumer>>) => {
		const secondTurn = h.timeline.indexOf("turn", h.timeline.indexOf("turn") + 1);
		expect(secondTurn).toBeGreaterThan(0);
		expect(h.timeline.slice(secondTurn, h.timeline.indexOf("driver", secondTurn))).toContain("warm");
	};
	const scenarios: { name: string; options: ConsumerOptions; beforeRelease?: () => Promise<void>; precondition?: (h: Awaited<ReturnType<typeof consumer>>) => void }[] = [
		{ name: "streaming", options: { slowFinalResponse: true, warmDecision: "warm", highEconomics: true } },
		{ name: "delayed finalization", options: { delayTurnEnd: true, warmDecision: "default", highEconomics: true } },
		{ name: "before response headers", options: { busy: true, warmDecision: "default", highEconomics: true, probe: { slowHeaders: true } } },
		{ name: "before the next real request", options: { busy: true, delayNextRequest: true, warmDecision: "default", highEconomics: true }, precondition: warmBetweenTurnAndDriver },
		{ name: "during a tool", options: { busy: true, warmDecision: "default", highEconomics: true }, beforeRelease: () => new Promise(resolve => setTimeout(resolve, 1400)) },
		{ name: "after an earlier asynchronous handler", options: { slowFinalResponse: true, warmDecision: "warm", highEconomics: true, probe: { earlierAsyncCallback: true, directApi: true } } },
		{ name: "on the retry of an overloaded request", options: { retryAfterMs: 10, slowFinalResponse: true, warmDecision: "warm", highEconomics: true } },
	];
	for (const scenario of scenarios) it(`preserves capture while warming ${scenario.name}`, async () => {
		const h = await consumer(scenario.options);
		const running = h.session.prompt("Finish now.");
		if (scenario.options.busy) {
			await h.entered.promise;
			await scenario.beforeRelease?.();
			h.hold.resolve();
		}
		await running;
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		scenario.precondition?.(h);
		const kinds = h.entries("hydra-call").map(entry => (entry as any).data.kind);
		expect(h.sm.getBranch().filter(entry => entry.type === "usage" && entry.kind === "cache_warm").length).toBeGreaterThan(0);
		expect(kinds).toContain("run-end");
		expect(h.entries("hydra-call").map((entry: any) => entry.data.stopReason)).toEqual(kinds.map(() => "stop"));
		expect(h.entries("hydra-call").some((entry: any) => entry.data.judgeErrorKind)).toBe(false);
		const driver = h.foregroundPayloads.at(-1);
		const head = h.observerPayloads.at(-1);
		expect(head.max_tokens).toBe(driver.max_tokens);
		expect(withoutMarkers(head.messages.slice(0, driver.messages.length))).toEqual(withoutMarkers(driver.messages));
		expect(head.system).toEqual(driver.system);
		expect(head.tools).toEqual(driver.tools);
		expect(head.metadata).toEqual(driver.metadata);
		expectLatestAnswerInHead(h);
		expect(h.errors).toEqual([]);
		console.log(JSON.stringify({ scenario: scenario.name, kinds, timeline: h.timeline, budget: head.max_tokens }));
	});

	it("ignores an old aborted warm callback released after the next real request", async () => {
		const h = await consumer({ busy: true, warmDecision: "default", highEconomics: true, probe: { lateWarmHook: true, directApi: true } });
		const driverGate = h.holdFinalDriver();
		const running = h.session.prompt("Finish now.");
		await h.entered.promise;
		await h.warmEntered.promise;
		h.hold.resolve();
		await h.thirdPrepared.promise;
		h.resumeWarm.resolve();
		await h.lateWarmDelivered.promise;
		driverGate.resolve();
		await running;
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(h.entries("hydra-call").map(entry => (entry as any).data.kind)).toContain("run-end");
		expect(h.entries("hydra-call").every((entry: any) => entry.data.stopReason === "stop" && !entry.data.judgeErrorKind)).toBe(true);
		const driver = h.foregroundPayloads.at(-1);
		const head = h.observerPayloads.at(-1);
		expect(head.max_tokens).toBe(driver.max_tokens);
		expect(withoutMarkers(head.messages.slice(0, driver.messages.length))).toEqual(withoutMarkers(driver.messages));
		expectLatestAnswerInHead(h);
		expect(h.errors).toEqual([]);
		console.log(JSON.stringify({ scenario: "late old warm callback", timeline: h.timeline, budget: head.max_tokens }));
	});

	it("reviews the answer to a retried request when no refresh happens", async () => {
		const h = await consumer({ retryAfterMs: 10, warmDecision: "stop", highEconomics: true });
		await h.session.prompt("Finish now.");
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(h.foregroundPayloads).toHaveLength(2);
		expect(h.entries("hydra-call").map(entry => (entry as any).data.kind)).toContain("run-end");
		expect(h.observerPayloads.at(-1).max_tokens).toBe(h.foregroundPayloads.at(-1).max_tokens);
		expectLatestAnswerInHead(h);
		expect(h.errors).toEqual([]);
	});

	// Spec DoD: "Capture sees the effective final payload after later handlers."
	// Hook-level designs capture at Hydra's place in the handler chain.
	it("a later handler's replacement payload reaches the review", async () => {
		const h = await consumer({ slowFinalResponse: true, warmDecision: "stop", highEconomics: true, probe: { finalTransform: true, directApi: true } });
		await h.session.prompt("Finish now.");
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(h.foregroundPayloads.at(-1).metadata).toEqual({ user_id: "last-handler" });
		expect(h.observerPayloads.at(-1).metadata).toEqual(h.foregroundPayloads.at(-1).metadata);
	});

	it("does not mistake a legitimate one-token driver request for warming", async () => {
		const h = await consumer({ warmDecision: "stop", highEconomics: true, probe: { driverOutputCap: 1, directApi: true } });
		await h.session.prompt("Finish now.");
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(h.foregroundPayloads[0].max_tokens).toBe(1);
		// The fixture does not enforce generation caps: this checks attribution,
		// not whether a real model could finish a review within one token.
		expect(h.entries("hydra-call").map(entry => (entry as any).data.kind)).toContain("run-end");
		expect(h.observerPayloads).toHaveLength(1);
		expectLatestAnswerInHead(h);
		expect(h.entries("hydra-call").every((entry: any) => entry.data.stopReason === "stop" && !entry.data.judgeErrorKind)).toBe(true);
		expect(h.errors).toEqual([]);
	});

	it("preserves the original ChatGPT selected-model fixture, warming and shared prefix", async () => {
		const h = await consumer({ warmDecision: "default", highEconomics: true, delayTurnEnd: true, openai: true, probe: { directApi: true } });
		await h.session.prompt("Finish now.");
		expect(h.session.model).toBe(h.model);
		expect(JSON.stringify(h.modelRuntime.getModels("openai"))).toBe(h.modelBefore);
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(h.sm.getBranch().filter(entry => entry.type === "usage" && entry.kind === "cache_warm")).toHaveLength(1);
		expect(h.observerPayloads).toHaveLength(1);
		const driver = h.foregroundPayloads[0];
		const head = h.observerPayloads[0];
		expect(head.input.slice(0, driver.input.length)).toEqual(driver.input);
		expect(head.prompt_cache_key).toBe(driver.prompt_cache_key);
		expectLatestAnswerInHead(h, true);
		expect(h.entries("hydra-call").every((entry: any) => entry.data.stopReason === "stop" && !entry.data.judgeErrorKind)).toBe(true);
		expect(h.errors).toEqual([]);
		console.log(JSON.stringify({ scenario: "original ChatGPT metadata", warmEntries: 1, successfulHeads: 1, prefixPreserved: true, routingPreserved: true }));
	});
});
