/**
 * Each head runs one observation at a time and keeps one waiting slot. A
 * newer snapshot overwrites whatever is waiting, so a head that falls behind
 * jumps straight to the latest state instead of working through a backlog.
 * Observations are never cut short, and session_shutdown waits for the ones
 * already running.
 *
 * Per head rather than one shared queue, so a head grinding through a long
 * tool loop cannot hold up the heads that only need one quick call.
 *
 * This file owns when observations run, not what they are. What an
 * observation does stays in index.ts and arrives through the hooks. It is
 * generic over the seed type so it never depends on engine types, and never
 * imports the entry file.
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

	// Runs one head's observations newest first, skipping whatever piled up
	// while it was busy. Heads run alongside each other rather than one after
	// another. Mid-run that is nearly free, because every head is only reading
	// the cache. At the end of a run each head pays to add the final message
	// once. The numbers are in docs/architecture.md.
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
						// A failing reporter must not kill the runner: schedule()
						// leaves this promise floating, so a throw here would
						// surface as an unhandled rejection (ctx.ui torn down, or
						// EPIPE on the headless stderr fallback) and take the
						// process with it.
						try {
							this.hooks.onError(seed, error);
						} catch {
							// Nothing left to report the failure to.
						}
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
			// observations already finished. allSettled, not all: a rejected
			// runner must not skip the timer clear, the abort, or the caller's
			// own shutdown work (pi's cached observer WebSocket is released
			// after this call returns).
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<void>((resolve) => {
				timer = setTimeout(resolve, graceMs);
			});
			try {
				await Promise.race([Promise.allSettled(running), timeout]);
			} finally {
				clearTimeout(timer);
			}
		}
		this.lifecycleAbort.abort();
	}
}
