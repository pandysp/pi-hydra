import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ref = process.argv.find((arg) => arg.startsWith("--ref="))?.slice(6) ?? "main";
const resolvedRef = execFileSync("git", ["rev-parse", `${ref}^{commit}`], { cwd: root, encoding: "utf8" }).trim();
const workspace = process.argv.find((arg) => arg.startsWith("--workspace="))?.slice(12) ?? "/Users/spannagel/main-workspace";
const outward = new Set(["README.md", "CONTRIBUTING.md", "docs/architecture.md", "docs/heads.md"]);
const records = new Map();

function add(path, fragment, provenance) {
	if (!outward.has(path)) return;
	const key = `${path}#${fragment}`;
	const record = records.get(key) ?? { path, fragment, provenance: [] };
	if (!record.provenance.includes(provenance)) record.provenance.push(provenance);
	records.set(key, record);
}

function decode(value) {
	try { return decodeURIComponent(value); } catch { return value; }
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

function inspectMarkdown(original, sourcePath, sourceLabel, repoSource) {
	const markdown = maskCode(original);
	const candidates = [];
	const collect = (regex, group = 1) => {
		for (const match of markdown.matchAll(regex)) candidates.push({ raw: match[group], index: match.index });
	};
	// Inline links/images, reference definitions, autolinks, HTML attributes,
	// bare repository GitHub URLs, file URLs, and absolute checkout paths.
	collect(/!?\[[^\]]*\]\(([^)]+)\)/g);
	collect(/^\s*\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm, 1);
	for (const match of markdown.matchAll(/^\s*\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm)) {
		if (match[2]) candidates.push({ raw: match[2], index: match.index });
	}
	collect(/<(https?:\/\/github\.com\/pandysp\/pi-hydra\/[^>\s]+|file:\/\/[^>\s]+)>/g);
	collect(/(?:href|src)=["']([^"']+)["']/gi);
	collect(/(?<![<("'])https?:\/\/github\.com\/pandysp\/pi-hydra\/(?:blob|tree)\/[^\s)>"']+/g, 0);
	collect(/(?<![<("'])file:\/\/\/Users\/spannagel\/dev\/personal\/pi-hydra\/[^\s)>"']+/g, 0);
	collect(/(?<![\w])\/Users\/spannagel\/dev\/personal\/pi-hydra\/(?:README\.md|CONTRIBUTING\.md|docs\/(?:architecture|heads)\.md)(?:#[^\s)>"']+)?/g, 0);
	collect(/(?<![\w])~\/dev\/personal\/pi-hydra\/(?:README\.md|CONTRIBUTING\.md|docs\/(?:architecture|heads)\.md)(?:#[^\s)>"']+)?/g, 0);

	for (const { raw: untrimmed, index } of candidates) {
		if (!untrimmed) continue;
		const raw = untrimmed.trim().replace(/\s+["'][^"']*["']\s*$/, "").replace(/^file:\/\//, "").replace(/^~\//, "/Users/spannagel/");
		const line = original.slice(0, index).split("\n").length;
		const provenance = `${sourceLabel}:${sourcePath}:${line}`;
		const github = /^https?:\/\/github\.com\/pandysp\/pi-hydra\/(?:blob|tree)\/[^/]+\/(.+?)(?:#([^\s]+))?$/.exec(raw);
		if (github) {
			add(decode(github[1]), decode(github[2] ?? ""), provenance);
			continue;
		}
		if (/^[a-z]+:/i.test(raw)) continue;
		const [pathPart, fragment = ""] = raw.split("#", 2);
		if (repoSource && !pathPart.startsWith("/")) {
			const target = pathPart ? posix.normalize(posix.join(posix.dirname(sourcePath), decode(pathPart))) : sourcePath;
			add(target, decode(fragment), provenance);
		} else {
			const absolute = pathPart.startsWith("/") ? pathPart : resolve(dirname(join(workspace, sourcePath)), decode(pathPart));
			const prefix = `${root}/`;
			if (absolute.startsWith(prefix)) add(relative(root, absolute).replaceAll("\\", "/"), decode(fragment), provenance);
		}
	}
}

function selfTest() {
	const repoFixture = [
		"[inline](README.md#fixture-inline)",
		"[reference]: <README.md#fixture-reference>",
	].join("\n");
	const workspaceFixture = [
		"<https://github.com/pandysp/pi-hydra/blob/main/README.md#fixture-autolink>",
		"<a href=\"https://github.com/pandysp/pi-hydra/blob/main/README.md#fixture-html\">x</a>",
		"https://github.com/pandysp/pi-hydra/blob/main/README.md#fixture-bare",
		"file:///Users/spannagel/dev/personal/pi-hydra/README.md#fixture-file",
		"/Users/spannagel/dev/personal/pi-hydra/README.md#fixture-absolute",
		"~/dev/personal/pi-hydra/README.md#fixture-tilde",
	].join("\n");
	inspectMarkdown(repoFixture, "fixture.md", "fixture", true);
	inspectMarkdown(workspaceFixture, "fixture.md", "fixture", false);
	for (const fragment of ["inline", "reference", "autolink", "html", "bare", "file", "absolute", "tilde"].map((name) => `fixture-${name}`)) {
		const key = `README.md#${fragment}`;
		if (!records.has(key)) throw new Error(`inbound inventory self-test missed ${fragment} link form`);
		records.delete(key);
	}
}

selfTest();
const tracked = execFileSync("git", ["ls-tree", "-r", "--name-only", resolvedRef], { cwd: root, encoding: "utf8" })
	.split("\n").filter((path) => path.endsWith(".md"));
for (const path of tracked) {
	const markdown = execFileSync("git", ["show", `${resolvedRef}:${path}`], { cwd: root, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
	inspectMarkdown(markdown, path, `repo@${resolvedRef}`, true);
}

function workspaceMarkdown(dir) {
	const found = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if ([".git", ".qmd", "node_modules"].includes(entry.name)) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...workspaceMarkdown(path));
		else if (entry.isFile() && entry.name.endsWith(".md")) found.push(path);
	}
	return found;
}
if (existsSync(workspace)) {
	for (const path of workspaceMarkdown(workspace)) {
		inspectMarkdown(readFileSync(path, "utf8"), relative(workspace, path), "main-workspace", false);
	}
}

const inventory = {
	description: "Pre-refactor inbound links to outward pi-hydra documentation. Targets are checkout-relative; provenance records every source occurrence found by the reproducible scan.",
	generatedFrom: { requestedRef: ref, repoCommit: resolvedRef, workspaceScanned: existsSync(workspace) },
	targets: [...records.values()].sort((a, b) => `${a.path}#${a.fragment}`.localeCompare(`${b.path}#${b.fragment}`)),
};
writeFileSync(join(root, "docs", "inbound-links.json"), `${JSON.stringify(inventory, null, 2)}\n`);
console.log(`wrote ${inventory.targets.length} inbound targets from ${tracked.length} repo Markdown files${existsSync(workspace) ? " plus main-workspace" : ""}`);
