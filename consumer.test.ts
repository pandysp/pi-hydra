import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore, Type } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionError } from "@earendil-works/pi-coding-agent";
import hydraExtension from "./index.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

// A real Anthropic SSE response, consumed by pi-ai's own serializer/parser.
// No network server: only the fetch boundary is replaced.
// largeUsage reports an uncached 10k-token prompt, enough for Pi to decide a cache refresh pays off.
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

// The same response, with its body held back for 1.4 s after the first event.
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

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

// The default first check steers with this message; later checks find nothing.
const STEER = "FIXTURE-STEER";

// Turns on Pi's cache refresh, with an 11-second cache lifetime, and the timing
// and failures the refresh tests need.
type Warming = {
	failFirstFinalAnswer?: boolean; // the final answer first fails with a retryable error, and Pi retries
	forceRefresh?: boolean; // refresh even when Pi would decide against it
	largeUsage?: boolean; // prices and usage that make a refresh pay off
	slowFinalAnswer?: boolean; // the final answer takes 1.4 s to arrive
	delayRunEnd?: boolean; // the run ends 1.4 s after each turn
};

// busy: the driver calls the checkpoint tool before its final answer, twice
// for true or the given number of times; the last call holds until released.
async function consumer(busy: boolean | number, firstObserverResponse?: AssistantMessage["content"], headTools = "[]", apiKey = "fixture-key", thinkingLevel: "off" | "medium" = "off", beforeHydra?: (api: ExtensionAPI) => void, warming?: Warming) {
	const cwd = mkdtempSync(join(process.cwd(), ".consumer-test-"));
	const agentDir = join(cwd, "agent");
	mkdirSync(join(cwd, ".pi", "hydra"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "hydra", "critic.md"), `---\nname: critic\ndescription: Fixture\ntools: ${headTools}\nautostart: true\n---\nCheck the visible work.\n`);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_OFFLINE", "1");
	initTheme("dark", false);
	// Keep Hydra's headless warnings out of the test output.
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	const settingsManager = SettingsManager.inMemory({ transport: "websocket", ...(warming ? { cacheWarming: "streaming" as const } : {}), compaction: { enabled: false }, retry: warming?.failFirstFinalAnswer ? { enabled: true, maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: 0 } } : { enabled: false } });
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false });
	const checkpointCalls = busy === true ? 2 : busy || 0;
	const driverPayloads: any[] = [];
	const observerPayloads: any[] = [];
	const hold = deferred();
	const entered = deferred();
	const finalDriver = deferred();
	let pauseFinalDriver = false;
	let realRequests = 0;
	let pendingRefreshes = 0;
	let failedFinalAnswer = false;
	let observerHold: Promise<void> | null = null;
	const fetchFixture = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init);
		const payload = await request.json();
		const observing = JSON.stringify(payload.messages).includes("You are reviewing the main assistant's work");
		if (observing) {
			observerPayloads.push(payload);
			await observerHold;
			if (observerPayloads.length === 1 && firstObserverResponse) return response(firstObserverResponse);
			if (observerPayloads.length === 1) return response([{ type: "text", text: `{"findings":[{"action":"steer","reason":"check","message":"${STEER}"}]}` }]);
			return response([{ type: "text", text: '{"findings":[]}' }]);
		}
		driverPayloads.push(payload);
		const largeUsage = warming?.largeUsage;
		// A cache refresh replays the last request with a one-token cap; Pi discards its answer.
		if (pendingRefreshes > 0 && payload.max_tokens === 1) {
			pendingRefreshes--;
			return response([{ type: "text", text: "." }], largeUsage);
		}
		const turn = ++realRequests;
		if (warming?.failFirstFinalAnswer && turn > checkpointCalls && !failedFinalAnswer) {
			failedFinalAnswer = true;
			return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status: 529, headers: { "content-type": "application/json" } });
		}
		if (turn <= checkpointCalls) return response([{ type: "toolCall", id: `checkpoint-${turn}`, name: "checkpoint", arguments: {} }], largeUsage);
		if (pauseFinalDriver) await finalDriver.promise;
		const answer: AssistantMessage["content"] = [{ type: "text", text: "Driver done." }];
		return warming?.slowFinalAnswer ? delayedResponse(answer, largeUsage) : response(answer, largeUsage);
	});
	modelRuntime.registerProvider("anthropic", {
		api: "anthropic-messages", apiKey, baseUrl: "https://fixture.invalid",
		streamSimple: (model, context, options) => streamSimple(model, context, { ...options, fetch: fetchFixture }),
		models: [{
			id: "fixture", name: "Fixture", input: ["text"], contextWindow: 200000, maxTokens: 4096,
			cost: warming?.largeUsage ? { input: 12, output: 12, cacheRead: 1, cacheWrite: 15 } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			...(warming ? { promptCache: { short: 11, long: 11 } } : {}),
			// A thinking driver gets current Claude's request shape: the effort travels in a system message at the end.
			...(thinkingLevel === "off" ? { reasoning: false } : { reasoning: true, compat: { supportsMidConvoEffort: true, forceAdaptiveThinking: true } }),
		}],
	});
	const model = modelRuntime.getModel("anthropic", "fixture") as Model<"anthropic-messages">;
	let pi!: ExtensionAPI;
	let checkpoints = 0;
	const loader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		systemPrompt: "Fixture driver.",
		extensionFactories: [(api) => {
			pi = api;
			vi.spyOn(pi, "sendMessage");
			vi.spyOn(pi, "sendUserMessage");
			beforeHydra?.(api);
			hydraExtension(pi);
			if (warming) api.on("cache_warming_decision", (event) => {
				if (warming.forceRefresh || event.action === "warm") pendingRefreshes++;
				return warming.forceRefresh ? { action: "warm" } : undefined;
			});
			if (warming?.delayRunEnd) api.on("turn_end", async () => { await new Promise(resolve => setTimeout(resolve, 1400)); });
			api.registerTool({ name: "checkpoint", label: "Checkpoint", description: "Test checkpoint", parameters: Type.Object({}),
				execute: async () => {
					checkpoints++;
					if (checkpoints === checkpointCalls) { entered.resolve(); await hold.promise; }
					return { content: [{ type: "text", text: "Continue" }], details: {} };
				},
			});
		}],
	});
	await loader.reload();
	const sm = SessionManager.create(cwd, join(cwd, "sessions"));
	const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model, settingsManager, sessionManager: sm, resourceLoader: loader, tools: ["checkpoint", "read", "write", "hydra"], thinkingLevel });
	const errors: ExtensionError[] = [];
	await session.bindExtensions({ onError: error => errors.push(error) });
	expect(errors).toEqual([]);
	cleanups.push(async () => {
		hold.resolve();
		finalDriver.resolve();
		await session.waitForIdle();
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
		rmSync(cwd, { recursive: true, force: true });
	});
	const entries = (type: string) => sm.getBranch().filter(e => (e.type === "custom" || e.type === "custom_message") && e.customType === type);
	return { cwd, pi, session, sm, driverPayloads, observerPayloads, hold, entered, errors, entries,
		holdObserver: (until: Promise<void>) => { observerHold = until; },
		holdFinalDriver: () => { pauseFinalDriver = true; return finalDriver; },
	};
}

const saved = (h: { sm: SessionManager }, phrase: string) =>
	h.sm.getBranch().filter(e => e.type === "message" && e.message.role === "user" && JSON.stringify(e.message.content).includes(phrase));
const seenIn = (payload: any, phrase: string) =>
	payload.messages.filter((message: any) => message.role === "user" && JSON.stringify(message.content).includes(phrase));

describe("Pi consumer context and session", () => {
	it("a steer during a busy run is saved and read by the next model request", async () => {
		const h = await consumer(true);
		const running = h.session.prompt("Work through checkpoints.");
		await h.entered.promise;
		await vi.waitFor(() => expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(1));
		expect(h.pi.sendUserMessage).toHaveBeenCalledWith(`[pi-hydra critic] ${STEER}`, { deliverAs: "steer" });
		expect(h.session.isStreaming).toBe(true);
		expect(h.driverPayloads).toHaveLength(2);
		h.hold.resolve();
		await running;
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(h.observerPayloads[0].tools).toEqual(h.driverPayloads[1].tools);
		expect(h.observerPayloads[0].tool_choice).toEqual(h.driverPayloads[1].tool_choice);
		expect(seenIn(h.driverPayloads[2], STEER)).toHaveLength(1);
		// The head's next check reads its own steer.
		expect(h.observerPayloads.length).toBeGreaterThan(1);
		expect(JSON.stringify(h.observerPayloads.slice(1))).toContain(STEER);
		const restored = SessionManager.open(h.sm.getSessionFile()!);
		expect(JSON.stringify(restored.buildSessionContext().messages)).toContain(STEER);
		expect(h.errors).toEqual([]);
	});

	it("a failed check from a head without tools runs nothing and sends nothing", async () => {
		const blocked: AssistantMessage["content"] = [{ type: "toolCall", id: "blocked-write", name: "write", arguments: { path: "observer.txt", content: "PRIVATE-ARGUMENT" } }];
		const h = await consumer(true, blocked);
		const running = h.session.prompt("Work through checkpoints.");
		await h.entered.promise;
		await vi.waitFor(() => expect(h.entries("hydra-call")).toHaveLength(1));
		h.hold.resolve();
		await running;
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(existsSync(join(h.cwd, "observer.txt"))).toBe(false);
		expect((h.entries("hydra-call")[0] as any).data).toMatchObject({ action: "noop", judgeErrorKind: "blocked-tool-request", attemptedTools: ["write"] });
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(h.pi.sendMessage).not.toHaveBeenCalled();
		expect(JSON.stringify(h.driverPayloads)).not.toContain("PRIVATE-ARGUMENT");
		expect(h.driverPayloads).toHaveLength(3);
		expect(h.errors).toEqual([]);
	});

	it("a steer during the final response is read on one additional model call", async () => {
		const h = await consumer(true);
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
		expect(seenIn(h.driverPayloads[3], STEER)).toHaveLength(1);
		expect(saved(h, STEER)).toHaveLength(1);
		expect(h.errors).toEqual([]);
	});

	const effort = (payload: any) => payload.messages.at(-1).output_config?.effort;
	const noFindings: AssistantMessage["content"] = [{ type: "text", text: '{"findings":[]}' }];

	it("a head thinks as hard as the main assistant", async () => {
		for (const headTools of ["[]", "write"]) {
			const h = await consumer(false, noFindings, headTools, "fixture-key", "medium");
			await h.session.prompt("Finish now.");
			await vi.waitFor(() => expect(h.observerPayloads.length).toBeGreaterThan(0));
			expect(effort(h.driverPayloads[0]), headTools).toBe("medium");
			expect(h.observerPayloads.map(effort), headTools).toEqual(h.observerPayloads.map(() => "medium"));
		}
	});

	it("a head follows the effort the main assistant's request was sent with, not the current setting", async () => {
		const cases: [string, (api: ExtensionAPI) => void, string][] = [
			["another extension edits the request", (api) => api.on("before_provider_request", (e) => { (e.payload as any).messages.at(-1).output_config.effort = "low"; }), "low"],
			["the setting changes after the request was built", (api) => api.on("before_provider_request", () => { api.setThinkingLevel("high"); }), "medium"],
		];
		for (const [name, edit, sent] of cases) {
			const h = await consumer(false, noFindings, "[]", "fixture-key", "medium", edit);
			await h.session.prompt("Finish now.");
			await vi.waitFor(() => expect(h.observerPayloads.length).toBeGreaterThan(0));
			expect(effort(h.driverPayloads[0]), name).toBe(sent);
			expect(h.observerPayloads.map(effort), name).toEqual(h.observerPayloads.map(() => sent));
		}
	});

	it("a head with tools can use them under a subscription login, where Pi renames tools", async () => {
		// Pi sends Claude Code tool names ("Write") for OAuth keys and maps replies
		// back using the tool list it declares in a system message.
		const h = await consumer(false, [{ type: "toolCall", id: "cc-write", name: "Write", arguments: { path: "made-by-head.txt", content: "HEAD" } }], "write", "sk-ant-oat01-fixture");
		await h.session.prompt("Finish now.");
		await vi.waitFor(() => expect(h.entries("hydra-call")).toHaveLength(1));
		await h.session.waitForIdle();
		expect(existsSync(join(h.cwd, "made-by-head.txt"))).toBe(true);
	});

	it("an acting head cannot restart the driver with a steer extracted from invalid mixed findings", async () => {
		const h = await consumer(false, [{ type: "text", text: JSON.stringify({ findings: [
			{ action: "print", message: "PRIVATE PRINT" },
			{ action: "steer", message: "PRIVATE STEER" },
		] }) }], "read");
		await h.session.prompt("Finish now.");
		await vi.waitFor(() => expect(h.entries("hydra-call")).toHaveLength(1));
		await h.session.waitForIdle();
		expect(h.entries("hydra-call")[0]).toMatchObject({ data: { action: "noop" } });
		expect(h.entries("hydra-delivery")).toHaveLength(0);
		expect(h.driverPayloads).toHaveLength(1);
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(h.pi.sendMessage).not.toHaveBeenCalled();
		expect(saved(h, "PRIVATE STEER")).toHaveLength(0);
		expect(h.errors).toEqual([]);
	});

	it("deliberate observer steering resumes a fully idle main assistant without a user message", async () => {
		const h = await consumer(false, [{ type: "text", text: '{"findings":[{"action":"steer","reason":"check","message":"DELIBERATE-STEER"}]}' }]);
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

	it("a steer finishing during shutdown is saved without a main assistant turn", async () => {
		const h = await consumer(false);
		const gate = deferred();
		h.holdObserver(gate.promise);
		await h.session.prompt("Finish now.");
		await vi.waitFor(() => expect(h.observerPayloads).toHaveLength(1));
		const shutdown = h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		gate.resolve();
		await shutdown;
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(JSON.stringify(h.entries("hydra-feedback"))).toContain(STEER);
		expect(h.driverPayloads).toHaveLength(1);
		expect(h.session.isIdle).toBe(true);
		expect(h.errors).toEqual([]);
	});

	it("does not carry a queued steer into another branch after abort", async () => {
		const h = await consumer(true);
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
		expect(JSON.stringify(h.driverPayloads.slice(2))).not.toContain(STEER);
		expect(saved(h, STEER)).toHaveLength(0);
		expect(h.errors).toEqual([]);
	});

	it("a run cancelled during a tool gets no run-end review; the next run does", async () => {
		const h = await consumer(true, [{ type: "text", text: '{"findings":[]}' }]);
		const running = h.session.prompt("Work through checkpoints.");
		await h.entered.promise;
		const aborted = h.session.abort();
		h.hold.resolve();
		await Promise.all([running, aborted]);
		await h.session.prompt("Finish now.");
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		const runEnds = h.entries("hydra-call").filter(e => (e as any).data.kind === "run-end");
		expect(runEnds).toHaveLength(1);
		expect(JSON.stringify(h.observerPayloads.at(-1))).toContain("Driver done.");
		expect(h.errors).toEqual([]);
	});

	for (const release of ["after the cancelled run ended", "while the cancelled run is still busy"] as const) {
		it(`a review still running when the user cancels is saved, and its steer starts no turn (released ${release})`, async () => {
			const h = await consumer(true, [{ type: "text", text: '{"findings":[{"action":"steer","reason":"check","message":"LATE-STEER"}]}' }]);
			const observer = deferred();
			h.holdObserver(observer.promise);
			const running = h.session.prompt("Work through checkpoints.");
			await h.entered.promise;
			await vi.waitFor(() => expect(h.observerPayloads).toHaveLength(1));
			const aborted = h.session.abort();
			if (release === "while the cancelled run is still busy") {
				// The tool still holds, so the run has not ended when the review does.
				observer.resolve();
				await vi.waitFor(() => expect(h.entries("hydra-call")).toHaveLength(1));
			}
			h.hold.resolve();
			await Promise.all([running, aborted]);
			const driverRequests = h.driverPayloads.length;
			observer.resolve();
			await vi.waitFor(() => expect(h.entries("hydra-feedback").filter(e => JSON.stringify((e as any).content).includes("LATE-STEER"))).toHaveLength(1));
			// A turn started by the steer would still be running or finished here.
			await h.session.waitForIdle();
			expect(h.driverPayloads).toHaveLength(driverRequests);
			expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
			expect(h.entries("hydra-call")).toHaveLength(1);
			expect(h.entries("hydra-delivery")).toHaveLength(1);
			expect(h.errors).toEqual([]);
		});
	}

	it("a review still waiting when the user cancels does not start", async () => {
		const h = await consumer(3, [{ type: "text", text: '{"findings":[]}' }]);
		const observer = deferred();
		h.holdObserver(observer.promise);
		const running = h.session.prompt("Work through checkpoints.");
		// The first mid-run review is running and held; the second waits behind it.
		await h.entered.promise;
		await vi.waitFor(() => expect(h.observerPayloads).toHaveLength(1));
		const aborted = h.session.abort();
		h.hold.resolve();
		await Promise.all([running, aborted]);
		observer.resolve();
		// Each head reviews one snapshot at a time, so once the next run's
		// review (the one that sees "Driver done.") is saved, every earlier
		// review has been started or skipped.
		await h.session.prompt("Finish now.");
		await vi.waitFor(() => expect(h.observerPayloads.some(p => JSON.stringify(p).includes("Driver done."))).toBe(true));
		await vi.waitFor(() => expect(h.entries("hydra-call")).toHaveLength(h.observerPayloads.length));
		expect(h.entries("hydra-call").map(e => (e as any).data.kind)).toEqual(["piggyback", "run-end"]);
		expect(h.observerPayloads).toHaveLength(2);
		expect(h.errors).toEqual([]);
	});

	it("a head-file notice from a cancelled run's review starts no turn", async () => {
		const h = await consumer(true, [{ type: "toolCall", id: "leave", name: "hydra", arguments: { action: "manage_heads", operation: "remove", head: "critic", message: "LEAVING" } }], "hydra");
		const observer = deferred();
		h.holdObserver(observer.promise);
		const running = h.session.prompt("Work through checkpoints.");
		await h.entered.promise;
		await vi.waitFor(() => expect(h.observerPayloads).toHaveLength(1));
		const aborted = h.session.abort();
		h.hold.resolve();
		await Promise.all([running, aborted]);
		const driverRequests = h.driverPayloads.length;
		// Head management rereads the head files; a missing one makes Hydra steer.
		rmSync(join(h.cwd, ".pi", "hydra", "critic.md"));
		observer.resolve();
		await vi.waitFor(() => expect(h.entries("hydra-call")).toHaveLength(1));
		await h.session.waitForIdle();
		expect(h.driverPayloads).toHaveLength(driverRequests);
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(h.errors).toEqual([]);
	});

	it("Pi reports a rejected steer as an extension error", async () => {
		const h = await consumer(false);
		vi.spyOn(h.session, "sendUserMessage").mockRejectedValueOnce(new Error("asynchronous host failure"));
		await h.session.prompt("Finish now.");
		await vi.waitFor(() => expect(h.errors).toContainEqual(expect.objectContaining({ error: "asynchronous host failure" })));
	});

	it("a head removing itself is saved and read by the woken main assistant", async () => {
		const h = await consumer(false, [{ type: "toolCall", id: "leave", name: "hydra", arguments: { action: "manage_heads", operation: "remove", head: "critic", message: "WHY-IT-FITS" } }], "hydra");
		await h.session.prompt("Finish now.");
		await vi.waitFor(() => expect(h.driverPayloads, JSON.stringify({ messages: h.session.messages, errors: h.errors })).toHaveLength(2));
		expect(seenIn(h.driverPayloads[1], "WHY-IT-FITS")).toHaveLength(1);
		await h.session.waitForIdle();
		expect(saved(h, "WHY-IT-FITS")).toHaveLength(1);
		expect(h.errors).toEqual([]);
	});

	it("a head whose tools the main assistant lacks is off before the first request; the user is warned, the main assistant isn't told yet", async () => {
		// The main assistant here has checkpoint, read, write and hydra; grep is off.
		const h = await consumer(false, undefined, "read, grep");
		await h.session.prompt("Finish now.");
		await h.session.waitForIdle();
		const off = "head critic is off: the main assistant doesn't have grep.";
		expect(h.observerPayloads).toHaveLength(0);
		expect(h.driverPayloads).toHaveLength(1);
		expect(saved(h, "Finish now.")).toHaveLength(1);
		// No note before pi's first system message, or a later tool change costs a cache miss.
		expect(h.entries("hydra-feedback")).toHaveLength(0);
		expect(vi.mocked(process.stderr.write).mock.calls.some(([written]) => String(written).includes(`hydra: ${off}`))).toBe(true);
		expect(h.errors).toEqual([]);
	});

	it("a head turned off later in the session is noted in the next request, without a run of its own", async () => {
		const h = await consumer(false, [{ type: "text", text: '{"findings":[]}' }], "read");
		await h.session.prompt("Finish now.");
		await vi.waitFor(() => expect(h.entries("hydra-call")).toHaveLength(1));
		await h.session.waitForIdle();
		writeFileSync(join(h.cwd, ".pi", "hydra", "critic.md"), "---\nname: critic\ndescription: Fixture\ntools: read, grep\nautostart: true\n---\nCheck the visible work.\n");
		await h.session.prompt("Next task.");
		await h.session.waitForIdle();
		const off = "[pi-hydra critic] automatic notice: head critic is off: the main assistant doesn't have grep.";
		expect(h.driverPayloads).toHaveLength(2);
		expect(seenIn(h.driverPayloads[1], off)).toHaveLength(1);
		expect(saved(h, "Next task.")).toHaveLength(1);
		expect(h.errors).toEqual([]);
	});

	it("a head file deleted before the first prompt is reported to the user", async () => {
		const h = await consumer(false, undefined, "read");
		rmSync(join(h.cwd, ".pi", "hydra", "critic.md"));
		await h.session.prompt("Finish now.");
		await h.session.waitForIdle();
		expect(h.observerPayloads).toHaveLength(0);
		expect(vi.mocked(process.stderr.write).mock.calls.some(([written]) => String(written).includes("hydra: head critic: this head's file is missing or invalid"))).toBe(true);
		expect(h.errors).toEqual([]);
	});

	it("a vanished active head is saved and read within the next run", async () => {
		const h = await consumer(false, [{ type: "text", text: '{"findings":[]}' }]);
		await h.session.prompt("Finish now.");
		await vi.waitFor(() => expect(h.entries("hydra-call")).toHaveLength(1));
		await h.session.waitForIdle();
		rmSync(join(h.cwd, ".pi", "hydra", "critic.md"));
		await h.session.prompt("Next task.");
		await h.session.waitForIdle();
		const gone = "automatic notice: this head's file is missing or invalid";
		expect(h.driverPayloads.slice(1).some(p => seenIn(p, gone).length === 1)).toBe(true);
		// A note, not a user message: it starts no run of its own.
		expect(h.entries("hydra-feedback").filter(e => JSON.stringify(e).includes(gone))).toHaveLength(1);
		expect(h.errors).toEqual([]);
	});
});

describe("Pi's cache refresh", () => {
	const noFindings: AssistantMessage["content"] = [{ type: "text", text: '{"findings":[]}' }];
	// Pi caps the output at the room left in the context window, down to one token.
	const nearlyFull = (api: ExtensionAPI) => api.on("before_provider_request", (event) => ({ ...(event.payload as object), max_tokens: 1 }));
	// Pi recorded at least one refresh, each one went out with the one-token cap
	// Hydra recognizes refreshes by, and the run-end check still reviewed the final answer.
	function expectRefreshedAndReviewed(h: Awaited<ReturnType<typeof consumer>>) {
		const refreshes = h.sm.getBranch().filter(e => e.type === "usage" && e.kind === "cache_warm");
		expect(refreshes.length).toBeGreaterThan(0);
		expect(h.driverPayloads.filter(payload => payload.max_tokens === 1)).toHaveLength(refreshes.length);
		expect(h.entries("hydra-call").map(entry => (entry as { data: { kind?: string } }).data.kind)).toContain("run-end");
		const head = h.observerPayloads.at(-1);
		expect(head.max_tokens).toBe(4096);
		const lastAnswer = head.messages.filter((message: any) => message.role === "assistant").at(-1);
		expect(JSON.stringify(lastAnswer.content)).toContain("Driver done.");
	}

	it("a refresh during a slow final answer keeps the run-end check", async () => {
		const h = await consumer(false, noFindings, "[]", "fixture-key", "off", undefined, { forceRefresh: true, slowFinalAnswer: true });
		await h.session.prompt("Finish now.");
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expectRefreshedAndReviewed(h);
	});

	it("a refresh Pi chooses during a long run keeps the run-end check", async () => {
		const h = await consumer(true, noFindings, "[]", "fixture-key", "off", undefined, { largeUsage: true, slowFinalAnswer: true });
		const running = h.session.prompt("Finish now.");
		await h.entered.promise;
		h.hold.resolve();
		await running;
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expectRefreshedAndReviewed(h);
	});

	it("a refresh after the final answer, before the run ends, keeps the run-end check", async () => {
		const h = await consumer(false, noFindings, "[]", "fixture-key", "off", undefined, { largeUsage: true, delayRunEnd: true });
		await h.session.prompt("Finish now.");
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expectRefreshedAndReviewed(h);
	});

	it("a real request capped at one token, as Pi does near a full context, is still reviewed", async () => {
		const h = await consumer(true, noFindings, "[]", "fixture-key", "off", nearlyFull);
		const running = h.session.prompt("Work through checkpoints.");
		await h.entered.promise;
		h.hold.resolve();
		await running;
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(h.driverPayloads.every(payload => payload.max_tokens === 1)).toBe(true);
		expect(h.entries("hydra-call").map(entry => (entry as { data: { kind?: string } }).data.kind)).toContain("run-end");
	});

	it("a retry with a nearly full context, which repeats the request at one token, is still reviewed", async () => {
		const h = await consumer(false, noFindings, "[]", "fixture-key", "off", nearlyFull, { failFirstFinalAnswer: true });
		await h.session.prompt("Finish now.");
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(h.driverPayloads).toHaveLength(2);
		expect(JSON.stringify(h.driverPayloads[1].messages)).toBe(JSON.stringify(h.driverPayloads[0].messages));
		expect(h.entries("hydra-call").map(entry => (entry as { data: { kind?: string } }).data.kind)).toContain("run-end");
	});

	it("Pi's catalog gives a cache lifetime only to Anthropic models, the ones whose refresh Hydra recognizes", async () => {
		const agentDir = mkdtempSync(join(process.cwd(), ".consumer-test-"));
		cleanups.push(async () => rmSync(agentDir, { recursive: true, force: true }));
		const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false });
		const refreshed = modelRuntime.getAllModels().filter(model => "promptCache" in model && model.promptCache && Object.keys(model.promptCache).length > 0);
		expect(refreshed.length).toBeGreaterThan(0);
		expect(new Set(refreshed.map(model => (model as Model<"anthropic-messages">).api))).toEqual(new Set(["anthropic-messages"]));
	});
});
