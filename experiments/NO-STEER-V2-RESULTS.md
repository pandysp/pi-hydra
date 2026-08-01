# No-steer v2 — results (2026-08-01)

Pre-registered in `NO-STEER-V2-SPEC.md` (612baf0, before data). Instrument
reused unchanged: `experiments/adaptive-skip-probe.mjs` with the variants
from `experiments/no-steer-variants.mjs` (MAIN-NS: 686 chars, −10 vs MAIN;
`steer` absent, `interrupt` retained — asserted before the run). 60 calls,
zero errors, **$1.4716 spent**. Recorded-payload replay only; no judges,
no new producer trajectories.

## M1 POWER — CONFIRMED, decisively

Same cell as v1: `scheduler/opus-high/a1/r1/6`, L=20,165, opus-high,
n=20 per variant (pooled with v1's 10 → n=30).

| variant | skip | mean | raw per-sample reasoning (new n=20) |
|---|---:|---:|---|
| MAIN | 8/20 | 678 | `1410 0 1437 1235 1309 1009 1256 0 0 1587 900 0 0 0 788 0 970 1057 0 608` |
| **MAIN-NS** | **20/20** | **0** | `0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0` |

MAIN-NS emitted **zero reasoning tokens on every one of 20 samples**.

| test | MAIN skips | MAIN-NS skips | Fisher one-sided p |
|---|---:|---:|---:|
| new data only (n=20) | 8/20 | 20/20 | **2.26e-05** |
| **pooled with v1 (n=30)** | **13/30** | **28/30** | **2.68e-05** |
| v1 alone (n=10), for the record | 5/10 | 8/10 | 0.175 |

Pre-registered rule: real iff pooled p < 0.05 AND direction unchanged.
**Both hold. M1 CONFIRMED.** v1's underpowered p=0.175 is superseded.

## M2 TRANSFER — the pre-registered rule does not fire, because of a FLOOR

**Point chosen: `scheduler/opus-high/a1/r2/10`, L=29,565.** Justification,
from the recorded rows: the trajectory's four scripted prompts map to runs
r0–r3; run **r2 is prompt 3** — *"Add a stats(store) function to
src/scheduler.js … and use it in src/worker.js"* — the only run whose task
is purely writing code with no documentation component (r1 is the docs
rewrite v1 used; r3 mixes code and docs). Within r2, the driver's response
to the captured request at this point was an `edit` call, so the driver is
mid-code-edit. This is the cleanest code-writing moment in the trajectory.

| variant | skip | mean | raw per-sample reasoning |
|---|---:|---:|---|
| MAIN | 10/10 | 0 | `0 0 0 0 0 0 0 0 0 0` |
| MAIN-NS | 10/10 | 0 | `0 0 0 0 0 0 0 0 0 0` |

Pre-registered rule: *"the label effect transfers iff MAIN-NS's skip rate
exceeds MAIN's at that prefix too. If MAIN-NS <= MAIN there, the v1 result
is a doc-task artifact."* MAIN-NS (10/10) does **not exceed** MAIN (10/10),
so by the letter **transfer is not demonstrated**.

**But the rule is uninformative in this cell, and saying otherwise would
misreport it.** MAIN is already at a 100% skip floor here: there is no
deliberation for the label to remove. The pre-registration did not
anticipate a cell where the baseline never thinks. So this is **not**
evidence that v1 was a doc-task artifact; it is a cell that cannot
discriminate.

**Why the floor is there is itself informative.** Deliveries at this point:

| variant | none | queue | steer |
|---|---:|---:|---:|
| MAIN | 10 | 0 | **0** |
| MAIN-NS | 3 | 7 | — (label absent) |

**MAIN routed zero steers here.** Under the delivery-type mechanism from
the skip study (steer 0% skip / mean ~1000; queue ~100% skip / mean ~0),
no steer-worthy situation means no thinking, for any contract — which is
exactly what both arms show. M2 is therefore *consistent with* the
mechanism rather than a counterexample to it: the label can only matter
when something steer-worthy is present.

A discriminating transfer test needs a **code-writing moment where MAIN
does think**. In the C1 run MAIN's only thinking points were r1/5 (docs)
and r3/14 (mixed code+docs); across all of run r2 — the pure-code run —
MAIN never thought. That pattern is worth a dedicated test and is **not**
established here.

## Coverage (N2 check) — read, not keyword-matched

Signatures require the MECHANISM, not the identifier, and were audited
against the full text before use. The first TOCTOU signature additionally
demanded a "two workers / same job" phrase and scored MAIN 1/20; reading
all 20 messages showed 4 genuine hits (s1 "read-then-await (racy)",
s2 "awaits saveJob after checking … two concurrent workers", s5 "no CAS
across its await (double-claim)", s17 "the claim path isn't atomic"), so
the signature was relaxed to mechanism-only and re-audited to 4/20.
Accepted wordings are stated below so the counts are auditable.

| cell | variant | defects/sample | delivered | per-defect |
|---|---|---:|---:|---|
| M1 docs | MAIN | 1.45 | 16/20 | toctou 4, stranded-claim 13, attempts-gap 12 |
| M1 docs | **MAIN-NS** | **2.30** | **20/20** | toctou 14, attempts-gap 14, stranded-claim 13, lease-clock 5 |
| M2 code | MAIN | 0.00 | 0/10 | — |
| M2 code | MAIN-NS | 0.30 | 7/10 | lease-clock 3 |

**M1: MAIN-NS thinks zero and names 1.6x more planted defects than MAIN**
(2.30 vs 1.45 per sample), and never goes silent where MAIN produced 4
noops. The v1 direction replicates at n=20. Representative MAIN-NS sample
(s3, **0 reasoning tokens**):

> When writing scheduling.md, describe scheduler.js as-is, including its
> real quirks: claimNext has a read-then-await race (two workers can claim
> the same job), sweepExpired requeues without clearing claimedBy or
> touching attempts, and MAX_ATTEMPTS…

Three planted defects, no deliberation. MAIN's most expensive sample
(s10, 1587 tokens) names two.

**M2: MAIN says nothing at all; MAIN-NS says real things.** MAIN is
10/10 `noop`, its stated reasons being *"stats() implementation is
correct and consistent with sweepExpired; worker.js edit still pending"* —
it judges nothing wrong yet. MAIN-NS delivers on 7/10 with specific,
grounded observations, e.g.:

> stats() lumps sweep-stranded jobs (state=pending, claimedBy set) into
> `pending`, so the summary hides them — the exact failure
> docs/scheduling.md flags.

> a lease of NaN (renewLease called without `now`, per your own doc) fails
> `leaseExpiresAt < now`, so those jobs count as healthy `running` and
> never show as expired.

So removing the label moves **two** things, not one: thinking (M1) and
the **speak/stay-silent threshold** (M2). With `steer` available the model
appears to ask "is this worth interrupting for?" and answers no; with only
`queue` it asks "is anything worth queueing?" and answers yes. Whether the
extra speech is an improvement is **not established here** — see limits.

### Signature wordings accepted (auditable)

- toctou: mentions claim AND one of race/racy/toctou/not atomic/no CAS/
  read-then-await/read-then-write/read-check-await/check-then-await/
  awaits saveJob after/two workers can claim/double-claim.
- stranded-claim: claimedBy AND sweep|expired AND leaves|keeps|without
  clearing|stale|set.
- attempts-gap: attempts AND reset|to 0|never increment|unused|never
  read. **Caveat:** the planted defect is `requeue` resetting attempts to
  0 in worker.js; most observed wordings say "attempts/MAX_ATTEMPTS are
  unused / never incremented", which is the same functional consequence
  (failed jobs never retire) reached by a different description. Counted,
  and flagged as a consequence-level rather than mechanism-level match.
- lease-clock: renewLease AND caller|explicit `now`|without `now`|no
  default|far-future|forever|immortal|NaN. **Caveat:** the planted defect
  is the far-future-timestamp consequence; every observed hit describes
  the NaN consequence of the same caller-supplied-`now` design. The design
  flaw named is the planted one; the consequence described is not.

## What is now established, and what is not

**Established.** Removing `steer` from MAIN's vocabulary eliminates its
deliberation at the v1 cell — 28/30 vs 13/30 skips pooled, p=2.7e-05 — and
does so without loss of coverage: planted defects named per sample rise
1.45 → 2.30 and MAIN-NS never stays silent there.

**Not established.** (1) Transfer to a code-writing moment: the chosen
cell floors at 100% skip for both arms and cannot discriminate; a cell
where MAIN thinks *and* the task is code-writing has not been found —
across the whole pure-code run MAIN never thought. (2) Whether MAIN-NS's
extra speech at M2 is an improvement or noise: nothing here judges it.
(3) Anything about F2 — v1 already showed F2 is unmoved by the label and
v2 did not re-test it.

**Carried forward, unchanged and unmeasured: driver-side interruption
cost.** Promoting every queue to steer would interrupt the driver on ~9 of
18 observations instead of ~2, and each interruption costs *driver* tokens
where driver turns cost multiples of an observation. The trajectory
harness is **open-loop by construction** — deliveries are recorded, never
injected — so it cannot see this at all. It remains an untested
hypothesis, and only a closed-loop run settles it. No recommendation from
this probe may assume the promotion is free.

## Limits

Two cells, one config (opus-high), one trajectory, one model. M1's cell is
the same one v1 and the skip study used, so the pooled n=30 is deep on one
point rather than broad across many. Coverage signatures are
mechanism-anchored and audited but not judge-scored; the two caveats above
name where a match is consequence-level rather than exact. M2's floor is
explained by the delivery-type mechanism, but that explanation is a
reading of the same data, not an independent test.
