import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api, AssistantMessage, Message, Model, ToolCall } from "@earendil-works/pi-ai";
import type { streamSimple } from "@earendil-works/pi-ai/compat";
import { convertToLlm, initTheme, SessionManager, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import hydraExtension from "./index.ts";
import type { HydraCall } from "./stats.ts";

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

async function harness(options: { flag?: string; autostart?: boolean; heads?: string[]; resume?: { cwd: string; sm: SessionManager }; tools?: string | null; api?: "anthropic-messages" | "openai-codex-responses" | "openai-responses"; provider?: string; oauth?: boolean; baseUrl?: string; transport?: "websocket" | "auto"; changeAuthAfter?: number; failAuthAfter?: number; authorizationHeaderAfter?: number; modelAuthHeader?: boolean; activeTools?: string[]; settings?: { codemode?: { mode?: "on" | "only" } } } = {}) {
	boundary.transport = options.transport ?? "websocket";
	let currentOAuth = options.oauth ?? true;
	let authChecks = 0;
	let authRequests = 0;
	const cwd = options.resume?.cwd ?? mkdtempSync(join(process.cwd(), ".observer-test-"));
	boundary.agentDir = join(cwd, "agent");
	mkdirSync(join(cwd, ".pi", "hydra"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "hydra", "critic.md"), `---\nname: critic\ndescription: Test observer\nautostart: ${options.autostart ?? false}\n${options.tools === null ? "" : `tools: ${options.tools ?? "[]"}\n`}---\nFollow these test instructions.\n`);
	const sm = options.resume?.sm ?? SessionManager.inMemory(cwd);
	const root = options.resume ? sm.getBranch()[0].id : sm.appendCustomEntry("hydra-config", { heads: options.heads ?? ["critic"] });
	const handlers = new Map<string, Handler>();
	const responses: (AssistantMessage | Promise<AssistantMessage>)[] = [];
	const payloads: unknown[] = [];
	let idle = true;
	const api = options.api ?? "anthropic-messages";
	const model = { api, provider: options.provider ?? (api === "anthropic-messages" ? "anthropic" : api === "openai-responses" ? "openai" : "openai-codex"), baseUrl: options.baseUrl ?? "https://api.openai.com/v1", headers: options.modelAuthHeader ? { Authorization: "Bearer sk-fake" } : undefined, id: "test", contextWindow: 200000, maxTokens: 4096 } as Model<Api>;
	// The main assistant's replies name the model that answered, as pi's do.
	const driverAnswer = (value: string): AssistantMessage => ({ ...answer([text(value)]), provider: model.provider, model: model.id });
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
			getApiKeyAndHeaders: async () => ++authRequests > (options.failAuthAfter ?? Infinity)
				? { ok: false, error: "credential refresh failed" }
				: { ok: true, apiKey: currentOAuth ? "test" : "api-key", headers: options.authorizationHeaderAfter !== undefined && authRequests > options.authorizationHeaderAfter ? { authorization: "Bearer sk-fake" } : undefined },
			getProviderAuth: async () => {
				authChecks++;
				if (options.changeAuthAfter && authChecks > options.changeAuthAfter) currentOAuth = false;
				return { source: currentOAuth ? "OAuth" : "stored credential", auth: { apiKey: currentOAuth ? "test" : "api-key" } };
			},
			streamSimple: transport,
			isUsingOAuth: () => options.oauth ?? true,
		},
	} as unknown as ExtensionContext;
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerFlag: vi.fn(), registerTool: vi.fn(), registerCommand: vi.fn(), registerMessageRenderer: vi.fn(),
		getFlag: () => options.flag,
		// Every tool Hydra can run is active unless a test says otherwise.
		getActiveTools: () => options.activeTools ?? ["read", "bash", "edit", "write", "grep", "find", "ls", "hydra"],
		getSettings: () => options.settings ?? {},
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
		await emit({ type: "message_start", message: driverAnswer("Driver is working") });
	};
	await emit({ type: "agent_start" });
	// The first main assistant response is deliberately skipped by Hydra.
	await emit({ type: "before_provider_request", payload: api === "anthropic-messages" ? { messages: [] } : { input: [] } });
	await emit({ type: "message_start", message: driverAnswer("First driver response") });
	cleanups.push(async () => {
		await emit({ type: "session_shutdown", reason: "quit" });
		rmSync(cwd, { recursive: true, force: true });
	});
	// The hydra tool as the main assistant calls it.
	const hydraTool = (params: Record<string, unknown>) => {
		const definition = vi.mocked(pi.registerTool).mock.calls[0][0] as unknown as { execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> };
		return definition.execute("driver-call", { message: "why", ...params }, undefined, undefined, ctx);
	};
	const configs = () => sm.getBranch().filter(e => e.type === "custom" && e.customType === "hydra-config").map(e => (e as { data: Record<string, unknown> }).data);
	const steers = () => vi.mocked(pi.sendUserMessage).mock.calls.map(([content]) => String(content));
	return { cwd, sm, root, ctx, pi, payloads, transport, notify, emit, observe, calls, hydraTool, configs, steers,
		changeAuth: () => { currentOAuth = false; },
		busy: () => { idle = false; }, idle: () => { idle = true; },
		waitCalls: async (count: number) => { await vi.waitFor(() => expect(calls(), JSON.stringify(notify.mock.calls)).toHaveLength(count)); },
	};
}

describe("heads without tools through the extension", () => {
	it("a judge head on ChatGPT sign-in gets its instructions as a user message and the rules as a developer message", async () => {
		const h = await harness({ api: "openai-responses" });
		await h.observe(noop());
		await h.waitCalls(1);
		const input = (h.payloads[0] as { input: { role?: string; content?: unknown }[] }).input;
		const lens = input.findIndex((item) => item.role === "user" && JSON.stringify(item.content).includes("HEAD INSTRUCTIONS:"));
		expect(lens).toBeGreaterThanOrEqual(0);
		expect(input[lens + 1]).toMatchObject({ role: "developer" });
		expect(JSON.stringify(input[lens + 1].content)).toContain("You are reviewing the main assistant's work");
		expect(JSON.stringify(input[lens].content)).not.toContain("You are reviewing the main assistant's work");
	});

	it("observes ChatGPT sign-in under the driver's cache session", async () => {
		const h = await harness({ api: "openai-responses" });
		await h.observe(noop());
		await h.waitCalls(1);
		expect(h.calls()[0].api).toBe("openai-responses");
		expect(h.transport.mock.calls[0][2].sessionId).toBe(h.sm.getSessionId());
		expect(h.payloads[0]).toMatchObject({ input: expect.arrayContaining([expect.objectContaining({ role: "user" })]) });
	});

	it("a judge head on ds4 gets its instructions and the rules in one user message, without a ChatGPT sign-in", async () => {
		const h = await harness({ api: "openai-responses", provider: "ds4", baseUrl: "http://127.0.0.1:8000/v1", oauth: false });
		await h.observe(noop());
		await h.waitCalls(1);
		const input = (h.payloads[0] as { input: { role?: string; content?: unknown }[] }).input;
		expect(input.some((item) => item.role === "developer")).toBe(false);
		const last = input.at(-1)!;
		expect(last.role).toBe("user");
		expect(JSON.stringify(last.content)).toContain("You are reviewing the main assistant's work");
		expect(JSON.stringify(last.content)).toContain("Follow these test instructions.");
		expect(h.transport.mock.calls[0][2]).toMatchObject({ apiKey: undefined, sessionId: undefined });
	});

	it("leaves ds4 on any other API disabled", async () => {
		const h = await harness({ api: "openai-codex-responses", provider: "ds4" });
		await h.observe();
		await vi.waitFor(() => expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("observations disabled for ds4/openai-codex-responses"), "warning"));
		expect(h.transport).not.toHaveBeenCalled();
	});

	it("does not enable unmeasured OpenAI API-key replay", async () => {
		const h = await harness({ api: "openai-responses", oauth: false });
		await h.observe();
		await vi.waitFor(() => expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("observations disabled for openai/openai-responses"), "warning"));
		expect(h.transport).not.toHaveBeenCalled();
		expect(h.calls()).toEqual([]);
	});

	it("rejects an API key even when Pi's OAuth availability snapshot is stale", async () => {
		const h = await harness({ api: "openai-responses" });
		h.changeAuth();
		await h.observe();
		await vi.waitFor(() => expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("sign-in or endpoint changed"), "warning"));
		expect(h.transport).not.toHaveBeenCalled();
	});

	it("rejects an Authorization override from the model or resolved headers", async () => {
		for (const options of [{ modelAuthHeader: true }, { authorizationHeaderAfter: 0 }]) {
			const h = await harness({ api: "openai-responses", ...options });
			await h.observe();
			await vi.waitFor(() => expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("sign-in or endpoint changed"), "warning"));
			expect(h.transport).not.toHaveBeenCalled();
		}
	});

	it("rechecks the actual OAuth credential before dispatching a judge", async () => {
		for (const options of [{ changeAuthAfter: 1 }, { failAuthAfter: 1 }, { authorizationHeaderAfter: 1 }]) {
			const h = await harness({ api: "openai-responses", ...options });
			await h.observe();
			await vi.waitFor(() => expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("observation failed"), "error"));
			expect(h.transport).not.toHaveBeenCalled();
			expect(h.calls()).toEqual([]);
		}
	});

	it("does not observe a different OpenAI-compatible endpoint", async () => {
		const h = await harness({ api: "openai-responses", baseUrl: "https://other.example/v1" });
		await h.observe();
		await vi.waitFor(() => expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("observations disabled for openai/openai-responses"), "warning"));
		expect(h.transport).not.toHaveBeenCalled();
	});

	it.each(["anthropic-messages", "openai-codex-responses", "openai-responses"] as const)("%s never executes or repairs a tool request, and records it without steering", async (api) => {
		const h = await harness({ api });
		const target = join(h.cwd, "must-not-exist");
		await h.observe(answer([tool("write", { path: target, content: "SECRET-ARGUMENT" }), text('{"findings":[{"action":"steer","reason":"mixed","message":"MUST NOT DELIVER"}]}')], "toolUse"));
		await h.waitCalls(1);
		expect(existsSync(target)).toBe(false);
		expect(h.transport).toHaveBeenCalledTimes(1);
		expect(h.calls()[0]).toMatchObject({ action: "noop", judgeErrorKind: "blocked-tool-request", attemptedTools: ["write"], stopReason: "toolUse" });
		// Judge heads get their instructions labelled on both providers.
		expect(JSON.stringify(h.payloads[0])).toContain("HEAD INSTRUCTIONS: Follow these test instructions.");
		expect(h.pi.sendMessage).not.toHaveBeenCalled();
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("blocked-tool-request"), "warning");
		await h.observe(noop());
		await h.waitCalls(2);
		expect(JSON.stringify(h.payloads[1])).not.toContain("SECRET-ARGUMENT");
	});

	it.each([
		["cut short", answer([tool("write", { path: "bad" }), text('{"findings":')], "length"), "truncated"],
		["empty", answer(), "empty-answer"],
		["empty zero-usage", { ...answer(), usage: { ...answer().usage, input: 0, cacheRead: 0, output: 0, totalTokens: 0 } }, "empty-answer"],
		["thinking-only", answer([{ type: "thinking", thinking: "SECRET-THINKING" }]), "empty-answer"],
		["malformed", answer([text("SECRET-PROSE")]), "malformed-findings"],
		["provider error", { ...answer([tool("write", {})], "error"), errorMessage: "provider unavailable" }, "provider-error"],
		["provider abort", answer([tool("write", {})], "aborted"), "aborted"],
	] as const)("records %s without guessing why it happened", async (_name, response, kind) => {
		const h = await harness();
		await h.observe(response);
		await h.waitCalls(1);
		expect(h.calls()[0]).toMatchObject({ action: "noop", judgeErrorKind: kind });
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining(kind), expect.any(String));
	});

	it("/hydra-stats counts failed checks by type", async () => {
		const h = await harness();
		await h.observe(answer([text("not JSON")]));
		await h.waitCalls(1);
		await h.observe(answer([tool("write", { path: "ignored" })], "toolUse"));
		await h.waitCalls(2);
		await h.observe(noop());
		await h.waitCalls(3);
		const command = vi.mocked(h.pi.registerCommand).mock.calls.find(([name]) => name === "hydra-stats")![1] as unknown as { handler: (args: string, ctx: unknown) => Promise<void> };
		await command.handler("", h.ctx);
		expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("failed checks (counted as noop): 2 (1 malformed-findings, 1 blocked-tool-request)"), "info");
	});

	it("keeps valid noop and steer separate", async () => {
		const h = await harness();
		await h.observe(noop());
		await h.waitCalls(1);
		expect(h.calls()[0]).not.toHaveProperty("judgeErrorKind", expect.any(String));
		await h.observe(answer([text(JSON.stringify({ findings: [
			{ action: "steer", message: "DRIVER ACTION", reason: "driver" },
		] }))]));
		await h.waitCalls(2);
		expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(h.pi.sendUserMessage).toHaveBeenCalledWith("[pi-hydra critic] DRIVER ACTION", undefined);
	});

	it.each([false, true])("rejects deprecated head print without delivering its answer (mixed: %s)", async (mixed) => {
		const h = await harness();
		const findings = [
			{ action: "print", message: "PRIVATE PRINT", reason: "user" },
			...(mixed ? [{ action: "steer", message: "PRIVATE STEER", reason: "driver" }] : []),
		];
		await h.observe(answer([text(JSON.stringify({ findings }))]));
		await h.waitCalls(1);
		expect(h.calls()[0]).toMatchObject({ action: "noop", judgeErrorKind: "malformed-findings" });
		expect(h.notify).not.toHaveBeenCalledWith(expect.stringContaining("PRIVATE PRINT"), "info");
		expect(JSON.stringify(vi.mocked(h.pi.sendUserMessage).mock.calls)).not.toMatch(/PRIVATE PRINT|PRIVATE STEER/);
		expect(h.pi.sendMessage).not.toHaveBeenCalled();
	});
});

describe("results that arrive late", () => {
	const late = () => answer([text(JSON.stringify({ findings: [{ action: "steer", message: "LATE STEER", reason: "r" }] }))]);

	it("does not inject stale-branch results", async () => {
		const h = await harness();
		let finish!: (response: AssistantMessage) => void;
		await h.observe(new Promise(resolve => { finish = resolve; }));
		await vi.waitFor(() => expect(h.transport).toHaveBeenCalledTimes(1));
		h.sm.branch(h.root);
		await h.emit({ type: "session_tree", oldLeafId: h.root, newLeafId: h.root });
		finish(late());
		await h.observe(noop());
		await h.waitCalls(1);
		expect(h.calls()).toHaveLength(1);
		expect(h.calls()[0].action).toBe("noop");
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("a head already checking when the user cancels keeps working, edits included, and its message does not wake the main assistant", async () => {
		const h = await harness({ api: "openai-codex-responses", tools: "write,hydra" });
		const run = new AbortController();
		(h.ctx as { signal?: AbortSignal }).signal = run.signal;
		let respond!: (response: AssistantMessage) => void;
		await h.observe(
			new Promise<AssistantMessage>((resolve) => { respond = resolve; }),
			answer([tool("hydra", { action: "complete_observation", delivery: "steer", message: "WROTE A FILE" })], "toolUse"),
		);
		await vi.waitFor(() => expect(h.transport).toHaveBeenCalledTimes(1));
		run.abort();
		await h.emit({ type: "agent_end", messages: [answer([], "aborted")] });
		respond(answer([tool("write", { path: "after-cancel.txt", content: "written after cancel" })], "toolUse"));
		await h.waitCalls(1);
		expect(readFileSync(join(h.cwd, "after-cancel.txt"), "utf8")).toBe("written after cancel");
		expect(h.calls()[0].toolsUsed).toEqual(["write"]);
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(h.pi.sendMessage).toHaveBeenCalledWith(expect.anything(), { triggerTurn: false });
	});

	it("does not inject a response arriving after cancellation", async () => {
		const h = await harness();
		let finish!: (response: AssistantMessage) => void;
		await h.observe(new Promise(resolve => { finish = resolve; }));
		await vi.waitFor(() => expect(h.transport).toHaveBeenCalledTimes(1));
		vi.stubEnv("HYDRA_SHUTDOWN_GRACE_MS", "0");
		await h.emit({ type: "session_shutdown", reason: "quit" });
		finish(late());
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
		await h.observe(answer([text(JSON.stringify({ findings: [{ action: "steer", message: "CANNOT SEND", reason: "r" }] }))]));
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
	it("keeps a ChatGPT acting head running under the default auto transport", async () => {
		const h = await harness({ api: "openai-responses", tools: "read", transport: "auto" });
		writeFileSync(join(h.cwd, "work.txt"), "content");
		await h.observe(
			answer([tool("read", { path: "work.txt" })], "toolUse"),
			answer([tool("hydra", { action: "complete_observation", delivery: "none", message: "" })], "toolUse"),
		);
		await h.waitCalls(1);
		expect(h.transport).toHaveBeenCalledTimes(2);
		expect(h.calls()[0]).toMatchObject({ action: "noop", iterations: 2, toolsUsed: ["read"] });
		expect(h.notify).not.toHaveBeenCalledWith(expect.stringContaining("codex cache sharing lost mid-loop"), "warning");
	});

	it("does not fall back to a stale ChatGPT token when credential refresh fails mid-loop", async () => {
		const h = await harness({ api: "openai-responses", tools: "read", failAuthAfter: 2 });
		writeFileSync(join(h.cwd, "work.txt"), "content");
		await h.observe(answer([tool("read", { path: "work.txt" })], "toolUse"));
		await vi.waitFor(() => expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("credential refresh failed"), "error"));
		expect(h.transport).toHaveBeenCalledTimes(1);
		expect(h.calls()).toEqual([]);
	});

	it("stops a ChatGPT acting head when an Authorization override appears mid-loop", async () => {
		const h = await harness({ api: "openai-responses", tools: "read", authorizationHeaderAfter: 2 });
		writeFileSync(join(h.cwd, "work.txt"), "content");
		await h.observe(answer([tool("read", { path: "work.txt" })], "toolUse"));
		await vi.waitFor(() => expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("head stopped"), "error"));
		expect(h.transport).toHaveBeenCalledTimes(1);
	});

	it("stops a ChatGPT acting head when the credential changes between turns", async () => {
		const h = await harness({ api: "openai-responses", tools: "read", changeAuthAfter: 2 });
		writeFileSync(join(h.cwd, "work.txt"), "content");
		await h.observe(answer([tool("read", { path: "work.txt" })], "toolUse"));
		await vi.waitFor(() => expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("head stopped"), "error"));
		expect(h.transport).toHaveBeenCalledTimes(1);
		expect(h.calls()).toEqual([]);
	});
	it.each([
		["anthropic-messages", undefined],
		["openai-codex-responses", undefined],
		["openai-responses", undefined],
		["openai-responses", "ds4"],
	] as const)("%s (%s) stops once the head completes and records its turns", async (api, provider) => {
		const h = await harness({ api, provider, tools: "read" });
		writeFileSync(join(h.cwd, "work.txt"), "content");
		// Anthropic and ds4 get one combined message and finish with a JSON
		// decision; the other routes split and finish through the hydra tool.
		const split = api !== "anthropic-messages" && provider !== "ds4";
		await h.observe(
			answer([tool("read", { path: "work.txt" })], "toolUse"),
			split
				? answer([tool("hydra", { action: "complete_observation", delivery: "none", message: "" })], "toolUse")
				: answer([text('{"action":"noop","reason":"checked","message":""}')]),
		);
		await h.waitCalls(1);
		expect(h.transport).toHaveBeenCalledTimes(2);
		expect(h.calls()[0]).toMatchObject({ action: "noop", iterations: 2 });
		// Pi's note with the head's tools reaches only Anthropic, which needs
		// it to map subscription tool names back. Codex requests stay as they were.
		const noted = JSON.stringify(h.payloads.at(-1)).includes('"toolsAdded"');
		expect(noted).toBe(api === "anthropic-messages");
		// Acting heads too. On the OpenAI routes the instructions arrive as their
		// own message, which heads otherwise took for the user's latest request.
		expect(JSON.stringify(h.payloads[0])).toContain("HEAD INSTRUCTIONS: Follow these test instructions.");
		// Split routes split on every turn of the loop: Hydra's rules follow
		// the head's instructions as one developer message.
		if (split) {
			for (const payload of h.payloads as { input: { role?: string; content?: unknown }[] }[]) {
				const lens = payload.input.findIndex((item) => item.role === "user" && JSON.stringify(item.content).includes("HEAD INSTRUCTIONS:"));
				expect(payload.input[lens + 1]).toMatchObject({ role: "developer" });
				expect(JSON.stringify(payload.input[lens + 1].content)).toContain("The previous user message contains all instructions");
				expect(payload.input.filter((item) => item.role === "developer")).toHaveLength(1);
			}
		}
		// ds4 gets no developer message and no key from hydra: pi resolves it.
		if (provider === "ds4") {
			for (const payload of h.payloads as { input: { role?: string }[] }[]) expect(payload.input.some((item) => item.role === "developer")).toBe(false);
			for (const call of h.transport.mock.calls) expect(call[2]).toMatchObject({ apiKey: undefined });
		}
	});

	it("skips a waiting check when the model changed since its request was captured", async () => {
		const h = await harness({ api: "openai-codex-responses" });
		let respond!: (response: AssistantMessage) => void;
		await h.observe(new Promise<AssistantMessage>(resolve => { respond = resolve; }));
		await vi.waitFor(() => expect(h.transport).toHaveBeenCalledTimes(1));
		await h.observe(noop()); // waits behind the busy check, with Codex's request
		(h.ctx as { model: Model<Api> }).model = { ...h.ctx.model!, api: "openai-responses", provider: "openai", baseUrl: "https://api.openai.com/v1" };
		respond(noop());
		await h.waitCalls(1);
		await new Promise(resolve => setTimeout(resolve, 50));
		expect(h.transport).toHaveBeenCalledTimes(1);
	});

	it("skips a check whose request the old model answered after the model was switched", async () => {
		const h = await harness({ api: "openai-codex-responses" });
		// pi applies a switch to the selection while a request already being
		// prepared still goes to the old model, so the capture sees the new one.
		(h.ctx as { model: Model<Api> }).model = { ...h.ctx.model!, api: "openai-responses", provider: "openai", baseUrl: "https://api.openai.com/v1" };
		await h.observe(noop());
		await new Promise(resolve => setTimeout(resolve, 50));
		expect(h.transport).not.toHaveBeenCalled();
	});

	it("a one-off whose request the old model answered does not start after the model was switched, and says so", async () => {
		const h = await harness({ heads: [], api: "openai-codex-responses" });
		await h.hydraTool({ action: "manage_heads", operation: "add", head: "single", lifetime: "once", instructions: "Check.", tools: [] });
		(h.ctx as { model: Model<Api> }).model = { ...h.ctx.model!, api: "openai-responses", provider: "openai", baseUrl: "https://api.openai.com/v1" };
		await h.observe(noop());
		await new Promise(resolve => setTimeout(resolve, 50));
		expect(h.transport).not.toHaveBeenCalled();
		expect(h.notify).toHaveBeenCalledWith('hydra: one-off head "single" did not start: the model was switched', "warning");
		expect(vi.mocked(h.ctx.ui.setStatus).mock.calls.at(-1)?.[1]).toBe("hydra: no heads | (no obs yet)");
		expect(h.steers()).toEqual(["[pi-hydra single] automatic notice: its one check did not start: the model was switched. This head is gone."]);
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

	it.each(["anthropic-messages", "openai-codex-responses"] as const)("%s: a head that removes itself finishes in that turn, with no further call or warning", async (api) => {
		const h = await harness({ api, tools: "hydra" });
		await h.observe(answer([tool("hydra", { action: "manage_heads", operation: "remove", head: "critic", message: "my job here is over" })], "toolUse"));
		await h.waitCalls(1);
		expect(h.transport).toHaveBeenCalledTimes(1);
		expect(h.calls()[0].action).toBe("noop");
		expect(h.notify).not.toHaveBeenCalledWith(expect.anything(), "warning");
		expect(JSON.stringify(vi.mocked(h.pi.sendUserMessage).mock.calls)).toContain("[pi-hydra critic] automatic notice: Removed critic — my job here is over");
	});

	it("anthropic: a decision written in the same reply as removing itself is delivered, not dropped", async () => {
		const h = await harness({ tools: "hydra" });
		await h.observe(answer([
			text('{"action":"steer","reason":"handover","message":"FINAL-FINDING"}'),
			tool("hydra", { action: "manage_heads", operation: "remove", head: "critic", message: "leaving" }),
		], "toolUse"));
		await h.waitCalls(1);
		expect(h.transport).toHaveBeenCalledTimes(1);
		expect(h.calls()[0].action).toBe("steer");
		expect(JSON.stringify(vi.mocked(h.pi.sendUserMessage).mock.calls)).toContain("FINAL-FINDING");
	});

	it("blocks a self-removal sent together with other work, so the head sees that work's result first", async () => {
		const h = await harness({ api: "openai-codex-responses", tools: "hydra, edit" });
		writeFileSync(join(h.cwd, "work.txt"), "content");
		const removal = tool("hydra", { action: "manage_heads", operation: "remove", head: "critic", message: "notes updated" });
		await h.observe(
			answer([tool("edit", { path: "work.txt", edits: [{ oldText: "missing", newText: "x" }] }), removal], "toolUse"),
			answer([removal], "toolUse"),
		);
		await h.waitCalls(1);
		expect(h.transport).toHaveBeenCalledTimes(2);
		const secondTurn = JSON.stringify(h.payloads[1]);
		expect(secondTurn).toContain("must be the only tool call in their turn");
		expect(secondTurn).toContain("Could not find");
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

describe("acting JSON answer validation", () => {
	it.each([
		["anthropic-messages", "anthropic"],
		["openai-responses", "ds4"],
	] as const)("%s (%s) accepts one prose-wrapped decision with a literal trailing brace", async (api, provider) => {
		const h = await harness({ api, provider, tools: "read" });
		await h.observe(answer([text('Decision: {"action":"steer","reason":"r","message":"Use the template syntax."} The placeholder is {name}.')]));
		await h.waitCalls(1);
		expect(h.calls()[0].action).toBe("steer");
		expect(h.pi.sendUserMessage).toHaveBeenCalledWith("[pi-hydra critic] Use the template syntax.", undefined);
	});

	it.each([
		["anthropic-messages", "anthropic"],
		["openai-responses", "ds4"],
	] as const)("%s (%s) rejects mixed findings without extracting a nested steer", async (api, provider) => {
		const h = await harness({ api, provider, tools: "read" });
		await h.observe(answer([text(JSON.stringify({ findings: [
			{ action: "print", message: "PRIVATE PRINT" },
			{ action: "steer", message: "PRIVATE STEER" },
		] }))]));
		await h.waitCalls(1);
		expect(h.calls()[0].action).toBe("noop");
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("unparseable JSON decision"), "warning");
		expect(h.notify).not.toHaveBeenCalledWith(expect.stringContaining("PRIVATE PRINT"), "info");
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(h.pi.sendMessage).not.toHaveBeenCalled();
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

describe("heads with an end: once and ends_when", () => {
	const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
	const headFiles = (h: { cwd: string }) => [join(h.cwd, ".pi", "hydra"), join(h.cwd, "agent", "hydra")].flatMap((dir) => (existsSync(dir) ? readdirSync(dir) : []));
	const findings = (value: object) => answer([text(JSON.stringify(value))]);

	it("a one-off head without a file checks exactly once, starting with the next response, and leaves nothing behind", async () => {
		const h = await harness({ heads: [] });
		const filesBefore = headFiles(h);
		const reply = await h.hydraTool({ action: "manage_heads", operation: "add", head: "cache-check", lifetime: "once", instructions: "Check the cache key.", tools: [] });
		expect(reply.content[0].text).toContain("Added cache-check for one check — why");
		await h.observe(noop());
		await h.waitCalls(1);
		expect(h.calls()[0].head).toBe("cache-check");
		expect(JSON.stringify(h.payloads[0])).toContain("HEAD INSTRUCTIONS: Check the cache key.");
		await h.observe();
		await h.emit({ type: "agent_end", messages: [] });
		await settle();
		expect(h.transport).toHaveBeenCalledTimes(1);
		expect(headFiles(h)).toEqual(filesBefore);
		expect(JSON.stringify(h.configs())).not.toContain("cache-check");
	});

	it("the footer shows a one-off head from the add until its check is done", async () => {
		const h = await harness({ heads: [] });
		const footer = () => vi.mocked(h.ctx.ui.setStatus).mock.calls.at(-1)?.[1];
		await h.hydraTool({ action: "manage_heads", operation: "add", head: "reviewer", ends_when: "the commit lands", instructions: "Review.", tools: [] });
		await h.hydraTool({ action: "manage_heads", operation: "add", head: "cache-check", lifetime: "once", instructions: "Check.", tools: [] });
		expect(footer()).toBe("hydra: reviewer+cache-check (once) | (no obs yet)");
		let finish!: (message: AssistantMessage) => void;
		await h.observe(noop(), new Promise<AssistantMessage>((resolve) => { finish = resolve; }));
		await h.waitCalls(1);
		expect(footer()).toContain("hydra:reviewer+cache-check (once) ");
		finish(noop());
		await h.waitCalls(2);
		await vi.waitFor(() => expect(footer()).toMatch(/^hydra:reviewer hit .*\(2 obs\)$/));
	});

	it("the reply to adding a one-off and /hydra-heads list it with the other heads", async () => {
		const h = await harness();
		const reply = await h.hydraTool({ action: "manage_heads", operation: "add", head: "cache-check", lifetime: "once", instructions: "Check.", tools: [] });
		expect(reply.content[0].text).toContain("You hear back when it has finished, also when it found nothing. Observing with: critic, cache-check (once).");
		// Without a UI, /hydra-heads lists the heads instead of opening the picker.
		(h.ctx as { hasUI: boolean }).hasUI = false;
		const command = vi.mocked(h.pi.registerCommand).mock.calls.find(([name]) => name === "hydra-heads")![1] as unknown as { handler: (args: string, ctx: unknown) => Promise<void> };
		await command.handler("", h.ctx);
		expect(h.notify).toHaveBeenLastCalledWith(expect.stringMatching(/^hydra: active: critic, cache-check \(once\)\n/), "info");
	});

	describe("a one-off head that sends no message of its own is reported to the main assistant", () => {
		const notice = (head: string, fact: string) => `[pi-hydra ${head}] automatic notice: ${fact} This head is gone.`;
		const add = (h: Awaited<ReturnType<typeof harness>>) => h.hydraTool({ action: "manage_heads", operation: "add", head: "cache-check", lifetime: "once", instructions: "Check.", tools: [] });

		it.each([
			["found nothing", noop(), "its one check found nothing to report, so it sent no message."],
			["its check failed", answer([text("not JSON")]), "its one check failed (malformed-findings), so it sent no message."],
		])("when it %s", async (_case, response, fact) => {
			const h = await harness({ heads: [] });
			await add(h);
			await h.observe(response);
			await h.waitCalls(1);
			await vi.waitFor(() => expect(h.steers()).toEqual([notice("cache-check", fact)]));
		});

		it("when its check stopped before it finished", async () => {
			const h = await harness({ heads: [], api: "openai-responses" });
			await add(h);
			h.changeAuth();
			await h.observe();
			await vi.waitFor(() => expect(h.steers()).toEqual([notice("cache-check", "its one check stopped before it finished, so it sent no message.")]));
			expect(h.calls()).toEqual([]);
		});

		it("but not when the head sent its own message", async () => {
			const h = await harness({ heads: [] });
			await add(h);
			await h.observe(findings({ findings: [{ action: "steer", reason: "r", message: "FOUND IT" }] }));
			await h.waitCalls(1);
			await settle();
			expect(h.steers()).toEqual(["[pi-hydra cache-check] FOUND IT"]);
		});

		it("but not for a check left behind when the conversation switched branches while it ran", async () => {
			const h = await harness({ heads: [] });
			await add(h);
			let finish!: (message: AssistantMessage) => void;
			await h.observe(new Promise<AssistantMessage>((resolve) => { finish = resolve; }));
			await vi.waitFor(() => expect(h.transport).toHaveBeenCalledTimes(1));
			await h.emit({ type: "session_tree" } as ExtensionEvent);
			finish(noop());
			await settle();
			expect(h.steers()).toEqual([]);
		});
	});

	it("a one-off head runs on the first response of a run too", async () => {
		const h = await harness({ heads: [] });
		await h.emit({ type: "agent_end", messages: [] });
		await h.hydraTool({ action: "manage_heads", operation: "add", head: "cache-check", lifetime: "once", instructions: "Check.", tools: [] });
		await h.emit({ type: "agent_start" });
		await h.observe(noop());
		await h.waitCalls(1);
		expect(h.calls()[0].head).toBe("cache-check");
	});

	it("runs a head file once without activating it", async () => {
		const h = await harness({ heads: [] });
		await h.hydraTool({ action: "manage_heads", operation: "add", head: "critic", lifetime: "once" });
		await h.observe(noop());
		await h.waitCalls(1);
		expect(JSON.stringify(h.payloads[0])).toContain("HEAD INSTRUCTIONS: Follow these test instructions.");
		await h.observe();
		await settle();
		expect(h.transport).toHaveBeenCalledTimes(1);
		expect(h.configs().at(-1)).toEqual({ heads: [] });
	});

	it("lets a one-off head with tools work through several turns", async () => {
		const h = await harness({ heads: [], api: "openai-codex-responses" });
		writeFileSync(join(h.cwd, "work.txt"), "content");
		await h.hydraTool({ action: "manage_heads", operation: "add", head: "worker", lifetime: "once", instructions: "Read work.txt.", tools: ["read"] });
		await h.observe(
			answer([tool("read", { path: "work.txt" })], "toolUse"),
			answer([tool("hydra", { action: "complete_observation", delivery: "steer", message: "work.txt says content" })], "toolUse"),
		);
		await h.waitCalls(1);
		expect(h.transport).toHaveBeenCalledTimes(2);
		expect(h.calls()[0]).toMatchObject({ head: "worker", action: "steer", toolsUsed: ["read"] });
	});

	it.each([
		["instructions under a head file's name", { head: "critic", lifetime: "once", instructions: "x" }, "is already a head's name"],
		["once for an active head", { head: "critic", lifetime: "once" }, "already active"],
		["ends_when for an active head", { head: "critic", ends_when: "x" }, "already active"],
		["an unknown head file", { head: "ghost", lifetime: "once" }, 'Unknown head "ghost"'],
		["a head without a file and without an end", { head: "fresh", instructions: "x" }, "needs an end"],
		["once with ends_when", { head: "fresh", lifetime: "once", instructions: "x", ends_when: "y" }, "cannot take ends_when"],
		["tools for a head file", { head: "critic", lifetime: "once", tools: ["read"] }, "tools is only for a head without a file"],
		["a diagnostic head with a lifetime", { head: "test", lifetime: "once" }, "diagnostic head"],
	])("rejects %s and changes nothing", async (_case, fields, error) => {
		const h = await harness();
		const configsBefore = h.configs().length;
		await expect(h.hydraTool({ action: "manage_heads", operation: "add", ...fields })).rejects.toThrow(error);
		expect(h.configs()).toHaveLength(configsBefore);
		await h.observe(noop());
		await h.waitCalls(1);
		expect(h.calls()[0].head).toBe("critic");
	});

	it("rejects a second one-off under a name whose check has not finished", async () => {
		const h = await harness({ heads: [] });
		await h.hydraTool({ action: "manage_heads", operation: "add", head: "cache-check", lifetime: "once", instructions: "Check.", tools: [] });
		await expect(h.hydraTool({ action: "manage_heads", operation: "add", head: "cache-check", lifetime: "once", instructions: "Again.", tools: [] })).rejects.toThrow("still finishing a check");
		let respond!: (response: AssistantMessage) => void;
		await h.observe(new Promise<AssistantMessage>((resolve) => { respond = resolve; }));
		await vi.waitFor(() => expect(h.transport).toHaveBeenCalledTimes(1));
		await expect(h.hydraTool({ action: "manage_heads", operation: "add", head: "cache-check", lifetime: "once", instructions: "Again.", tools: [] })).rejects.toThrow("still finishing a check");
		respond(noop());
		await h.waitCalls(1);
	});

	it("warns when a one-off cannot start because its run was cancelled", async () => {
		const h = await harness({ heads: [] });
		await h.hydraTool({ action: "manage_heads", operation: "add", head: "cache-check", lifetime: "once", instructions: "Check.", tools: [] });
		(h.ctx as { signal?: AbortSignal }).signal = AbortSignal.abort();
		await h.observe();
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('one-off head cache-check did not start: its run was cancelled'), "warning");
		expect(vi.mocked(h.ctx.ui.setStatus).mock.calls.at(-1)?.[1]).toBe("hydra: no heads | (no obs yet)");
		expect(h.transport).not.toHaveBeenCalled();
		// The main assistant hears of it without a new turn.
		expect(h.steers()).toEqual([]);
		expect(JSON.stringify(vi.mocked(h.pi.sendMessage).mock.calls)).toContain("[pi-hydra cache-check] automatic notice: its one check did not start: its run was cancelled. This head is gone.");
		expect(h.pi.sendMessage).toHaveBeenCalledWith(expect.anything(), { triggerTurn: false });
	});

	it.each([
		["the conversation switches branches", "the conversation switched branches", (h: Awaited<ReturnType<typeof harness>>) => h.emit({ type: "session_tree" } as ExtensionEvent)],
		["the session ends", "the session ended", (h: Awaited<ReturnType<typeof harness>>) => h.emit({ type: "session_shutdown", reason: "quit" } as ExtensionEvent)],
	])("warns when a one-off cannot start because %s", async (_case, why, event) => {
		const h = await harness({ heads: [] });
		await h.hydraTool({ action: "manage_heads", operation: "add", head: "cache-check", lifetime: "once", instructions: "Check.", tools: [] });
		await event(h);
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining(`one-off head cache-check did not start: ${why}`), "warning");
		await h.observe();
		await settle();
		expect(h.transport).not.toHaveBeenCalled();
		// Nobody is left to tell, or the notice would land in a conversation that never asked for the head.
		expect(h.steers()).toEqual([]);
		expect(h.pi.sendMessage).not.toHaveBeenCalled();
	});

	it.each(["openai-codex-responses", "openai-responses"] as const)("%s: a judging head with ends_when gets its condition in the split envelope and ends through the findings JSON", async (api) => {
		const h = await harness({ heads: [], api });
		await h.hydraTool({ action: "manage_heads", operation: "add", head: "refactor-review", instructions: "Review.", tools: [], ends_when: "the refactor is committed" });
		await h.observe(findings({ findings: [], done: true }));
		await h.waitCalls(1);
		const input = (h.payloads[0] as { input: { role?: string; content?: unknown }[] }).input;
		const developer = input.filter((item) => item.role === "developer").map((item) => JSON.stringify(item.content)).join("");
		expect(developer).toContain("This head ends when: the refactor is committed");
		expect(h.configs().at(-1)).toEqual({ heads: [] });
	});

	it("anthropic: an acting head with ends_when ends through its JSON decision", async () => {
		const h = await harness({ heads: [] });
		await h.hydraTool({ action: "manage_heads", operation: "add", head: "refactor-review", instructions: "Review.", tools: ["read"], ends_when: "the refactor is committed" });
		await h.observe(answer([text('{"action":"steer","reason":"r","message":"FINAL","done":true}')]));
		await h.waitCalls(1);
		expect(JSON.stringify(h.payloads[0])).toContain("This head ends when: the refactor is committed. If that is true now, add \\\"done\\\": true to the JSON object");
		expect(h.steers().some((message) => message.includes("FINAL"))).toBe(true);
		expect(h.configs().at(-1)).toEqual({ heads: [] });
		expect(h.calls()[0].doneIgnored).toBeUndefined();
	});

	const addWatcher = (h: Awaited<ReturnType<typeof harness>>, instructions = "OLD") =>
		h.hydraTool({ action: "manage_heads", operation: "add", head: "watcher", ends_when: "the task is committed", instructions, tools: [] });

	it("a cancelled run that ends with nothing to review drops its one-off with a warning, so it never starts in a later run", async () => {
		const h = await harness({ heads: [] });
		const run = new AbortController();
		(h.ctx as { signal?: AbortSignal }).signal = run.signal;
		await h.hydraTool({ action: "manage_heads", operation: "add", head: "cache-check", lifetime: "once", instructions: "Check.", tools: [] });
		run.abort();
		await h.emit({ type: "agent_end", messages: [answer([], "aborted")] });
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("one-off head cache-check did not start: its run was cancelled"), "warning");
		(h.ctx as { signal?: AbortSignal }).signal = new AbortController().signal;
		await h.emit({ type: "agent_start" });
		await h.observe(noop());
		await settle();
		expect(h.transport).not.toHaveBeenCalled();
	});

	const startPendingOneOff = async (h: Awaited<ReturnType<typeof harness>>, mode: "tui" | "rpc" | "json" | "print") => {
		(h.ctx as { mode: string }).mode = mode;
		await h.hydraTool({ action: "manage_heads", operation: "add", head: "single", lifetime: "once", instructions: "Check.", tools: [] });
		let respond!: (response: AssistantMessage) => void;
		await h.observe(new Promise<AssistantMessage>((resolve) => { respond = resolve; }));
		await vi.waitFor(() => expect(h.transport).toHaveBeenCalledTimes(1));
		return {
			respond,
			endRun: () => {
				const run = { ended: false, done: h.emit({ type: "agent_end", messages: [answer([text("I will wait for the check.")])] }) };
				run.done.then(() => { run.ended = true; });
				return run;
			},
		};
	};

	it.each(["print", "json"] as const)("a %s-mode run waits at its end for a one-off it asked for, so the feedback still wakes the main assistant", async (mode) => {
		const h = await harness({ heads: [] });
		const check = await startPendingOneOff(h, mode);
		const run = check.endRun();
		await settle();
		expect(run.ended).toBe(false);
		check.respond(findings({ findings: [{ action: "steer", reason: "r", message: "EDGE-CASE" }] }));
		await run.done;
		expect(h.steers()).toEqual(["[pi-hydra single] EDGE-CASE"]);
	});

	it.each([
		["a TUI run, which stays open anyway", "tui", false],
		["an RPC run, which stays open anyway", "rpc", false],
		["a cancelled print-mode run, whose feedback never starts a turn", "print", true],
	] as const)("%s does not wait at its end for a one-off", async (_case, mode, cancelled) => {
		const h = await harness({ heads: [] });
		const runSignal = new AbortController();
		(h.ctx as { signal?: AbortSignal }).signal = runSignal.signal;
		const check = await startPendingOneOff(h, mode);
		if (cancelled) runSignal.abort();
		const run = check.endRun();
		await run.done;
		check.respond(noop());
		await h.waitCalls(1);
	});

	it("the timeout warning names only the one-off that is still unfinished, not one that already reported", async () => {
		const h = await harness({ heads: [] });
		(h.ctx as { mode: string }).mode = "print";
		for (const head of ["alpha", "beta"]) {
			await h.hydraTool({ action: "manage_heads", operation: "add", head, lifetime: "once", instructions: "Check.", tools: [] });
		}
		let respondFirst!: (response: AssistantMessage) => void;
		let respondSecond!: (response: AssistantMessage) => void;
		await h.observe(
			new Promise<AssistantMessage>((resolve) => { respondFirst = resolve; }),
			new Promise<AssistantMessage>((resolve) => { respondSecond = resolve; }),
		);
		await vi.waitFor(() => expect(h.transport).toHaveBeenCalledTimes(2));
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const end = h.emit({ type: "agent_end", messages: [answer([text("I will wait for the checks.")])] });
			respondFirst(noop());
			await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
			await end;
		} finally {
			vi.useRealTimers();
		}
		const reported = h.calls().map((call) => call.head);
		expect(reported).toHaveLength(1);
		const stuck = reported[0] === "alpha" ? "beta" : "alpha";
		const warnings = h.notify.mock.calls.filter(([message]) => String(message).includes("did not finish")).map(([message]) => message);
		expect(warnings).toEqual([`hydra: one-off head ${stuck} did not finish within 10 minutes; this headless run ends without waiting for its feedback`]);
		respondSecond(noop());
		await h.waitCalls(2);
	});

	it("a print-mode run stops waiting as soon as it is cancelled, since the feedback could no longer start a turn", async () => {
		const h = await harness({ heads: [] });
		const runSignal = new AbortController();
		(h.ctx as { signal?: AbortSignal }).signal = runSignal.signal;
		const check = await startPendingOneOff(h, "print");
		const run = check.endRun();
		await settle();
		expect(run.ended).toBe(false);
		runSignal.abort();
		await run.done;
		expect(h.notify).not.toHaveBeenCalledWith(expect.stringContaining("did not finish"), "warning");
		check.respond(noop());
		await h.waitCalls(1);
	});

	it("a print-mode run does not wait for an ongoing head that reuses the name of a finished one-off", async () => {
		const h = await harness({ heads: [] });
		(h.ctx as { mode: string }).mode = "print";
		await h.hydraTool({ action: "manage_heads", operation: "add", head: "critic", lifetime: "once" });
		await h.observe(noop());
		await h.waitCalls(1);
		await h.hydraTool({ action: "manage_heads", operation: "add", head: "critic" });
		let respond!: (response: AssistantMessage) => void;
		await h.observe(new Promise<AssistantMessage>((resolve) => { respond = resolve; }));
		await vi.waitFor(() => expect(h.transport).toHaveBeenCalledTimes(2));
		let ended = false;
		const end = h.emit({ type: "agent_end", messages: [answer([text("Committed.")])] }).then(() => { ended = true; });
		await settle();
		expect(ended).toBe(true);
		respond(noop());
		await end;
		await h.waitCalls(2);
	});

	it("a print-mode run stops waiting for a stuck one-off after ten minutes and says so", async () => {
		const h = await harness({ heads: [] });
		const check = await startPendingOneOff(h, "print");
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const run = check.endRun();
			await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
			await run.done;
			expect(h.notify).toHaveBeenCalledWith("hydra: one-off head single did not finish within 10 minutes; this headless run ends without waiting for its feedback", "warning");
		} finally {
			vi.useRealTimers();
		}
		check.respond(noop());
		await h.waitCalls(1);
	});

	it("a head still checking after the user cancelled cannot order a one-off; the head is told, and nothing starts in the next run", async () => {
		const h = await harness({ api: "openai-codex-responses", tools: "hydra" });
		const run = new AbortController();
		(h.ctx as { signal?: AbortSignal }).signal = run.signal;
		let respond!: (response: AssistantMessage) => void;
		await h.observe(
			new Promise<AssistantMessage>((resolve) => { respond = resolve; }),
			answer([tool("hydra", { action: "complete_observation", delivery: "none", message: "" })], "toolUse"),
		);
		await vi.waitFor(() => expect(h.transport).toHaveBeenCalledTimes(1));
		run.abort();
		await h.emit({ type: "agent_end", messages: [answer([], "aborted")] });
		respond(answer([tool("hydra", { action: "manage_heads", operation: "add", head: "late-one", lifetime: "once", instructions: "OLD TASK", tools: [], message: "check the old task" })], "toolUse"));
		await h.waitCalls(1);
		expect(JSON.stringify(h.payloads[1])).toContain("The run this check reviews was cancelled, so a one-off head cannot start from it.");
		(h.ctx as { signal?: AbortSignal }).signal = new AbortController().signal;
		await h.emit({ type: "agent_start" });
		await h.observe(noop());
		await settle();
		expect(h.calls().map((call) => call.head)).toEqual(["critic"]);
	});

	it("refuses to add a head again while its previous check is still running, so an old done cannot end the new one", async () => {
		const h = await harness({ heads: [] });
		await addWatcher(h);
		let respond!: (response: AssistantMessage) => void;
		await h.observe(new Promise<AssistantMessage>((resolve) => { respond = resolve; }));
		await vi.waitFor(() => expect(h.transport).toHaveBeenCalledTimes(1));
		await h.hydraTool({ action: "manage_heads", operation: "remove", head: "watcher" });
		await expect(addWatcher(h, "NEW")).rejects.toThrow("still finishing a check");
		await expect(h.hydraTool({ action: "manage_heads", operation: "add", head: "critic" })).resolves.toBeDefined();
		respond(findings({ findings: [], done: true }));
		await h.waitCalls(1);
		expect(h.calls()[0].doneIgnored).toBe(true);
		await addWatcher(h, "NEW");
		expect(h.configs().at(-1)?.heads).toEqual(["critic", "watcher"]);
	});

	it("refuses any add while a diagnostic head holds the active set", async () => {
		const h = await harness({ heads: ["test"] });
		await expect(addWatcher(h)).rejects.toThrow("A diagnostic head is running");
		await expect(h.hydraTool({ action: "manage_heads", operation: "add", head: "critic" })).rejects.toThrow("A diagnostic head is running");
		expect(h.configs().at(-1)).toEqual({ heads: ["test"] });
	});

	it("refuses tools Hydra cannot run for a head without a file", async () => {
		const h = await harness({ heads: [] });
		await expect(h.hydraTool({ action: "manage_heads", operation: "add", head: "single", lifetime: "once", instructions: "Check.", tools: ["imaginary-mcp"] })).rejects.toThrow("head single can't be added: it lists tools Hydra can't run: imaginary-mcp. Remove them from its tools");
		await h.observe();
		await settle();
		expect(h.transport).not.toHaveBeenCalled();
	});


	it.each(["resume", "going back and forth"])("a plain add of a head file survives %s, with nothing extra saved", async (mode) => {
		const h = await harness({ heads: [] });
		await h.hydraTool({ action: "manage_heads", operation: "add", head: "critic" });
		expect(h.configs().at(-1)).toEqual({ heads: ["critic"] });
		const target = mode === "resume" ? await harness({ resume: { cwd: h.cwd, sm: h.sm } }) : h;
		if (mode !== "resume") {
			const leaf = h.sm.getLeafId()!;
			h.sm.branch(h.root);
			await h.emit({ type: "session_tree" } as ExtensionEvent);
			h.sm.branch(leaf);
			await h.emit({ type: "session_tree" } as ExtensionEvent);
		}
		await target.observe(noop());
		await target.waitCalls(1);
		expect(target.notify).not.toHaveBeenCalledWith(expect.anything(), "warning");
	});

	it.each([null, [], "broken"])("a saved record of added heads that is %j restores none of the saved heads, not even from a head file", async (added) => {
		const setup = await harness({ heads: [] });
		const sm = SessionManager.inMemory(setup.cwd);
		sm.appendCustomEntry("hydra-config", { heads: ["critic"], added });
		const h = await harness({ resume: { cwd: setup.cwd, sm } });
		expect(h.notify).toHaveBeenCalledWith("hydra: saved head is damaged and was not restored: critic", "warning");
		await h.observe(noop());
		await settle();
		expect(h.transport).not.toHaveBeenCalled();
	});

	it("a head that says done while a diagnostic head runs does not come back when the diagnostic ends", async () => {
		const h = await harness({ heads: [] });
		await h.hydraTool({ action: "manage_heads", operation: "add", head: "critic", ends_when: "DONE" });
		let respond!: (response: AssistantMessage) => void;
		await h.observe(new Promise<AssistantMessage>((resolve) => { respond = resolve; }));
		await vi.waitFor(() => expect(h.transport).toHaveBeenCalledTimes(1));
		const command = vi.mocked(h.pi.registerCommand).mock.calls.find(([name]) => name === "hydra-heads")![1] as unknown as { handler: (args: string, ctx: unknown) => Promise<void> };
		await command.handler("test", h.ctx);
		respond(findings({ findings: [], done: true }));
		await h.waitCalls(1);
		expect(h.steers().some((message) => message.includes("has ended"))).toBe(true);
		await h.observe(answer([tool("hydra", { action: "complete_observation", delivery: "none", message: "" })], "toolUse"));
		await h.waitCalls(2);
		expect(h.configs().at(-1)).toEqual({ heads: [] });
		await h.observe(noop());
		await settle();
		expect(h.calls().map((call) => call.head)).toEqual(["critic", "test"]);
	});

	it.each([
		["no end", { withoutFile: { instructions: "x" } }],
		["tools that are not a list", { withoutFile: { instructions: "x", tools: "read" }, endsWhen: "y" }],
		["a tool Hydra cannot run", { withoutFile: { instructions: "x", tools: ["imaginary-mcp"] }, endsWhen: "y" }],
	])("does not restore a saved head with %s, not even from a head file of the same name, and says so", async (_case, saved) => {
		const setup = await harness({ heads: [] });
		const sm = SessionManager.inMemory(setup.cwd);
		sm.appendCustomEntry("hydra-config", { heads: ["critic"], added: { critic: saved } });
		const h = await harness({ resume: { cwd: setup.cwd, sm } });
		expect(h.notify).toHaveBeenCalledWith("hydra: saved head is damaged and was not restored: critic", "warning");
		await h.observe(noop());
		await settle();
		expect(h.transport).not.toHaveBeenCalled();
	});

	it.each([
		["autostart", { autostart: true }, undefined],
		["a launch flag", { flag: "critic" }, { heads: ["critic"] }],
	] as const)("going back to before any saved set with %s gives the starting head without the end condition added later", async (_case, launch, saved) => {
		const setup = await harness({ heads: [] });
		const sm = SessionManager.inMemory(setup.cwd);
		const beforeConfig = sm.appendCustomEntry("anchor", {});
		const h = await harness({ resume: { cwd: setup.cwd, sm }, ...launch });
		await h.hydraTool({ action: "manage_heads", operation: "remove", head: "critic" });
		await h.hydraTool({ action: "manage_heads", operation: "add", head: "critic", ends_when: "OLD BRANCH CONDITION" });
		sm.branch(beforeConfig);
		await h.emit({ type: "session_tree" } as ExtensionEvent);
		// Autostart heads are never saved; a flag-chosen set is.
		expect(h.configs().at(-1)).toEqual(saved);
		await h.emit({ type: "agent_start" });
		await h.observe();
		await h.observe(findings({ findings: [], done: true }));
		await h.waitCalls(1);
		expect(JSON.stringify(h.payloads)).not.toContain("OLD BRANCH CONDITION");
		expect(h.steers().some((message) => message.includes("has ended"))).toBe(false);
	});

	it("going back to before any saved set with a launch flag that matches nothing leaves no head from the branch left behind", async () => {
		const setup = await harness({ heads: [] });
		const sm = SessionManager.inMemory(setup.cwd);
		const beforeConfig = sm.appendCustomEntry("anchor", {});
		const h = await harness({ resume: { cwd: setup.cwd, sm }, flag: "missing" });
		await addWatcher(h);
		sm.branch(beforeConfig);
		await h.emit({ type: "session_tree" } as ExtensionEvent);
		expect(h.notify).toHaveBeenLastCalledWith("hydra: --hydra-heads matched nothing; observing with no heads", "warning");
		await h.emit({ type: "agent_start" });
		await h.observe();
		await h.observe(noop());
		await settle();
		expect(h.transport).not.toHaveBeenCalled();
	});

	it("going back to a saved set whose heads all no longer exist leaves no head from the branch left behind", async () => {
		const h = await harness();
		const missing = h.sm.appendCustomEntry("hydra-config", { heads: ["absent"] });
		await h.hydraTool({ action: "manage_heads", operation: "add", head: "critic" });
		await addWatcher(h);
		h.sm.branch(missing);
		await h.emit({ type: "session_tree" } as ExtensionEvent);
		expect(h.notify).toHaveBeenCalledWith("hydra: saved head no longer exists: absent", "warning");
		await h.emit({ type: "agent_start" });
		await h.observe();
		await h.observe(noop());
		await settle();
		expect(h.transport).not.toHaveBeenCalled();
	});

	it("codex: a head without ends_when that says done through complete_observation keeps running", async () => {
		const h = await harness({ api: "openai-codex-responses", tools: "read" });
		await h.observe(answer([tool("hydra", { action: "complete_observation", delivery: "steer", message: "FINDING", done: true })], "toolUse"));
		await h.waitCalls(1);
		expect(h.calls()[0].doneIgnored).toBe(true);
		expect(h.configs().at(-1)?.heads).toEqual(["critic"]);
		expect(h.steers()).toEqual(["[pi-hydra critic] FINDING"]);
	});

	it("once with a head file uses that file's tools", async () => {
		const h = await harness({ heads: [], api: "openai-codex-responses", tools: "read" });
		writeFileSync(join(h.cwd, "data.txt"), "FILE BODY");
		await h.hydraTool({ action: "manage_heads", operation: "add", head: "critic", lifetime: "once" });
		await h.observe(answer([tool("read", { path: "data.txt" })], "toolUse"), answer([tool("hydra", { action: "complete_observation", delivery: "none", message: "" })], "toolUse"));
		await h.waitCalls(1);
		expect(h.calls()[0].toolsUsed).toEqual(["read"]);
		expect(JSON.stringify(h.payloads[1])).toContain("FILE BODY");
		expect(h.configs()).toEqual([{ heads: [] }]);
	});

	it.each([
		["remove with lifetime", { operation: "remove", head: "critic", lifetime: "once" }, "manage_heads remove does not accept lifetime"],
		["remove with ends_when", { operation: "remove", head: "critic", ends_when: "x" }, "manage_heads remove does not accept ends_when"],
		["manage_heads with done", { operation: "add", head: "critic", done: true }, "manage_heads does not accept done"],
	])("the tool rejects %s and changes nothing", async (_case, fields, error) => {
		const h = await harness();
		const configsBefore = h.configs().length;
		await expect(h.hydraTool({ action: "manage_heads", ...fields })).rejects.toThrow(error);
		expect(h.configs()).toHaveLength(configsBefore);
	});

	it.each(["anthropic-messages", "openai-codex-responses", "openai-responses"] as const)("%s: handoffs of one-off heads never mention done; acting heads with ends_when get the condition", async (api) => {
		const h = await harness({ heads: [], api });
		const finish = api === "anthropic-messages"
			? answer([text('{"action":"noop","reason":"","message":""}')])
			: answer([tool("hydra", { action: "complete_observation", delivery: "none", message: "" })], "toolUse");
		await h.hydraTool({ action: "manage_heads", operation: "add", head: "one-off", lifetime: "once", instructions: "Check.", tools: ["read"] });
		await h.observe(finish);
		await h.waitCalls(1);
		expect(JSON.stringify(h.payloads[0])).not.toMatch(/This head ends when|leave done out/);
		await h.hydraTool({ action: "manage_heads", operation: "add", head: "watcher", instructions: "Review.", tools: ["read"], ends_when: "the task is committed" });
		await h.observe(finish);
		await h.waitCalls(2);
		expect(JSON.stringify(h.payloads[1])).toContain("This head ends when: the task is committed");
	});

	it("a head file with ends_when survives a resume, delivers its findings before the end notice, and makes no call after", async () => {
		const first = await harness({ heads: [] });
		await first.hydraTool({ action: "manage_heads", operation: "add", head: "critic", ends_when: "the auth PR is merged" });
		const h = await harness({ resume: { cwd: first.cwd, sm: first.sm } });
		await h.observe(findings({ findings: [] }));
		await h.waitCalls(1);
		expect(JSON.stringify(h.payloads[0])).toContain("This head ends when: the auth PR is merged");
		await h.observe(findings({ findings: [{ action: "steer", reason: "r", message: "MERGED-FINDING" }], done: true }));
		await h.waitCalls(2);
		const steers = h.steers();
		expect(steers.findIndex((m) => m.includes("MERGED-FINDING"))).toBeLessThan(steers.findIndex((m) => m.includes("has ended")));
		await h.observe();
		await settle();
		expect(h.transport).toHaveBeenCalledTimes(2);
	});

	it("a head without a file and with ends_when checks every response until it says done, then ends", async () => {
		const h = await harness({ heads: [] });
		const filesBefore = headFiles(h);
		await h.hydraTool({ action: "manage_heads", operation: "add", head: "refactor-review", instructions: "Review each step.", tools: [], ends_when: "the refactor is committed" });
		expect(h.configs().at(-1)).toEqual({
			heads: ["refactor-review"],
			added: { "refactor-review": { withoutFile: { instructions: "Review each step.", tools: [] }, endsWhen: "the refactor is committed" } },
		});
		await h.observe(findings({ findings: [] }));
		await h.waitCalls(1);
		expect(JSON.stringify(h.payloads[0])).toContain("This head ends when: the refactor is committed. If that is true now, add \\\"done\\\": true to the JSON object");
		await h.observe(findings({ findings: [{ action: "steer", reason: "r", message: "LAST-FINDING" }], done: true }));
		await h.waitCalls(2);
		const steers = h.steers();
		const finding = steers.findIndex((message) => message.includes("LAST-FINDING"));
		const ended = steers.findIndex((message) => message.includes("[pi-hydra refactor-review] automatic notice: done, so this head has ended. It was to end when: the refactor is committed"));
		expect(finding).toBeGreaterThanOrEqual(0);
		expect(ended).toBeGreaterThan(finding);
		expect(h.configs().at(-1)).toEqual({ heads: [] });
		await h.observe();
		await settle();
		expect(h.transport).toHaveBeenCalledTimes(2);
		expect(headFiles(h)).toEqual(filesBefore);
	});

	it("brings a head without a file and its end condition back on resume", async () => {
		const first = await harness({ heads: [] });
		await first.hydraTool({ action: "manage_heads", operation: "add", head: "refactor-review", instructions: "Review each step.", tools: [], ends_when: "the refactor is committed" });
		const resumed = await harness({ resume: { cwd: first.cwd, sm: first.sm } });
		await resumed.observe(findings({ findings: [] }));
		await resumed.waitCalls(1);
		const payload = JSON.stringify(resumed.payloads[0]);
		expect(payload).toContain("HEAD INSTRUCTIONS: Review each step.");
		expect(payload).toContain("This head ends when: the refactor is committed");
	});

	it("a head file with ends_when ends the same way and its file stays untouched", async () => {
		const h = await harness({ heads: [] });
		const file = join(h.cwd, ".pi", "hydra", "critic.md");
		const before = readFileSync(file, "utf8");
		const reply = await h.hydraTool({ action: "manage_heads", operation: "add", head: "critic", ends_when: "the auth PR is merged" });
		expect(reply.content[0].text).toContain("Added critic until the auth PR is merged — why");
		await h.observe(findings({ findings: [], done: true }));
		await h.waitCalls(1);
		expect(h.configs().at(-1)).toEqual({ heads: [] });
		expect(readFileSync(file, "utf8")).toBe(before);
	});

	it("codex: an acting head with ends_when ends through complete_observation", async () => {
		const h = await harness({ heads: [], api: "openai-codex-responses" });
		await h.hydraTool({ action: "manage_heads", operation: "add", head: "refactor-review", instructions: "Review.", tools: ["read"], ends_when: "the refactor is committed" });
		await h.observe(answer([tool("hydra", { action: "complete_observation", delivery: "none", message: "", done: true })], "toolUse"));
		await h.waitCalls(1);
		expect(JSON.stringify(h.payloads[0])).toContain("If that is true now, also pass done: true");
		expect(JSON.parse(h.calls()[0].rawResponse ?? "{}")).toMatchObject({ action: "complete_observation", done: true });
		expect(h.configs().at(-1)).toEqual({ heads: [] });
		expect(h.calls()[0].doneIgnored).toBeUndefined();
	});

	it("a head without ends_when that says done keeps running, and its record says the done was ignored", async () => {
		const h = await harness();
		await h.observe(findings({ findings: [{ action: "steer", reason: "r", message: "STILL-HERE" }], done: true }));
		await h.waitCalls(1);
		expect(h.calls()[0].doneIgnored).toBe(true);
		expect(h.steers().some((message) => message.includes("STILL-HERE"))).toBe(true);
		expect(h.steers().some((message) => message.includes("has ended"))).toBe(false);
		expect(JSON.stringify(h.payloads[0])).not.toContain("This head ends when");
		expect(JSON.stringify(h.payloads[0])).not.toMatch(/"done"|done: true/);
		await h.observe(noop());
		await h.waitCalls(2);
	});

	it("shows a head without a file in completions, keeps it through discovery, and removes it by name", async () => {
		const h = await harness({ heads: [] });
		await h.hydraTool({ action: "manage_heads", operation: "add", head: "refactor-review", instructions: "Review.", tools: [], ends_when: "done" });
		const command = vi.mocked(h.pi.registerCommand).mock.calls.find(([name]) => name === "hydra-heads")?.[1] as unknown as { getArgumentCompletions: (prefix: string) => { label: string }[] };
		expect(command.getArgumentCompletions("ref").map((item) => item.label)).toEqual(["refactor-review (no file)"]);
		// A head file of the same name appears: the head without a file keeps running.
		writeFileSync(join(h.cwd, ".pi", "hydra", "refactor-review.md"), "---\nname: refactor-review\ndescription: x\n---\nFILE INSTRUCTIONS\n");
		await h.emit({ type: "agent_start" });
		await h.observe(); // the run's first response, reviewed by the previous run's end
		await h.observe(findings({ findings: [] }));
		await h.waitCalls(1);
		expect(JSON.stringify(h.payloads[0])).toContain("HEAD INSTRUCTIONS: Review.");
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('head file "refactor-review" is ignored'), "warning");
		await h.hydraTool({ action: "manage_heads", operation: "remove", head: "refactor-review" });
		expect(h.configs().at(-1)).toEqual({ heads: [] });
	});
});

describe("heads and the main assistant's tools", () => {
	const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
	// The main assistant's tools under pi's defaults: grep, find and ls are off.
	const piDefaults = ["read", "bash", "edit", "write", "hydra"];

	it("turns off a head whose listed tool the main assistant lacks, with the fix, before any check, and saves that", async () => {
		const h = await harness({ tools: "read, grep", activeTools: piDefaults });
		const off = "hydra: head critic is off: the main assistant doesn't have grep. To fix: add \"+grep\" to defaultTools in settings.json and run /reload.";
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining(off), "warning");
		// Before pi's first system message only the user is told (consumer.test.ts shows the note later).
		expect(vi.mocked(h.pi.sendMessage)).not.toHaveBeenCalled();
		expect(vi.mocked(h.pi.sendUserMessage)).not.toHaveBeenCalled();
		await h.observe(noop());
		await settle();
		expect(h.transport).not.toHaveBeenCalled();
		expect(h.configs().at(-1)).toEqual({ heads: [] });
	});

	it("keeps a turned-off head off when the session is resumed, even once the main assistant has the tool", async () => {
		const h = await harness({ tools: "read, grep", activeTools: piDefaults });
		expect(h.configs().at(-1)).toEqual({ heads: [] });
		const resumed = await harness({ resume: { cwd: h.cwd, sm: h.sm }, tools: "read, grep", activeTools: [...piDefaults, "grep"] });
		await resumed.observe(noop());
		await settle();
		expect(resumed.transport).not.toHaveBeenCalled();
	});

	it("turns off a head whose file gained a missing tool, before the next run", async () => {
		const h = await harness({ tools: "read", activeTools: piDefaults });
		writeFileSync(join(h.cwd, ".pi", "hydra", "critic.md"), "---\nname: critic\ndescription: Test observer\ntools: read, find\n---\nFollow these test instructions.\n");
		await h.emit({ type: "before_agent_start", prompt: "next", systemPrompt: "" } as unknown as ExtensionEvent);
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("hydra: head critic is off: the main assistant doesn't have find."), "warning");
		await h.observe(noop());
		await settle();
		expect(h.transport).not.toHaveBeenCalled();
	});

	it("turns off a head that /hydra-heads turns on while the main assistant lacks its tools", async () => {
		const h = await harness({ heads: [], tools: "read, ls", activeTools: piDefaults });
		const command = vi.mocked(h.pi.registerCommand).mock.calls.find(([name]) => name === "hydra-heads")![1] as unknown as { handler: (args: string, ctx: unknown) => Promise<void> };
		await command.handler("critic", h.ctx);
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("hydra: head critic is off: the main assistant doesn't have ls."), "warning");
		await h.observe(noop());
		await settle();
		expect(h.transport).not.toHaveBeenCalled();
	});

	it("refuses to add a head whose tools the main assistant lacks, naming them all", async () => {
		const h = await harness({ heads: [], activeTools: piDefaults });
		await expect(h.hydraTool({ action: "manage_heads", operation: "add", head: "single", lifetime: "once", instructions: "Check.", tools: ["read", "grep", "ls"] }))
			.rejects.toThrow("head single can't be added: the main assistant doesn't have grep, ls. To fix: add \"+grep\", \"+ls\" to defaultTools");
		await expect(h.hydraTool({ action: "manage_heads", operation: "add", head: "critic" })).resolves.toBeDefined();
	});

	it("reads codemode.mode from pi's live settings", async () => {
		const h = await harness({ tools: "read", activeTools: [...piDefaults, "codemode"], settings: { codemode: { mode: "only" } } });
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('hydra: head critic is off: codemode.mode is "only", which hides all tools from the model; set it to "on". Then turn the head back on.'), "warning");
	});

	it("needs hydra for a head with tools only where it finishes through the hydra tool", async () => {
		const codex = await harness({ api: "openai-codex-responses", tools: "read", activeTools: ["read"] });
		expect(codex.notify).toHaveBeenCalledWith(expect.stringContaining("hydra: head critic is off: the main assistant doesn't have hydra."), "warning");
		const anthropic = await harness({ tools: "read", activeTools: ["read"] });
		await anthropic.observe(noop());
		await anthropic.waitCalls(1);
	});

	it("checks the heads a diagnostic head hands back when it has fired", async () => {
		const active = [...piDefaults];
		const h = await harness({ tools: "read", activeTools: active });
		const command = vi.mocked(h.pi.registerCommand).mock.calls.find(([name]) => name === "hydra-heads")![1] as unknown as { handler: (args: string, ctx: unknown) => Promise<void> };
		await command.handler("test", h.ctx);
		// The main assistant loses read while the diagnostic holds the set.
		active.splice(active.indexOf("read"), 1);
		await h.observe(answer([tool("hydra", { action: "complete_observation", delivery: "none", message: "" })], "toolUse"));
		await h.waitCalls(1);
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("hydra: head critic is off: the main assistant doesn't have read."), "warning");
		await h.observe(noop());
		await settle();
		expect(h.calls().map((call) => call.head)).toEqual(["test"]);
	});

	it("re-adding an active head checks its file again", async () => {
		const h = await harness({ tools: "read", activeTools: piDefaults });
		// pi's first system message is in, so notes would go out.
		h.sm.appendMessage({ role: "system", content: "", timestamp: Date.now() } as unknown as Message);
		writeFileSync(join(h.cwd, ".pi", "hydra", "critic.md"), "---\nname: critic\ndescription: Test observer\ntools: read, grep\n---\nFollow these test instructions.\n");
		await expect(h.hydraTool({ action: "manage_heads", operation: "add", head: "critic" })).rejects.toThrow("head critic is off: the main assistant doesn't have grep.");
		expect(h.configs().at(-1)).toEqual({ heads: [] });
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("hydra: head critic is off"), "warning");
		// The error reaches the main assistant; no second message about it.
		expect(vi.mocked(h.pi.sendMessage)).not.toHaveBeenCalled();
	});

	it("drops a waiting one-off whose tool went away when heads change", async () => {
		const active = [...piDefaults, "grep"];
		const h = await harness({ heads: [], activeTools: active });
		await h.hydraTool({ action: "manage_heads", operation: "add", head: "single", lifetime: "once", instructions: "Check.", tools: ["read", "grep"] });
		active.splice(active.indexOf("grep"), 1);
		await h.hydraTool({ action: "manage_heads", operation: "add", head: "critic" });
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("hydra: head single is off: the main assistant doesn't have grep."), "warning");
		await h.observe(noop());
		await h.waitCalls(1);
		expect(h.calls().map((call) => call.head)).toEqual(["critic"]);
	});

	it("doesn't ask hydra of a head without a list that gets no tools at all, since it answers with JSON", async () => {
		const h = await harness({ api: "openai-codex-responses", tools: null, activeTools: [] });
		await h.observe(noop());
		await h.waitCalls(1);
	});

	it("lets a head without a list use only the main assistant's tools, hydra included", async () => {
		const h = await harness({ tools: null, activeTools: ["read"] });
		await h.observe(answer([tool("bash", { command: "touch made-by-bash" })], "toolUse"), answer([tool("hydra", { action: "manage_heads", operation: "remove", head: "critic", message: "x" })], "toolUse"), noop());
		await h.waitCalls(1);
		expect(existsSync(join(h.cwd, "made-by-bash"))).toBe(false);
		expect(JSON.stringify(h.payloads.at(-1))).toContain("not found");
		expect(JSON.stringify(h.payloads.at(-1))).toContain('Head \\"critic\\" is not allowed to manage heads');
		expect(h.configs().at(-1)).toEqual({ heads: ["critic"] });
	});
});

describe("the hydra tool row", () => {
	it("draws its own row: what changed when collapsed, every argument when expanded, then the result", async () => {
		const h = await harness();
		initTheme("dark");
		const [definition] = vi.mocked(h.pi.registerTool).mock.calls[0];
		const args = { action: "manage_heads", operation: "add", head: "critic", lifetime: "once", message: "Check the plan once." };
		const row = new ToolExecutionComponent("hydra", "call-1", args, undefined, definition as never, { requestRender() {} } as never, h.cwd);
		row.setArgsComplete();
		row.markExecutionStarted();
		row.updateResult({ content: [{ type: "text", text: "Added critic for one check." }], isError: false }, false);
		const plain = () => row.render(120).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim()).filter(Boolean);
		expect(plain()).toEqual(["hydra add critic", "Added critic for one check."]);
		row.setExpanded(true);
		expect(plain()).toEqual(["hydra add critic", "action: manage_heads", "operation: add", "head: critic", "lifetime: once", "message: Check the plan once.", "Added critic for one check."]);
	});
});
