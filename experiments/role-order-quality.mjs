#!/usr/bin/env node
/**
 * Compare split observer-envelope ordering on a real pi trajectory.
 *
 * The session is truncated at --through, then two judge-only heads fan out
 * over that exact snapshot. Only the final two input items vary:
 *
 *   developer-user: developer envelope, user lens
 *   user-developer: user lens, developer envelope
 *
 * Usage:
 *   node experiments/role-order-quality.mjs \
 *     --session /path/to/session.jsonl --through ENTRY_ID \
 *     --heads-dir /path/to/.pi/hydra [--model gpt-5.6-terra] [--samples 3]
 */

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { streamSimple, getModel } from "@earendil-works/pi-ai/compat";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { uuidv7 } from "@earendil-works/pi-agent-core";
import { argOf } from "./lib.mjs";

const args = process.argv.slice(2);
const sessionPath = argOf(args, "--session", "");
const throughId = argOf(args, "--through", "");
const headsDir = argOf(args, "--heads-dir", "");
const modelId = argOf(args, "--model", "gpt-5.6-terra");
const samples = Number(argOf(args, "--samples", "3"));
const reasoning = argOf(args, "--thinking", "low");
const requestedOrders = argOf(args, "--orders", "developer-user,user-developer").split(",");

if (!sessionPath || !throughId || !headsDir) {
	console.error("--session, --through, and --heads-dir are required");
	process.exit(1);
}

const auth = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/auth.json`, "utf8"))["openai-codex"];
if (!auth?.access || (typeof auth.expires === "number" && auth.expires < Date.now())) {
	console.error("missing or expired openai-codex login; run pi and log in first");
	process.exit(1);
}
const model = getModel("openai-codex", modelId);
if (!model) {
	console.error(`unknown openai-codex model ${modelId}`);
	process.exit(1);
}

function sessionMessages() {
	const messages = [];
	let found = false;
	for (const line of readFileSync(sessionPath, "utf8").trim().split("\n")) {
		const entry = JSON.parse(line);
		if (entry.type === "message") messages.push(entry.message);
		if (entry.id === throughId) {
			found = true;
			break;
		}
	}
	if (!found) throw new Error(`entry ${throughId} not found in ${sessionPath}`);
	return messages;
}

function head(name) {
	const raw = readFileSync(join(headsDir, `${name}.md`), "utf8");
	const match = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]+)$/);
	if (!match) throw new Error(`cannot parse ${name}.md`);
	return match[1].trim();
}

const shape = '{"action":"noop|print|queue|steer|interrupt","reason":"≤120 chars","message":"≤240 chars, empty if noop"}';
function envelope(name) {
	return `Side watcher. The adjacent user message is the complete ${name} lens, not merely a topic label. Follow its scope and intervention rules in full unless they conflict with this envelope. Review the visible trajectory and reply with one JSON object, nothing else:\n${shape}\n\nNoop unless something warrants feedback. Print a note the user sees but the agent does not. Queue if useful but waitable. Steer to correct the agent between turns. Interrupt only for emergencies that must stop the line. No tools, no \"let me check...\", no follow-up turn. Don't prefix message with [${name}].`;
}

const baseMessages = sessionMessages();
const validOrders = new Set(["developer-user", "user-developer"]);
if (requestedOrders.some((order) => !validOrders.has(order))) {
	console.error(`invalid --orders value: ${requestedOrders.join(",")}`);
	process.exit(1);
}
const orders = requestedOrders;
const heads = ["security", "quality"];

function textOf(result) {
	return result.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

async function run(order, name, sample) {
	const sessionId = uuidv7();
	const started = performance.now();
	let payloadRoles = [];
	const lensMessage = { role: "user", content: [{ type: "text", text: head(name) }], timestamp: Date.now() };
	const result = await streamSimple(
		model,
		{ systemPrompt: "You are pi, a coding agent.", messages: [...baseMessages, lensMessage], tools: [] },
		{
			apiKey: auth.access,
			maxTokens: 500,
			reasoning,
			sessionId,
			transport: "websocket",
			onPayload: (body) => {
				const input = structuredClone(body.input);
				const lensIndex = input.length - 1;
				if (input[lensIndex]?.role !== "user") throw new Error("serialized lens is not the final user item");
				const developer = {
					role: "developer",
					content: [{ type: "input_text", text: envelope(name) }],
				};
				input.splice(order === "developer-user" ? lensIndex : lensIndex + 1, 0, developer);
				payloadRoles = input.slice(-4).map((item) => item.role ?? item.type ?? "?");
				return { ...body, input };
			},
		},
	).result();
	closeOpenAICodexWebSocketSessions(sessionId);
	return {
		order,
		head: name,
		sample,
		ms: Math.round(performance.now() - started),
		roles: payloadRoles.join(","),
		stop: result.stopReason,
		error: result.errorMessage ?? null,
		usage: result.usage,
		response: textOf(result),
	};
}

console.error(`trajectory=${basename(sessionPath)} through=${throughId} messages=${baseMessages.length}`);
console.error(`model=${modelId} thinking=${reasoning} samples=${samples} two-head fan-out`);
for (const order of orders) {
	for (let sample = 1; sample <= samples; sample++) {
		const pair = await Promise.all(heads.map((name) => run(order, name, sample)));
		for (const result of pair) console.log(JSON.stringify(result));
	}
}
