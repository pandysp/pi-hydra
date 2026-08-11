import { describe, expect, it } from "vitest";
import { HeadScheduler } from "./scheduler";
import type { SchedulerHooks } from "./scheduler";

interface Seed {
	head: string;
	tag: string;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// Every observation blocks until the test settles it by tag, so conflation
// and lifecycle become fully deterministic.
function createHarness(shouldRun: (seed: Seed) => boolean = () => true) {
	const observed: string[] = [];
	const errors: string[] = [];
	const signals: AbortSignal[] = [];
	const pending = new Map<string, { resolve: () => void; reject: (error: unknown) => void }>();
	const hooks: SchedulerHooks<Seed> = {
		shouldRun,
		observe: (seed, signal) => {
			observed.push(seed.tag);
			signals.push(signal);
			return new Promise<void>((resolve, reject) => {
				pending.set(seed.tag, { resolve, reject });
			});
		},
		onError: (seed, error) => {
			errors.push(`${seed.tag}: ${error instanceof Error ? error.message : String(error)}`);
		},
	};
	return { observed, errors, signals, pending, scheduler: new HeadScheduler<Seed>(hooks) };
}

describe("head scheduler", () => {
	it("keeps one observation in flight per head and conflates to the newest snapshot", async () => {
		const h = createHarness();
		h.scheduler.schedule({ head: "a", tag: "a1" });
		await tick();
		expect(h.observed).toEqual(["a1"]);
		h.scheduler.schedule({ head: "a", tag: "a2" });
		h.scheduler.schedule({ head: "a", tag: "a3" });
		await tick();
		expect(h.observed).toEqual(["a1"]);
		h.pending.get("a1")?.resolve();
		await tick();
		expect(h.observed).toEqual(["a1", "a3"]);
		h.pending.get("a3")?.resolve();
	});

	it("runs heads in parallel with each other", async () => {
		const h = createHarness();
		h.scheduler.schedule({ head: "a", tag: "a1" });
		h.scheduler.schedule({ head: "b", tag: "b1" });
		await tick();
		expect(h.observed).toEqual(["a1", "b1"]);
		h.pending.get("a1")?.resolve();
		h.pending.get("b1")?.resolve();
	});

	it("re-checks the predicate at execution time and skips stale seeds", async () => {
		const h = createHarness((seed) => !seed.tag.startsWith("stale"));
		h.scheduler.schedule({ head: "a", tag: "stale-1" });
		await tick();
		expect(h.observed).toEqual([]);
		h.scheduler.schedule({ head: "a", tag: "a1" });
		await tick();
		expect(h.observed).toEqual(["a1"]);
		h.pending.get("a1")?.resolve();
	});

	it("contains an observation failure to its head and keeps observing", async () => {
		const h = createHarness();
		h.scheduler.schedule({ head: "a", tag: "a1" });
		await tick();
		h.pending.get("a1")?.reject(new Error("provider down"));
		await tick();
		expect(h.errors).toEqual(["a1: provider down"]);
		h.scheduler.schedule({ head: "a", tag: "a2" });
		await tick();
		expect(h.observed).toEqual(["a1", "a2"]);
		h.pending.get("a2")?.resolve();
	});

	it("shutdown waits at most the grace for in-flight work, then aborts", async () => {
		const h = createHarness();
		h.scheduler.schedule({ head: "a", tag: "a1" });
		await tick();
		await h.scheduler.shutdown(25);
		expect(h.signals[0].aborted).toBe(true);
	});

	it("shutdown aborts immediately when nothing is in flight", async () => {
		const h = createHarness();
		// A grace far beyond the test timeout proves shutdown does not wait it out.
		await h.scheduler.shutdown(60_000);
		h.scheduler.schedule({ head: "a", tag: "late" });
		await tick();
		expect(h.observed).toEqual([]);
	});

	// The reporter is the headless stderr fallback, which can fail (EPIPE) at
	// exactly the moment observations are failing. schedule() leaves the
	// runner promise floating, so a throw there would land as an unhandled
	// rejection and take the process down before shutdown finishes.
	it("survives a reporter that throws and still aborts on shutdown", async () => {
		const signals: AbortSignal[] = [];
		let settle: (() => void) | undefined;
		const scheduler = new HeadScheduler<Seed>({
			shouldRun: () => true,
			observe: (_seed, signal) => {
				signals.push(signal);
				return new Promise<void>((_resolve, reject) => {
					settle = () => reject(new Error("provider down"));
				});
			},
			onError: () => {
				throw new Error("stderr closed");
			},
		});
		scheduler.schedule({ head: "a", tag: "a1" });
		await tick();
		settle?.();
		await tick();

		// The failed run does not gate the head: it observes again.
		scheduler.schedule({ head: "a", tag: "a2" });
		await tick();
		expect(signals).toHaveLength(2);

		await scheduler.shutdown(10);
		expect(signals[1].aborted).toBe(true);
	});

	it("reports no error for a failure that races the abort", async () => {
		const h = createHarness();
		h.scheduler.schedule({ head: "a", tag: "a1" });
		await tick();
		const done = h.scheduler.shutdown(10);
		await done;
		h.pending.get("a1")?.reject(new Error("aborted transport"));
		await tick();
		expect(h.errors).toEqual([]);
	});
});
