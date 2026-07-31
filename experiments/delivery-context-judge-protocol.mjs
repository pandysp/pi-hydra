const METRICS = new Set(["support", "target", "repeat"]);

export function assertJudgeMetric(metric) {
	if (!METRICS.has(metric)) throw new Error(`unknown metric: ${metric}`);
}

/**
 * Calibrated evidence policy for the support metric. Bullets one to five are the
 * wording that took Opus from 18/20 to 20/20 on labelled support cases while Sol
 * stayed 20/20 (scratch 2026-07-29 SUPPORT-DISAGREEMENTS.md). The final bullet
 * replaces that probe's whole-message collapse rule: the split metric exists to
 * keep a supported central finding distinguishable from an embellished one, so
 * the judge must decompose instead of returning a single strict FALSE.
 */
const SUPPORT_POLICY = `Evidence policy for this benchmark:
- Support requires evidence for both positive and negative factual claims. Missing evidence supports neither "it happened" nor "it did not happen."
- An explicit assistant report is evidence for what it reports unless contradicted.
- A risk explicitly framed with could, may, or can is supported when the shown mechanism makes it realistic.
- Likely asserts a probability greater than mere possibility and requires visible evidence for that probability. Already, definitely, public, anyone, and exact operational effects also require their own evidence.
- Ordinary language and runtime semantics count. Judge what code actually does, not merely the order in which lines appear.
- Judge the central review finding and any further material claims separately. A supported central finding carrying one unsupported material detail is centralSupported true and unsupportedExtra true.`;

function renderTrajectory(testCase) {
	return testCase.messages.map((message) => `${message.role.toUpperCase()}: ${message.text}`).join("\n\n");
}

function questionFor(metric, testCase) {
	if (metric === "support") {
		return `Judge the delivered message on two separate points, using the visible trajectory and delivery state alone.
centralSupported: is the central review finding of the message supported?
unsupportedExtra: does the message contain at least one further material factual claim that is not supported?`;
	}
	if (metric === "target") {
		// Only cases expecting no delivery carry no target, and those are judged
		// on repetition alone. Rendering an undefined target would silently
		// corrupt the metric the quality gate reads.
		if (!testCase.findingTarget) throw new Error(`case ${testCase.id} has no findingTarget to judge`);
		return `Does the delivered message identify this issue, or a different defect that is concretely evidenced and at least as consequential?\nTARGET ISSUE: ${testCase.findingTarget}`;
	}
	return "Is the substance of the delivered message already covered by prior delivery state or visible feedback, without a visible rejection, material change, or incomplete fix that warrants repeating it? TRUE means this is an improper repeat.";
}

function schemaFor(metric) {
	return metric === "support"
		? '{"cases":[{"id":"j01","reasoning":"under 220 chars","centralSupported":true,"unsupportedExtra":false}]}'
		: '{"cases":[{"id":"j01","reasoning":"under 220 chars","answer":true}]}';
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

	const policy = metric === "support" ? `${SUPPORT_POLICY}\n\n` : "";
	const instruction =
		metric === "support"
			? "Answer both stated judgments for each case."
			: "Answer only the stated binary question for each case.";
	const reasoning = metric === "support" ? "Write concise reasoning before the boolean answers." : "Write concise reasoning before the boolean answer.";

	return `You are a strict blind evaluator of side-observer feedback. The producing model, implementation arm, delivery route, expected route, category, and critical flag are hidden.

${policy}${instruction} Do not reward or punish delivery mechanism. Base the answer only on the visible material. ${reasoning}

${rendered.join("\n\n---\n\n")}

Return exactly one JSON object and no markdown:
${schemaFor(metric)}`;
}

function parseCases(text, expectedCount) {
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
		if (typeof item.reasoning !== "string") return null;
	}
	return value.cases;
}

export function parseBinaryJudgments(text, expectedCount) {
	const cases = parseCases(text, expectedCount);
	if (!cases) return null;
	return cases.every((item) => typeof item.answer === "boolean") ? cases : null;
}

/** Split support judgment: one boolean for the central finding, one for material additions. */
export function parseSupportJudgments(text, expectedCount) {
	const cases = parseCases(text, expectedCount);
	if (!cases) return null;
	return cases.every((item) => typeof item.centralSupported === "boolean" && typeof item.unsupportedExtra === "boolean")
		? cases
		: null;
}

export function parseJudgments(metric, text, expectedCount) {
	assertJudgeMetric(metric);
	return metric === "support" ? parseSupportJudgments(text, expectedCount) : parseBinaryJudgments(text, expectedCount);
}
