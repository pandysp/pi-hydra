import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidv7 } from "@earendil-works/pi-agent-core";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import hydraExtension from "./index";
import type { HydraCall } from "./stats";

it("lets an observation finish after more than 25 tool turns", async () => {
	const root = await mkdtemp(join(tmpdir(), "hydra-long-observation-"));
	const agentDir = join(root, "agent");
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const calls: HydraCall[] = [];
	let reads: ToolResultMessage[] = [];
	const notices: { message: string; level: string }[] = [];
	const sessionId = uuidv7();
	// The host and model are fixtures. The extension, scheduler, Pi agent loop,
	// native read tool and Hydra completion tool all execute normally.
	const faux = createFauxCore({ api: "openai-codex-responses", provider: "openai-codex" });
	const pi = {
		registerFlag() {},
		getFlag: (name: string) => name === "hydra-heads" ? "long-check" : undefined,
		registerCommand() {},
		registerMessageRenderer() {},
		registerTool() {},
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
		appendEntry: (type: string, data: HydraCall) => {
			if (type === "hydra-call") calls.push(data);
		},
		sendMessage: vi.fn(),
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: root,
		model: faux.getModel(),
		hasUI: true,
		isProjectTrusted: () => false,
		isIdle: () => true,
		ui: {
			notify: (message: string, level: string) => notices.push({ message, level }),
			setStatus() {},
			theme: { fg: (_color: string, text: string) => text },
		},
		sessionManager: { getBranch: () => [], getSessionId: () => sessionId },
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "offline-fixture-only" }),
			getRegisteredProviderConfig: () => ({ api: faux.api, streamSimple: faux.streamSimple }),
		},
	} as unknown as ExtensionContext;
	const fire = async (name: string, event: unknown) => {
		const handler = handlers.get(name);
		expect(handler).toBeDefined();
		await handler!(event, ctx);
	};

	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("HYDRA_SHUTDOWN_GRACE_MS", "0");
	vi.stubEnv("HYDRA_UNSAFE_FORCE_SHARE", "0");
	try {
		await mkdir(join(agentDir, "hydra"), { recursive: true });
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ transport: "websocket" }));
		await writeFile(join(agentDir, "hydra", "long-check.md"), [
			"---", "name: long-check", "description: Long observation fixture", "tools: read", "---",
			"Read the fixture, then complete.",
		].join("\n"));
		const input = join(root, "input.txt");
		await writeFile(input, "owned fixture\n");
		faux.setResponses([
			...Array.from({ length: 40 }, () => fauxAssistantMessage(
				fauxToolCall("read", { path: input }), { stopReason: "toolUse" },
			)),
			(context) => {
				reads = context.messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
				return fauxAssistantMessage(fauxToolCall("hydra", {
					action: "complete_observation", delivery: "none", message: "",
				}), { stopReason: "toolUse" });
			},
		]);

		hydraExtension(pi);
		await fire("session_start", { reason: "startup" });
		await fire("agent_start", {});
		await fire("before_provider_request", { payload: { input: [{ role: "user", content: "fixture" }] } });
		const driverMessage = fauxAssistantMessage("Fixture driver response.");
		await fire("message_start", { message: driverMessage });
		await fire("agent_end", { messages: [driverMessage] });
		await vi.waitFor(() => expect(calls).toHaveLength(1));

		expect(calls[0].iterations).toBe(41);
		expect(calls[0].toolsUsed).toEqual(Array(40).fill("read"));
		expect(reads).toHaveLength(40);
		for (const result of reads) {
			expect(result.isError).toBe(false);
			expect(result.content).toEqual([{ type: "text", text: "owned fixture\n" }]);
		}
		expect(faux.state.callCount).toBe(41);
		expect(faux.getPendingResponseCount()).toBe(0);
		expect(calls[0].action).toBe("noop");
		expect(JSON.parse(calls[0].rawResponse!)).toEqual({
			action: "complete_observation", delivery: "none", message: "",
		});
		expect(notices.filter(item => item.level === "warning" || item.level === "error")).toEqual([]);
		expect(pi.sendMessage).not.toHaveBeenCalled();
	} finally {
		try {
			if (handlers.has("session_shutdown")) await fire("session_shutdown", {});
		} finally {
			vi.unstubAllEnvs();
			await rm(root, { recursive: true, force: true });
		}
	}
});
