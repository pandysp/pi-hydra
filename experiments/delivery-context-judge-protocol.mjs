const METRICS = new Set(["support", "target", "repeat"]);

export function assertJudgeMetric(metric) {
	if (!METRICS.has(metric)) throw new Error(`unknown metric: ${metric}`);
}

function renderTrajectory(testCase) {
	return testCase.messages.map((message) => `${message.role.toUpperCase()}: ${message.text}`).join("\n\n");
}

function questionFor(metric, testCase) {
	if (metric === "support") {
		return "Is every factual claim in the delivered message supported by the visible trajectory and delivery state alone?";
	}
	if (metric === "target") {
		return `Does the delivered message identify this issue, or a different defect that is concretely evidenced and at least as consequential?\nTARGET ISSUE: ${testCase.findingTarget}`;
	}
	return "Is the substance of the delivered message already covered by prior delivery state or visible feedback, without a visible rejection, material change, or incomplete fix that warrants repeating it? TRUE means this is an improper repeat.";
}

export function buildJudgePrompt(metric, items) {
	assertJudgeMetric(metric);
	const rendered = items.map(({ testCase, message }, index) => `CASE j${String(index + 1).padStart(2, "0")}
Head: ${testCase.head}
Delivery state: ${JSON.stringify(testCase.state)}

VISIBLE TRAJECTORY
${renderTrajectory(testCase)}

DELIVERED MESSAGE
${JSON.stringify(message)}

QUESTION
${questionFor(metric, testCase)}`);

	return `You are a strict blind evaluator of side-observer feedback. The producing model, implementation arm, delivery route, expected route, category, and critical flag are hidden.

Answer only the stated binary question for each case. Do not reward or punish delivery mechanism. Base the answer only on the visible material. Write concise reasoning before the boolean answer.

${rendered.join("\n\n---\n\n")}

Return exactly one JSON object and no markdown:
{"cases":[{"id":"j01","reasoning":"under 220 chars","answer":true}]}`;
}

export function parseBinaryJudgments(text, expectedCount) {
	let value;
	try {
		value = JSON.parse(text.trim());
	} catch {
		return null;
	}
	if (!value || typeof value !== "object" || !Array.isArray(value.cases) || value.cases.length !== expectedCount) {
		return null;
	}
	for (let index = 0; index < value.cases.length; index++) {
		const item = value.cases[index];
		if (item?.id !== `j${String(index + 1).padStart(2, "0")}`) return null;
		if (typeof item.reasoning !== "string" || typeof item.answer !== "boolean") return null;
	}
	return value.cases;
}
