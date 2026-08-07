# Severity v3 — pairwise ranking + reference review (2026-08-01, pre-data)

> **SUPERSEDED — never run.** Pairwise ranking exists to rescue unreliable
> absolute grading; [`SEVERITY-V4-BLOCKING-TIER.md`](SEVERITY-V4-BLOCKING-TIER.md)
> showed absolute grading is already 90.5% reliable at the resolution that
> matters (blocking vs rest), so the fine-grained ordering this would buy is
> not needed. Do not restart it unless intra-tier ordering becomes necessary.


## Why a third design, not a third tweak

v1 and v2 both ask judges for an ABSOLUTE grade ("how severe is this
issue"). Absolute scales are known to have poor inter-rater reliability
and v1 measured exactly that (41.7% exact agreement). v2 decomposes the
grade into factual sub-questions, which may rescue it — but even if it
does, absolute grading is the harder elicitation.

Andreas's own statement of the target was never absolute: "from a ranking
of 1 to 10 most severe to least severe, does the reviewer find the top
ones?" That is a RANKING. Rankings are built reliably from PAIRWISE
comparisons, which is the standard fix for unreliable absolute scales.

v3 runs INDEPENDENTLY of v2's outcome: if v2 succeeds, v3 cross-checks it
with a different elicitation; if v2 fails, v3 is the remaining approach.

## Design

**Stage 1 — REFERENCE REVIEW (removes the arm-seeded pool defect).**
One strong model (claude-opus-5 xhigh via the claude-cli transport) is
given the full recorded trajectory and asked to write the ideal review:
every defect it can find in the visible code, one line each, no ranking.
Candidate pool = reference issues + the 4 planted defects + any issue an
arm raised that the reference missed (so arms can still get credit for
finding something the reference did not). Pool provenance is recorded per
issue: reference / planted / arm-only.

**Stage 2 — PAIRWISE RANKING.** Judges compare issues two at a time:
"Which of these two would you rather a code reviewer had caught, given
this codebase and task? A / B / genuinely equal." No numbers, no scale.
Comparisons are sampled to cover the pool (round-robin if the pool is
<= 12, otherwise a randomised connected design), presented in randomised
order and orientation, blind to which arm found what.
A Bradley-Terry fit turns the comparisons into a severity ranking.

**Stage 3 — SCORE.** Rank-weighted coverage per arm, and the metric
Andreas actually described: **top-k hit rate** — of the top 3 (and top 5)
ranked issues, how many did this arm surface while the issue was live?
Also reported: issues an arm raised that the reference judged not real
(the noise axis v1 hinted at).

## Pre-registered viability

- **W1 (the gate): pairwise agreement between the two judges >= 75%** on
  the same comparisons (ties counted as agreement only if both say tie).
  Pairwise should beat absolute grading substantially; if it does not
  clear 75%, severity is not reliably elicitable from these judges by
  either method and Avenue 3 needs a human anchor, not another design.
  Below 65%: STOP and say the avenue is exhausted at the LLM-judge level.
- W2: does the Bradley-Terry ranking put the PLANTED defects near the
  top? If the planted set ranks mid-pack, the corpus's implicit severity
  assumptions are wrong (v1 already found both judges calling a planted
  defect "serious" rather than blocking).
- W3: top-3 and top-5 hit rate per arm, with the ranking printed in full.
- W4: does this ranking order the arms DIFFERENTLY from the old
  precision-on-one-seeded-finding metric? That is the whole point of the
  avenue.

## Rules

Judges never see arm labels. Comparison order and orientation randomised
per pair. The full pool, the full ranking, and every raw comparison are
printed. Derived fields read against raw text before quoting (96eff06).
Zero producer spend: the trajectory rows and payloads already exist.
