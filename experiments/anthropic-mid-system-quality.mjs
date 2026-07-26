#!/usr/bin/env node
/**
 * Does Anthropic accept a mid-conversation system envelope, and does it
 * preserve Hydra's two-head review behavior on a real pi trajectory?
 *
 * Compares the intended `[user lens, system envelope]` suffix with the same
 * envelope sent as a second user message.
 */

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { streamSimple, getModel } from "@earendil-works/pi-ai/compat";
import { argOf } from "./lib.mjs";

const args = process.argv.slice(2);
const sessionPath = argOf(args, "--session", "");
const throughId = argOf(args, "--through", "");
const headsDir = argOf(args, "--heads-dir", "");
const modelId = argOf(args, "--model", "claude-sonnet-5");
const samples = Number(argOf(args, "--samples", "3"));
const reasoning = argOf(args, "--thinking", "low");

if (!sessionPath || !throughId || !headsDir) {
	console.error("--session, --through, and --heads-dir are required");
	process.exit(1);
}

const auth = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/auth.json`, "utf8")).anthropic;
if (!auth?.access || (typeof auth.expires === "number" && auth.expires < Date.now())) {
	console.error("missing or expired Anthropic login; run pi and log in first");
	process.exit(1);
}
const model = getModel("anthropic", modelId);
if (!model) {
	console.error(`unknown Anthropic model ${modelId}`);
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
	return `Side watcher. The preceding user message is the complete ${name} lens, not merely a topic label. Follow its scope and intervention rules in full unless they conflict with this envelope. Review the visible trajectory and reply with one JSON object, nothing else:\n${shape}\n\nNoop unless something warrants feedback. Print a note the user sees but the agent does not. Queue if useful but waitable. Steer to correct the agent between turns. Interrupt only for emergencies that must stop the line. No tools, no \"let me check...\", no follow-up turn. Don't prefix message with [${name}].`;
}

const baseMessages = sessionMessages();
const roles = ["system", "user"];
const heads = ["security", "quality"];

function textOf(result) {
	return result.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

async function run(envelopeRole, name, sample) {
	const started = performance.now();
	let payloadRoles = [];
	let responseStatus = null;
	const lensMessage = { role: "user", content: [{ type: "text", text: head(name) }], timestamp: Date.now() };
	const result = await streamSimple(
		model,
		{ systemPrompt: "You are pi, a coding agent.", messages: [...baseMessages, lensMessage], tools: [] },
		{
			apiKey: auth.access,
			maxTokens: 500,
			reasoning,
			onResponse: (response) => { responseStatus = response.status; },
			onPayload: (body) => {
				const messages = structuredClone(body.messages);
				if (messages.at(-1)?.role !== "user") throw new Error("serialized lens is not the final user message");
				messages.push({
					role: envelopeRole,
					content: [{ type: "text", text: envelope(name) }],
				});
				payloadRoles = messages.slice(-4).map((message) => message.role);
				return { ...body, messages };
			},
		},
	).result();
	return {
		envelopeRole,
		head: name,
		sample,
		ms: Math.round(performance.now() - started),
		status: responseStatus,
		roles: payloadRoles.join(","),
		stop: result.stopReason,
		error: result.errorMessage ?? null,
		usage: result.usage,
		response: textOf(result),
	};
}

console.error(`trajectory=${basename(sessionPath)} through=${throughId} messages=${baseMessages.length}`);
console.error(`model=${modelId} thinking=${reasoning} samples=${samples} two-head fan-out`);
for (const envelopeRole of roles) {
	for (let sample = 1; sample <= samples; sample++) {
		const pair = await Promise.all(heads.map((name) => run(envelopeRole, name, sample)));
		for (const result of pair) console.log(JSON.stringify(result));
	}
}
