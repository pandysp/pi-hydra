# Reference review — scheduler task (2026-08-01)

The independent-discovery stage of the golden dataset
(`GOLDEN-DATASET-DESIGN.md`, Build step 2). A strong reviewer
(claude-opus-5, xhigh, Claude CLI) reads the authored source COLD and
lists every defect it finds. Three independent passes, union taken.

**Blindness, asserted structurally not just intended:** the prompt is
built from `task.files` only; `task.defects` is never read by the
builder, and the runner throws if any planted target text appears in the
rendered prompt (`reference-review.mjs`). No observer message, no prior
results doc, no planted list reached the reviewer.

**Scope:** the SEEDED state, not the driver's mid-run damage. The golden
set is per-task and stable; damage a driver inflicts during one run
("two edits corrupted braces") is per-run and belongs to the bonus
category by construction.

Artifacts: `experiments/artifacts/2026-08-01-reference-review/`.
Zero producer spend (subscription reviewer).

## Passes and overlap

| pass | defect lines | duration |
|---|---:|---:|
| 1 | 35 | 196s |
| 2 | 32 | 198s |
| 3 | 26 | 177s |
| raw union | 93 | — |
| **distinct after dedup** | **44** | — |

Agreement across passes: **19 found by all three, 10 by exactly two, 15
by only one.** A single pass would have missed roughly **30%** of the
distinct defects. Multi-pass is not belt-and-braces here; it is load
bearing.

## Result 1 — the blind spot is large: 40 of 44 are new

**40 distinct defects are in NEITHER the planted list NOR the 21-issue
observer pool.** The arm-seeded pool plus planting captured a small
fraction of what is actually in this code.

The strongest (found by all three passes), verbatim:

- The dead-letter path is unwired: `isExhausted` is never called and
  `store.dead` is never written or read, so `MAX_ATTEMPTS` is inert.
- `sweepExpired` computes the expired list before any `await` and writes
  those stale snapshots in the loop, clobbering a job completed during
  the sweep.
- `requeue` writes back the claim-time snapshot rather than a fresh read,
  silently reverting any lease renewal or sweep that landed meanwhile.
- `runOnce` awaits the handler without ever calling `renewLease`, so any
  handler outliving `LEASE_MS` has its job swept and re-claimed while it
  is still executing.
- `requeue` reads `error.message` unguarded, so a non-Error throw yields
  `lastError: undefined` and a null/undefined throw raises a TypeError
  inside the catch block.
- `complete` never deletes the entry, so finished jobs accumulate forever.
- `putJob` stores the caller's object by reference while `saveJob`
  copies; `getJob`/`listJobs` return live references, so callers can
  mutate persisted state in place.
- No test covers store, scheduler or worker — all claim, lease, sweep and
  retry logic is untested.

**Caveat on the number 40.** It is raw discovery, not severity-weighted.
Several are minor (`formatDuration` rounding, `pluralize` unused, a
missing hours unit). Tiering them is exactly what the consensus protocol
adds; until then "40 novel defects" must not be read as "40 blocking
issues".

## Result 2 — the reference review is NOT complete either: it missed a planted defect

**Planted defects found: 3 of 4. Missed: `sched-lease-caller-clock`** —
the same defect no observer arm described.

That is the finding to carry, and it cuts against this stage's own
value: the lease-clock defect was found by exactly ONE of the three
possible discovery mechanisms (planting), not by the arms and not by
three independent blind passes.

**The miss is subtler than a plain miss, and the nuance matters for the
golden set.** All three passes DID flag the same line as dangerous:

> `renewLease` gives `now` no default (unlike `sweepExpired`), so a
> caller omitting it stores `leaseExpiresAt: NaN`, and `NaN < now` being
> false the job is never swept.

Same line, same consequence (job pinned forever, never reclaimed),
**different trigger**: omission producing NaN, versus a caller supplying
a hostile far-future value. The matcher judged those different root
causes and scored it a miss. Defensible — but it exposes an open
question the consensus protocol must rule on: **how finely are defects
individuated?** Same line + same consequence + different input is a
boundary case, and where that line falls changes recall numbers for
every arm.

No pass mentioned a far-future or attacker-supplied timestamp anywhere.

## What this stage can and cannot guarantee

CAN: find defects that every observer arm missed — 40 of them here,
which is the measured size of the blind spot a golden set built from
arms plus planting alone would have carried.

CANNOT: guarantee completeness. It missed a planted defect across three
passes. Any claim that the golden set is exhaustive is unsupported by
this evidence, and the set should be treated as a growing floor (via
promotion) rather than a ceiling.

CANNOT: rank or tier. Severity is deliberately not asked for here —
asking would anchor the consensus protocol on one model's opinion.

## Consequences for the golden dataset

1. Keep all three discovery mechanisms. Each caught something the others
   did not; none is redundant, and none is sufficient.
2. Run the reference review multi-pass. One pass loses ~30%.
3. The 44 reference defects join planted + observer pool as candidates
   for the consensus protocol, which assigns `blocking` / `harmful` and
   settles the individuation question above.
4. Re-run the reference review when a task's code changes, not per run —
   it reviews the seeded state, which is stable.
