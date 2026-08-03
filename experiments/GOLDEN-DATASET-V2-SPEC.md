# Golden dataset v2 — instrument waves before further benchmarks (SPEC, 2026-08-02)

Pre-registered before data. Funded by Andreas 2026-08-02: invest dataset
waves BEFORE judged sol coverage and the G1 contract decision, because
every pending number scores against this ruler and ruler defects compound
downstream. Zero producer spend anywhere: reviewers and auditors are
orchestration (opus-5 high/xhigh subagents per his instruction), judges
subscription-billed (sol via pi, opus via claude -p), analyst is this
session.

## Why now — the three known instrument issues

1. **Thin slices.** Exporter 5 issues (3 blocking), dispatcher 4 (3
   blocking) — thin BY CONSTRUCTION (v1 Limits: no reference review, no
   observer pool existed there at freeze). Every cross-task coverage
   number has a 3-blocker denominator: one judgment moves an arm 33pp.
   The G1 counter-argument (ENUM dispatcher precision 54%) is measured
   against the thinnest reference in the program.
2. **Calibration gap.** The cross-task run's two-judge pools sit exactly
   one tier below golden-v1 (serious vs blocking) on all three exporter
   blockers, dispatcher agreeing everywhere
   (CROSS-TASK-TRAJECTORY-RESULTS, discrepancy note). Systematic and
   one-sided — a protocol difference, not noise. Unresolved, and judged
   sol coverage would inherit it.
3. **RULING 3 is not in the rubric text.** It was argued through
   deliberation reasons mid-build (GOLDEN-DATASET-DESIGN.md records the
   TODO); the next consensus run must produce labels under it from
   round 1, not re-argue it.

Plus one hygiene gap: the ~14 verified /code-review-max runner-ups exist
only in an agent report (artifact README documents this), unfrozen.

## Wave 1 — stabilize v1

### Q1 — is the tier gap a rubric effect or a deliberation effect?

One factor varied: the RULINGS in the pool-judge rubric.

- Take the three drifted issues (`EXP-offset-drift`, `EXP-c-11`,
  `EXP-c-12`) exactly as stated in the cross-task run pool.
- Re-judge, SAME two judge models as that run (opus + sol), independent
  labels, NO deliberation — the only change is the three RULINGS added
  to the pool rubric verbatim.
- Readings, pre-registered: **≥2 of 3 unanimous-blocking** → the gap is
  a rubric effect; every future pool run carries the RULINGS; no
  deliberation needed for pool tiering. **≤1 flips** → deliberation is
  load-bearing; RULE: pool tiers are advisory; any tier that enters a
  decision table comes from golden matching or the full three-participant
  protocol.
- Standing rule effective immediately, independent of outcome: an issue
  matching an active golden record takes the GOLDEN tier by definition;
  pool tiers apply only to novel (promotion-candidate) issues.
- Prerequisite step, same agent: fold RULING 3 into the consensus rubric
  text and commit before any judging. The judgment-fingerprint guard
  correctly refuses to pool these new judgments with old ones; the
  mini-run stands alone in its artifact.

### Q2 — consistency audit of v1 (46 active + 26 rejected)

Three independent lens auditors + one synthesizer (workflow; auditors
flag, never edit):

- **Individuation (RULING 2):** duplicates, overlaps, bad merges — the
  13 multi-member clusters and near-neighbour singletons first.
- **Temporal frame (RULING 3):** for every scheduler issue judged under
  the session source whose provenance is seed-era (planted,
  reference-review), verify no convergence-carrying reason rests on
  driver-era state. The seven re-judged issues are known-good; the claim
  under audit is v1's "everything else converged on frame-independent
  reasoning". Also: anchors resolve against the correct state.
- **Reachability (RULING 1) + rejected pool:** no accept/reject reason
  rests on "nothing in this repo calls it" for exported API; the 26
  rejections' reasons survive all three rulings.

Rules: editorial fixes (anchor paths, typos) land directly with
`golden-dataset.check.mjs` green. Any flag entailing a label, tier, or
status change goes through the full consensus protocol (post-Q1-fold
rubric) — never applied on the auditor's authority. Every flag is
triaged harness-bug | dataset-label-bug | real-effect | no-issue in the
results doc. Honesty rule: the count of label-changing flags is reported
even if zero; zero is a pass, not a failed audit.

### Q3 — freeze the /code-review-max runner-ups

Locate the ~14 verified runner-up findings (the agent report of the
2026-08-01 `/code-review max` run; the frozen JSON carries only the top
15). Freeze verbatim, additive-only, alongside
`artifacts/2026-08-01-code-review-max/` with SHA256SUMS updated and the
addition dated in the README. They enter wave 2 as pool candidates
(provenance: code-review). If the report is unrecoverable, record that
in the README and proceed — wave 2's blind reviews cover the same ground
independently.

## Wave 2 — deepen exporter and dispatcher

v1's method, applied to the two thin tasks. Blind reviews are
independent of everything wave 1 touches and run in parallel with it;
pooling and consensus wait for wave 1 (rubric fold, protocol ruling,
audit flags).

1. **Blind reference review:** three independent opus-xhigh passes per
   task over the SEED ONLY (golden corpus `main`), lenses correctness /
   data-integrity / API-contract. Reviewers see no planted list, no
   golden set, no prior findings, and not each other (design-doc
   blindness requirement — it is what makes independent discovery mean
   something).
2. **Pool:** new review reports + the cross-task run's observer claims
   (exporter 37, dispatcher 47 raised issues — INCLUDING the 13
   both-judges-not-real dispatcher claims, re-entered as ordinary
   candidates and judged fresh) + Q3 runner-ups if recovered. Cluster
   under RULING 2 (`golden-dataset-pool.mjs`).
3. **Consensus:** full three-participant protocol, all four RULINGS in
   the rubric, with each candidate routed to its recorded seed or session
   frame. Convergence to the v1 bar: ≥95%, clean 2-1 stalls recorded as
   verbatim dissent, never averaged.
4. **Assemble v2:** fold in any wave-1 label changes, bump the version,
   `golden-dataset.check.mjs` green, re-score every frozen artifact
   (deterministic, $0), write GOLDEN-DATASET-V2-RESULTS.md, update
   DECISION-TABLE.md and INDEX.md. All previously quoted numbers keep
   their version pin; re-scored blocks state both versions.

Pre-registered honesty item: v1's blind review found 40/44 issues
outside all prior pools on the scheduler. If the exporter+dispatcher
reviews surface **fewer than 5 novel accepted issues per task**, the
thin slices were code-limited, not discovery-limited — that is reported
as the finding, and the set is not padded to avoid it.

## Recovery amendment — precision pass after the interrupted run (2026-08-02)

Registered before any further judge call. The saved novel run reached 62/67
unanimous after round 6; the saved audit rejudge reached 4/5 after round 5.
The original protocol terminates an unchanged question after three
deliberation rounds, so another ordinary round is forbidden. It would pressure
stable dissent rather than add evidence.

The raw reasons separate two statement defects from four genuine disagreements:

- `V2-I38` bundles the no-abort expression with duplicate-charge harm owned by
  the separate missing-idempotency record. All three participants already agree
  that the no-abort behavior is real; they disagree only over the imported
  consequence.
- `V2-I52` says four documentation locations omit the per-result log. The end
  source refutes three conjuncts; all participants eventually identified the
  narrower, real residue that the runnable examples show a three-field result.

Those two records receive one fresh precision batch under new question ids and
the unchanged four-ruling rubric. The original rounds remain immutable. Round 1
is independent: analyst labels are written first, sol and opus see only the
revised statement and source, and no prior positions. If round 1 disagrees, the
ordinary maximum of three deliberation rounds applies. The replacement text is
fixed now:

- `CL38`: “`runAttempt` races an in-flight POST against a timer but has no way
  to cancel the losing POST, so work continues after the caller has timed out
  and may settle after the caller has moved on.”
- `CL52`: “The runnable `dispatchCharge` examples in docs/dispatch.md show a
  three-field `{ id, delivered, attempts }` result even though the function and
  the same document specify a fourth per-result `log` field.”

If both converge, they replace only the statements and votes of their original
records, preserving ids, members, provenance, anchors, and the complete old
deliberation trail. Novel convergence then becomes 64/67 (95.5%), above the
registered bar. `V2-I02`, `V2-I04`, and `V2-I05` are ineligible: their reasons
show real contract/policy ambiguity, not a compound or factually overbroad
statement, so they terminate as stable verbatim dissent.

`RD04` is also ineligible for statement repair. Sol and the analyst individuate
attempt accounting onto `SCHED-requeue-resets-attempts`; Opus additionally
points to lease-expiry accounting, already recorded as `SCHED-o-g05`. That is a
genuine ownership disagreement, not a malformed source claim. It terminates
under the original rule as unresolved majority-false with Opus's dissent kept
verbatim. The 95% Wave 2 bar applies to the 67 novel clusters; no denominator,
threshold, rubric, or settled label changes here.

## Boundaries

No producer runs, no driver runs, no contract changes. No deepening of
the scheduler slice (37/11 is the deep end; nothing pending decides on
it). No re-judging of settled v1 issues except through audit flags. No
changes to screen-corpus expected-labels. Judged sol coverage starts
only after v2 freezes.

## Spend

$0 producer. Judge invocations bounded by the v1 build's shape (~40
across seven rounds there; wave 2 pools are smaller than v1's 90
reports). Plan-window discipline applies (resets ~11pm Europe/Berlin).

## Deliverables

Rubric fold commit; Q1 mini-verdict + protocol ruling; audit flags with
triage table; runner-ups frozen or documented unrecoverable;
`golden-dataset.json` v2 + results doc; re-scored decision-table blocks.

## Final freeze gate (prepared 2026-08-03, not yet run)

After consensus, the ordinary builder must pass without
`--allow-provisional`, produce byte-identical output on a second invocation,
and pass all 8 checker invariants. Commit the final dataset, results, and
documentation first. Then build the freeze source with:

```sh
node experiments/golden-dataset-v2-freeze-stage.mjs \
  --output ~/scratch/2026-08-03-golden-v2-final-freeze
```

The staging command is zero-call and fails closed on a dirty worktree, a
provisional dataset, novel consensus below 95%, either missing precision
replacement, consensus round/count metadata that disagrees with the saved
states, any checker result other than 8/8, incomplete source state, or a
pre-existing output directory. It copies the logical bytes of the dataset,
results, rubric/build/checker code, frame sources, pool, calibration, every
saved consensus checkpoint and raw judge response into one flat source directory and
writes a SHA-256 provenance manifest. Only that source is eligible for the new
`2026-08-03-golden-dataset-v2-final` freeze and ledger entry. The existing
`2026-08-02-golden-dataset-v2` artifact is provisional recovery material and
must not be overwritten or presented as the final freeze.
