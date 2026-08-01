# No-steer v2 — pre-registration (2026-08-01, before data)

v1 (NO-STEER-RESULTS.md, 4f1227e) found MAIN-NS skips 8/10 vs MAIN 5/10,
mean thinking -77%, planted-defect coverage UP (1.4 -> 2.5/sample), and
F2-NS unchanged from F2. Two problems keep it from being actionable:
Fisher p=0.175 at n=10 (underpowered), and one prefix at a DOC-WRITING
moment where enumeration is the natural response.

## Two questions, both cheap

**M1 POWER.** Re-run MAIN vs MAIN-NS at n=20 per variant on the SAME mid
prefix. Pre-registered: the effect is real iff the pooled Fisher test
(v1's 10 + these 20 = 30/variant) reaches p < 0.05 AND the skip-rate
direction is unchanged. If p >= 0.05 at n=30, the effect is not
established and no further no-steer work is licensed on cost grounds.

**M2 TRANSFER.** The v1 prefix sits at a doc-writing moment. Re-run
MAIN vs MAIN-NS, n=10 each, at a CODE-WRITING moment from the same
trajectory (a point where the driver's next act is an edit/write, not
prose — select it from the recorded rows and state which point and why).
Pre-registered: the label effect transfers iff MAIN-NS's skip rate
exceeds MAIN's at that prefix too. If MAIN-NS <= MAIN there, the v1
result is a doc-task artifact and must be reported as such.

Also recorded per prefix, not gated: planted-defect coverage per sample
(the N2 check — a cost win from not noticing is a loss), and whether the
response SHAPE shifts from single-urgent-item to enumeration.

## What this does NOT test

Driver-side cost of promoting every queue to steer. Untested hypothesis;
open-loop harness cannot see it; only a closed-loop run settles it. Any
recommendation carries that limit.

## Cost

Recorded-payload replay only. 40 + 20 = 60 calls, ~$1.20. Judges: none.
