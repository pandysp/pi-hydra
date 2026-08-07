# Discarded judge option — Sealed Ledger

Status: **discarded as the default design, 2026-08-04.** Superseded by
`JUDGE-DESIGN-SELECTED.md`.

## Idea

Make evaluation an auditable conservation ledger. Every eligible observer
delivery ends as credited, disputed, dismissed, missed, or unresolved. Publish
recall bands instead of hiding one-judge matches, cross-examine selected
disagreements in both directions, and sample cases where both judges agree to
detect shared mistakes.

## Why it was not selected

- Too much machinery for the decision pi-hydra needs.
- Roughly 21% more judge calls than the existing process, despite deleting
  analyst agents.
- Requires decoy controls, multiple uncertainty registers, cross-examination,
  and special reading rules.
- Can spend a full iteration to produce no usable answer.
- Tries to bound every possible evaluator failure inside every run instead of
  making the ordinary path simple and auditing it selectively.

## What survives

- Every input must end in a mechanically checked terminal state.
- One-sided matches must remain visible rather than silently disappearing.
- A small seeded sample of agreements and misses should be manually audited.
- `not separated` is an acceptable result when evaluator uncertainty could
  change the ordering.

The original 845-line draft was intentionally reduced after the option was
discarded. Its binding evidence remains in `JUDGE-DESIGN-UNDERSTAND.md` and the
frozen experiment artifacts.
