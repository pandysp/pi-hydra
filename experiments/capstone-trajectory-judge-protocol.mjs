import { basename } from "node:path";
import { SUPPORT_POLICY } from "./delivery-context-judge-protocol.mjs";
import { sha16 } from "./fingerprints.mjs";

const FOOTER = /\s*DELIVERY:\s*\w+\s*$/i;

/** The text actually delivered for each independently routed finding. */
export function deliveredFindings(row) {
	if (row?.kind !== "observation" || row.error || row.valid === false || !row.delivery || row.delivery === "none") return [];
	const raw = String(row.responseText ?? "").trim();
	if (!raw) return [];
	try {
		const value = JSON.parse(raw);
		if (Array.isArray(value?.findings)) {
			return value.findings
				.map((finding, index) => ({
					index,
					message: String(finding?.message ?? "").trim(),
				}))
				.filter((finding) => finding.message);
		}
		if (typeof value?.message === "string" && value.message.trim()) return [{ index: 0, message: value.message.trim() }];
	} catch {
		/* Footer/prose arms are intentionally accepted. */
	}
	const message = raw.replace(FOOTER, "").trim();
	return message ? [{ index: 0, message }] : [];
}

export function findingSourceKey(row, findingIndex) {
	return [row.runId, row.trajectoryId, row.config, row.pointId, row.arm, `f${findingIndex}`].join("/");
}

export function buildFindingItems(rows) {
	return rows.flatMap((row) =>
		deliveredFindings(row).map((finding) => ({
			sourceKey: findingSourceKey(row, finding.index),
			runId: row.runId,
			pointKey: [row.runId, row.trajectoryId, row.config, row.pointId].join("/"),
			pointId: row.pointId,
			task: row.trajectoryId,
			config: row.config,
			arm: row.arm,
			findingIndex: finding.index,
			message: finding.message,
			capturedPayloadHash: row.capturedPayloadHash,
			capturedPayloadFile: basename(row.capturedPayloadPath),
			pointKind: row.pointKind,
			requestIndex: row.requestIndex,
			runIndex: row.runIndex,
		})),
	);
}

/**
 * Render only evidence visible in the captured driver request. Encrypted
 * reasoning is deliberately absent: neither judge needs it and replaying it
 * would leak opaque, high-volume transport state into the prompt.
 */
export function visiblePayload(payload) {
	const lines = [];
	if (payload.instructions) lines.push(`SYSTEM\n${payload.instructions}`);
	for (const item of payload.input ?? []) {
		if (item?.role && Array.isArray(item.content)) {
			const text = item.content
				.filter((block) => ["input_text", "output_text", "text"].includes(block?.type))
				.map((block) => String(block.text ?? ""))
				.filter(Boolean)
				.join("\n");
			if (text) lines.push(`${String(item.role).toUpperCase()}\n${text}`);
		} else if (item?.type === "function_call") {
			lines.push(`TOOL CALL ${item.name}\n${item.arguments ?? ""}`);
		} else if (item?.type === "function_call_output") {
			lines.push(`TOOL RESULT\n${item.output ?? ""}`);
		}
	}
	return lines.join("\n\n");
}

/**
 * A run-end observer receives the final assistant response after the captured
 * request. In the old artifact that response is recoverable from the next
 * request's added prefix, up to (but not including) tool results and the next
 * user prompt. The last run in a cell has no next request and must not guess.
 */
export function recoverRunEndAssistant(currentPayload, nextPayload) {
	const current = currentPayload?.input ?? [];
	const next = nextPayload?.input ?? [];
	if (next.length <= current.length) return null;
	for (let index = 0; index < current.length; index++) {
		if (JSON.stringify(current[index]) !== JSON.stringify(next[index])) return null;
	}
	const added = next.slice(current.length);
	const assistant = [];
	for (const item of added) {
		if (item?.role === "user" || String(item?.type ?? "").endsWith("_output")) break;
		assistant.push(item);
	}
	return assistant.length > 0 ? assistant : null;
}

export function visiblePiAssistant(message) {
	const lines = [];
	for (const block of message?.content ?? []) {
		if (block?.type === "text" && block.text) lines.push(`ASSISTANT\n${block.text}`);
		if (block?.type === "toolCall") lines.push(`ASSISTANT TOOL CALL ${block.name}\n${JSON.stringify(block.arguments ?? {})}`);
	}
	return lines.join("\n\n");
}

export function fileStateFor(rows, pointKey) {
	const states = rows.filter(
		(row) => row.kind === "file-state" && [row.runId, row.trajectoryId, row.config, row.pointId].join("/") === pointKey,
	);
	if (states.length !== 1) throw new Error(`${pointKey}: expected exactly one file-state row, found ${states.length}`);
	return Object.entries(states[0].files ?? {})
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([path, text]) => `FILE ${path}\n${text}`)
		.join("\n\n");
}

export function activeCatalog(dataset, task) {
	return dataset.issues
		.filter((issue) => issue.status === "active" && issue.task === task)
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((issue, index) => ({ key: `k${String(index + 1).padStart(2, "0")}`, issueId: issue.id, statement: issue.statement }));
}

export function catalogHash(datasetVersion, catalog) {
	return sha16(JSON.stringify({ datasetVersion, catalog }));
}

export function stableBlindOrder(items) {
	return [...items].sort((a, b) => sha16(a.sourceKey).localeCompare(sha16(b.sourceKey)) || a.sourceKey.localeCompare(b.sourceKey));
}

function schema() {
	return '{"findings":[{"id":"j01","claims":[{"statement":"neutral one-sentence defect","reasoning":"under 240 chars","centralSupported":true,"unsupportedExtra":false,"matches":["k01"]}]}]}';
}

export function buildCapstoneJudgePrompt({ items, visibleTranscript, files, catalog }) {
	const ordered = stableBlindOrder(items);
	const renderedFindings = ordered
		.map((item, index) => `FINDING j${String(index + 1).padStart(2, "0")}\n${JSON.stringify(item.message)}`)
		.join("\n\n");
	const renderedCatalog = catalog.map((issue) => `${issue.key}: ${issue.statement}`).join("\n\n");
	return {
		ordered,
		prompt: `You are a strict blind evaluator of side-observer feedback. The producing model, implementation arm, delivery route, cost, expected result, issue tiers, votes, and planted labels are hidden.

${SUPPORT_POLICY}

Split EACH delivered finding into its distinct atomic DEFECT CLAIMS, then judge each claim. A finding that names two different defects must yield two claims. Do not split one defect merely because it has several clauses. A process-only note may yield zero claims.

For each atomic claim:
- statement: neutral one-sentence description of the defect itself;
- centralSupported and unsupportedExtra: apply the evidence policy above;
- matches: every reference entry describing the SAME underlying wrong behavior in the SAME code. A shared function name or only a downstream consequence is not a match. An empty list is normal.

Support and matching are separate. Do not assume a reference entry is live merely because it is listed. Base support only on the visible evidence. Do not reward or punish wording, cardinality, or delivery mechanism.

VISIBLE DRIVER TRANSCRIPT
${visibleTranscript}

EXACT TRACKED-FILE STATE
${files}

ACTIVE TASK REFERENCE CATALOG (statements only)
${renderedCatalog}

DELIVERED FINDINGS
${renderedFindings}

Return exactly one JSON object and no markdown. Preserve finding ids and order. Every claim needs all five fields; matches may contain only listed catalog keys.
${schema()}`,
	};
}

function extractJson(text) {
	const raw = String(text ?? "").trim();
	const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
	const body = fenced ? fenced[1].trim() : raw;
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		return JSON.parse(body.slice(start, end + 1));
	} catch {
		return null;
	}
}

export function parseCapstoneJudgments(text, expectedCount, catalogKeys) {
	const value = extractJson(text);
	if (!value || !Array.isArray(value.findings) || value.findings.length !== expectedCount) return null;
	const known = new Set(catalogKeys);
	for (let index = 0; index < value.findings.length; index++) {
		const finding = value.findings[index];
		if (finding?.id !== `j${String(index + 1).padStart(2, "0")}` || !Array.isArray(finding.claims)) return null;
		for (const claim of finding.claims) {
			if (typeof claim?.statement !== "string" || !claim.statement.trim()) return null;
			if (typeof claim.reasoning !== "string") return null;
			if (typeof claim.centralSupported !== "boolean" || typeof claim.unsupportedExtra !== "boolean") return null;
			if (!Array.isArray(claim.matches) || claim.matches.some((key) => !known.has(key))) return null;
			if (new Set(claim.matches).size !== claim.matches.length) return null;
		}
	}
	return value.findings;
}

export function capstoneJudgeBuilderSource() {
	return [
		SUPPORT_POLICY,
		deliveredFindings.toString(),
		findingSourceKey.toString(),
		visiblePayload.toString(),
		recoverRunEndAssistant.toString(),
		visiblePiAssistant.toString(),
		fileStateFor.toString(),
		activeCatalog.toString(),
		stableBlindOrder.toString(),
		schema.toString(),
		buildCapstoneJudgePrompt.toString(),
		parseCapstoneJudgments.toString(),
	].join("\n<<<>>>\n");
}

export function capstoneJudgeBuilderHash() {
	return sha16(capstoneJudgeBuilderSource());
}
