// Structural guard against cross-session state leaks.
//
// pi caches the extension FACTORY across /new, fork, and resume within one
// process (loader.js: extensionCache, keyed by cwd + reload generation; its
// jiti instance runs with moduleCache: false, but a fresh evaluation happens
// only when the generation bumps on explicit reload or cwd change). Sibling
// modules therefore evaluate ONCE per generation: anything mutable at module
// scope survives session re-creation and leaks across sessions. All session
// state must be instance state constructed inside the entry factory. This
// gate makes the accident unmergeable instead of a review rule.
//
// Residual not caught: a top-level const object literal mutated at runtime.
// Schema-style const objects (for example the hydra tool parameters) are
// legitimate and allowed; do not mutate them.
import ts from "typescript";
import { readFileSync, readdirSync } from "node:fs";

const files = readdirSync(".")
	.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
	.sort();

const MUTABLE_CONSTRUCTORS = new Set(["Map", "Set", "WeakMap", "WeakSet", "Array"]);
const findings = [];

const line = (source, node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;

for (const file of files) {
	const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
	for (const statement of source.statements) {
		if (ts.isVariableStatement(statement)) {
			const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
			if (!isConst) {
				findings.push(`${file}:${line(source, statement)} top-level let/var`);
				continue;
			}
			for (const decl of statement.declarationList.declarations) {
				if (
					decl.initializer &&
					ts.isNewExpression(decl.initializer) &&
					MUTABLE_CONSTRUCTORS.has(decl.initializer.expression.getText(source))
				) {
					findings.push(`${file}:${line(source, decl)} top-level mutable container: ${decl.name.getText(source)}`);
				}
			}
		} else if (ts.isClassDeclaration(statement)) {
			for (const member of statement.members) {
				if (
					ts.isPropertyDeclaration(member) &&
					member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)
				) {
					findings.push(`${file}:${line(source, member)} static class property: ${member.name.getText(source)}`);
				}
			}
		}
	}
}

if (findings.length > 0) {
	console.error(
		"module-state gate: mutable module-scope state survives pi's factory cache across /new, fork, and resume.",
	);
	for (const finding of findings) console.error(`  ${finding}`);
	process.exit(1);
}
console.log(`module-state gate: ${files.length} root modules clean`);
