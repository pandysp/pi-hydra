# Golden dataset v1 — build results (2026-08-02)

The initial build per `GOLDEN-DATASET-DESIGN.md`: union the four discovery
sources, cluster under RULING 2, tier every cluster through the consensus
protocol with the two RULINGS in the rubric, freeze with a content hash.
Zero producer spend — the clustering judge and both consensus judges are
subscription-billed; the analyst is this session.

Pipeline: `golden-dataset-pool.mjs` (stage 1) →
`golden-dataset-consensus.mjs` (stage 2, round per invocation) →
`golden-dataset-assemble.mjs` (stage 3, deterministic) →
`golden-dataset.check.mjs` (offline guard) → `golden-dataset-score.mjs`
(regression scoring, no judges).

## Input pool: 90 source reports → 72 clustered issues

| source | reports | notes |
|---|---:|---|
| planted | 10 | all three tasks (4 scheduler, 3 exporter, 3 dispatcher) |
| reference-review | 44 | 3 blind opus-xhigh passes over the scheduler seed |
| code-review | 15 | `/code-review max` over the golden-corpus repo, measured failure scenarios |
| observer | 21 | every distinct claim any arm made on the C2 trajectory |

Clustering: 13 multi-member clusters + 59 singletons; the mapping is a
bijection (90/90 members, zero duplicates, all 10 planted defects present)
and was reviewed cluster by cluster before any judging. Task split: 62
scheduler, 6 exporter, 4 dispatcher — the imbalance is honest (only the
scheduler has a reference review and an observer pool so far; see limits).

## Consensus (three participants, two binary axes)

Two protocols after the frame repair (see Anomalies): the main run (65
issues, session source) and the seed-frame run (7 issues, seeded source).

| protocol round | converged | |
|---|---:|---|
| main 1 (independent) | 33/72 | 45.8% |
| main 2 (deliberation) | 55/72 | 76.4% |
| main 3 (65 after the 7 split out) | 59/65 | 90.8% |
| main 4 | 62/65 | (analyst concessions on I21/I50/I67) |
| main 5 (stall test) | 63/65 | I07 converged; I20/I38 stalled 2-1 on blocking |
| seed-frame 1 (independent, correct source) | 1/7 | |
| seed-frame 2 | 4/7 | |
| seed-frame 3 | 7/7 | fully unanimous |

Round-1 independent agreement (45.8%) sits in the same band as the C2
run's 42.9% — replicating that independent labelling alone is not enough
and deliberation is load-bearing.

**The round-1 disagreements split on a rubric gap, now RULING 3.** The
scheduler slice is judged against the recorded session (start AND end
state), and the rubric never said which state an issue is ABOUT. On every
planted defect the driver repaired mid-session (the requeue attempts
reset, the unwired dead-letter path) one judge labelled the seed
(defect real) and the other the end state (defect "not present"), with
the same split on the seeded doc stub vs the driver's rewrite. The
analyst deliberated round 2 under the seeded-state frame —
`GOLDEN-DATASET-DESIGN.md` RULING 3, consistent with the reference
review's scope and with anchors resolving against the seed — arguing it
through source-citing reasons rather than a mid-protocol rubric edit.

**Surviving dissents, verbatim (recorded, never averaged).** Both are
sol alone holding `blocking=true` on issues all three call real, with
positions byte-stable across rounds 3-5 — the clean-stall condition:

- `SCHED-r-d20` (live references out of `getJob`/`listJobs`), harmful by
  majority. sol: "`getJob` and `listJobs` return the exact objects held
  by the Map, so mutating a returned public record silently changes
  stored state without `saveJob`."
- `SCHED-r-d37` (shallow copy aliases `payload`), harmful by majority.
  sol: "`saveJob` copies only the outer job while `runOnce` passes the
  shared `payload` to the handler, so a failing handler can silently
  alter the payload subsequently persisted for retry."

**Position-change accounting (the C2 discipline):** 57 changes across
both protocols — analyst 34, sol 14, opus 9. Classifier: 34
evidence-driven, **0 authority-driven**, 23 unclassified (the classifier
is deliberately conservative; spot-reads of the unclassified cite the
source). Nobody converged by deferring. The analyst again moved most,
and three of those moves were forced by re-reading the artifact after
holding a wrong position (the sweepExpired docstring on I49, the
exporter schema on I67, the stats docstring on I50).

## The set

Version `4ea27b0018705940` — **46 active issues (17 blocking, 29
harmful), 26 rejected** (recorded with votes and reasons in the
`rejected` array, not deleted). All 10 planted defects covered; all 7
offline invariants pass (`golden-dataset.check.mjs`).

| task | blocking | harmful | rejected |
|---|---:|---:|---:|
| scheduler | 11 | 26 | 25 |
| exporter | 3 | 2 | 1 |
| dispatcher | 3 | 1 | 0 |

Notable calls the protocol settled:
- `SCHED-lease-caller-clock` is BLOCKING and unanimous — the standing
  2-1 dissent from the C2 consensus dissolved once RULING 1
  (reachability) was in the rubric rather than argued post-hoc.
- The two inert-budget defects (`SCHED-requeue-resets-attempts`,
  `SCHED-r-d05`) are BLOCKING and unanimous under the seed frame: each
  unbudgeted retry re-executes a side-effecting handler, and
  MAX_ATTEMPTS is a shipped safety contract the seed silently disables.
- The cross-tenant exporter "leak" from /code-review max was REJECTED
  unanimously as stated: `exportOrders` takes no tenant parameter and no
  row field carries tenant identity, so the shown data model cannot
  express another tenant's orders. The genuine residue — tenant
  isolation rests on an undocumented one-db-per-tenant precondition — is
  a different statement, left for the promotion path.

## Per-arm scores under v1 (regression mode, zero spend)

Whole set: MAIN 2/17 blocking + 5/29 harmful, F 2/17 + 5/29,
F2 1/17 + 5/29. **34 of 46 issues were found by no arm** (14 blocking).

The honest denominator is per task — arms have only ever observed the
scheduler; the exporter/dispatcher rows are structurally out of reach
until the cross-task trajectories land:

| arm | scheduler blocking | scheduler harmful |
|---|---:|---:|
| MAIN | 2/11 | 5/26 |
| F | 2/11 | 5/26 |
| F2 | 1/11 | 5/26 |

Found by no arm, scheduler only: 25/37 (8 blocking). This is the
measured size of the blind spot an arm-seeded pool would have carried —
the number the reference review exists to produce. It also says the
recall ceiling for every contract measured so far is low in absolute
terms; the ENUM trajectory numbers (11/12 any-harm on the C2 pool) used
a pool an order of magnitude smaller than this set.

## Anomalies and their triage

1. **Seed-authored issues judged against the driver's end state —
   HARNESS BUG, repaired mid-protocol.** Round 2 left both judges
   rejecting seven seed-authored issues (including planted
   `sched-requeue-resets-attempts`, ground-truth-confirmed live in every
   trajectory run) on reasons citing driver-written repairs: "the shipped
   requeue writes attempts+1", "worker.js calls pluralize five times",
   "the doc is no longer a stub". The consensus script fed ONE source per
   task (recorded session, start and end) where the set needs the state
   each issue's author reviewed. Accepting those labels would have
   dropped a planted defect from the set — `golden-dataset.check.mjs`
   fails exactly this. Same bug class as the first C2 consensus run
   (wrong sourceBlock), same remedy: `--source seed` added, the seven
   issues re-judged fresh against the seeded files in a separate state
   dir (`seed-frame/`), rounds 1-2 of the main run discarded FOR THOSE
   SEVEN ONLY. Everything else converged on frame-independent reasoning
   and stands. RULING 3 records the convention.
2. **The analyst's own seed-frame recheck flipped one of the seven** —
   I49's premise ("the doc describes swept jobs as returning to claimable
   work") is not evidenced by the seeded stub, which never mentions
   sweeping; the omission is I36's expression. Labeled not-real by the
   analyst BEFORE the seed-frame judges ran; dataset-label-bug caught by
   reading the seed rather than trusting the reference line.

## Spend

$0 producer. Both judges subscription-billed (sol via pi, opus via
claude -p); the analyst is this session. ~40 judge invocations across
seven rounds of two protocols.

## Limits

- The exporter and dispatcher entered with planted + code-review sources
  only — no reference review (never run there) and no observer pool (no
  trajectory had been driven on them when the pool froze). Their slices
  are thin by construction and will grow via promotion once the cross-task
  trajectories land.
- The scheduler slice is judged against the recorded C2 session (start and
  end state); exporter/dispatcher against their seeds. A future scheduler
  re-seed invalidates anchors, not judgments.
- Set version changes on every promotion; scores quote the version they
  were computed against.
