import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api, AssistantMessage, Message, Model, ToolCall } from "@earendil-works/pi-ai";
import type { streamSimple } from "@earendil-works/pi-ai/compat";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import hydraExtension from "./index";
import type { HydraCall } from "./stats";

const boundary = vi.hoisted(() => ({ agentDir: "", transport: "websocket" }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => {
	const pi = await original<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...pi,
		getAgentDir: () => boundary.agentDir,
		SettingsManager: { ...pi.SettingsManager, create: () => pi.SettingsManager.inMemory({ transport: boundary.transport as "websocket" }) },
	};
});

function answer(content: AssistantMessage["content"] = [], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant", content, stopReason, api: "anthropic-messages", provider: "anthropic", model: "test",
		usage: { input: 10, output: 5, cacheRead: 90, cacheWrite: 0, totalTokens: 105, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		timestamp: Date.now(),
	};
}
const text = (value: string) => ({ type: "text" as const, text: value });
const tool = (name: string, args: ToolCall["arguments"]): ToolCall => ({ type: "toolCall", id: `call-${name}`, name, arguments: args });
const noop = () => answer([text('{"findings":[]}')]);

type Handler = (event: ExtensionEvent, ctx: ExtensionContext) => unknown;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	boundary.transport = "websocket";
	vi.unstubAllEnvs();
});

async function harness(options: { tools?: string; api?: "anthropic-messages" | "openai-codex-responses" } = {}) {
	const cwd = mkdtempSync(join(process.cwd(), ".observer-test-"));
	boundary.agentDir = join(cwd, "agent");
	mkdirSync(join(cwd, ".pi", "hydra"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "hydra", "critic.md"), `---\nname: critic\ndescription: Test observer\ntools: ${options.tools ?? "[]"}\n---\nFollow these test instructions.\n`);
	const sm = SessionManager.inMemory(cwd);
	const root = sm.appendCustomEntry("hydra-config", { heads: ["critic"] });
	const handlers = new Map<string, Handler>();
	const responses: (AssistantMessage | Promise<AssistantMessage>)[] = [];
	const payloads: unknown[] = [];
	let idle = true;
	const api = options.api ?? "anthropic-messages";
	const model = { api, provider: api === "anthropic-messages" ? "anthropic" : "openai-codex", id: "test", contextWindow: 200000, maxTokens: 4096 } as Model<Api>;
	const transport = vi.fn((model: Model<Api>, context: { messages: Message[] }, opts: { onPayload: (payload: unknown) => unknown }) => {
		const built = model.api === "anthropic-messages" ? { messages: context.messages } : { input: context.messages };
		payloads.push(opts.onPayload(built));
		const next = responses.shift();
		if (!next) throw new Error("Unexpected provider call (repair or runaway loop)");
		return { result: async () => next, async *[Symbol.asyncIterator]() { await next; } };
	}) as unknown as typeof streamSimple & ReturnType<typeof vi.fn>;
	const notify = vi.fn();
	const ctx = {
		cwd, model, sessionManager: sm, isIdle: () => idle, isProjectTrusted: () => true, hasUI: true,
		ui: { notify, setStatus: vi.fn(), theme: { fg: (_: string, value: string) => value } },
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
			getRegisteredProviderConfig: () => ({ api, streamSimple: transport }),
		},
		abort: vi.fn(),
	} as unknown as ExtensionContext;
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerFlag: vi.fn(), registerTool: vi.fn(), registerCommand: vi.fn(), registerMessageRenderer: vi.fn(),
		getFlag: () => undefined,
		appendEntry: (type: string, data: unknown) => sm.appendCustomEntry(type, data),
		// Delivery itself is Pi's; consumer.test.ts covers it in a real session.
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
	} as unknown as ExtensionAPI;
	async function emit(event: ExtensionEvent) { await handlers.get(event.type)?.(event, ctx); }
	hydraExtension(pi);
	await emit({ type: "session_start", reason: "startup" });
	const calls = () => sm.getBranch().filter(e => e.type === "custom" && e.customType === "hydra-call").map(e => (e as { data: HydraCall }).data);
	const observe = async (...results: (AssistantMessage | Promise<AssistantMessage>)[]) => {
		responses.push(...results);
		const messages = convertToLlm(sm.buildSessionContext().messages);
		await emit({ type: "before_provider_request", payload: api === "anthropic-messages" ? { messages } : { input: messages } });
		await emit({ type: "message_start", message: answer([text("Driver is working")]) });
	};
	await emit({ type: "agent_start" });
	// The first main assistant response is deliberately skipped by Hydra.
	await emit({ type: "before_provider_request", payload: api === "anthropic-messages" ? { messages: [] } : { input: [] } });
	await emit({ type: "message_start", message: answer([text("First driver response")]) });
	cleanups.push(async () => {
		await emit({ type: "session_shutdown", reason: "quit" });
		rmSync(cwd, { recursive: true, force: true });
	});
	return { cwd, sm, root, ctx, pi, payloads, transport, notify, emit, observe, calls,
		busy: () => { idle = false; }, idle: () => { idle = true; },
		waitCalls: async (count: number) => { await vi.waitFor(() => expect(calls(), JSON.stringify(notify.mock.calls)).toHaveLength(count)); },
	};
}

describe("heads without tools through the extension", () => {
	it.each(["anthropic-messages", "openai-codex-responses"] as const)("%s never executes or repairs a tool request and reports it in future context", async (api) => {
		const h = await harness({ api });
		const target = join(h.cwd, "must-not-exist");
		await h.observe(answer([tool("write", { path: target, content: "SECRET-ARGUMENT" }), text('{"findings":[{"action":"steer","reason":"mixed","message":"MUST NOT DELIVER"}]}')], "toolUse"));
		await h.waitCalls(1);
		expect(existsSync(target)).toBe(false);
		expect(h.transport).toHaveBeenCalledTimes(1);
		expect(h.calls()[0]).toMatchObject({ action: "noop", judgeErrorKind: "blocked-tool-request", attemptedTools: ["write"], stopReason: "toolUse" });
		expect(h.pi.sendMessage).not.toHaveBeenCalled();
		expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(1);
		const [report, options] = vi.mocked(h.pi.sendUserMessage).mock.calls[0];
		expect(report).toMatch(/^\[pi-hydra critic\] automatic notice: A head without tools/);
		expect(options).toBeUndefined(); // idle: starts a turn, like any head steer
		expect(report).not.toContain("MUST NOT DELIVER");
		await h.observe(noop());
		await h.waitCalls(2);
		// The head sees what was sent on its behalf in its next check.
		const payload = JSON.stringify(h.payloads[1]);
		expect(payload).toContain("automatic notice: A head without tools");
		expect(payload).not.toContain("SECRET-ARGUMENT");
	});

	it.each([
		["cut short", answer([tool("write", { path: "bad" }), text('{"findings":')], "length"), "truncated", false],
		["empty", answer(), "empty-answer", false],
		["empty zero-usage", { ...answer(), usage: { ...answer().usage, input: 0, cacheRead: 0, output: 0, totalTokens: 0 } }, "empty-answer", false],
		["thinking-only", answer([{ type: "thinking", thinking: "SECRET-THINKING" }]), "empty-answer", false],
		["malformed", answer([text("SECRET-PROSE")]), "malformed-findings", true],
		["provider error", { ...answer([tool("write", {})], "error"), errorMessage: "provider unavailable" }, "provider-error", false],
		["provider abort", answer([tool("write", {})], "aborted"), "aborted", false],
	] as const)("records %s without guessing why it happened", async (_name, response, kind, report) => {
		const h = await harness();
		await h.observe(response);
		await h.waitCalls(1);
		expect(h.calls()[0]).toMatchObject({ action: "noop", judgeErrorKind: kind });
		expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(report ? 1 : 0);
		expect(JSON.stringify(vi.mocked(h.pi.sendUserMessage).mock.calls)).not.toMatch(/SECRET-PROSE|SECRET-THINKING/);
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining(kind), expect.any(String));
	});

	it("keeps valid noop, print and steer separate", async () => {
		const h = await harness();
		await h.observe(noop());
		await h.waitCalls(1);
		expect(h.calls()[0]).not.toHaveProperty("judgeErrorKind", expect.any(String));
		await h.observe(answer([text(JSON.stringify({ findings: [
			{ action: "print", message: "USER ONLY", reason: "user" },
			{ action: "steer", message: "DRIVER ACTION", reason: "driver" },
		] }))]));
		await h.waitCalls(2);
		expect(h.notify).toHaveBeenCalledWith("[pi-hydra critic] USER ONLY", "info");
		expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(h.pi.sendUserMessage).toHaveBeenCalledWith("[pi-hydra critic] DRIVER ACTION", undefined);
	});
});

describe("one error notice per head and error type", () => {
	const blocked = () => answer([tool("write", { path: "ignored", content: "not executed" })], "toolUse");
	it("steers each error notice once per head and error type", async () => {
		const h = await harness();
		h.busy();
		await h.observe(blocked());
		await h.waitCalls(1);
		await h.observe(blocked());
		await h.waitCalls(2);
		await h.observe(answer([text("not JSON")]));
		await h.waitCalls(3);
		const sent = vi.mocked(h.pi.sendUserMessage).mock.calls;
		expect(sent).toHaveLength(2);
		expect(sent[0]).toEqual([expect.stringMatching(/^\[pi-hydra critic\] automatic notice: .*requested tools \(write\)/), { deliverAs: "steer" }]);
		expect(sent[1][0]).toContain("did not match the required findings JSON");
		expect(JSON.stringify(sent)).not.toContain("not executed");
		expect(h.pi.sendMessage).not.toHaveBeenCalled();
		expect(h.notify.mock.calls.filter(([message]) => message.includes("blocked-tool-request"))).toHaveLength(2);
	});

	it("sends an error notice again after switching to another branch", async () => {
		const h = await harness();
		await h.observe(blocked());
		await h.waitCalls(1);
		h.sm.branch(h.root);
		await h.emit({ type: "session_tree", oldLeafId: h.sm.getLeafId(), newLeafId: h.root });
		await h.observe(blocked());
		await vi.waitFor(() => expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(2));
	});

	it("does not inject stale-branch results", async () => {
		const h = await harness();
		let finish!: (response: AssistantMessage) => void;
		await h.observe(new Promise(resolve => { finish = resolve; }));
		await vi.waitFor(() => expect(h.transport).toHaveBeenCalledTimes(1));
		h.sm.branch(h.root);
		await h.emit({ type: "session_tree", oldLeafId: h.root, newLeafId: h.root });
		finish(blocked());
		await h.observe(noop());
		await h.waitCalls(1);
		expect(h.calls()[0].judgeErrorKind).toBeUndefined();
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("saves an error notice finishing inside the shutdown grace without starting a main assistant turn", async () => {
		const h = await harness();
		let finish!: (response: AssistantMessage) => void;
		await h.observe(new Promise(resolve => { finish = resolve; }));
		await vi.waitFor(() => expect(h.transport).toHaveBeenCalledTimes(1));
		const shutdown = h.emit({ type: "session_shutdown", reason: "quit" });
		finish(blocked());
		await shutdown;
		expect(h.calls()).toHaveLength(1);
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(h.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/^\[pi-hydra critic\] automatic notice: /) }), { deliverAs: "followUp", triggerTurn: false });
	});

	it("does not inject a response arriving after cancellation", async () => {
		const h = await harness();
		let finish!: (response: AssistantMessage) => void;
		await h.observe(new Promise(resolve => { finish = resolve; }));
		await vi.waitFor(() => expect(h.transport).toHaveBeenCalledTimes(1));
		vi.stubEnv("HYDRA_SHUTDOWN_GRACE_MS", "0");
		await h.emit({ type: "session_shutdown", reason: "quit" });
		finish(blocked());
		await h.emit({ type: "session_shutdown", reason: "quit" });
		expect(h.calls()).toHaveLength(0);
		expect(h.pi.sendMessage).not.toHaveBeenCalled();
	});
});

describe("messages Hydra sends on a head's behalf", () => {
	it.each(["remove", "add"] as const)("steers a head's %s of the active set with its explanation", async (operation) => {
		const h = await harness({ api: "openai-codex-responses", tools: "hydra" });
		writeFileSync(join(h.cwd, ".pi", "hydra", "helper.md"), "---\nname: helper\ndescription: Helper\ntools: []\n---\nHelp.\n");
		const head = operation === "remove" ? "critic" : "helper";
		h.busy();
		await h.observe(
			answer([tool("hydra", { action: "manage_heads", operation, head, message: "WHY-IT-FITS" })], "toolUse"),
			...(operation === "add" ? [answer([tool("hydra", { action: "complete_observation", delivery: "none", message: "" })], "toolUse")] : []),
		);
		await h.waitCalls(1);
		expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(h.pi.sendUserMessage).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^\\[pi-hydra critic\\] automatic notice: .*${head}.*WHY-IT-FITS`)), { deliverAs: "steer" });
		expect(h.notify).not.toHaveBeenCalledWith(expect.stringContaining("WHY-IT-FITS"), expect.anything());
	});

	it("sends nothing extra when the main assistant changes the heads itself", async () => {
		const h = await harness();
		const [definition] = vi.mocked(h.pi.registerTool).mock.calls[0] as unknown as [{ execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }];
		const result = await definition.execute("call", { action: "manage_heads", operation: "remove", head: "critic", message: "WHY-IT-FITS" }, undefined, undefined, h.ctx);
		expect(result.content[0].text).toContain("WHY-IT-FITS");
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(h.pi.sendMessage).not.toHaveBeenCalled();
	});

	it("warns loudly when a steer cannot be sent", async () => {
		const h = await harness();
		vi.mocked(h.pi.sendUserMessage).mockImplementation(() => { throw new Error("Extension context is stale"); });
		await h.observe(answer([tool("write", { path: "ignored", content: "x" })], "toolUse"));
		await h.waitCalls(1);
		expect(h.notify).toHaveBeenCalledWith("hydra: steer delivery failed: Extension context is stale", "warning");
	});

	it("warns on the error output in a headless run when a steer never arrived", async () => {
		const h = await harness();
		(h.ctx as { hasUI: boolean }).hasUI = false;
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		h.busy();
		await h.observe(answer([text(JSON.stringify({ findings: [{ action: "steer", message: "NEVER ARRIVES", reason: "r" }] }))]));
		await h.waitCalls(1);
		await h.emit({ type: "agent_settled" });
		expect(stderr).toHaveBeenCalledWith(expect.stringContaining("never reached the driver"));
		stderr.mockRestore();
	});
});

describe("observation loop stops", () => {
	it.each(["anthropic-messages", "openai-codex-responses"] as const)("%s stops once the head completes and records its turns", async (api) => {
		const h = await harness({ api, tools: "read" });
		writeFileSync(join(h.cwd, "work.txt"), "content");
		await h.observe(
			answer([tool("read", { path: "work.txt" })], "toolUse"),
			api === "anthropic-messages"
				? answer([text('{"action":"noop","reason":"checked","message":""}')])
				: answer([tool("hydra", { action: "complete_observation", delivery: "none", message: "" })], "toolUse"),
		);
		await h.waitCalls(1);
		expect(h.transport).toHaveBeenCalledTimes(2);
		expect(h.calls()[0]).toMatchObject({ action: "noop", iterations: 2 });
	});

	it("stops a Codex head sharing the driver's session once sharing becomes unsafe", async () => {
		const h = await harness({ api: "openai-codex-responses", tools: "read" });
		writeFileSync(join(h.cwd, "work.txt"), "content");
		let respond!: (response: AssistantMessage) => void;
		await h.observe(new Promise<AssistantMessage>(resolve => { respond = resolve; }));
		await vi.waitFor(() => expect(h.transport).toHaveBeenCalledTimes(1));
		boundary.transport = "auto";
		respond(answer([tool("read", { path: "work.txt" })], "toolUse"));
		await h.waitCalls(1);
		expect(h.transport).toHaveBeenCalledTimes(1);
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("codex cache sharing lost mid-loop"), "warning");
	});

	it("stops a head turned off part-way through its check", async () => {
		const h = await harness({ tools: "read" });
		writeFileSync(join(h.cwd, "work.txt"), "content");
		let respond!: (response: AssistantMessage) => void;
		await h.observe(new Promise<AssistantMessage>(resolve => { respond = resolve; }));
		await vi.waitFor(() => expect(h.transport).toHaveBeenCalledTimes(1));
		rmSync(join(h.cwd, ".pi", "hydra", "critic.md"));
		await h.emit({ type: "agent_start" });
		respond(answer([tool("read", { path: "work.txt" })], "toolUse"));
		await h.waitCalls(1);
		expect(h.transport).toHaveBeenCalledTimes(1);
		expect(h.calls()[0].action).toBe("noop");
	});
});

describe("file changes by a head", () => {
	it("sends nothing automatically; the head reports its own change", async () => {
		const h = await harness({ tools: "write" });
		await h.observe(
			answer([tool("write", { path: "work.txt", content: "after" })], "toolUse"),
			answer([text('{"action":"steer","reason":"changed","message":"I rewrote work.txt"}')]),
		);
		await h.waitCalls(1);
		expect(readFileSync(join(h.cwd, "work.txt"), "utf8")).toBe("after");
		expect(h.pi.sendMessage).not.toHaveBeenCalled();
		expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(h.pi.sendUserMessage).toHaveBeenCalledWith("[pi-hydra critic] I rewrote work.txt", undefined);
	});
});
