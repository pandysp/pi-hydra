import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function githubBaseSlug(value) {
	return value
		.trim()
		.toLowerCase()
		.replace(/<[^>]*>/g, "")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/[`*_~]/g, "")
		// GitHub removes punctuation before replacing each ASCII space with '-'.
		.replace(/[\u0000-\u001f\u007f-\u009f\u2000-\u206f\u2e00-\u2e7f'!"#$%&()+,./:;<=>?@[\\\]^{}|]/g, "")
		.replace(/ /g, "-");
}

export function githubHeadingSlugs(markdown) {
	const seen = new Map();
	const slugs = new Set();
	let fenced = false;
	for (const line of markdown.split(/\r?\n/)) {
		if (/^\s*(```|~~~)/.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;
		const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (!match) continue;
		const base = githubBaseSlug(match[2]);
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		slugs.add(count === 0 ? base : `${base}-${count}`);
	}
	return slugs;
}

function markdownFiles(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if ([".git", "node_modules"].includes(entry.name)) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...markdownFiles(path));
		else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") files.push(path);
	}
	return files;
}

function decode(value, context, errors) {
	try {
		return decodeURIComponent(value);
	} catch {
		errors.push(`${context}: invalid URL encoding in ${value}`);
		return value;
	}
}

function validateTarget(source, rawTarget, errors) {
	if (!rawTarget || /^(?:https?:|mailto:|tel:|data:)/i.test(rawTarget) || /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(rawTarget)) return;
	const withoutTitle = rawTarget.replace(/\s+["'][^"']*["']\s*$/, "").replace(/^file:\/\//, "");
	const hash = withoutTitle.indexOf("#");
	const rawPath = hash === -1 ? withoutTitle : withoutTitle.slice(0, hash);
	const rawFragment = hash === -1 ? "" : withoutTitle.slice(hash + 1);
	const target = rawPath ? resolve(dirname(source), decode(rawPath, relative(root, source), errors)) : source;
	if (!target.startsWith(`${root}/`) && target !== root) {
		errors.push(`${relative(root, source)}: local link escapes checkout: ${rawTarget}`);
		return;
	}
	if (!existsSync(target)) {
		errors.push(`${relative(root, source)}: missing target ${rawTarget}`);
		return;
	}
	if (rawFragment) {
		if (statSync(target).isDirectory() || extname(target).toLowerCase() !== ".md") {
			errors.push(`${relative(root, source)}: fragment target is not Markdown: ${rawTarget}`);
			return;
		}
		const fragment = decode(rawFragment, relative(root, source), errors).toLowerCase();
		if (!githubHeadingSlugs(readFileSync(target, "utf8")).has(fragment)) {
			errors.push(`${relative(root, source)}: missing fragment #${fragment} in ${relative(root, target)}`);
		}
	}
}

function maskCode(markdown) {
	let fenced = false;
	return markdown.split(/(\r?\n)/).map((part) => {
		if (/^\r?\n$/.test(part)) return part;
		if (/^\s*(```|~~~)/.test(part)) {
			fenced = !fenced;
			return " ".repeat(part.length);
		}
		if (fenced) return " ".repeat(part.length);
		return part.replace(/(`+)(.*?)\1/g, (match) => " ".repeat(match.length));
	}).join("");
}

function markdownTargets(rawMarkdown) {
	const markdown = maskCode(rawMarkdown);
	const targets = [];
	const collect = (regex, group = 1) => {
		for (const match of markdown.matchAll(regex)) if (match[group]) targets.push(match[group]);
	};
	// Inline links/images, reference definitions, valid URI/email autolinks, and HTML links.
	collect(/!?\[[^\]]*\]\(([^)]+)\)/g);
	for (const match of markdown.matchAll(/^\s*\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm)) targets.push(match[1] ?? match[2]);
	collect(/<((?:https?|file|mailto):[^>\s]+)>/gi);
	collect(/<([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>/gi);
	collect(/(?:href|src)=["']([^"']+)["']/gi);
	return targets;
}

function validateMarkdown(source, errors) {
	for (const target of markdownTargets(readFileSync(source, "utf8"))) validateTarget(source, target.trim(), errors);
}

function validateInventory(errors) {
	const path = join(root, "docs", "inbound-links.json");
	const inventory = JSON.parse(readFileSync(path, "utf8"));
	for (const [index, item] of inventory.targets.entries()) {
		if (typeof item.path !== "string" || typeof item.fragment !== "string" || !Array.isArray(item.provenance) || item.provenance.length === 0) {
			errors.push(`docs/inbound-links.json: target ${index + 1} requires path, fragment, and provenance`);
			continue;
		}
		if (item.path.startsWith("/") || item.path.includes("..")) {
			errors.push(`docs/inbound-links.json: target ${index + 1} is not a normalized checkout path: ${item.path}`);
			continue;
		}
		validateTarget(join(root, "INBOUND.md"), `${item.path}${item.fragment ? `#${item.fragment}` : ""}`, errors);
	}
}

function selfTest() {
	const sample = "# Hello, world!\n## A & B\n## Repeat\n## Repeat\n```md\n# Not a heading\n```\n";
	const actual = githubHeadingSlugs(sample);
	for (const expected of ["hello-world", "a--b", "repeat", "repeat-1"]) {
		if (!actual.has(expected)) throw new Error(`GitHub slug self-test missed ${expected}`);
	}
	if (actual.has("not-a-heading")) throw new Error("GitHub slug self-test parsed a fenced heading");
	const extracted = markdownTargets([
		"[real](target.md)",
		"`[inline](ignored-inline.md)`",
		"```md",
		"[fenced](ignored-fenced.md)",
		"```",
		"<https://example.com/docs>",
		"<docs@example.com>",
	].join("\n"));
	for (const expected of ["target.md", "https://example.com/docs", "docs@example.com"]) {
		if (!extracted.includes(expected)) throw new Error(`link extraction self-test missed ${expected}`);
	}
	if (extracted.some((target) => target.includes("ignored-"))) throw new Error("link extraction self-test parsed inline or fenced code");

	const fixture = mkdtempSync(join(root, ".link-check-test-"));
	try {
		const source = join(fixture, "source.md");
		writeFileSync(source, [
			"[real](target.md)",
			"`[inline](ignored-inline.md)`",
			"```md",
			"[fenced](ignored-fenced.md)",
			"```",
			"<https://example.com/docs>",
			"<docs@example.com>",
		].join("\n"));
		writeFileSync(join(fixture, "target.md"), sample);
		const parsedErrors = [];
		validateMarkdown(source, parsedErrors);
		if (parsedErrors.length > 0) throw new Error(`link validation self-test rejected code masking or valid autolinks: ${parsedErrors.join("; ")}`);
		const failures = [];
		validateTarget(source, "missing.md", failures);
		validateTarget(source, "target.md#missing", failures);
		if (failures.length !== 2) throw new Error("link checker self-test did not reject missing file and fragment");
		const valid = [];
		for (const target of ["target.md#hello-world", "target.md#a--b", "target.md#repeat-1"]) validateTarget(source, target, valid);
		if (valid.length > 0) throw new Error(`link checker self-test rejected GitHub-compatible fragments: ${valid.join("; ")}`);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
}

selfTest();
const errors = [];
for (const file of markdownFiles(root)) validateMarkdown(file, errors);
validateInventory(errors);
if (errors.length > 0) {
	console.error(errors.join("\n"));
	process.exit(1);
}
console.log(`documentation links: ${markdownFiles(root).length} Markdown files and inbound inventory clean`);
