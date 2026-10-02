import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Decision } from "./utils.ts";
export type JudgeErrorKind = "provider-error" | "aborted" | "truncated" | "blocked-tool-request" | "empty-answer" | "malformed-findings" | "incomplete-response";
export interface JudgeResult {
    decisions: Decision[] | null;
    errorKind: JudgeErrorKind | null;
    parseError: string | null;
    attemptedTools: string[];
}
export declare function classifyJudgeResponse(response: AssistantMessage): JudgeResult;
export declare const JUDGE_ERROR_DESCRIPTIONS: Record<JudgeErrorKind, string>;
export declare function buildJudgeReport(result: Pick<JudgeResult, "errorKind" | "attemptedTools">): string | null;
