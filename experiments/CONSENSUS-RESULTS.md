# Severity consensus — results (2026-08-01)

Protocol: `CONSENSUS-SPEC.md`, run by `experiments/severity-consensus.mjs`.
Three participants — sol, opus, analyst — on the two axes v4 established
as reliable (`blocking`, `anyHarm`). 21 pooled issues from the C2
trajectory. Andreas delegated the set: no human sign-off. Zero producer
spend; both judges subscription-billed.

## C1 — convergence: deliberation is worth keeping, decisively

| round | converged | |
|---|---:|---|
| 1 (independent) | 9/21 | 42.9% |
| 2 (deliberation) | 19/21 | 90.5% |
| 3 | 20/21 | 95.2% |
| 4 | 20/21 | 95.2% (stalled) |

Deliberation added **+52.3pp** over independent labelling, far above the
5pp "this is ceremony" bar. It also stalled cleanly: round 4 moved
nothing, so the protocol terminates rather than grinding.

## C2 — evidence vs authority: ZERO capitulation

12 position changes across all rounds: **8 evidence-driven, 0
authority-driven, 4 unclassified** (the classifier is deliberately
conservative; reading the four, each cites the docstring, the lifecycle
table or the repository — none defers to another reviewer).

Not one participant changed position by deferring. The consensus is
built from citations to the artefact, which is the only kind worth
having.

## C4 — who moved: the ANALYST, not the judges

11 of the 12 changes are mine; the judges moved once (sol on g03).
**I was wrong on 10 of 21 in round 1, for a specific and embarrassing
reason: I labelled against the SEEDED code while the judges read the
FINAL session state.** They quoted the artefacts I claimed were missing —
a docs section titled "Known gap — a swept job is not requeued", and
`stats()` returning `dead: store.dead.length` — and I revised.

The same defect broke the script's first round-1 run: `sourceBlock` fed
the judges `task.files` (the seed) instead of `codeContext(rows)` (start
AND end state from the recorded `file-state` rows). 13 of 21 issues are
about `stats`, `deadLetter`, `logSummary` or the docs — all written by
the DRIVER during the trajectory and absent from the seed — so the
judges correctly answered "not evidenced" and the run measured my prompt.
Fixed, re-run, and the fix is what produced the numbers above.
**The v2 probe got this right** (it used `codeContext`), so v2's
judgments are unaffected.

## C3 — the converged set, and how it differs

**Blocking (3 unanimous + 1 unresolved):**

| issue | status | found by | what it is |
|---|---|---|---|
| g01 | unanimous | MAIN, F, F2 | swept jobs keep `claimedBy`, so `claimNext` can never re-claim them |
| g07 | unanimous | **F only** | `requeue`/`deadLetter` skip the owner check `complete` performs — a stale-claim worker can permanently delete a job another worker is running |
| g13 | unanimous | **MAIN only** | `claimNext` check-then-await race: two workers claim and run the same job |
| s01 | **UNRESOLVED** (2-1) | nobody | `renewLease` computes expiry from the caller-supplied `now` |

v2's derived blocking set was {g01, g13}. The consensus set **adds g07**,
which v2 missed because only one judge called it blocking there. g07 was
also the one issue the analyst added independently in round 1.

**s01 dissent, recorded verbatim rather than averaged.** opus holds
`blocking: false` on a fact the others verified and accepted: no code in
the repo calls `renewLease` (worker.js imports `claimNext`, `complete`,
`stats` only), so the permanent capture needs a caller that does not
exist. sol and the analyst hold `blocking: true`: `renewLease` is
exported, documented public API, and the rubric names permanent resource
capture without conditioning on a present caller. **This is the
reachability convention the rubric never specifies — the same gap v1
identified.** It is a real definitional split, not noise, and forcing it
would have hidden the most useful thing the run found.

`anyHarm`: 11 of 21 issues judged real.

## Per-arm scores under the consensus set

| arm | blocking-tier (of 4) | unanimous-only (of 3) | claims raised | not-real |
|---|---:|---:|---:|---:|
| MAIN | 2 | 2 | 14 | **7** |
| F | 2 | 2 | 9 | 4 |
| F2 | 1 | 1 | 7 | **2** |

**This revises v4's headline.** v4 read MAIN 2/2 vs F 1/2 and concluded
MAIN was the recall winner. Under the consensus set MAIN and F **tie** at
2 of 3 unanimous blocking issues — they find *different* ones (MAIN the
concurrency race, F the permanent-deletion bug) — and F2 trails at 1.
The precision ordering is unchanged and now sharper: MAIN 7 not-real, F
4, F2 2.

So the honest statement is not "MAIN finds more". It is: **MAIN and F
find equally many top-tier issues but not the same ones, and MAIN is
markedly noisier.** F2 is the quietest and the least complete.

## Limits

One trajectory. Three unanimous blocking issues, so one flip moves an arm
by 33pp. The tie between MAIN and F rests on one issue each. `s01` was
found by no arm at all, which is why seeding the pool with planted
defects matters — it is the only reason a universally-missed defect is
visible in the reference set.
