import { describe, expect, it } from "vitest";
import { HeadRegistry } from "./heads";
import type { HeadRegistryGateway } from "./heads";

const USER_DIR = "/home/u/.pi/agent/hydra";
const PROJECT_DIR = "/repo/.pi/hydra";

function headFile(name: string, extra = ""): string {
	return `---\nname: ${name}\ndescription: ${name} lens\n${extra}---\nWatch for ${name} problems.`;
}

interface HarnessOptions {
	user?: Record<string, string>;
	project?: Record<string, string>;
	/** Directories whose readdir throws instead of listing. */
	unreadable?: Record<string, NodeJS.ErrnoException>;
}

// One fake gateway standing in for the file system and every pi effect, in
// the delivery.test.ts mold.
function createHarness(options: HarnessOptions = {}) {
	const files = new Map<string, string>();
	for (const [name, content] of Object.entries(options.user ?? {})) files.set(`${USER_DIR}/${name}`, content);
	for (const [name, content] of Object.entries(options.project ?? {})) files.set(`${PROJECT_DIR}/${name}`, content);
	const announced: string[] = [];
	const notified: string[] = [];
	const warnedOnce: string[] = [];
	const persisted: string[][] = [];
	let footerRefreshes = 0;

	const listDir = (dir: string) =>
		[...files.keys()].filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1));

	const gateway: HeadRegistryGateway = {
		readDir: (dir) => {
			const failure = options.unreadable?.[dir];
			if (failure) throw failure;
			const entries = listDir(dir);
			if (entries.length === 0) {
				const error = new Error(`ENOENT: no such directory ${dir}`) as NodeJS.ErrnoException;
				error.code = "ENOENT";
				throw error;
			}
			return entries;
		},
		readFile: (path) => {
			const content = files.get(path);
			if (content === undefined) throw new Error(`missing ${path}`);
			return content;
		},
		isDirectory: (path) => path === PROJECT_DIR && listDir(PROJECT_DIR).length > 0,
		announce: (message) => announced.push(message),
		notify: (message, level) => notified.push(`${level}: ${message}`),
		warnOnce: (message) => warnedOnce.push(message),
		persistConfig: (heads) => persisted.push([...heads]),
		onActiveSetChanged: () => {
			footerRefreshes++;
		},
	};

	return {
		gateway,
		files,
		announced,
		notified,
		warnedOnce,
		persisted,
		footer: () => footerRefreshes,
		registry: new HeadRegistry(USER_DIR),
	};
}

describe("head discovery", () => {
	it("shadows a same-named user head with the project head and announces both facts once", () => {
		const h = createHarness({
			user: { "quality.md": headFile("quality"), "security.md": headFile("security") },
			project: { "quality.md": headFile("quality") },
		});
		h.registry.discover(h.gateway, "/repo/src");
		expect(h.registry.get("quality")?.source).toBe("project");
		expect(h.registry.get("security")?.source).toBe("user");
		expect(h.announced).toEqual([`hydra: project heads from ${PROJECT_DIR}: quality`]);
		expect(h.notified).toEqual([`warning: hydra: project head shadows your user head: quality`]);

		// Rediscovery runs at every agent_start and tool call; the same result
		// must stay silent.
		h.registry.discover(h.gateway, "/repo/src");
		expect(h.announced).toHaveLength(1);
		expect(h.notified).toHaveLength(1);
	});

	it("re-announces when the discovery result actually changes", () => {
		const h = createHarness({ project: { "quality.md": headFile("quality") } });
		h.registry.discover(h.gateway, "/repo/src");
		h.files.set(`${PROJECT_DIR}/perf.md`, headFile("perf"));
		h.registry.discover(h.gateway, "/repo/src");
		expect(h.announced).toEqual([
			`hydra: project heads from ${PROJECT_DIR}: quality`,
			`hydra: project heads from ${PROJECT_DIR}: perf, quality`,
		]);
	});

	it("drops a vanished head from the active set and signals the change", () => {
		const h = createHarness({ user: { "quality.md": headFile("quality"), "security.md": headFile("security") } });
		h.registry.discover(h.gateway, "/repo");
		h.registry.setHeadSet(h.gateway, ["quality", "security"]);
		const footerBefore = h.footer();

		h.files.delete(`${USER_DIR}/security.md`);
		h.registry.discover(h.gateway, "/repo");
		expect(h.registry.activeSet()).toEqual(["quality"]);
		expect(h.notified).toContain("warning: hydra: head file gone, deactivating: security");
		expect(h.footer()).toBe(footerBefore + 1);
	});

	it("warns about an unreadable head dir but stays silent about an absent one", () => {
		const denied = new Error("EACCES") as NodeJS.ErrnoException;
		denied.code = "EACCES";
		const h = createHarness({ unreadable: { [USER_DIR]: denied } });
		h.registry.discover(h.gateway, "/repo");
		expect(h.warnedOnce).toEqual([`hydra: cannot read head dir ${USER_DIR}: EACCES`]);

		const clean = createHarness();
		clean.registry.discover(clean.gateway, "/repo");
		expect(clean.warnedOnce).toEqual([]);
	});

	it("skips reserved diagnostic names, malformed files, and non-markdown entries", () => {
		const h = createHarness({
			user: {
				"test.md": headFile("test"),
				"broken.md": "no frontmatter here",
				"notes.txt": headFile("notes"),
				"quality.md": headFile("quality"),
			},
		});
		h.registry.discover(h.gateway, "/repo");
		expect(h.registry.names()).toEqual(["quality"]);
		expect(h.warnedOnce).toEqual([
			`hydra: skipping ${USER_DIR}/broken.md: no frontmatter (name: and description: are required)`,
			`hydra: skipping ${USER_DIR}/test.md: "test" is a reserved diagnostic name`,
		]);
	});

	it("warns about tools hydra cannot execute without dropping the head", () => {
		const h = createHarness({ user: { "quality.md": headFile("quality", "tools: read, telepathy\n") } });
		h.registry.discover(h.gateway, "/repo");
		expect(h.registry.get("quality")).toBeDefined();
		expect(h.warnedOnce[0]).toContain("lists tools hydra cannot execute: telepathy");
	});
});

describe("active set", () => {
	function seeded() {
		const h = createHarness({
			user: {
				"quality.md": headFile("quality"),
				"security.md": headFile("security"),
				"auto.md": headFile("auto", "autostart: true\n"),
			},
		});
		h.registry.discover(h.gateway, "/repo");
		return h;
	}

	it("refuses to empty the set by accident but clears it deliberately", () => {
		const h = seeded();
		h.registry.setHeadSet(h.gateway, ["quality"]);
		expect(h.registry.setHeadSet(h.gateway, ["typo"])).toBe(false);
		expect(h.registry.activeSet()).toEqual(["quality"]);
		expect(h.notified).toContain("warning: hydra: unknown head: typo. available: auto, quality, security");

		h.registry.clearHeadSet(h.gateway);
		expect(h.registry.activeSet()).toEqual([]);
		expect(h.persisted.at(-1)).toEqual([]);
	});

	it("collapses to a single diagnostic and restores the product set after it fires", () => {
		const h = seeded();
		h.registry.setHeadSet(h.gateway, ["quality", "security"]);
		h.registry.setHeadSet(h.gateway, ["test", "quality"]);
		expect(h.registry.activeSet()).toEqual(["test"]);

		h.registry.revertDiagnosticAfterFire(h.gateway, "test");
		expect(h.registry.activeSet()).toEqual(["quality", "security"]);
		expect(h.announced.at(-1)).toBe('hydra: diagnostic head "test" fired once; reverting to quality+security');
	});

	it("leaves a product head alone and keeps a diagnostic that shares the set", () => {
		const h = seeded();
		h.registry.setHeadSet(h.gateway, ["quality"]);
		h.registry.revertDiagnosticAfterFire(h.gateway, "quality");
		expect(h.registry.activeSet()).toEqual(["quality"]);
	});

	it("reports a diagnostic's allowance as judge-only and a plain head's as its file says", () => {
		const h = createHarness({ user: { "quality.md": headFile("quality", "tools: read\n") } });
		h.registry.discover(h.gateway, "/repo");
		expect(h.registry.headTools("test")).toEqual([]);
		expect(h.registry.headTools("quality")).toEqual(["read"]);
		expect(h.registry.headTools("missing")).toBeUndefined();
	});

	it("applies a saved set, respects a deliberately empty one, and warns about vanished names", () => {
		const h = seeded();
		h.registry.applyConfig(h.gateway, { heads: ["quality", "ghost"] });
		expect(h.registry.activeSet()).toEqual(["quality"]);
		expect(h.notified).toContain("warning: hydra: saved head no longer exists: ghost");

		h.registry.applyConfig(h.gateway, { heads: [] });
		expect(h.registry.activeSet()).toEqual([]);
	});

	it("reads the pre-rename lens fields from old sessions", () => {
		const h = seeded();
		h.registry.applyConfig(h.gateway, { lens: "quality" } as never);
		expect(h.registry.activeSet()).toEqual(["quality"]);
		h.registry.applyConfig(h.gateway, { lenses: ["security"] } as never);
		expect(h.registry.activeSet()).toEqual(["security"]);
	});

	it("keeps the current set when a config carries no head field at all", () => {
		const h = seeded();
		h.registry.setHeadSet(h.gateway, ["quality"]);
		h.registry.applyConfig(h.gateway, {} as never);
		expect(h.registry.activeSet()).toEqual(["quality"]);
	});

	it("seeds from autostart without persisting, so tomorrow reads tomorrow's files", () => {
		const h = seeded();
		h.registry.applyAutostart();
		expect(h.registry.activeSet()).toEqual(["auto"]);
		expect(h.persisted).toEqual([]);
	});

	// The session_start composition: a saved set beats autostart, and an
	// explicit flag beats both. The wiring sequences these primitives.
	it("composes saved over autostart and flag over saved", () => {
		const saved = seeded();
		saved.registry.applyConfig(saved.gateway, { heads: ["quality"] });
		expect(saved.registry.activeSet()).toEqual(["quality"]);

		const flagged = seeded();
		flagged.registry.applyConfig(flagged.gateway, { heads: ["quality"] });
		flagged.registry.setHeadSet(flagged.gateway, ["security"]);
		expect(flagged.registry.activeSet()).toEqual(["security"]);

		const cold = seeded();
		cold.registry.applyAutostart();
		expect(cold.registry.activeSet()).toEqual(["auto"]);
	});
});
