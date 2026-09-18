import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore, Type } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionError } from "@earendil-works/pi-coding-agent";
import hydraExtension from "./index";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

// A real Anthropic SSE response, consumed by pi-ai's own serializer/parser.
// No network server: only the fetch boundary is replaced.
function response(content: AssistantMessage["content"]): Response {
	const events: unknown[] = [{ type: "message_start", message: {
		id: "msg_fixture", type: "message", role: "assistant", model: "fixture", content: [], stop_reason: null, stop_sequence: null,
		usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 },
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

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

async function consumer(busy: boolean, acting = false, firstObserverResponse?: AssistantMessage["content"]) {
	const cwd = mkdtempSync(join(process.cwd(), ".consumer-test-"));
	const agentDir = join(cwd, "agent");
	mkdirSync(join(cwd, ".pi", "hydra"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "hydra", "critic.md"), `---\nname: critic\ndescription: Fixture\ntools: ${acting ? "write" : "[]"}\n${acting ? "after-change: noop\n" : ""}autostart: true\n---\nCheck the visible work.\n`);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_OFFLINE", "1");
	initTheme("dark", false);
	const warnings = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	const settingsManager = SettingsManager.inMemory({ transport: "websocket", compaction: { enabled: false }, retry: { enabled: false } });
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false });
	const driverPayloads: any[] = [];
	const observerPayloads: any[] = [];
	const hold = deferred();
	const entered = deferred();
	let repeatFailure = false;
	let observerHold: Promise<void> | null = null;
	const fetchFixture = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init);
		const payload = await request.json();
		const observing = JSON.stringify(payload.messages).includes("You are reviewing the main assistant's work");
		if (observing) {
			observerPayloads.push(payload);
			await observerHold;
			if (observerPayloads.length === 1 && firstObserverResponse) return response(firstObserverResponse);
			if (observerPayloads.length === 1 || repeatFailure) return response([{ type: "toolCall", id: "blocked-write", name: "write", arguments: { path: "observer.txt", content: "PRIVATE-ARGUMENT" } }]);
			return response([{ type: "text", text: acting ? '{"action":"noop","reason":"done","message":""}' : '{"findings":[]}' }]);
		}
		driverPayloads.push(payload);
		if (busy && driverPayloads.length <= 2) return response([{ type: "toolCall", id: `checkpoint-${driverPayloads.length}`, name: "checkpoint", arguments: {} }]);
		return response([{ type: "text", text: "Driver done." }]);
	});
	modelRuntime.registerProvider("anthropic", {
		api: "anthropic-messages", apiKey: "fixture-key", baseUrl: "https://fixture.invalid",
		streamSimple: (model, context, options) => streamSimple(model, context, { ...options, fetch: fetchFixture }),
		models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }],
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
			hydraExtension(pi);
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
		await session.waitForIdle();
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
		rmSync(cwd, { recursive: true, force: true });
	});
	const entries = (type: string) => sm.getBranch().filter(e => (e.type === "custom" || e.type === "custom_message") && e.customType === type);
	return { cwd, pi, session, sm, driverPayloads, observerPayloads, hold, entered, errors, warnings, entries,
		repeatFailure: () => { repeatFailure = true; },
		holdObserver: (until: Promise<void>) => { observerHold = until; },
	};
}

describe("Pi consumer context and session", () => {
	it.each([{ acting: false, name: "error notice" }, { acting: true, name: "write notice" }])("a busy $name reaches the next model request, not an idle follow-up", async ({ acting }) => {
		const h = await consumer(true, acting);
		const running = h.session.prompt("Work through checkpoints.");
		await vi.waitFor(() => expect(h.driverPayloads, JSON.stringify({ messages: h.session.messages, errors: h.errors })).toHaveLength(2));
		await h.entered.promise;
		await vi.waitFor(() => expect(h.pi.sendMessage).toHaveBeenCalledTimes(1));
		expect(h.session.isStreaming).toBe(true);
		expect(h.driverPayloads).toHaveLength(2);
		expect(h.sm.getBranch().filter(e => e.type === "custom_message")).toHaveLength(0);
		h.hold.resolve();
		await running;
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(h.observerPayloads[0].tools).toEqual(h.driverPayloads[1].tools);
		expect(h.observerPayloads[0].tools.some((tool: { name: string }) => tool.name === "write")).toBe(true);
		expect(h.observerPayloads[0].tool_choice).toEqual(h.driverPayloads[1].tool_choice);
		const phrase = acting ? "reread this file" : "Hydra error notice";
		const nextRequest = h.driverPayloads[2];
		const delivered = nextRequest.messages.filter((message: any) => JSON.stringify(message.content).includes(phrase));
		expect(delivered).toHaveLength(1);
		expect(delivered[0].role).toBe("user");
		if (!acting) expect(JSON.stringify(nextRequest)).not.toContain("PRIVATE-ARGUMENT");
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(h.errors).toEqual([]);
		expect(existsSync(join(h.cwd, "observer.txt"))).toBe(acting);
		expect(JSON.stringify(h.observerPayloads.slice(1))).toContain(phrase);
		const restored = SessionManager.open(h.sm.getSessionFile()!);
		expect(restored.getBranch().filter(e => e.type === "custom_message")).toHaveLength(1);
		expect(JSON.stringify(restored.buildSessionContext().messages)).toContain(phrase);
	});

	it.each([{ acting: false, name: "error notice" }, { acting: true, name: "write notice" }])("a late $name leaves a fully idle main assistant idle and reaches its next user-prompted request", async ({ acting }) => {
		const h = await consumer(false, acting);
		if (!acting) h.repeatFailure();
		const gate = deferred();
		h.holdObserver(gate.promise);
		await h.session.prompt("Finish now.");
		await vi.waitFor(() => expect(h.observerPayloads).toHaveLength(1));
		expect(h.session.isIdle).toBe(true);
		expect(h.driverPayloads).toHaveLength(1);
		gate.resolve();
		const type = acting ? "hydra-feedback" : "hydra-runtime-report";
		await vi.waitFor(() => expect(h.entries("hydra-call")).toHaveLength(1));
		await vi.waitFor(() => expect(h.entries(type)).toHaveLength(1));
		await h.session.waitForIdle();
		// An automatic notice is recorded, not turned into new work.
		expect(h.driverPayloads, JSON.stringify({ messages: h.session.messages, errors: h.errors })).toHaveLength(1);
		expect(h.session.isIdle).toBe(true);
		await h.session.prompt("Next task.");
		expect(h.driverPayloads).toHaveLength(2);
		const phrase = acting ? "reread this file" : "Hydra error notice";
		const delivered = h.driverPayloads[1].messages.filter((message: any) => JSON.stringify(message.content).includes(phrase));
		expect(delivered).toHaveLength(1);
		expect(delivered[0].role).toBe("user");
		if (!acting) expect(JSON.stringify(h.driverPayloads[1])).not.toContain("PRIVATE-ARGUMENT");
		// The second run ends with its own check: a repeated failure from the head
		// without tools is not sent again, and the head with tools writes nothing more.
		await vi.waitFor(() => expect(h.entries("hydra-call")).toHaveLength(2));
		await h.session.waitForIdle();
		expect(h.entries(type)).toHaveLength(1);
		expect(h.driverPayloads).toHaveLength(2);
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(h.errors).toEqual([]);
	});

	it("deliberate observer steering resumes a fully idle main assistant without a user message", async () => {
		const h = await consumer(false, false, [{ type: "text", text: '{"findings":[{"action":"steer","reason":"check","message":"DELIBERATE-STEER"}]}' }]);
		const gate = deferred();
		h.holdObserver(gate.promise);
		await h.session.prompt("Finish now.");
		await vi.waitFor(() => expect(h.observerPayloads).toHaveLength(1));
		expect(h.session.isIdle).toBe(true);
		gate.resolve();
		await vi.waitFor(() => expect(h.driverPayloads, JSON.stringify({ messages: h.session.messages, errors: h.errors })).toHaveLength(2));
		expect(h.pi.sendUserMessage).toHaveBeenCalledWith("[critic] DELIBERATE-STEER", undefined);
		const delivered = h.driverPayloads[1].messages.filter((message: any) => JSON.stringify(message.content).includes("DELIBERATE-STEER"));
		expect(delivered).toHaveLength(1);
		expect(delivered[0].role).toBe("user");
		await vi.waitFor(() => expect(h.entries("hydra-call")).toHaveLength(2));
		await h.session.waitForIdle();
		expect(h.driverPayloads).toHaveLength(2);
		expect(h.entries("hydra-delivery")).toHaveLength(1);
		expect(h.errors).toEqual([]);
	});

	it.each([{ acting: false, name: "error notice" }, { acting: true, name: "write notice" }])("a $name finishing during shutdown is recorded without a main assistant turn", async ({ acting }) => {
		const h = await consumer(false, acting);
		const gate = deferred();
		h.holdObserver(gate.promise);
		await h.session.prompt("Finish now.");
		await vi.waitFor(() => expect(h.observerPayloads).toHaveLength(1));
		const shutdown = h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		gate.resolve();
		await shutdown;
		expect(h.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: acting ? "hydra-feedback" : "hydra-runtime-report" }), { deliverAs: "steer" });
		expect(h.entries(acting ? "hydra-feedback" : "hydra-runtime-report")).toHaveLength(1);
		expect(h.driverPayloads).toHaveLength(1);
		expect(h.session.isIdle).toBe(true);
		expect(h.errors).toEqual([]);
	});

	it("does not carry an automatic notice across branch navigation after abort", async () => {
		const h = await consumer(true);
		const running = h.session.prompt("Work through checkpoints.");
		await h.entered.promise;
		await vi.waitFor(() => expect(h.pi.sendMessage).toHaveBeenCalledTimes(1));
		const aborted = h.session.abort();
		h.hold.resolve();
		await Promise.all([running, aborted]);
		const firstUser = h.sm.getBranch().find(e => e.type === "message" && e.message.role === "user")!;
		await h.session.navigateTree(firstUser.id);
		await h.session.prompt("New branch.");
		expect(JSON.stringify(h.driverPayloads.slice(2))).not.toContain("Hydra error notice");
		expect(h.sm.getBranch().filter(e => e.type === "custom_message")).toHaveLength(0);
		expect(h.errors).toEqual([]);
	});

	it("a host-cleared busy notice can retry after abort and branch navigation", async () => {
		const h = await consumer(true);
		const running = h.session.prompt("Work through checkpoints.");
		await h.entered.promise;
		await vi.waitFor(() => expect(h.pi.sendMessage).toHaveBeenCalledTimes(1));
		h.session.clearQueue();
		const aborted = h.session.abort();
		h.hold.resolve();
		await Promise.all([running, aborted]);
		expect(h.sm.getBranch().filter(e => e.type === "custom_message")).toHaveLength(0);
		expect(h.warnings).toHaveBeenCalledWith(expect.stringContaining("error notice(s) did not reach"));
		const abandoned = h.sm.getLeafId()!;
		const firstUser = h.sm.getBranch().find(e => e.type === "message" && e.message.role === "user")!;
		await h.session.navigateTree(firstUser.id);
		h.repeatFailure();
		await h.session.prompt("New branch.");
		await vi.waitFor(() => expect(h.sm.getBranch().filter(e => e.type === "custom_message")).toHaveLength(1));
		expect(h.sm.getBranch(abandoned).filter(e => e.type === "custom_message")).toHaveLength(0);
		expect(h.errors).toEqual([]);
	});

	it("Pi reports asynchronous send failure; Hydra releases the undelivered pending notice at settle", async () => {
		const h = await consumer(false);
		vi.spyOn(h.session, "sendCustomMessage").mockRejectedValueOnce(new Error("asynchronous host failure"));
		await h.session.prompt("Finish now.");
		await vi.waitFor(() => expect(h.errors).toContainEqual(expect.objectContaining({ event: "send_message", error: "asynchronous host failure" })));
		await h.session.extensionRunner.emit({ type: "agent_settled" });
		expect(h.sm.getBranch().filter(e => e.type === "custom_message")).toHaveLength(0);
		expect(h.warnings).toHaveBeenCalledWith(expect.stringContaining("error notice(s) did not reach"));
	});
});
