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
import { EXECUTABLE_TOOL_NAMES, parseHeadFile, sanitizeHeadSet, savedAddedHeads, savedHeadList } from "./utils.ts";
import type { AddedHead, HeadDefinition, HydraConfig } from "./utils.ts";

// Diagnostic heads force a fixed decision so the delivery pipeline can be
// smoke-tested end-to-end. Accepted by /hydra-heads but hidden from its
// completions and the picker.
export const DIAGNOSTIC_PROMPTS = {
	test: `<system-reminder>Developer integration test for the hydra framework. This is not a real review. Call the hydra tool exactly once with action "complete_observation", delivery "steer", and message "hydra test head fired (e2e pipeline verified)". Do nothing else.</system-reminder>`,
} as const;

// "call" is a head added by a hydra call without a file. It exists only while
// it is active; the saved config is what brings it back on resume.
export type DiscoveredHead = HeadDefinition & { source: "user" | "project" | "call" };


export interface HeadRegistryGateway {
	/** readdirSync semantics: throws, with the error's `code` preserved. */
	readDir(dir: string): string[];
	readFile(path: string): string;
	isDirectory(path: string): boolean;
	/** ui.notify info: consented informational notices, a headless no-op. */
	announce(message: string): void;
	/** Warning/error with the headless stderr fallback. */
	notify(message: string, level: "warning" | "error"): void;
	/** Tells the main assistant on a head's behalf, as that head's steer would. */
	steer(head: string, message: string): void;
	/** Deduped warning; the dedup set is shared with the engine in index.ts. */
	warnOnce(message: string): void;
	persistConfig(config: HydraConfig): void;
	/** The active set changed; index.ts refreshes the footer. */
	onActiveSetChanged(): void;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class HeadRegistry {
	private heads = new Map<string, DiscoveredHead>();
	// What add calls said about active heads: instructions for a head without
	// a file, an end condition, or both. Entries leave with their head.
	private added = new Map<string, AddedHead>();
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
			// An entry outside EXECUTABLE_TOOL_NAMES can never run, so discovery
			// warns about it; the head still loads, since the rest of its list works.
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
		for (const name of this.added.keys()) {
			if (this.added.get(name)?.withoutFile && merged.has(name)) {
				gateway.warnOnce(`hydra: head file "${name}" is ignored while the head of that name added without a file is active`);
			}
		}

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
			this.activeHeads = pruned;
			gateway.onActiveSetChanged();
			for (const name of dropped) {
				gateway.steer(name, "this head's file is missing or invalid, so it is no longer active.");
			}
		}
	}

	exists(name: string): boolean {
		return this.heads.has(name) || this.withoutFile(name) !== undefined || name in DIAGNOSTIC_PROMPTS;
	}

	names(): string[] {
		const withoutFile = [...this.added.keys()].filter((name) => this.withoutFile(name) !== undefined);
		return [...new Set([...this.heads.keys(), ...withoutFile])].sort();
	}

	// A head added without a file wins over a file that appears later under
	// its name, until it leaves the active set.
	get(name: string): DiscoveredHead | undefined {
		return this.withoutFile(name) ?? this.heads.get(name);
	}

	private withoutFile(name: string): DiscoveredHead | undefined {
		const call = this.added.get(name)?.withoutFile;
		if (!call) return undefined;
		const firstLine = call.instructions.split("\n")[0];
		return {
			name,
			description: `no file: ${firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine}`,
			tools: call.tools,
			prompt: call.instructions,
			source: "call",
		};
	}

	list(): DiscoveredHead[] {
		return this.names().map((name) => this.get(name)).filter((head): head is DiscoveredHead => head !== undefined);
	}

	/** The condition after which this active head ends itself, if it has one. */
	endsWhen(name: string): string | undefined {
		return this.added.get(name)?.endsWhen;
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
		return this.get(name)?.tools;
	}

	// Records the last set that had no diagnostic head in it, which is what a
	// diagnostic reverts to after firing once. Deliberate set changes come
	// through here. Two paths do not: discovery, which prunes both lists
	// itself when a head file disappears, and the diagnostic revert, which
	// reads productHeads back into the active set.
	private adoptHeadSet(headsList: string[]) {
		this.activeHeads = headsList;
		if (!headsList.some((name) => name in DIAGNOSTIC_PROMPTS)) {
			this.productHeads = headsList;
		}
		// What an add call said lives only while its head is in the set (or
		// waits behind a diagnostic to come back).
		const kept = new Set([...this.activeHeads, ...this.productHeads]);
		for (const name of [...this.added.keys()]) {
			if (!kept.has(name)) this.added.delete(name);
		}
	}

	private savedConfig(): HydraConfig {
		const added = this.activeHeads.filter((name) => this.added.has(name));
		return added.length === 0
			? { heads: this.activeHeads }
			: { heads: this.activeHeads, added: Object.fromEntries(added.map((name) => [name, this.added.get(name) as AddedHead])) };
	}

	/**
	 * Activates one head as an add call describes it. The caller has already
	 * checked the call against the rules (names, lifetimes, active state).
	 */
	addHead(gateway: HeadRegistryGateway, name: string, added: AddedHead) {
		this.added.set(name, added);
		if (!this.setHeadSet(gateway, [...this.activeHeads, name])) {
			throw new Error(`hydra: could not activate "${name}"`);
		}
	}

	// Every user-facing surface routes through here: the flag, the picker, the
	// command and the hydra tool. Returns false when nothing usable was asked
	// for, and leaves the current set alone, so a typo cannot silently turn
	// hydra off.
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
		gateway.persistConfig(this.savedConfig());
		gateway.onActiveSetChanged();
		return true;
	}

	/** Takes one head out of the active set; removing the last one empties it on purpose. */
	removeHead(gateway: HeadRegistryGateway, name: string) {
		const remaining = this.activeHeads.filter((active) => active !== name);
		if (remaining.length > 0) {
			this.setHeadSet(gateway, remaining);
		} else {
			this.clearHeadSet(gateway);
		}
	}

	// The deliberate "observe nothing" state; distinct from setHeadSet, which
	// refuses to empty the set by accident (e.g. a typo'd name).
	clearHeadSet(gateway: HeadRegistryGateway) {
		this.adoptHeadSet([]);
		gateway.persistConfig(this.savedConfig());
		gateway.onActiveSetChanged();
	}

	applyConfig(gateway: HeadRegistryGateway, config: HydraConfig) {
		const saved = savedHeadList(config);
		if (saved === null) {
			return;
		}
		const { added, damaged } = savedAddedHeads(config);
		if (damaged.length > 0) {
			gateway.notify(`hydra: saved head is damaged and was not restored: ${damaged.join(", ")}`, "warning");
		}
		this.added = new Map(Object.entries(added));
		const next = sanitizeHeadSet(saved.filter((name) => !damaged.includes(name)), this.catalog);
		if (next.unknown.length > 0) {
			gateway.notify(`hydra: saved head no longer exists: ${next.unknown.join(", ")}`, "warning");
		}
		this.adoptHeadSet(next.heads);
	}

	/**
	 * Another point in the conversation starts from no heads; its saved set or
	 * the launch default is applied after. Nothing of the branch left behind
	 * survives, not even when what follows matches no head.
	 */
	resetForBranch() {
		this.adoptHeadSet([]);
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

	// Diagnostic heads are one-shot: revert before routing, otherwise their
	// steer re-triggers itself forever (a steer sent while idle starts a run
	// whose run-end observation would steer again).
	revertDiagnosticAfterFire(gateway: HeadRegistryGateway, head: string) {
		if (head in DIAGNOSTIC_PROMPTS && this.activeHeads.length === 1 && this.activeHeads[0] === head) {
			this.activeHeads = this.productHeads;
			gateway.persistConfig(this.savedConfig());
			gateway.announce(
				`hydra: diagnostic head "${head}" fired once; reverting to ${this.productHeads.join("+") || "no heads"}`,
			);
		}
	}
}
