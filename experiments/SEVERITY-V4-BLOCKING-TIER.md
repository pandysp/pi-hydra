# Severity, resolved: judges can grade — just not at four levels (2026-08-01)

## The finding

v2's headline (61.9% agreement on a 4-level harm scale, "marginal") was
the wrong reading. The informative number was the OTHER one: adjacent-or-
better agreement 100%. The judges never disagreed by more than one level.
That is not unreliable judgment — it is a scale finer than their
resolution.

Re-bucketing v2's EXISTING labels (no new judging, zero spend):

| scale | exact agreement |
|---|---:|
| 4-level (as run) | 61.9% |
| 3-level | 66.7% |
| **2-level: blocking vs rest** | **90.5%** |
| **2-level: any-harm vs none** | **95.2%** |

All eight disagreements sit in the MIDDLE of the scale; five are
serious-vs-minor. Judges reliably recognise a blocking issue and
reliably recognise nothing-there. They cannot split the middle.

## The metric that follows

Two judged questions, both above 90% agreement, no authored gold set
needed for scoring and no per-task authoring cost:
- **blocking-tier recall**: of the unanimously-blocking issues, how many
  did this arm surface (while live)?
- **reality-gated precision**: how many of its claims did BOTH judges
  call not-real?

Scored on the C2 trajectory from v2's own judgments:

| arm | blocking-tier | any-harm recall | claims raised | both-judges-not-real |
|---|---:|---:|---:|---:|
| **MAIN** | **2/2** | 8/14 | 14 | **5** |
| F0 | 1/2 | 8/14 | 9 | 1 |
| F2 | 1/2 | 6/14 | 7 | 1 |

Only two issues in a 21-issue pool are unanimously blocking: the
stranded-claim bug (everyone found it) and the concurrency race (MAIN
alone). So on "did the reviewer catch the top ones", MAIN is 2/2 and both
envelope arms are 1/2 — and MAIN pays for it with 5 not-real claims
against 1 each.

**MAIN = high recall, low precision. The envelope arms = conservative,
rarely wrong.** Which you want is a product call; this is the first
metric in the program able to POSE that question. The old metric
(precision on one seeded finding) could express neither axis.

## Consequences for the other designs

- **GOLD-SET-SPEC (authored severities): NOT needed for scoring.** Its
  surviving job is ONE-TIME CALIBRATION: does the judges' blocking set
  match Andreas's own top picks (GOLD-SET-DRAFT-FOR-REVIEW.md)? If yes,
  the cheap automated metric is validated against the definition that
  matters and scales to any new trajectory. If it disagrees — e.g. judges
  call the lease-clock security bug "serious" where he ranks it first —
  the fix is a one-time prompt-anchor adjustment, not perpetual
  authoring.
- **SEVERITY-V3-SPEC (pairwise ranking): SUPERSEDED.** Pairwise exists to
  rescue unreliable absolute grading; at the resolution that matters
  (blocking vs not) absolute grading is already 90.5%. Fine-grained
  ranking within the tier is not needed for "did they catch the top
  ones". The fork was stopped; do not restart it unless a use appears
  for intra-tier ordering.
- **inDeliverable: DROP IT.** 38.1% agreement, and the practical blend it
  fed did not re-rank the arms. It encodes a definitional dispute (session
  subject-matter vs the artefact literally requested), not a fact.

## Limits

One trajectory, 21 candidate issues, 2 blocking. The blocking tier is
thin — 2 issues means one flip changes an arm's score by 50pp. The
agreement numbers (n=21) are the solid part; the per-arm scores need more
trajectories before they carry a verdict.

## Reproduction

Re-bucketing script inputs: `experiments/artifacts/2026-08-01-severity-
probe-v2/out.json.gz` (fields `judgments.sol`, `judgments.opus`,
`candidates`, `claims`, `pool`). Arm membership resolves
candidate.members -> claims[].note -> pool[].arm; the direct
candidate.arm field does not exist and a naive read scores every arm 0.
