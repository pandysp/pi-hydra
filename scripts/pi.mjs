#!/usr/bin/env node
// Starts Pi with this clone's Hydra in place of the installed one, and with
// every other extension you have. Pi runs in a new folder, removed when Pi
// ends, whose .pi/settings.json turns the installed Hydra off and adds this
// clone; a project entry replaces the user entry for the same package.
// Arguments go to Pi: npm run pi -- --model openai-codex/gpt-5.5
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const clone = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const agentDir = resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));

function fail(message) {
	console.error(`npm run pi: ${message}`);
	process.exit(1);
}

function isHydra(dir) {
	const manifest = join(dir, "package.json");
	return existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "pi-hydra";
}

// Only a package entry can be swapped this way.
const extensionsDir = join(agentDir, "extensions");
for (const name of existsSync(extensionsDir) ? readdirSync(extensionsDir) : []) {
	const path = join(extensionsDir, name);
	if (existsSync(path) && isHydra(realpathSync(path))) {
		fail(`Hydra is linked as ${path}. Install it as a package instead:\n  rm ${path} && pi install ${realpathSync(path)}`);
	}
}

const remote = (source) => /^(npm:|git:|https?:|ssh:|git@)/.test(source);
const settingsFile = join(agentDir, "settings.json");
const packages = existsSync(settingsFile) ? (JSON.parse(readFileSync(settingsFile, "utf8")).packages ?? []) : [];
// Every installed Hydra but this clone, local paths made absolute since the
// project file sits elsewhere. This clone's own entry replaces its user entry.
const replaced = packages
	.map((entry) => (typeof entry === "string" ? entry : entry.source))
	.map((source) => (remote(source) ? source : resolve(agentDir, source)))
	.filter((source) =>
		source.startsWith("npm:") ? /^npm:pi-hydra(@|$)/.test(source)
		: remote(source) ? /\/pi-hydra(\.git)?(@[^/]*)?$/.test(source)
		: existsSync(source) && isHydra(source) && realpathSync(source) !== clone,
	);
const folder = mkdtempSync(join(tmpdir(), "pi-hydra-"));
mkdirSync(join(folder, ".pi"));
writeFileSync(
	join(folder, ".pi", "settings.json"),
	JSON.stringify({ packages: [...replaced.map((source) => ({ source, extensions: [] })), clone] }, null, 2) + "\n",
);
console.error(`npm run pi: Pi starts in ${folder} with Hydra from ${clone}${replaced.length > 0 ? `, in place of ${replaced.join(", ")}` : ""}.`);

// Your own pi, not the copy npm puts first in PATH for this repository's tests.
const PATH = process.env.PATH.split(":").filter((dir) => !dir.endsWith("/node_modules/.bin")).join(":");
const pi = spawnSync("pi", ["--approve", ...process.argv.slice(2)], { cwd: folder, stdio: "inherit", env: { ...process.env, PATH } });
rmSync(folder, { recursive: true });
if (pi.error) fail(`could not start pi: ${pi.error.message}`);
process.exit(pi.status ?? 1);
