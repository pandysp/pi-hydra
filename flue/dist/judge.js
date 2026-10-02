import { parseEnumeratedDecision } from "./utils.js";
function boundedName(name) {
    return typeof name === "string" && /^[a-zA-Z0-9_.:-]{1,64}$/.test(name) ? name : "(name omitted)";
}
export function classifyJudgeResponse(response) {
    const attemptedTools = [...new Set(response.content.flatMap(block => block.type === "toolCall" ? [boundedName(block.name)] : []))].slice(0, 8);
    const failed = (errorKind) => ({ decisions: null, errorKind, parseError: null, attemptedTools });
    if (response.stopReason === "error")
        return failed("provider-error");
    if (response.stopReason === "aborted")
        return failed("aborted");
    if (response.stopReason === "length")
        return failed("truncated");
    if (response.stopReason !== "stop" && response.stopReason !== "toolUse")
        return failed("incomplete-response");
    if (attemptedTools.length > 0)
        return failed("blocked-tool-request");
    if (response.stopReason !== "stop")
        return failed("incomplete-response");
    const text = response.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
    if (!text.trim())
        return failed("empty-answer");
    const parsed = parseEnumeratedDecision(text);
    return {
        decisions: parsed.decisions,
        errorKind: parsed.error ? "malformed-findings" : null,
        parseError: parsed.error,
        attemptedTools,
    };
}
export const JUDGE_ERROR_DESCRIPTIONS = {
    "provider-error": "provider returned an error",
    aborted: "provider stopped the response",
    truncated: "output was cut short; no findings or tool requests were accepted",
    "blocked-tool-request": "head requested tools it cannot run; nothing ran and there was no retry",
    "empty-answer": "answer text is missing (empty or thinking-only); expected findings JSON",
    "malformed-findings": "completed answer did not match the required findings JSON",
    "incomplete-response": "provider did not mark the response as finished",
};
// Only these two errors can be corrected by the head itself, so only they
// are sent to the main assistant, where the head sees them on its next check.
export function buildJudgeReport(result) {
    if (result.errorKind === "blocked-tool-request") {
        return `A head without tools requested tools (${result.attemptedTools.join(", ")}); none ran. In future checks without tools, return the required findings JSON instead.`;
    }
    if (result.errorKind === "malformed-findings") {
        return "A completed answer from a head without tools did not match the required findings JSON. Use that format in future checks.";
    }
    return null;
}
