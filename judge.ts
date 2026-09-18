import type { AssistantMessage } from "@earendil-works/pi-ai";
import { parseEnumeratedDecision } from "./utils";
import type { Decision } from "./utils";

export type JudgeErrorKind =
	| "provider-error"
	| "aborted"
	| "truncated"
	| "blocked-tool-request"
	| "empty-answer"
	| "malformed-findings"
	| "incomplete-response";

type CorrectableJudgeError = "blocked-tool-request" | "malformed-findings";

export interface JudgeResult {
	decisions: Decision[] | null;
	errorKind: JudgeErrorKind | null;
	// Saved as written in the log, never sent into the conversation.
	parseError: string | null;
	attemptedTools: string[];
}

function boundedName(name: string): string {
	return typeof name === "string" && /^[a-zA-Z0-9_.:-]{1,64}$/.test(name) ? name : "(name omitted)";
}

export function classifyJudgeResponse(response: AssistantMessage): JudgeResult {
	const attemptedTools = [...new Set(response.content.flatMap(block => block.type === "toolCall" ? [boundedName(block.name)] : []))].slice(0, 8);
	const failed = (errorKind: JudgeErrorKind): JudgeResult => ({ decisions: null, errorKind, parseError: null, attemptedTools });
	if (response.stopReason === "error") return failed("provider-error");
	if (response.stopReason === "aborted") return failed("aborted");
	if (response.stopReason === "length") return failed("truncated");
	if (response.stopReason !== "stop" && response.stopReason !== "toolUse") return failed("incomplete-response");
	if (attemptedTools.length > 0) return failed("blocked-tool-request");
	if (response.stopReason !== "stop") return failed("incomplete-response");
	const text = response.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
	if (!text.trim()) return failed("empty-answer");
	const parsed = parseEnumeratedDecision(text);
	return {
		decisions: parsed.decisions,
		errorKind: parsed.error ? "malformed-findings" : null,
		parseError: parsed.error,
		attemptedTools,
	};
}

export const JUDGE_ERROR_DESCRIPTIONS: Record<JudgeErrorKind, string> = {
	"provider-error": "provider returned an error",
	aborted: "provider stopped the response",
	truncated: "output was cut short; no findings or tool requests were accepted",
	"blocked-tool-request": "head requested tools it cannot run; nothing ran and there was no retry",
	"empty-answer": "answer text is missing (empty or thinking-only); expected findings JSON",
	"malformed-findings": "completed answer did not match the required findings JSON",
	"incomplete-response": "provider did not mark the response as finished",
};

export interface JudgeReportDetails {
	head: string;
	errorKind: CorrectableJudgeError;
}

export function buildJudgeReport(head: string, result: Pick<JudgeResult, "errorKind" | "attemptedTools">) {
	if (result.errorKind !== "blocked-tool-request" && result.errorKind !== "malformed-findings") return null;
	const details: JudgeReportDetails = {
		head,
		errorKind: result.errorKind,
	};
	const fact = result.errorKind === "blocked-tool-request"
		? `A head without tools requested tools (${result.attemptedTools.join(", ")}); none ran. In future checks without tools, return the required findings JSON instead.`
		: "A completed answer from a head without tools did not match the required findings JSON. Use that format in future checks.";
	return {
		customType: "hydra-runtime-report" as const,
		content: `Hydra error notice (not a user request or a head finding). Head: ${boundedName(head)}. ${fact}`,
		display: true,
		details,
	};
}

function reportDetails(value: unknown): JudgeReportDetails | null {
	if (typeof value !== "object" || value === null) return null;
	const details = value as Partial<JudgeReportDetails>;
	return typeof details.head === "string" && details.head.length > 0 &&
		(details.errorKind === "blocked-tool-request" || details.errorKind === "malformed-findings")
		? details as JudgeReportDetails : null;
}

function reportKey(details: JudgeReportDetails): string {
	return `${details.head}:${details.errorKind}`;
}

// One notice per head and error kind on the current branch. Only a message
// that arrived counts as delivered, not an attempted send: cancelling in Pi
// can clear queued messages. `pending` also stops a second notice
// while the first is still queued, which happens when a slow head fails
// twice before the main assistant's current response ends.
export class JudgeReports {
	private readonly delivered = new Set<string>();
	private readonly pending = new Set<string>();

	stage(details: JudgeReportDetails): boolean {
		const key = reportKey(details);
		if (this.delivered.has(key) || this.pending.has(key)) return false;
		this.pending.add(key);
		return true;
	}

	consume(value: unknown): void {
		const details = reportDetails(value);
		if (!details) return;
		const key = reportKey(details);
		this.pending.delete(key);
		this.delivered.add(key);
	}

	sync(entries: Iterable<{ type: string; customType?: string; details?: unknown }>): void {
		for (const entry of entries) {
			if (entry.type === "custom_message" && entry.customType === "hydra-runtime-report") this.consume(entry.details);
		}
	}

	restore(entries: Iterable<{ type: string; customType?: string; details?: unknown }>): void {
		this.delivered.clear();
		this.pending.clear();
		this.sync(entries);
	}

	settle(): number {
		const orphaned = this.pending.size;
		this.pending.clear();
		return orphaned;
	}
}
