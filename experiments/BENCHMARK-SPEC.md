# Benchmark — baseline and arms against golden v2 (SPEC, 2026-08-02)

Funded by Andreas 2026-08-02: once the dataset is finished, run baseline
and the arms and produce ONE table across all runs — cost per
observation, trajectory cost as a share of the driver's, and a quality
score in which blocking findings weigh more than non-blocking. The
scoring design was delegated ("separate scores or fused — part of your
job"). End state: Andreas locks in the design(s).

## What is registered now vs later

The SCORING DESIGN below is registered before any judged coverage
exists, so the metric cannot be tuned toward an arm after the fact. The
RUN MATRIX depends on two pending inputs (the golden v2 freeze and the
steer-only probe verdict) and lands as a dated addendum to this file
BEFORE any new producer run. Rescoring already-frozen rows needs no
addendum.

## Scoring design (registered 2026-08-02, before data)

Per arm × config × task, computed from judged coverage against the
current golden version (issues whose liveness window overlaps no
observation point of a run leave that run's denominator):

1. **blocking recall** — unique active blocking issues of the task the
   arm is credited with / the task's active blocking issues. Credit by
   READING the delivered messages (96eff06 discipline), never keyword
   match.
2. **any-harm recall** — the same over ALL active issues.
3. **precision** — raised issues judged real by both judges / raised
   issues; the absolute both-judges-not-real count is reported beside
   it (13 noisy queue items and 3 noisy queue items are different
   products at the same ratio).
4. **quiet-span deliveries** — driver-visible deliveries
   (steer/interrupt) inside the task's pre-registered quiet span.
   Semantics note (Andreas, 2026-08-02): a steer is NOT a disruption —
   it folds into the driver's work at the next checkpoint. This column
   therefore measures unneeded feedback reaching the driver, not
   interruption; earlier docs' "false interrupts" label carries the
   same definition under a misleading name.
5. **costs** — $/observation (production-priced) and observer$/driver$
   across the trajectory, from the run's own usage records.

Reading rules, registered with the metric:

- **Blocking outranks non-blocking lexicographically**: no arm ranks
  above another that found strictly more blocking issues on the same
  task, whatever the other columns say. A missed blocker is the failure
  mode observers exist for; harmless recall does not buy it back.
- **One convenience column**: weighted recall =
  (2×blocking-found + harmful-found) / (2×blocking-total + harmful-total),
  weights 2:1 fixed today. It exists for scanning the table, never for
  verdicts; every verdict sentence cites the separate columns. The
  standing rule stands: quality, cost, and delivery-correctness are
  never fused into one number.
- **Ties on blocking recall** are broken in the verdict sentence,
  written from any-harm recall, precision, false interrupts, and cost
  together — judgment stated in plain language, no further formula.
- **No cross-task summing** (denominators differ): per-task rows plus
  an unweighted mean of per-task rates, labelled as such.
- **Evaluator freeze**: no metric change after the first scored row. A
  metric defect found mid-run is recorded, the table finishes on the
  frozen metric, and the fix lands in a versioned follow-up pass.

Bonus promotion (Andreas: "see if we need to fold any bonus findings
into the dataset"): any raised issue judged real by both judges and
absent from the set enters the design doc's promotion path; a version
bump re-scores every frozen run for free, and every quoted number
carries its version.

## Iteration protocol (Andreas, 2026-08-02)

Issues are EXPECTED to surface once benchmarks run against the set;
plan is 2–3 iterations before the dataset is declared final for serious
comparisons. Per iteration:

1. Scoring pass under that iteration's frozen metric and dataset
   version.
2. A dedicated look-at-the-data pass over raw rows AND judgments
   (fork/workflow agents reading the text, not summaries), before any
   number is distilled.
3. Every surprise triaged harness-bug | dataset-label-bug |
   real-effect. Label fixes go through the consensus protocol, never
   applied on the finder's authority; harness fixes land immediately;
   real effects enter the results.
4. Version bump, free re-score, next iteration.

The dataset is FINAL for lock-in comparisons only after an iteration
whose data pass surfaces no dataset-label bugs (target: by iteration
3). The lock-in table reads exclusively from the final iteration;
earlier passes are kept as shakedown artifacts, quoted only for what
they taught. The evaluator freeze above applies WITHIN an iteration;
metric changes land between iterations, versioned and documented.

## Run matrix — pending addendum

- Zero-spend rescoring against v2 of every frozen trajectory run:
  scheduler (C2, enum-trajectory), cross-task exporter + dispatcher,
  and the sol openai-trajectory rows — the latter is the standing
  missing input (first judged sol coverage), subscription-billed.
- Fresh producer cells: only those the steer-only verdict earns, each
  pre-registered here with arms, n, configs, and spend before running.

## Boundaries

No runtime changes in this spec's scope. No evaluator edits after
scoring starts. No fresh Anthropic producer spend without the addendum.
Judges are sol + opus throughout (both must credit a finding for
promotion; coverage credit follows the two-judge flow with disagreement
recorded, not averaged).
