# Frozen OpenAI trajectory — first Sol judgment pass (2026-08-02)

Status: **one judge column complete; not a score or design verdict.** The input
catalog is provisional golden candidate `2b0a85843c9be981`, and Opus has not run.
This pass exists to fill the Sol half without pretending it is consensus.

## Frozen result

- Producer rows and payloads: unchanged `2026-08-02-openai-trajectory` artifact.
- Judge protocol: `CAPSTONE-JUDGE-SPEC.md`, builder
  `df3cc0f57a725965` at code commit `369ed58`.
- 119 delivered findings across MAIN, F2, and ENUM.
- 107 findings judged in 29 point batches.
- 12 terminal run-end findings recorded as unjudgeable because the old runner
  did not freeze the final assistant message visible to the observer.
- 0 failed batches and 0 format-recovery turns.
- 168 atomic defect claims and 8 prescriptive findings that yielded no defect
  claim.
- 7 supported central claims carried a material unsupported extra.
- Sol marked every atomic central claim supported. This is one vote, not 100%
  precision: distinct-issue grouping and the independent Opus support vote are
  still absent.

The 12 missing-evidence findings are not silently dropped. They remain in the
checkpoint with the reason `unjudgeable-missing-final-assistant`. The fresh
trajectory runner now freezes `assistantMessage` on every point, so the gap does
not recur in the capstone producer wave.

## Raw review

The analyst read all 107 original delivered messages, all 168 parsed atomic
claims and reasons, and all 29 verbatim raw Sol responses after the pass.

Forty-three distinct unmatched claim statements remain after exact-string
deduplication (44 claim occurrences). Most are repeated variants of three
themes: the speculative `pluralize(-1)` change and missing test, overlapping
`running`/`expired` statistics, and branch/summary verification. They are
`pending-opus`, not bonus promotions. Semantic clustering, the Opus vote, and
analyst deliberation are still required.

The shakedown exposed one evaluator-granularity issue. A broad Sol claim that
“renewal, sweep, and completion paths” can overwrite newer state matched four
separate catalog issues, including specific consequences the neutral claim did
not itself name. Twenty other multi-match claims mainly reflect a narrower test
gap also matching the broad “scheduler modules untested” issue. The pass stays
immutable under its registered v1 protocol. Before any lock-in score, iteration
2 must sharpen atomic matching: a generic mechanism cannot earn a more specific
catalog consequence unless that consequence is stated, while legitimate
narrow-plus-broad coverage overlap must stay visible rather than being forced
into an arbitrary single id. Opus must first answer the identical v1 questions;
then the flagged multi-match subset receives the versioned follow-up rather
than rewriting this evidence.

## What this does and does not say

It does say that the two-judge path is replay-safe, that multi-finding ENUM
responses can be judged without collapsing their items, and that the old
artifact has a bounded evidence hole now fixed for future production.

It does **not** establish recall, precision, noise, a winning arm, or a golden-v2
result. Those require valid v2, the Opus file over the same frozen questions,
two-judge grouping/matching, and the registered scoring pass. No supported
unmatched claim was promoted from this Sol pass.

## Artifact

`artifacts/2026-08-02-openai-trajectory/judge-sol.json.gz` preserves metadata,
all 107 judgments, all 12 unjudgeable records, prompt/evidence hashes, and each
raw response. Its uncompressed SHA-256 is
`eb9f56b6f491fcf4c81b488480cf21010f31d47761ece0bf5583ef4e96643f6f`.

## Exact Opus replay basis

The original scratch resume note pointed at mutable working code and the
working dataset. That would cease to reproduce Sol after either advanced.
Preflight on 2026-08-03 verified the durable basis instead:

- judge commit `369ed58`, builder hash `df3cc0f57a725965`;
- rows SHA-256
  `a6766a5aae4e0f6233ff1fb0fce54e3fd4aeb4e5551d071d8bf2d840ade6865b`;
- payload archive SHA-256
  `369e5b1e1afc73611e9bcc0ff8a07d3cb5cde47db4f79a323b51c058d5074278`;
- frozen provisional dataset SHA-256
  `4035950fd2ff2fbf1ee515f1d3da88f9437eebd15db198d354d305b6f1fce8c0`;
- scheduler catalog hash `a4f32c23a111a979`.

The dataset is the copy frozen under
`artifacts/2026-08-03-openai-capstone-judge-basis/`. Run Opus from a detached
worktree at `369ed58`; do not use the current judge implementation. This yields
the same 119 findings, of which 107 are judgeable and the same 12 remain
unjudgeable.
