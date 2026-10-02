// Installs pi-hydra the way a Flue app does and checks that it works there.
//   node consumer-check.mjs
// Packs this repository, installs the tarball into a fresh app next to the Flue and pi-ai versions
// docs/flue.md documents, type-checks a typed use of the API, and runs a scripted agent whose wrong
// answer a head corrects. Needs the npm registry; makes no model calls.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FLUE = "2.2.2";
const PI_AI = "0.87.1"; // the version Flue 2.2.2 depends on
const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const app = mkdtempSync(join(tmpdir(), "pi-hydra-consumer-"));
const run = (command, args, cwd = app) => execFileSync(command, args, { cwd, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
try {
	run("npm", ["pack", "--silent", "--pack-destination", app], repo);
	const tarball = readdirSync(app).find((name) => name.endsWith(".tgz"));
	writeFileSync(join(app, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
	run("npm", ["install", "--silent", "--no-audit", "--no-fund", `./${tarball}`, `@flue/runtime@${FLUE}`, `@earendil-works/pi-ai@${PI_AI}`, "typescript@5", "@types/node@22"]);
	const installed = run("npm", ["ls", "--all", "--parseable"]);
	if (installed.includes("pi-coding-agent") || installed.includes("pi-tui")) throw new Error("installing pi-hydra pulled pi's own packages into the app");

	writeFileSync(join(app, "head.md"), "---\nname: checker\ndescription: checks the product\ntools: []\n---\nCheck the product.\n");
	writeFileSync(join(app, "types.ts"), `import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { useModel } from "@flue/runtime";
import { start } from "@flue/runtime/node";
import { createFlueHydra, type HydraRecord } from "pi-hydra/flue";
const records: HydraRecord[] = [];
const hydra = createFlueHydra({ heads: ["head.md"], maxRounds: 2, onRecord: (record) => records.push(record) });
function Agent() { useModel("anthropic/claude-opus-5-5"); hydra.useHydra(); return "x"; }
export const boot = () => start({ agents: [Agent], providers: [hydra.wrap(anthropicProvider())] });
`);
	writeFileSync(join(app, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true, types: ["node"] }, files: ["types.ts"] }));
	run("npx", ["tsc", "-p", "tsconfig.json"]);

	writeFileSync(join(app, "app.mjs"), `import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { init, useModel } from "@flue/runtime";
import { start } from "@flue/runtime/node";
import { createFlueHydra } from "pi-hydra/flue";
const faux = fauxProvider({ provider: "test", api: "anthropic-messages", models: [{ id: "m" }] });
let drivers = 0, heads = 0;
faux.setResponses([async function step(context, options, _state, model) {
	faux.appendResponses([step]);
	const params = { model: model.id, messages: context.messages.map((m) => ({ role: m.role === "toolResult" ? "user" : m.role, content: [{ type: "text", text: JSON.stringify(m.content) }] })) };
	const sent = (await options?.onPayload?.(params, model)) ?? params;
	if (JSON.stringify(sent).includes("reviewing the main assistant")) return fauxAssistantMessage(heads++ === 0 ? JSON.stringify({ findings: [{ action: "steer", reason: "r", message: "17 x 23 is 391" }] }) : '{"findings":[]}');
	return fauxAssistantMessage(drivers++ === 0 ? "401" : "391");
}]);
const hydra = createFlueHydra({ heads: ["head.md"] });
function Agent() { useModel("test/m"); hydra.useHydra(); return "Multiply."; }
const flue = await start({ agents: [Agent], providers: [hydra.wrap(faux.provider)] });
const handle = init(Agent);
const reply = await handle.read(await handle.dispatch("17 times 23?"));
await flue.stop();
await hydra.close();
if (!reply.text.endsWith("391") || heads !== 2) throw new Error("expected a steer and a corrected reply, got " + JSON.stringify(reply.text));
`);
	run("node", ["app.mjs"]);
	console.log(`consumer check passed: pi-hydra/flue installs, type-checks and corrects an agent with Flue ${FLUE} and pi-ai ${PI_AI}`);
} finally {
	rmSync(app, { recursive: true, force: true });
}
