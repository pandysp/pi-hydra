/**
 * The head registry: which heads exist and which are active.
 *
 * Heads: one markdown file per head, name and capabilities in the
 * frontmatter, instruction in the body. Two directories, re-read at every
 * agent_start and hydra tool call so edits apply to the next observation
 * without a reload. A project head shadows a same-named user head; both
 * loads are announced, since project files are repo-controlled prompts
 * (consented through pi's folder trust, like everything else in .pi/).
 *
 * The registry owns the head map and the active set; pi effects (file
 * system, messaging, config persistence, the footer refresh) sit behind
 * the gateway, built per call in index.ts.
 */
import { dirname, join } from "node:path";
import { parseHeadFile, sanitizeHeadSet, savedHeadList } from "./utils";
import type { HeadDefinition, HydraConfig } from "./utils";

// Diagnostic heads force a fixed decision so the delivery pipeline can be
// smoke-tested end-to-end. Accepted by /hydra-heads but hidden from its
// completions and the picker.
export const DIAGNOSTIC_PROMPTS = {
	test: `<system-reminder>Developer integration test for the hydra framework. This is not a real review. Call the hydra tool exactly once with action "complete_observation", delivery "steer", and message "hydra test head fired (e2e pipeline verified)". Do nothing else.</system-reminder>`,
	"test-interrupt": `<system-reminder>Developer integration test for hydra's interrupt path. Call the hydra tool exactly once with action "complete_observation", delivery "interrupt", and message "hydra interrupt fired; if you see this in your context, interrupt delivery works". Do nothing else.</system-reminder>`,
} as const;

// What hydra can execute for a head: the seven standard tools plus its own.
// A `tools:` entry outside this set can never run (hydra has no execute for
// other extensions' tools or MCP), so discovery warns about it; the head
// still loads, since the rest of its list works.
const EXECUTABLE_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls", "hydra"];

export type DiscoveredHead = HeadDefinition & { source: "user" | "project" };

export interface HeadRegistryGateway {
	/** readdirSync semantics: throws, with the error's `code` preserved. */
	readDir(dir: string): string[];
	readFile(path: string): string;
	isDirectory(path: string): boolean;
	/** ui.notify info: consented informational notices, a headless no-op. */
	announce(message: string): void;
	/** Warning/error with the headless stderr fallback. */
	notify(message: string, level: "warning" | "error"): void;
	/** Deduped warning; the dedup set is shared with the engine in index.ts. */
	warnOnce(message: string): void;
	persistConfig(heads: string[]): void;
	/** The active set changed; index.ts refreshes the footer. */
	onActiveSetChanged(): void;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class HeadRegistry {
	private heads = new Map<string, DiscoveredHead>();
	// The active head set: one observation fans out per head, in parallel.
	// Either a single diagnostic head or any number of product heads; the
	// two never mix, since the diagnostics' one-shot revert restores
	// productHeads. Empty means hydra observes nothing.
	private activeHeads: string[] = [];
	private productHeads: string[] = [];
	private announcedDiscovery = "";

	private readonly catalog = {
		exists: (name: string) => this.exists(name),
		isDiagnostic: (name: string) => name in DIAGNOSTIC_PROMPTS,
	};

	constructor(private readonly userHeadDir: string) {}

	private findProjectHeadDir(gateway: HeadRegistryGateway, cwd: string): string | null {
		let current = cwd;
		while (true) {
			const candidate = join(current, ".pi", "hydra");
			if (gateway.isDirectory(candidate)) {
				return candidate;
			}
			const parent = dirname(current);
			if (parent === current) {
				return null;
			}
			current = parent;
		}
	}

	private loadHeadsFromDir(
		gateway: HeadRegistryGateway,
		dir: string,
		source: "user" | "project",
	): Map<string, DiscoveredHead> {
		const loaded = new Map<string, DiscoveredHead>();
		let files: string[];
		try {
			// Copy before sorting: the gateway's array is the caller's, not ours.
			files = [...gateway.readDir(dir)].sort();
		} catch (error) {
			// ENOENT means no heads; anything else (EACCES, ENOTDIR) hides
			// real head files and must not read as deliberate emptiness.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				gateway.warnOnce(`hydra: cannot read head dir ${dir}: ${errorText(error)}`);
			}
			return loaded;
		}
		for (const file of files) {
			if (!file.endsWith(".md")) {
				continue;
			}
			let parsed: ReturnType<typeof parseHeadFile>;
			try {
				parsed = parseHeadFile(gateway.readFile(join(dir, file)));
			} catch (error) {
				gateway.warnOnce(`hydra: failed to read ${join(dir, file)}: ${errorText(error)}`);
				continue;
			}
			if ("error" in parsed) {
				gateway.warnOnce(`hydra: skipping ${join(dir, file)}: ${parsed.error}`);
				continue;
			}
			const { head } = parsed;
			if (head.name in DIAGNOSTIC_PROMPTS) {
				gateway.warnOnce(`hydra: skipping ${join(dir, file)}: "${head.name}" is a reserved diagnostic name`);
				continue;
			}
			if (loaded.has(head.name)) {
				gateway.warnOnce(`hydra: duplicate head "${head.name}" in ${dir}; keeping the first file`);
				continue;
			}
			const unexecutable = head.tools?.filter((tool) => !EXECUTABLE_TOOL_NAMES.includes(tool)) ?? [];
			if (unexecutable.length > 0) {
				gateway.warnOnce(
					`hydra: head "${head.name}" lists tools hydra cannot execute: ${unexecutable.join(", ")} (valid: ${EXECUTABLE_TOOL_NAMES.join(", ")})`,
				);
			}
			loaded.set(head.name, { ...head, source });
		}
		return loaded;
	}

	discover(gateway: HeadRegistryGateway, cwd: string): void {
		const merged = this.loadHeadsFromDir(gateway, this.userHeadDir, "user");
		const projectDir = this.findProjectHeadDir(gateway, cwd);
		const project = projectDir
			? this.loadHeadsFromDir(gateway, projectDir, "project")
			: new Map<string, DiscoveredHead>();
		const shadowed: string[] = [];
		for (const [name, head] of project) {
			if (merged.has(name)) {
				shadowed.push(name);
			}
			merged.set(name, head);
		}
		this.heads = merged;

		// Announce project heads once per distinct discovery result, not on
		// every rediscovery (which runs at each agent_start and tool call).
		// Losing the project dir clears the memo, so heads that come back
		// (a branch switch away and back) are announced again rather than
		// loading silently.
		if (project.size > 0 && projectDir) {
			const signature = `${projectDir}|${[...project.keys()].join(",")}|${shadowed.join(",")}`;
			if (signature !== this.announcedDiscovery) {
				this.announcedDiscovery = signature;
				gateway.announce(`hydra: project heads from ${projectDir}: ${[...project.keys()].join(", ")}`);
				if (shadowed.length > 0) {
					gateway.notify(`hydra: project head shadows your user head: ${shadowed.join(", ")}`, "warning");
				}
			}
		} else {
			this.announcedDiscovery = "";
		}

		// A vanished file must not leave a ghost in the active set; dropping
		// it with a notice beats observing with a head that no longer exists.
		// productHeads is pruned unconditionally: while a diagnostic holds the
		// active set nothing active vanishes, but the one-shot revert would
		// otherwise restore a head whose file is gone (observed with an empty
		// instruction and, absent a tools: list, full tool access).
		const pruned = this.activeHeads.filter((name) => this.exists(name));
		this.productHeads = this.productHeads.filter((name) => this.exists(name));
		if (pruned.length !== this.activeHeads.length) {
			const dropped = this.activeHeads.filter((name) => !this.exists(name));
			gateway.notify(`hydra: head file gone, deactivating: ${dropped.join(", ")}`, "warning");
			this.activeHeads = pruned;
			gateway.onActiveSetChanged();
		}
	}

	exists(name: string): boolean {
		return this.heads.has(name) || name in DIAGNOSTIC_PROMPTS;
	}

	names(): string[] {
		return [...this.heads.keys()].sort();
	}

	get(name: string): DiscoveredHead | undefined {
		return this.heads.get(name);
	}

	list(): DiscoveredHead[] {
		return [...this.heads.values()];
	}

	isActive(name: string): boolean {
		return this.activeHeads.includes(name);
	}

	activeSet(): readonly string[] {
		return this.activeHeads;
	}

	// A head's executable allowance: diagnostics never act; a head file's
	// omitted `tools:` means everything, `[]` means judging only.
	headTools(name: string): string[] | undefined {
		if (name in DIAGNOSTIC_PROMPTS) {
			return [];
		}
		return this.heads.get(name)?.tools;
	}

	// The one invariant of set changes: productHeads tracks the last set
	// without a diagnostic, so a diagnostic's one-shot revert has a home.
	private adoptHeadSet(headsList: string[]) {
		this.activeHeads = headsList;
		if (!headsList.some((name) => name in DIAGNOSTIC_PROMPTS)) {
			this.productHeads = headsList;
		}
	}

	// Apply a head set from any surface (command, picker, flag, tool).
	// Returns false when nothing valid was requested; the current set stays.
	setHeadSet(gateway: HeadRegistryGateway, requested: string[]): boolean {
		const next = sanitizeHeadSet(requested, this.catalog);
		if (next.unknown.length > 0) {
			gateway.notify(
				`hydra: unknown head: ${next.unknown.join(", ")}. available: ${this.names().join(", ") || "none"}`,
				"warning",
			);
		}
		if (next.heads.length === 0) {
			return false;
		}
		this.adoptHeadSet(next.heads);
		gateway.persistConfig(this.activeHeads);
		gateway.onActiveSetChanged();
		return true;
	}

	// The deliberate "observe nothing" state; distinct from setHeadSet, which
	// refuses to empty the set by accident (e.g. a typo'd name).
	clearHeadSet(gateway: HeadRegistryGateway) {
		this.adoptHeadSet([]);
		gateway.persistConfig(this.activeHeads);
		gateway.onActiveSetChanged();
	}

	applyConfig(gateway: HeadRegistryGateway, config: HydraConfig) {
		const saved = savedHeadList(config);
		if (saved === null) {
			return;
		}
		if (saved.length === 0) {
			// A deliberately emptied set is respected on restore.
			this.adoptHeadSet([]);
			return;
		}
		const next = sanitizeHeadSet(saved, this.catalog);
		if (next.unknown.length > 0) {
			gateway.notify(`hydra: saved head no longer exists: ${next.unknown.join(", ")}`, "warning");
		}
		if (next.heads.length > 0) {
			this.adoptHeadSet(next.heads);
		}
	}

	// Cold-start default: the heads whose files say autostart. Consulted only
	// when the session has neither a flag nor a saved set, and deliberately
	// not persisted, so tomorrow's session reads tomorrow's files.
	applyAutostart() {
		this.adoptHeadSet(
			[...this.heads.values()]
				.filter((head) => head.autostart)
				.map((head) => head.name)
				.sort(),
		);
	}

	// Diagnostic heads are one-shot: revert before routing, otherwise an
	// interrupt delivery re-triggers itself forever (each injected message
	// starts a run whose run-end observation would interrupt again).
	revertDiagnosticAfterFire(gateway: HeadRegistryGateway, head: string) {
		if (head in DIAGNOSTIC_PROMPTS && this.activeHeads.length === 1 && this.activeHeads[0] === head) {
			this.activeHeads = this.productHeads;
			gateway.persistConfig(this.activeHeads);
			gateway.announce(
				`hydra: diagnostic head "${head}" fired once; reverting to ${this.productHeads.join("+") || "no heads"}`,
			);
		}
	}
}
