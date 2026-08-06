/**
 * Conflating single-slot scheduler, per head: every head has at most one
 * observation in flight and one waiting slot that a newer snapshot
 * overwrites. Observations always run to completion; staleness is bounded
 * to one cycle because the slot always holds the newest snapshot. The
 * granularity is per head (not one global batch) so an acting head's
 * minutes-long tool loop cannot starve the judging heads, and a head busy
 * through a commit point still reviews the newest snapshot when it frees
 * up. session_shutdown awaits the in-flight runs.
 *
 * The scheduler owns conflation and lifecycle only; what an observation IS
 * stays in index.ts, injected through the hooks. It is generic over the
 * seed type so it never depends on engine types (and never imports the
 * entry file).
 */

export interface SchedulerHooks<Seed> {
	/**
	 * Evaluated inside the run loop, immediately before execution, so a
	 * seed scheduled while valid is still skipped once its head is
	 * deactivated or its snapshot is left behind by branch navigation.
	 */
	shouldRun(seed: Seed): boolean;
	/** Runs one observation to completion under the lifecycle signal. */
	observe(seed: Seed, signal: AbortSignal): Promise<void>;
	/** Called when observe rejects while the scheduler is not shutting down. */
	onError(seed: Seed, error: unknown): void;
}

interface HeadRunner<Seed> {
	pending: Seed | null;
	running: Promise<void> | null;
}

export class HeadScheduler<Seed extends { head: string }> {
	private readonly runners = new Map<string, HeadRunner<Seed>>();
	private readonly lifecycleAbort = new AbortController();

	constructor(private readonly hooks: SchedulerHooks<Seed>) {}

	schedule(seed: Seed): void {
		let runner = this.runners.get(seed.head);
		if (!runner) {
			runner = { pending: null, running: null };
			this.runners.set(seed.head, runner);
		}
		runner.pending = seed;
		if (!runner.running) {
			runner.running = this.runHead(runner);
		}
	}

	// Run one head's observations to completion, newest snapshot first
	// (conflating whatever piled up while busy). Heads run in parallel with
	// each other: mid-run they are all pure cache reads; at run-end each fork
	// pays M's write (the measured economics are in docs/architecture.md).
	private async runHead(runner: HeadRunner<Seed>): Promise<void> {
		// Yield once so schedule() stores the running promise before the loop
		// can drain synchronously: a seed skipped at its first pop would
		// otherwise null the slot before the assignment, leaving a settled
		// promise that permanently gates the head.
		await Promise.resolve();
		try {
			while (runner.pending && !this.lifecycleAbort.signal.aborted) {
				const seed = runner.pending;
				runner.pending = null;
				if (!this.hooks.shouldRun(seed)) {
					continue; // deactivated or left behind by branch navigation
				}
				try {
					await this.hooks.observe(seed, this.lifecycleAbort.signal);
				} catch (error) {
					if (!this.lifecycleAbort.signal.aborted) {
						this.hooks.onError(seed, error);
					}
				}
			}
		} finally {
			runner.running = null;
		}
	}

	// Let the in-flight observations finish (bounded by the grace), then
	// cancel; this is the sole lifecycle abort.
	async shutdown(graceMs: number): Promise<void> {
		const running = [...this.runners.values()].flatMap((runner) => runner.running ?? []);
		if (running.length > 0) {
			// Clear the timer once the race settles: a pending timeout keeps
			// the headless process alive for the full grace after the
			// observations already finished.
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<void>((resolve) => {
				timer = setTimeout(resolve, graceMs);
			});
			await Promise.race([Promise.all(running), timeout]);
			clearTimeout(timer);
		}
		this.lifecycleAbort.abort();
	}
}
