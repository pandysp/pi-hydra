# Anthropic cost sweep — main contract (A0) vs footer (F), 2026-07-31

Cost-only sweep (no quality judging) requested by Andreas: is the footer's
cost comparable to main's shipped contract across Claude model classes and
reasoning efforts? 8 configs × {A0, F} × 12 screen cases × 2 samples = 384
planned rows; 372 completed (12 fable rows policy-blocked, see below).
Rows: `~/scratch/2026-07-31-hydra-anthropic-cost-sweep/rows.jsonl`, frozen
copy in `experiments/artifacts/2026-07-31-anthropic-cost-sweep/`.

Accounting: paired cells only (case/sample present in both arms). Measured =
harness usage.cost (prompt billed at cache-write 1.25×; sonnet driver below
the 1024-token cache floor, so its driver bills at write rates too).
Production-priced = driver at cache-read + prompt at input + output at output
rates, reconstructed per row from token columns (driver tokens = max
cacheRead per case). Both accountings agree on every sign.

## Result: comparable at medium; NOT comparable at high/xhigh.

Production-priced, per observation:

| Config | A0 | F | Δ | think A0 | think F |
|---|---:|---:|---:|---:|---:|
| sonnet-medium | $0.0030 | $0.0032 | +5.5% | 37 | 50 |
| sonnet-high | $0.0040 | $0.0060 | **+51%** | 139 | 329 |
| sonnet-xhigh | $0.0046 | $0.0075 | **+65%** | 201 | 487 |
| opus-medium | $0.0087 | $0.0102 | +17% | 113 | 178 |
| opus-high | $0.0106 | $0.0122 | +15% | 186 | 255 |
| opus-xhigh | $0.0103 | $0.0152 | **+48%** | 173 | 378 |
| fable-medium | $0.0177 | $0.0225 | +27% | 115 | 208 |
| fable-high | $0.0223 | $0.0294 | +32% | 202 | 343 |

## Mechanism: thinking, not answers, not retries.

Zero recoveries, zero multi-call rows in all 16 cells. F's *visible* output
is consistently under half of A0's (42–66 vs 92–107 tokens — the footer
answer is terser than the JSON). The entire gap is thinking tokens, billed
as output: A0's 120/240-char field caps act as an implicit deliberation
damper; the footer + envelope invite deliberation, and reasoning effort
multiplies it (F/A0 thinking ratio ≈1.3× at medium → ≈2.4× at xhigh).

Replication check: sonnet-medium F output 116 vs the screen's 119; A0 143
vs 142. The screen's medium-effort story is intact.

## Fable-5 policy blocks — deployment finding.

12 requests (fable only, all four cells, deterministic across the retry
pass) were refused by Anthropic's usage-policy layer: "violative cyber
content". Cases: screen-quality-emergency (6), screen-security-fresh-store-
fail-open (5), screen-security-rejected (1). The same cases pass on sonnet
and opus. Fable as an observer head can hard-refuse security-review
content; treat fable heads as unsuitable for security-lens observation
until probed further. Fable also prices at 2× opus ($10/$50 per M).

## What this changes

- Observer heads at **medium** effort (every prior experiment's setting):
  the standing verdict holds — Anthropic cost premium +5.5% (sonnet) to
  +27% (fable), against measured routing/quality gains.
- Observer heads at **high/xhigh** on Anthropic: F costs +32–65% vs main's
  contract. Before shipping high-effort Anthropic observers on F, either
  (a) pin observer-call thinking budgets independently of the driver's
  effort (runtime knob, no contract change), or (b) run the envelope-trim
  pass. Whether F's extra thinking *buys* quality at high effort is
  unmeasured (this sweep is cost-only) — do not assume rumination.
- OpenAI is out of scope here by request; its prior cost story (terra −15%)
  is unaffected.

## Limits

Cost-only (no judging). n=24/cell (12 cases × 2 samples; the 5 empty-state
dev cases of the original screen are not in `--corpus screen`). Fable cells
pair only 19–20 rows due to policy blocks. Anthropic billing via pi rides
Claude-Code identity headers (plan quota, not metered API) — all dollar
figures are list-price equivalents, which is what production API users pay.
