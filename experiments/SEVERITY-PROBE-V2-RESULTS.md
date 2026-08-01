# Severity pooling v2 — results (2026-08-01)

Pre-registered in `SEVERITY-PROBE-V2-SPEC.md` (42c0646, before data).
Probe, not a shipped metric. Same input as v1: the C2 trajectory
(scheduler task, opus-high, arms MAIN/F/F2), 28 delivered messages, 4
planted defects. **Zero producer spend** — judges only, both
subscription-billed. Output frozen under
`experiments/artifacts/2026-08-01-severity-probe-v2/`.

## V1 GATE: 61.9% — MARGINAL

| measure | v1 | v2 | threshold |
|---|---:|---:|---|
| exact agreement on the severity field | 41.7% | **61.9%** (13/21) | >= 70% viable, < 60% stop |
| adjacent-or-better | 91.7% | **100.0%** | — |
| `reachable` agreement | — | 85.7% | not gated |
| `inDeliverable` agreement | — | **38.1%** | not gated |

Decomposition moved exact agreement by **20 points** and eliminated
two-step disagreements entirely (v1 had one; v2 has none — every
disagreement is now one level). The result lands in the pre-registered
MARGINAL band: not viable as a gate, not dead.

### The residual disagreement, named as the spec requires

Seven of the eight disagreements are the SAME pattern: sol grades one
level above opus on issues whose harm is contingent — `stats()` counting
bugs (g03, g04), a truncated doc (g08), a stale gaps table (g09),
unconditional logging (g16). The eighth (g07) is sol blocking / opus
serious on a missing ownership check.

**The decomposition worked exactly as intended, and the evidence is
`inDeliverable` at 38.1%.** sol answers yes on 16 of 21 candidates, opus
on 3 of 21 — a definitional split, not noise: sol reads "the deliverable"
as the session's subject matter (the scheduler), opus as the artefact the
user literally asked for (the doc). That is v1's "deliverable relevance"
convention, now **isolated in a field where it cannot contaminate the
harm judgment**. v1 blended it into severity and got 41.7%; v2 quarantines
it and gets 61.9%.

That points at a v3 that is a wording fix, not a redesign: define
`inDeliverable` precisely (the artefact named in the user's request), and
the remaining harm disagreements are contingent-harm calls that a
sharpened `serious`/`minor` boundary may close.

## V3 — the pool: 21 candidate issues, up from 12

75 atomic claims extracted from 28 messages (sol 40, opus 35; 11 notes
yielded more than one claim), deduped into 20 issues, plus 1 seeded
planted defect nobody found = **21 candidates**.

| planted defect | v1 | v2 |
|---|---|---|
| sched-expired-keeps-claim | g02, judged serious | **g01, judged BLOCKING by both** |
| sched-claim-toctou | **swallowed by clustering** | **g13, its own issue — found by MAIN alone** |
| sched-lease-caller-clock | absent | **s01, seeded: found by NO arm** |
| sched-requeue-resets-attempts | only as a stale-doc claim | g05, matched to F (see caveat) |

**F2 is confirmed fixed.** MAIN's p6 message — *"claimNext has a
check-then-await race (two workers can claim the same job), sweepExpired
requeues without clearing claimedBy"* — now yields claims in BOTH g13 and
g01. v1 folded the whole message into one group and made MAIN's only
blocking-class finding invisible.

**F3 is confirmed working.** `sched-lease-caller-clock` was described by
no arm and enters the pool as s01 with zero members — impossible in v1,
where recall was measured over the collectively-found set.

Also notable: with reachability discounting forbidden in question 1,
`sched-expired-keeps-claim` is rated **blocking** by both judges, where
v1's blended question produced *serious*. The planted set's assumed
severities remain unvalidated in the other direction too.

## V4 — do the two blends re-rank the arms? NO, and not because the modifiers were inert

| arm | mechanism recall | practical recall | mechanism precision | practical precision |
|---|---:|---:|---:|---:|
| **MAIN** | **81.5%** | **81.5%** | 81.5% | 81.5% |
| F | 48.1% | 48.1% | 92.9% | 92.9% |
| F2 | 37.0% | 37.0% | 90.9% | 90.9% |

Both blends total weight 27 and rank identically. The modifiers DID fire
— they cancelled:

- g05 (`sweepExpired` never charges attempts): both judges say
  `reachable = no`, so serious (3) downgrades to minor (1).
- g06 (a doc claim): both say `inDeliverable = yes`, so minor (1)
  upgrades to serious (3).

Two adjustments, equal and opposite, on issues raised by the same arm
(F). Reporting this as "the modifiers made no difference" would be false;
they made no difference *here*, by coincidence.

## The ranking, and what drives it

MAIN's lead is one issue: **g13, the TOCTOU race, weight 9, found by MAIN
alone** (22 of MAIN's 27 recall points come from g01 + g13, both
blocking). Remove g13 and MAIN and F are level.

This **confirms the retraction in 828ce45/96eff06**: read properly, MAIN
is the stronger arm on defect recall on this trajectory, and my earlier
keyword-matched claim that the envelope arms caught what MAIN missed was
an artifact.

## V5 — the precision signal REPLICATES

| arm | messages | claims | issues raised | judged no-harm | judged-disagreed |
|---|---:|---:|---:|---:|---:|
| MAIN | 10 | 33 | 14 | **5** | 5 |
| F | 9 | 21 | 9 | 1 | 5 |
| F2 | 9 | 21 | 7 | 1 | 4 |

v1: MAIN 5 not-real vs F 2, F2 1. v2, different pipeline, different
question: MAIN 5 no-harm vs F 1, F2 1. **MAIN has the highest recall AND
the lowest precision** — it says considerably more, and more of what it
says is both valuable and worthless. Neither the binary frozen-case
scoring nor the trajectory cost metric can express that trade; this
probe can.

## Caveats, in order of how much they should worry a reader

1. **The planted-match pass has its own error mode.** `g05` was matched
   to `sched-requeue-resets-attempts`, but g05's statement is about
   *`sweepExpired` not incrementing attempts* while the planted defect is
   *`requeue` resetting attempts to 0* — adjacent mechanisms, same theme,
   arguably not the same defect. F receives credit for a planted defect
   it may not have found. The match prompt forbids downstream-consequence
   matches but says nothing about adjacent mechanisms.
2. **The one universally-missed defect carries no weight.** s01
   (lease-clock) is exactly the case F3 exists to score, and the judges
   disagreed on it (sol blocking / opus serious), so it drops out of the
   denominator. Had it carried weight 9, every arm's recall would fall by
   roughly a quarter. The seeding fix works; the agreement problem
   swallowed its effect on this run.
3. n = 1 trajectory, 21 issues, 2 judges. Every number here is one draw.
4. Both blends rest on 7 weighted issues of 21 — better than v1's 2 of
   12, still thin.

## Verdict

**MARGINAL, and the failure mode is now a wording fix rather than a
design flaw.** Decomposition delivered what it was meant to: +20 points
of agreement, zero two-step disagreements, and the offending convention
quarantined in a field (`inDeliverable`, 38.1%) where it no longer
corrupts severity. The design is not ready to gate a shipping decision;
it is ready for a v3 that defines `inDeliverable` precisely and sharpens
the serious/minor boundary for contingent harm.

What it already established, at zero producer cost: the pool is 21 issues
where the planted set is 4 (so 17 real findings live entirely outside the
corpus's ground truth), MAIN leads recall on the strength of one blocking
defect nobody else found, and MAIN's precision is the worst of the three
— a trade no metric in this program could previously express.

Method note: every derived field quoted here was checked against raw text
first (the 96eff06 lesson). g13's membership was verified by reading
MAIN's p6 message; g01, g05 likewise; the `inDeliverable` split was
recounted from the raw judgments.
