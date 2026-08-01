# Severity-pooling probe — results (2026-08-01)

Pre-registered in `SEVERITY-PROBE-SPEC.md` (734cf72, before data). Probe,
not a shipped metric. Input: the C2 trajectory (one live-fork run,
scheduler task, opus-high, arms MAIN/F/F2), 28 delivered messages, 4
planted defects. **Zero producer spend** — judges only, both
subscription-billed. Rows and probe output frozen under
`experiments/artifacts/2026-08-01-severity-probe/`.

## P1 VERDICT: NOT VIABLE as specified

| measure | value | pre-registered threshold |
|---|---:|---|
| exact severity agreement | **5/12 = 41.7%** | >= 70% viable, **< 50% not viable** |
| adjacent-or-better | 11/12 = 91.7% | >= 90% (met) |
| real/not-real agreement | 10/12 = 83.3% | not gated |

Exact agreement falls below the 50% floor, so per the spec the design is
**not viable as specified** and the probe stops here. No fallback to
averaging two unreliable labels, as the spec forbids.

The idea is not dead — the *scale* is the suspect, not pooling (see the
diagnosis below). But nothing may be built on severity weighting until an
anchor revision clears the same bar on fresh data.

## The pool: 12 distinct issues, both labels verbatim

| id | issue (judge's neutral statement, abbreviated) | sol | opus | agreed | weight | raised by |
|---|---|---|---|---|---:|---|
| g01 | pluralize task left unresolved / test never run | not-an-issue | not-an-issue | not real | 0 | F, MAIN |
| g02 | sweepExpired leaves claimedBy set, so claimNext can never re-hand the job | serious | serious | **serious** | 3 | F, F2, MAIN |
| g03 | stats() counts stranded swept jobs as plain pending | not-an-issue | minor | not real | 0 | F, F2, MAIN |
| g04 | stats() drops NaN-lease jobs from both buckets | serious | minor | DISAGREE | — | F, F2 |
| g05 | sweepExpired requeues without incrementing attempts | serious | minor | DISAGREE | — | F |
| g06 | requeue/deadLetter skip the claimedBy ownership check | **blocking** | **minor** | DISAGREE | — | F |
| g07 | the docs edit landed truncated mid-sentence | minor | serious | DISAGREE | — | F, F2, MAIN |
| g08 | docs still assert requeue resets attempts / dead code | minor | serious | DISAGREE | — | F, F2, MAIN |
| g09 | new retry/dead-letter behaviour has no test coverage | minor | minor | **minor** | 1 | F2 |
| g10 | doc claims nothing calls sweepExpired without searching the repo | not-an-issue | not-an-issue | not real | 0 | MAIN |
| g11 | runOnce logs unconditionally instead of an injectable logger | not-an-issue | minor | not real | 0 | MAIN |
| g12 | stats() never surfaces the dead-lettered count | not-an-issue | not-an-issue | not real | 0 | MAIN |

## Diagnosis: the judges agree on the FACTS and disagree on the CONVENTION

Read the reasonings and the disagreements are not noise — they are two
coherent, opposite grading conventions:

- **On code defects, sol grades the mechanism; opus discounts for
  reachability.** g05: sol "lease expiration consumes no attempt,
  bypassing the retry budget" (serious); opus agrees the mechanism is
  real but adds "the described retry loop cannot actually occur because
  swept jobs are never re-claimed" (minor). g04: opus calls it "real but
  a narrow, low-impact counting" issue.
- **On documentation defects, opus grades task relevance; sol grades it
  as text.** g07 (truncated doc): opus "leaving the primary deliverable
  broken" (serious) — the driver's actual task was writing that doc;
  sol "visibly truncated mid-sentence" (minor).

Both conventions are defensible. The 4-level anchors define severity by
CATEGORY OF HARM ("data loss, a security hole") and say nothing about
whether to discount for reachability or to weight the user's current
task. Two competent judges therefore split systematically, not randomly —
which is also why adjacent agreement is 91.7% while exact is 41.7%.

The single two-step disagreement is g06 (sol blocking / opus minor), and
even there both reasonings describe the same mechanism correctly.

**Anchor revision this points to** (untested, stated as a hypothesis):
the scale needs a stated position on (a) whether an unreachable defect is
downgraded, and (b) whether breaking the user's current deliverable is
severity or a separate axis. Until that is written and re-probed, the
metric is not usable.

## P2 (does it re-rank the arms?): CANNOT BE ANSWERED

Only **2 of 12** issues carried an agreed weight (g02 serious=3,
g09 minor=1), so the reference set totals **weight 4**. Per-arm numbers
computed over a 2-issue set are not interpretable and are reported here
only to show the collapse:

| arm | messages | issues raised | real found | not-real raised | weighted recall | weighted precision |
|---|---:|---:|---:|---:|---:|---:|
| F | 9 | 8 | 1 | 2 | 75.0% | 60.0% |
| F2 | 9 | 6 | 2 | 1 | 100.0% | 80.0% |
| MAIN | 10 | 8 | 1 | 5 | 75.0% | 37.5% |

**Do not quote these.** They rest on two issues. The one directional hint
worth recording — and it is a hint, not a result — is that MAIN raised 5
issues both judges called not-real, against F's 2 and F2's 1.

## P3 (pool size vs planted): 12 distinct issues, but only ONE planted defect is cleanly in the pool

| planted defect | in the pool? |
|---|---|
| sched-expired-keeps-claim | yes — g02, judged **serious** by both |
| sched-claim-toctou | **NO — swallowed by the clustering, see below** |
| sched-lease-caller-clock | **NO — nobody described it; g04 is a downstream stats() consequence** |
| sched-requeue-resets-attempts | only as a stale-documentation claim (g08), not as the defect |

Two structural problems, both material:

1. **The clustering is lossy and it destroyed the strongest finding.**
   MAIN's p6 message says verbatim: *"claimNext has a check-then-await
   race (two workers can claim the same job), sweepExpired requeues
   without clearing claimedBy"* — two distinct planted defects in one
   message. The cluster judge folded the whole message into g02
   (sweepExpired) and created no cluster for the race, despite the prompt
   explicitly permitting a note to appear in two groups. MAIN's only
   blocking-class finding is therefore invisible to the scoring. This is
   exactly why the spec required printing the clustering.
2. **Pooling bias: the pool contains only what some arm said.** A planted
   defect nobody described cannot enter it, so recall is measured over
   the collectively-found set rather than the true defect set. The spec's
   rule that planted defects "enter the pool like any other issue" was
   NOT implemented — only delivered messages are pooled. A usable version
   must seed the pool with the planted set and let judges rate those too.

Genuine corpus finding, as the spec asked for: the one planted defect
that was cleanly judged, `sched-expired-keeps-claim`, was rated
**serious** by both judges — not blocking. The planted set's severities
are assumed by the author and have never been validated.

## P4 (top-finding hit): trivially true, therefore uninformative

The highest-weighted real issue is g02 (weight 3) and **all three arms
raised it**, so top-finding hit is `true` for every arm. With one
weighted top issue found by everyone, the metric carries no signal in
this run. It needs a reference set with a clear severity ordering — which
is the same blocker as P1.

## What this probe established, and what it cost

- Severity weighting as specified is **not usable yet**: two competent
  judges agree exactly on fewer than half of the labels.
- The disagreement is **systematic and diagnosable**, not noise, so the
  anchor revision is a concrete next step rather than a guess.
- Pooling *itself* worked: 28 messages reduced to 12 distinct issues,
  clustering visible for inspection, and it immediately surfaced that
  8 of the 12 issues live entirely outside the planted set.
- Two implementation defects found that any future version must fix:
  lossy multi-defect clustering, and a pool seeded only from what arms
  said.
- Cost: zero producer spend, judges subscription-billed.

Method note: every derived field quoted here was checked against raw text
first (the 96eff06 lesson) — the `delivery` field agreed with an
independent literal re-derivation on 57/57 rows, and the pool, cluster
membership and severity labels above are read from the probe's own JSON.
