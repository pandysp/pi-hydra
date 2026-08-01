# No-steer probe — results (2026-08-01)

Pre-registered in `NO-STEER-SPEC.md` (6b7fc38, amended bfb4de5 — both
before data). Instrument: `experiments/adaptive-skip-probe.mjs` (reused,
not rebuilt). Variants: `experiments/no-steer-variants.mjs`. 20 calls,
zero errors, **$0.6741 spent**. One prefix (`scheduler/opus-high/a1/r1/6`,
L=20,165), opus-high, 10 samples per variant — the same cell the skip
study measured MAIN and F2 on, so the baselines are directly comparable.

Variants are byte-precise edits of the rendered parents, each asserting
its anchor landed, plus a guard that the word "steer" is gone and
`interrupt` survives:

| variant | chars | vs parent |
|---|---:|---:|
| MAIN-NS | 686 | −10 vs MAIN (696) |
| F2-NS | 2037 | −53 vs F2 (2090) |

Design note carried from the variants file: queue ABSORBS steer's
semantics in both variants. Deleting steer's sentence alone would leave
urgent findings with nowhere to go (MAIN's queue reads "useful but
waitable", F2's rule 5 "genuinely deferrable"), which would be removing a
capability — a different experiment.

## N1 — the causal test: CONFIRMED on the pre-registered threshold, with a dissociation that matters more

| variant | skip | mean | median | raw per-sample reasoning |
|---|---:|---:|---:|---|
| MAIN (baseline) | 5/10 | 569 | 485 | `0 1295 0 1166 0 1134 0 970 1123 0` |
| **MAIN-NS** | **8/10** | **132** | **0** | `0 1027 0 0 0 295 0 0 0 0` |
| F2 (baseline) | 0/10 | 933 | 915 | `806 901 1043 928 1017 902 989 761 1100 878` |
| **F2-NS** | **0/10** | **838** | **852** | `1023 499 751 1029 892 1086 615 778 830 874` |

The pre-registered rule reads: CONFIRMED if MAIN-NS skips >= 8/10 OR
F2-NS >= 5/10. **MAIN-NS is exactly 8/10, so N1 is CONFIRMED as
registered.** Mean thinking falls 569 -> 132, **−77%**.

Both statistics, because they disagree in strength and the reader is
entitled to both:
- The pre-registered ABSOLUTE threshold fires. Its false-positive rate
  under the null that the edit does nothing (p=0.5 per sample, from the
  skip study) is **5.5%** — an acceptable one-shot test.
- The COMPARATIVE test against MAIN's own 5/10 is **Fisher one-sided
  p = 0.175 — not significant at n=10.** If the effect size holds, n=20
  per arm reaches p=0.048; n=30 reaches p=0.015.

**The dissociation is the real finding: the label moves MAIN and does
nothing to F2.** F2-NS is 0/10 skips like F2, mean 838 vs 933 (−10%,
inside a per-sample spread of 499-1086). Removing steer from F2 changed
neither its cost nor its output.

Hypothesis this suggests, labelled as such and NOT tested here: MAIN's
only real decision was which of five actions to pick, and the urgent/
deferrable split was the judgment inside it — collapse the split and the
judgment disappears. F2 still has six ordered rules, a semantic-
equivalence clause and a selection clause to evaluate no matter how many
delivery labels exist, so its cost is RULE EVALUATION, not label choice.
That is consistent with F2's framing (−23%) and F3's decidability
(+7.6%) both failing to move the structural gap, but it is a story that
fits, not a result.

## N2 — the finding SURVIVES, and improves. The cost win is not blindness.

This is the check that decides whether the number above is worth
anything. Planted defects named per sample (regex over the full message,
then every MAIN-NS message read in full to verify the count):

| variant | planted defects / sample | / delivery | deliveries |
|---|---:|---:|---:|
| MAIN | 1.4 | 1.8 | 8/10 (2 noops) |
| **MAIN-NS** | **2.5** | **2.5** | **10/10** |
| F2 | 1.6 | 1.6 | 10/10 |
| F2-NS | 1.4 | 1.4 | 10/10 |

**MAIN-NS thinks 77% less and names 1.8x more planted defects than
MAIN.** It also never goes silent, where MAIN produced two noops.

A zero-thinking MAIN-NS sample, verbatim (s7, 0 reasoning tokens):

> When writing docs/scheduling.md, describe today's real behavior:
> claimNext's read-then-await leaves a TOCTOU race (two workers can claim
> one job), sweepExpired resets state but leaves claimedBy set, and
> attempts/MAX_ATTEMPTS/store.dead are never used, so failed jobs never
> retire. Don't document intent as fact.

Three planted defects, precisely characterised, zero deliberation.
Against MAIN's most expensive sample (s2, 1295 reasoning tokens):

> Check before writing: sweepExpired sets state=pending but leaves
> claimedBy set... [one defect]

F2-NS is unchanged in content as well as cost — all ten samples deliver
the same single `sweepExpired` stranding finding F2 delivered.

**A correction to my own framing while running this:** I said earlier
that MAIN's cheap samples produce "a different, lesser finding — an
unrun test". Reading them in full, that is only true of s7. s3 and s5
DO name planted defects (the attempts gap; the attempts gap plus the
stranded claim) alongside the test note. MAIN's cheap samples were never
empty — they were just narrower than MAIN-NS's.

### The shape changed, and it may be task-specific

Removing steer did not merely relabel MAIN's output; it changed its
shape from "one urgent thing to stop for" to "here are the gaps to
document". At this observation point the driver's task IS writing
`docs/scheduling.md`, so enumerating gaps is the natural response and
the shift may not transfer to a code-writing moment. **One prefix, one
task type — this is the single biggest limit on reading N2 as a general
quality win.**

## N3 — demoted to descriptive (spec amendment bfb4de5)

Urgency lives in the message text, not the channel label, and the driver
is an agent that triages content on arrival — so a flattened message
routed urgently is not the concern I originally made it. Per the
amendment this is descriptive and does not qualify N1/N2.

Not run as a judged metric: the existing judge harness carries fixed
metrics (support/target/repeat), and building a new judged question for
a demoted descriptive note is disproportionate. Qualitative reading of
the raw text instead: MAIN-NS's messages preserve act-now framing in 4 of
10 ("Before writing docs/scheduling.md, read src/worker.js too — ...")
and use a softer "When writing scheduling.md, describe..." in the other
6, where the action is imminent anyway. Urgency is largely legible in the
text. This is an unjudged observation, not a measurement.

## The honest caveat: driver-side interruption cost is UNMEASURED

Promoting every queue to steer means the driver is interrupted on ~9 of
18 observations instead of ~2, and each interruption costs DRIVER tokens
— re-read, re-plan, possibly abandon good work — where driver turns cost
multiples of an observation. **Our trajectory harness is open-loop by
construction** (deliveries are recorded, never injected), so it cannot
see this cost at all. Any recommendation built on this probe carries that
limit, and only a closed-loop run settles it.

## Limits

n=10 per variant, ONE prefix, ONE config (opus-high), ONE task type
(documentation). The comparative test is underpowered (p=0.175). The
planted-defect counts are regex-derived and read-verified on MAIN-NS but
spot-checked (3 of 10) on the MAIN baseline. Nothing here says the
runtime promotion is safe — it says the model's cost responds to the
label on MAIN's contract and not on F2's.

## What would settle it

n=20-30 per arm on the same cell (~$1.40-2.00) for the comparative test;
two more prefixes with non-documentation driver tasks for the shape
question; a closed-loop trajectory for the interruption cost.
