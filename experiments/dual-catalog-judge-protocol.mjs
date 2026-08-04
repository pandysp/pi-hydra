import { sha16 } from "./fingerprints.mjs";
import { dualCatalogDefinitionHash } from "./dual-catalog.mjs";
import {
	buildFindingItems,
	cacheOnlyInvalid,
	deliveredFindings,
	failedDriverPointKeys,
	fileStateFor,
	findingSourceKey,
	recoverRunEndAssistant,
	stableBlindOrder,
	visiblePayload,
	visiblePiAssistant,
} from "./capstone-trajectory-judge-protocol.mjs";

export const DUAL_CATALOG_JUDGE_SYSTEM_PROMPT = `You are an independent, strict, blind evaluator of software-review findings. Evaluate one observer-authored finding as one main defect proposition; do not atomize it into judge-authored claims.

Truth is about whether the main proposition identifies an actionable defect in the visible code context:
- real: it identifies an actionable defect here;
- false: it identifies no defect here, including a wrong premise, irrelevant concern, expected behavior, or true-but-harmless observation;
- unclear: the visible evidence cannot settle whether it is a defect.

A request to test, inspect, verify, qualify, or change something only if a later
check fails is process advice, not evidence that a defect exists. Classify it as
false unless the finding itself asserts an existing wrong behavior. Never invent
"missing test coverage" or another defect from a recommendation alone.

Severity is separate:
- real severe means blocking; real minor means harmful but non-blocking;
- false severe means accepting the report could plausibly cause a dangerous wrong change, remove a safeguard, create correctness or security loss, or materially redirect the work;
- false minor means accepting it primarily costs bounded investigation, clarification, testing, documentation, or a local unnecessary change.

Severe is exceptional and must be justified by the current shown defect, not by
the general importance of the task. Missing a requested test without a shown
behavior failure is not severe.

First match the main proposition against the supplied real-issue and known-invalid-report catalogs. A match requires the same proposition in the same code context, not a shared symbol or downstream consequence. A known match imports truth and severity from its catalog and must not be re-proven or classified as unmatched. If there is no match, classify truth and severity from the visible evidence. Use severity null only when truth is unclear. Ignore attached embellishments unless they change which proposition is main.

Return only the requested JSON. Never infer hidden arm, model, cost, delivery route, expected result, catalog id, or catalog severity.`;

export const MAX_DUAL_CATALOG_FINDINGS_PER_BATCH = 12;

function exactKeys(value, expected) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	return JSON.stringify(actual) === JSON.stringify(wanted);
}

function parseJson(text) {
	try {
		return JSON.parse(String(text ?? "").trim());
	} catch {
		return null;
	}
}

function validateCatalogView(catalog) {
	if (!catalog || typeof catalog !== "object" || !Array.isArray(catalog.real) || !Array.isArray(catalog.false)) {
		throw new Error("dual catalog view requires real[] and false[]");
	}
	if (typeof catalog.task !== "string" || !catalog.task) throw new Error("dual catalog view requires a task");
	const all = [...catalog.real, ...catalog.false];
	const keys = new Set();
	for (const entry of all) {
		if (typeof entry?.key !== "string" || typeof entry?.statement !== "string" || !entry.statement.trim()) {
			throw new Error("dual catalog entries require key and non-empty statement");
		}
		if (keys.has(entry.key)) throw new Error(`duplicate rendered catalog key ${entry.key}`);
		keys.add(entry.key);
	}
	if (catalog.real.some((entry) => !/^r\d{2,}$/.test(entry.key))) throw new Error("real catalog keys must use rNN");
	if (catalog.false.some((entry) => !/^f\d{2,}$/.test(entry.key))) throw new Error("false catalog keys must use fNN");
	return catalog;
}

function renderCatalog(entries) {
	return entries.length > 0 ? entries.map((entry) => `${entry.key}: ${entry.statement}`).join("\n\n") : "(none)";
}

function responseSchema() {
	return `Matched example:
{"findings":[{"id":"j01","realMatches":["r01"],"falseMatches":[],"quote":"exact finding span","unmatched":null,"reasoning":"under 240 chars"}]}

Unmatched examples:
{"findings":[{"id":"j01","realMatches":[],"falseMatches":[],"quote":"exact finding span","unmatched":{"truth":"real","severity":"severe"},"reasoning":"under 240 chars"}]}
For false use truth "false" with severity "severe" or "minor". For unclear use exactly {"truth":"unclear","severity":null}.`;
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function blindSecrets(items) {
	const unbounded = items.flatMap((item) => [item.sourceKey, item.runId, item.pointKey, item.pointId])
		.filter((value) => typeof value === "string" && value.length >= 4)
		.map((value) => ({ value, bounded: false }));
	const bounded = items.flatMap((item) => [item.config, item.arm])
		.filter((value) => typeof value === "string" && value.length >= 2)
		.map((value) => ({ value, bounded: true }));
	return [...new Map([...unbounded, ...bounded].map((secret) => [`${secret.bounded}:${secret.value}`, secret])).values()]
		.sort((a, b) => b.value.length - a.value.length);
}

export function blindDualCatalogText(value, items) {
	let result = String(value ?? "")
		.replace(/\/tmp\/hydra-traj-[A-Za-z0-9._-]+/g, "<benchmark-workspace>")
		.replace(/Benchmark nonce:\s*[^.\s]+/g, "Benchmark nonce: <hidden>");
	for (const secret of blindSecrets(items)) {
		const pattern = secret.bounded
			? `(?<![A-Za-z0-9_-])${escapeRegExp(secret.value)}(?![A-Za-z0-9_-])`
			: escapeRegExp(secret.value);
		result = result.replace(new RegExp(pattern, "g"), "<hidden>");
	}
	return result;
}

export function buildDualCatalogJudgePrompt({ items, visibleTranscript, files, catalog }) {
	validateCatalogView(catalog);
	if (!Array.isArray(items) || items.length === 0) throw new Error("dual-catalog judge requires at least one finding");
	if (items.length > MAX_DUAL_CATALOG_FINDINGS_PER_BATCH) {
		throw new Error(`dual-catalog judge accepts at most ${MAX_DUAL_CATALOG_FINDINGS_PER_BATCH} findings per batch`);
	}
	for (const item of items) {
		if (typeof item?.sourceKey !== "string" || typeof item?.message !== "string" || !item.message.trim()) {
			throw new Error("each judge item requires sourceKey and non-empty message");
		}
		if (item.task !== catalog.task) throw new Error(`${item.sourceKey}: task differs from catalog`);
	}
	const ordered = stableBlindOrder(items).map((item) => ({
		...item,
		judgeMessage: blindDualCatalogText(item.message, items),
	}));
	const findings = ordered
		.map((item, index) => `FINDING j${String(index + 1).padStart(2, "0")}\n${JSON.stringify(item.judgeMessage)}`)
		.join("\n\n");
	const blindedTranscript = blindDualCatalogText(visibleTranscript, items);
	const blindedFiles = blindDualCatalogText(files, items);
	const userPrompt = `Judge every delivered finding below exactly once and in order.

For each finding:
1. Identify its main defect proposition.
2. Return every real-catalog entry expressing that same proposition in the same context, OR every false-catalog entry expressing it. The two match lanes are exclusive.
3. If and only if both match arrays are empty, classify the unmatched proposition. Real or false requires severe or minor; unclear requires severity null.
4. Quote an exact non-empty span from the delivered finding that states its main proposition.
5. Give non-empty evidence-based reasoning of at most 240 characters.

If the finding is only process advice and asserts no present defect, its main
reported issue is invalid: use unmatched false and normally minor severity.

Do not split one finding into multiple claims. A matched finding has unmatched null. An unmatched finding has no matches. Preserve the supplied jNN ids and order. Use only listed keys. Return exactly one JSON object with exactly the requested fields and no markdown.

VISIBLE DRIVER TRANSCRIPT
${blindedTranscript}

EXACT TRACKED-FILE STATE
${blindedFiles}

REAL-ISSUE CATALOG (statements only; ids and severity hidden)
${renderCatalog(catalog.real)}

KNOWN INVALID-REPORT CATALOG (statements only; ids and severity hidden)
${renderCatalog(catalog.false)}

DELIVERED FINDINGS
${findings}

RESPONSE CONTRACT
${responseSchema()}`;
	return { ordered, systemPrompt: DUAL_CATALOG_JUDGE_SYSTEM_PROMPT, userPrompt };
}

function validMatches(value, known) {
	return Array.isArray(value) &&
		value.every((key) => typeof key === "string" && known.has(key)) &&
		new Set(value).size === value.length;
}

function validUnmatched(value) {
	if (!exactKeys(value, ["truth", "severity"])) return false;
	if (value.truth === "unclear") return value.severity === null;
	return (value.truth === "real" || value.truth === "false") && (value.severity === "severe" || value.severity === "minor");
}

export function parseDualCatalogJudgments(text, ordered, catalog) {
	validateCatalogView(catalog);
	if (!Array.isArray(ordered)) return null;
	const value = parseJson(text);
	if (!exactKeys(value, ["findings"]) || !Array.isArray(value.findings) || value.findings.length !== ordered.length) return null;
	const realKeys = new Set(catalog.real.map((entry) => entry.key));
	const falseKeys = new Set(catalog.false.map((entry) => entry.key));
	for (let index = 0; index < value.findings.length; index++) {
		const finding = value.findings[index];
		if (!exactKeys(finding, ["id", "realMatches", "falseMatches", "quote", "unmatched", "reasoning"])) return null;
		if (finding.id !== `j${String(index + 1).padStart(2, "0")}`) return null;
		if (!validMatches(finding.realMatches, realKeys) || !validMatches(finding.falseMatches, falseKeys)) return null;
		const hasReal = finding.realMatches.length > 0;
		const hasFalse = finding.falseMatches.length > 0;
		if (hasReal && hasFalse) return null;
		if ((hasReal || hasFalse) ? finding.unmatched !== null : !validUnmatched(finding.unmatched)) return null;
		if (typeof ordered[index]?.judgeMessage !== "string") throw new Error(`j${String(index + 1).padStart(2, "0")}: missing blinded judgeMessage`);
		if (typeof finding.quote !== "string" || !finding.quote.trim() || !ordered[index].judgeMessage.includes(finding.quote)) return null;
		if (typeof finding.reasoning !== "string" || !finding.reasoning.trim() || [...finding.reasoning].length > 240) return null;
	}
	return value.findings;
}

export function dualCatalogJudgeSystemHash() {
	return sha16(DUAL_CATALOG_JUDGE_SYSTEM_PROMPT);
}

export function dualCatalogJudgeBuilderSource() {
	return [
		dualCatalogDefinitionHash(),
		DUAL_CATALOG_JUDGE_SYSTEM_PROMPT,
		String(MAX_DUAL_CATALOG_FINDINGS_PER_BATCH),
		cacheOnlyInvalid.toString(),
		failedDriverPointKeys.toString(),
		deliveredFindings.toString(),
		buildFindingItems.toString(),
		findingSourceKey.toString(),
		visiblePayload.toString(),
		recoverRunEndAssistant.toString(),
		visiblePiAssistant.toString(),
		fileStateFor.toString(),
		stableBlindOrder.toString(),
		exactKeys.toString(),
		parseJson.toString(),
		validateCatalogView.toString(),
		renderCatalog.toString(),
		responseSchema.toString(),
		escapeRegExp.toString(),
		blindSecrets.toString(),
		blindDualCatalogText.toString(),
		buildDualCatalogJudgePrompt.toString(),
		validMatches.toString(),
		validUnmatched.toString(),
		parseDualCatalogJudgments.toString(),
	].join("\n<<<EXPANDED-2Q>>>\n");
}

export function dualCatalogJudgeBuilderHash() {
	return sha16(dualCatalogJudgeBuilderSource());
}
