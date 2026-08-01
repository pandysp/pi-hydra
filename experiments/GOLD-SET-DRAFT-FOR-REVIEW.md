# Draft severity ranking for review (2026-08-01)

Ten seeded defects across three tasks, drafted in one ranking per task,
1 = "I would most want a reviewer to catch this".

## scheduler
1. sched-lease-caller-clock  [security]  — a worker sends a far-future
   expiry and holds a job FOREVER; no sweep can ever reclaim it. Remote
   input controls a resource lease: permanent loss, attacker-triggerable.
2. sched-claim-toctou  [correctness] — two workers claim and RUN the same
   job. Duplicate execution of arbitrary work; the classic race.
3. sched-expired-keeps-claim [correctness] — swept jobs keep the dead
   worker's claim, so they are never picked up again. Silent stall of
   recovered work; bad, but no duplicate side effects.
4. sched-requeue-resets-attempts [resource] — failing jobs retry forever
   and never retire. Wasteful and noisy; bounded blast radius.

## exporter
1. exp-offset-drift [correctness] — records silently DUPLICATED OR
   SKIPPED in the export. Wrong data leaves the system and nobody sees it.
2. exp-unbounded-page-size [resource] — one request pulls the whole order
   table into memory. Trivially remote-triggerable OOM.
3. exp-n-plus-one-customer [resource] — one DB round trip per row. Slow
   and expensive, but correct and self-limiting.

## dispatcher
1. retry-no-idempotency-key [correctness] — a retry DOUBLE-CHARGES a
   customer. Money, irreversible, externally visible.
2. retry-swallowed-failure [correctness] — a charge that never succeeded
   is recorded as delivered. Silent data corruption of financial state.
3. retry-retries-client-errors [resource] — 4xx re-sent for the whole
   budget. Load and latency, no incorrect state.

## The judgement calls I made, so you can overrule them

- scheduler: I put the SECURITY lease bug above the TOCTOU race because
  its effect is permanent and attacker-controlled, where the race
  duplicates work that is often idempotent. If your jobs are NOT
  idempotent, swap 1 and 2.
- exporter: silent wrong data (drift) over an OOM, because the OOM is
  loud and the drift is not. If availability matters more than
  correctness here, swap 1 and 2.
- dispatcher: double-charge over false-success, because it moves real
  money outward. Both are severe; a case could be made either way.
- Across tasks I ranked by "worst outcome if it ships", not by
  likelihood, and not by how hard it is to spot.
