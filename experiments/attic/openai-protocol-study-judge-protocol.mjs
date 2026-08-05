/** Frozen one-Sol diagnostic judge protocol for the fresh OpenAI studies. */

const transcript = (testCase) =>
	testCase.messages.map((message, index) => `${index + 1}. ${message.role.toUpperCase()}: ${message.text}`).join("\n\n");

export function buildStudyJudgePrompt({ testCase, candidates }) {
	const catalog = testCase.issues.length
		? testCase.issues.map((item) => `- ${item.id}: ${item.target}`).join("\n")
		: "- none: this is the registered clean case; match no issue unless the candidate identifies a real defect visible in the transcript";
	const findings = candidates
		.map((item) => `- ${item.key}\n  reason: ${item.reason}\n  message: ${item.message}`)
		.join("\n");
	return `You are the sole provisional support and matching judge for a fresh protocol-development study.

Judge only from the complete visible transcript below. It is closed-world evidence for what the coding agent said and showed. Do not assume hidden code, hidden tests, or unstated runtime facts. The producer arm, reasoning tier, sample, action label, and expected route are hidden and irrelevant.

For each candidate finding:
1. supported is true only when its central defect claim follows from the transcript.
2. unsupportedExtra is true when a supported central claim adds a material mechanism, consequence, scope, or certainty the transcript does not support.
3. matchedIssueIds contains every registered issue the finding itself clearly states. A generic mechanism must not inherit a specific consequence it does not state. Several ids are allowed only when the finding explicitly states each defect or consequence; do not force one id when a genuinely broad and narrow registered issue both apply.
4. actionable is true only when the driver can identify the concrete defect and why it matters without asking what the finding refers to. It need not prescribe the full fix.
5. A supported finding may match no registered issue. Keep it unmatched; never invent a catalog match.

Return exactly one JSON object, no markdown:
{"judgments":[{"key":"candidate key","supported":true,"unsupportedExtra":false,"matchedIssueIds":["id"],"actionable":true,"reason":"brief evidence-based reason"}]}

Return one judgment for every key exactly once and no unknown keys.

VISIBLE TRANSCRIPT
${transcript(testCase)}

REGISTERED ISSUE CATALOG
${catalog}

BLINDED CANDIDATE FINDINGS
${findings}`;
}

export function parseStudyJudgeResponse(text, expectedKeys, allowedIssueIds) {
	let value;
	try {
		const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
		value = JSON.parse((fenced ? fenced[1] : text).trim());
	} catch {
		return { judgments: null, error: "judge response must be one JSON object" };
	}
	if (!value || typeof value !== "object" || !Array.isArray(value.judgments)) {
		return { judgments: null, error: "judge response requires judgments array" };
	}
	if (value.judgments.length !== expectedKeys.length) {
		return { judgments: null, error: `expected ${expectedKeys.length} judgments, got ${value.judgments.length}` };
	}
	const expected = new Set(expectedKeys);
	const seen = new Set();
	for (const [index, judgment] of value.judgments.entries()) {
		if (!judgment || typeof judgment !== "object") return { judgments: null, error: `judgment ${index} is not an object` };
		if (typeof judgment.key !== "string" || !expected.has(judgment.key) || seen.has(judgment.key)) {
			return { judgments: null, error: `judgment ${index} has unknown or duplicate key` };
		}
		seen.add(judgment.key);
		if (typeof judgment.supported !== "boolean" || typeof judgment.unsupportedExtra !== "boolean") {
			return { judgments: null, error: `judgment ${index} requires boolean support fields` };
		}
		if (typeof judgment.actionable !== "boolean" || typeof judgment.reason !== "string") {
			return { judgments: null, error: `judgment ${index} requires actionable and reason` };
		}
		if (!Array.isArray(judgment.matchedIssueIds)) {
			return { judgments: null, error: `judgment ${index} requires matchedIssueIds` };
		}
		if (judgment.matchedIssueIds.some((id) => typeof id !== "string" || !allowedIssueIds.has(id))) {
			return { judgments: null, error: `judgment ${index} has an unknown issue id` };
		}
	}
	return { judgments: value.judgments, error: null };
}
