import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mapPath = join(root, "docs", "claims.json");
const updating = process.argv.includes("--update");
const reviewed = process.argv.includes("--reviewed");
const selectedClaims = new Set(process.argv.filter((arg) => arg.startsWith("--claim=")).map((arg) => arg.slice("--claim=".length)));
if (updating && (!reviewed || selectedClaims.size === 0)) {
	console.error("baseline update requires --reviewed and at least one explicit --claim=<id>");
	process.exit(1);
}
const hash = (value) => createHash("sha256").update(value.replaceAll("\r\n", "\n")).digest("hex");

function codeRegion(authority, claim) {
	const text = readFileSync(join(root, authority.path), "utf8");
	const start = text.indexOf(authority.start);
	if (start === -1) throw new Error(`${claim}: missing start marker in ${authority.path}: ${authority.start}`);
	const end = authority.end ? text.indexOf(authority.end, start + authority.start.length) : text.length;
	if (end === -1) throw new Error(`${claim}: missing end marker in ${authority.path}: ${authority.end}`);
	return `${authority.path}\n${text.slice(start, end)}`;
}

function baseSlug(value) {
	return value.trim().toLowerCase().replace(/<[^>]*>/g, "").replace(/[`*_~]/g, "")
		.replace(/[\u0000-\u001f\u007f-\u009f\u2000-\u206f\u2e00-\u2e7f'!"#$%&()+,./:;<=>?@[\\\]^{}|]/g, "").replace(/ /g, "-");
}

function docSection(doc, claim) {
	const text = readFileSync(join(root, doc.path), "utf8");
	const lines = text.split("\n");
	const seen = new Map();
	let start = -1;
	let level = 0;
	let fenced = false;
	for (let i = 0; i < lines.length; i++) {
		if (/^\s*(```|~~~)/.test(lines[i])) {
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;
		const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
		if (!heading) continue;
		const base = baseSlug(heading[2]);
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		const slug = count === 0 ? base : `${base}-${count}`;
		if (start === -1 && slug === doc.fragment) {
			start = i;
			level = heading[1].length;
			continue;
		}
		if (start !== -1 && heading[1].length <= level) return `${doc.path}#${doc.fragment}\n${lines.slice(start, i).join("\n")}`;
	}
	if (start === -1) throw new Error(`${claim}: missing canonical section ${doc.path}#${doc.fragment}`);
	return `${doc.path}#${doc.fragment}\n${lines.slice(start).join("\n")}`;
}

const map = JSON.parse(readFileSync(mapPath, "utf8"));
const errors = [];
for (const claim of map.claims) {
	try {
		const codeHash = hash(claim.code.map((authority) => codeRegion(authority, claim.id)).join("\n---\n"));
		const docHash = hash(docSection(claim.doc, claim.id));
		const codeChanged = claim.baseline?.codeHash !== codeHash;
		const docChanged = claim.baseline?.docHash !== docHash;
		if (updating && selectedClaims.has(claim.id)) {
			if (!codeChanged && !docChanged) errors.push(`${claim.id}: selected for baseline update but neither authority changed`);
			claim.baseline = { codeHash, docHash };
		} else {
			if (codeChanged) errors.push(`${claim.id}: code authority changed; review its canonical docs and explicitly update this claim's joint baseline`);
			if (docChanged) errors.push(`${claim.id}: canonical doc section changed; review its code authority and explicitly update this claim's joint baseline`);
		}
		if (updating) selectedClaims.delete(claim.id);
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}
}
if (updating && selectedClaims.size > 0) errors.push(`unknown claim ids: ${[...selectedClaims].join(", ")}`);
if (updating && errors.length === 0) {
	writeFileSync(mapPath, `${JSON.stringify(map, null, 2)}\n`);
	console.log("updated explicitly reviewed joint code/documentation baselines");
} else if (errors.length > 0) {
	console.error(errors.join("\n"));
	process.exit(1);
} else {
	console.log(`code-to-doc claims: ${map.claims.length} joint baselines clean`);
}
