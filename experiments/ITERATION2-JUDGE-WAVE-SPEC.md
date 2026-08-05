# Iteration-2 judge wave — dataset v3 + re-judging (SPEC, registered 2026-08-04)

Status: **historical registration, partially spent and not applied. The expanded
2Q design supersedes unstarted evaluator steps 3–5; the settled dataset-repair
work below remains valid but requires Andreas's fold/residue decisions.**

Registered before any judge call, per the standing spend discipline. This wave
executes every judge-spend item the iteration-1 data pass produced
(ITERATION1-DATA-PASS.md lanes A4/A5-staged and B), plus the promotion of the
consensus wave's novel candidates. Its output is golden dataset v3 and the
inputs for the iteration-2 rescore. The original wave registered Sol on its
established transport and Opus via `claude -p` or the then-verified replay
transport. Any new expanded-2Q pass uses the shared Pi hook/replay transport for
both judges instead;
the analyst is the coordinator session's agents. All deliberation follows the
v2 consensus protocol as amended by the adopted Option A
(GOLDEN-V2-PROTOCOL-DECISION.md): converged, or terminated as recorded
dissent after the maximum rounds — nothing forced, nothing averaged.

## Order of execution (checkpoint after every numbered step)

1. **Dataset repairs (B2–B4, small):** the three anchor-mismatch records
   (`DISP-o-xd-g03`, `EXP-o-xe-g17` anchor-only; `EXP-o-xe-g21` anchor AND
   statement) and the three statement re-examinations (`EXP-o-xe-g22`,
   `EXP-o-xe-g27`, `SCHED-c-13`). Full three-participant protocol per record;
   statement changes use the precision-pass replacement mechanics (replace
   statement and votes, preserve ids, members, provenance, trails).
2. **Anchor backfill rule (B1):** the portable-anchor rule proposed by the
   data pass (seed bytes or edit-surviving declaration regex, never bytes that
   exist only after one driver's edit) is put to the three participants as a
   RULING-style confirmation; on adoption, the 33 anchor-less records and the
   12 non-portable end-state anchors are backfilled mechanically where the
   rule decides, and through deliberation where it does not. The exporter
   denominator proposal (B5) is judged here as ordinary statement semantics.
3. **Cache-only re-judge (A5, staged in CAPSTONE-JUDGE-SPEC.md):** the 23
   fresh-input cache-only findings, both judges, clarified instruction,
   new builder hash recorded. Versioned follow-up; the frozen iteration-1
   judgments remain immutable.
4. **Old-basis re-judge (A4, staged):** the 12 old-input cache-only findings
   under semantic-v2 at the current builder, both judges; the 12 run-end
   findings remain unjudgeable by construction and stay excluded.
5. **Promotions:** the 67 novel candidates from
   `artifacts/2026-08-04-capstone-consensus` (34 fresh + 33 old) enter the
   established pool→consensus→assemble pipeline as promotion candidates
   (provenance: observer, frame from their run records). Deduplication
   against v2 actives AND recorded rejections first (settled rejections are
   not re-litigated: the `EXP-o-xe-g06` precedent). Batches of ~15 clusters,
   checkpoint per batch, resumable — the v2 interruption is the design
   input here.
6. **Assemble v3:** fold 1–2 and 5 into the builder (base = v2
   `0aadc215658a775b` at its freeze commit), checker green, freeze via the
   established artifact flow, version-bumped rescore of every frozen run
   (the iteration-2 scorer landed in lane A and emits `iteration: 2`).

## Spend and interruption discipline

The promotion step is the largest remaining subscription draw of the program
(order of the v2 wave-2 consensus). Every step checkpoints to disk before and
after each judge batch; a quota interruption terminates the STEP cleanly and
never the wave's earlier steps. If the weekly window dies mid-step, the
recovery is the registered resume path, not improvisation: identical inputs,
only unanswered questions retried.

## Boundaries

No runtime changes. No evaluator changes (the iteration-2 scorer is frozen as
landed by lane A before this wave's first judge call). No metric tuning. The
iteration-1 published numbers stay immutable. Promotion requires both judges
plus the protocol — a coordinator or agent never promotes on its own
authority. The driver-prompt realism probe (pending Andreas's documentation
section) is OUTSIDE this wave and separately registered when its input
arrives.

## Execution and recovery checkpoint — 2026-08-04

This wave is **partially spent, checkpointed, and not applied**. A fork that
looked failed to the coordinator continued in the background until 18:43 CEST.
It wrote only to `~/scratch/2026-08-04-iter2-wave/`; the tracked dataset,
scores, run ledger, and frozen artifacts did not change. No worker from this
wave is still running.

Step 1 reached the registered three-round stop and was reconciled from the raw
checkpoints:

- `RG22` and `RG27` converged as statement replacements. RG22 is unanimously
  harmful/minor; RG27 is unanimously blocking/severe.
- `RG21` terminates mechanically under adopted Option A at the majority
  blocking/severe tier with Sol's non-blocking dissent preserved verbatim.
- anchor proposals `AG03` and `AG17` converged; `AC13` was replaced by the
  scoped `AC13B`, which ended open after round 3.

Step 2 adopted `RULE-ANCHOR-V2` unanimously. The first 31-record backfill pass
produced 22 unanimous outcomes, but only 19 were adopted. Three proposals
(`SCHED-o-g07`, `SCHED-o-g14`, `SCHED-r-d18`) were unanimously rejected because
their file-wide tokens collide and the current anchor rule cannot express the
faithful function scope. Nine records remained open:
`SCHED-r-d11`, `SCHED-r-d37`, `SCHED-r-d39`, `SCHED-r-d44`, `SCHED-c-15`,
`DISP-o-xd-g20`, `DISP-o-xd-g26`, `EXP-o-xe-g21R`, and `EXP-o-xe-g22R`.
A corrected six-record residue was then staged. Sol completed all six; Opus
returned the Claude session-limit error before producing its first batch, so
`consensus-backfill-v2/` has no consensus file and is not a completed round.

The fold-ready machine record is
`~/scratch/2026-08-04-iter2-reconciliation/settled-outcomes.json`: 25 items
(two statements, RG21 termination, two anchor repairs, the rule, and 19 adopted
backfills). It is evidence only until deliberately folded into a new catalog
version.

Seven items require a dataset-repair queue distinct from expanded-2Q judge
disagreements: `AC13B`, `SCHED-c-15`, `DISP-o-xd-g20`, `DISP-o-xd-g26`,
`SCHED-o-g07`, `SCHED-o-g14`, and `SCHED-r-d18`. The six Sol-only residue votes
remain incomplete old-protocol evidence. Until adopted anchors are folded, 33
of 75 active real-catalog records remain anchor-less and must be visibly
excluded from recall denominators.

Recovery must reuse these exact checkpoints; do not restart completed judge
work and do not treat an analyst proposal as a settled vote. The original
cache-only re-judges and atomized 67-candidate promotion step were never started
and are superseded by the full expanded-2Q pass. The 67 candidates survive only
as completeness leads; they are not direct promotions. V3 assembly and rescore
remain unstarted.

Two user decisions gate recovery:

1. authorize folding the 25 settled outcomes before any catalog-ready expanded-
   2Q pass; and
2. either complete the six-record Opus residue under the frozen old protocol,
   or retire it as incomplete evidence and leave those records excluded/pending
   explicit repair.

The seven repair items and the expanded-2Q semantic contract must then be
settled before iteration 2 resumes. Any catalog change creates a fresh judge
checkpoint identity; the 45-finding mechanics sample cannot be pooled with it.

## Recovery executed — 2026-08-05

Andreas decided both gates: fold now, and complete the residue. Outcome:

- **Residue completed** under the frozen old protocol: Sol resumed from
  checkpoint (zero calls), Opus answered all six on the byte-identical
  prompt (`consensus-backfill-v2/consensus.json`). BF-d11, BF-d37, BF-d44,
  BF-g22R ratified unanimously; BF-d39 and BF-g21R carry substantive Opus
  objections and route to the blinded queue with no further persuasion
  rounds. `backfill-proposals.json` holds STALE pre-correction anchors for
  these records; the voted question blobs are the only authoritative source.
- **Byte-verification before fold** (now permanent in the settled-outcomes
  generator): every anchor must resolve against the frozen frame sources.
  Two unanimously voted anchors were refuted — BF-d44's absence witness
  `leaseExpiresAt: 0` collides with `complete()`'s reset elsewhere in the
  seed file, and SCHED-r-d35 pins `# Scheduling` where the seed doc says
  `# Scheduler`. Votes do not override bytes; both route to the queue.
- **Fold applied** (`golden-dataset-v3-fold.mjs`, ledger row
  `2026-08-05-golden-dataset-v3-fold`): v2 `0aadc215658a775b` -> v3
  `d176183abab2d211`, 75 active / 26 blocking, 27 settled outcomes, checker
  8/8, full suite green. `EXP-o-xe-g21` keeps its v2 anchor pending the
  BF-g21R ruling.
- **The blinded human queue is ELEVEN items**: AC13B, SCHED-c-15,
  DISP-o-xd-g20, DISP-o-xd-g26, SCHED-o-g07, SCHED-o-g14, SCHED-r-d18,
  BF-d39, BF-g21R, BF-d44, SCHED-r-d35.
- **Rescore split by provider quota**: the Opus half of the expanded-2Q
  sample reruns against v3 under a fresh checkpoint identity now; the Sol
  half waits for the OpenAI limit reset. Nothing pools with the v2
  mechanics sample.
