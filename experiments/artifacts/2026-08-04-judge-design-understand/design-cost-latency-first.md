# Discarded judge option — cost and latency first

Status: **discarded, 2026-08-04.** Superseded by
`../../JUDGE-DESIGN-SELECTED.md`.

## Idea

Keep two complete judge passes, remove claim counts from published metrics,
route only judge disagreements onto a review docket, retry suspicious silence,
and buy one repeatability cell. Replace broad analyst alignment with targeted
cross-examination and code-based accounting.

## Why it was not selected

- It preserves most of the current architecture rather than removing its
  underlying complexity.
- Its own estimate was roughly 389–409 calls versus about 276 today and
  45–85% more wall-clock time.
- It reduces analyst agents but does not actually deliver the named priority:
  lower cost and latency.
- It occupies an unattractive middle: neither the simplest design nor the most
  defensible one.

## What survives

- Keep judge-authored claim counts out of published denominators.
- Checkpoint every batch and retry only unanswered work.
- Spend additional judgment on unmatched or disputed cases, not on settled
  catalog entries.
- Measure repeatability before treating a narrow margin as real.

The original 546-line draft was intentionally reduced after rejection. The
measurements it relied on remain in `../../JUDGE-DESIGN-UNDERSTAND.md` and
the frozen capstone artifacts.
