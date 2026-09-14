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
	// Kept verbatim in the record, never injected into conversation context.
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
	aborted: "provider returned an aborted response",
	truncated: "output was cut short; partial findings and tool requests were not accepted",
	"blocked-tool-request": "judge requested tools; no tools executed and no repair call was made",
	"empty-answer": "no answer text (empty or thinking-only); the required findings JSON is missing",
	"malformed-findings": "completed answer did not match the findings JSON contract",
	"incomplete-response": "provider returned a non-terminal response",
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
		? `A judge-only observation requested tools (${result.attemptedTools.join(", ")}); none executed. Future judge observations must return the required findings JSON, not tool requests.`
		: "A completed judge-only answer did not match the findings JSON contract. Future judge observations must return one JSON object with a findings array and the required action/reason/message fields.";
	return {
		customType: "hydra-runtime-report" as const,
		content: `Hydra runtime report (not a user request or a lens finding). Head: ${boundedName(head)}. ${fact} The failed observation was recorded as noop, without a repair call. Driver: do not execute the blocked request; you need not acknowledge this notice.`,
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

// Separate from lens feedback: a protocol report must not replace the head's
// last finding or imply that a send attempt reached the conversation.
export class JudgeReports {
	private readonly delivered = new Set<string>();
	private readonly pending = new Set<string>();

	stage(details: JudgeReportDetails): boolean {
		const key = reportKey(details);
		if (this.delivered.has(key) || this.pending.has(key)) return false;
		this.pending.add(key);
		return true;
	}

	fail(details: JudgeReportDetails): void {
		this.pending.delete(reportKey(details));
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
