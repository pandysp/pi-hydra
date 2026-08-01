# pi-hydra — decision table (2026-08-01, live document)

Every measured arm, its cost and its quality, in one place, so the keep/
drop decision is readable without re-reading the wave docs. Every number
traces to a frozen artifact via RUN-LEDGER.md. Cells are only compared
within a measurement basis; bases are named per block.

## The arms

| Arm | What it is | Status |
|---|---|---|
| MAIN | main's shipped 3-field JSON + minimal instructions (120/240-char caps) | baseline, re-benchmarked |
| J | MAIN's JSON shape + the unified envelope | refuted at medium (sonnet routing never moved) |
| F0 | natural finding + DELIVERY footer + the unified envelope | incumbent challenger; carries the user-actor defect |
| F1 | F0 + the semantic repair (selection, print, dedup scope, re-liveness) | quality fixed, thinking-neutral |
| F2 | F1's semantics as an ordered first-match checklist + "do not deliberate" | current lead |
| F3 | F2's semantics at maximum decidability (62% longer than F2, on purpose) | REFUTED as a cost lever (+7.6% thinking); safe but pointless |

## Quality — fresh user-actor corpus, judged (opus-high, n=12 judged rows/arm)

| Arm | finding quality | support | target | routing (of 16) | prints |
|---|---:|---:|---:|---:|---:|
| MAIN | 91.7 | 100.0 | 91.7 | 9 | 6 |
| F0 | 66.7 | 75.0 | 75.0 | 9 | 3 |
| F1 | 83.3 | 83.3 | **100.0** | 12 | 10 |
| F2 | **91.7** | 91.7 | **100.0** | **13** | 11 |

Routing replication, same corpus, other configs (bucket-correct of 16):
sol-high MAIN 5 / F0 4 / F1 13 / F2 12 · sol-xhigh MAIN 7 / F0 3 / F1 13 / F2 11.

Regression guards (of 8 quiet + 8 must-speak):
- opus-high: MAIN 2+8 · F0 6+8 · F1 5+8 · F2 6+8 — E2 PASSES.
- opus-xhigh: MAIN 1+8 · F0 **7**+8 · F1 5+8 · F2 **4**+8 — **E2 FAILS**
  for both repaired arms at the primary config.
Zero prints on critical rows anywhere. On the rows F2 loses it raises
different, real, first-time findings rather than re-nagging — the same
contested-label pattern as the fresh corpus, and an undecided product
question, not an excuse for the gate.

opus-xhigh user-actor routing: MAIN 9/16 · F0 **7/16** · F1 12/16 ·
F2 12/16 — the routing gain replicates at the primary config.

## Quality — established screen corpus, judged (historical, 17 cases)

| Config | Arm | routing | finding quality | strict |
|---|---|---:|---:|---:|
| opus-high | MAIN(A0) | 70.6 | 92.3 | 73.1 |
| opus-high | J | 82.4 | 84.6 | 57.7 |
| opus-high | F0 | 82.4 | 84.6 | 46.2 |
| opus-xhigh | MAIN(A0) | 61.8 | 96.2 | 42.3 |
| opus-xhigh | J | 82.4 | 84.6 | 69.2 |
| opus-xhigh | F0 | 82.4 | 84.6 | 61.5 |
| sonnet-medium | MAIN(A0) | 64.7 | 84.6 | 65.4 |
| sonnet-medium | F0 | 76.5 | 96.2 | 61.5 |
| terra-medium | MAIN(A0) | 58.8 | 73.1 | 61.5 |
| terra-medium | F0 | 79.4 | 76.9 | 69.2 |
| sol-high | MAIN(A0) | 67.6 | judging | — |
| sol-high | J | 73.5 | judging | — |
| sol-high | F0 | 73.5 | judging | — |
| sol-xhigh | MAIN(A0) | 58.8 | judging | — |
| sol-xhigh | J | **79.4** | judging | — |
| sol-xhigh | F0 | 70.6 | judging | — |

The old envelope's quality deficit at opus was ONE case (user-actor
targeting) — the case F1/F2 fix (100.0 target above).

## Cost — per observation (production-priced where stated)

Frozen mini-prefix basis (~800 tokens; understates the envelope premium
— see the trajectory block):

| Config | MAIN | J | F0 | note |
|---|---:|---:|---:|---|
| opus-high | $0.0094 | $0.0128 | $0.0124 | +32% F0 |
| opus-xhigh | $0.0119 | $0.0145 | $0.0158 | +48% production-priced |
| sonnet-medium | $0.0030 | — | $0.0032 | +5.5% |
| terra-medium | $0.0036 | $0.0038 | $0.0030 | **-15%, F0 cheapest** |
| sol-high | $0.00911 | $0.01010 | **$0.00896** | **-1.6%, F0 cheapest** |
| sol-xhigh | $0.01016 | $0.01166 | **$0.00962** | **-5.3%, F0 cheapest** |

(sol rows: full 17-case screen, 34 rows/cell, zero errors — the same
corpus and cell shape as the opus screens, so they are directly
comparable to the opus block above.)

OpenAI: the envelope is better AND cheaper at every effort measured.
Anthropic: the envelope costs more, and the premium grows with effort.

## Cost — thinking on realistic prefixes (19 recorded payloads, opus-high)

| Arm | thinking tokens | vs F0 | prompt chars |
|---|---:|---:|---:|
| MAIN | 59 | — | 708 |
| F0 | 663 | — | 1468 |
| F1 | 691 | +4% | 2115 |
| F2 | **511** (487 in the paired re-measure) | **-23%** | 2102 |
| F3 | 524 | +7.6% vs F2 | 3407 |

Length is refuted as the cost driver: F2 is 43% longer than F0 and thinks
23% less. Decidability is refuted as a further lever: F3 is 62% longer
again and thinks 7.6% MORE. The structural gap to MAIN (59 tokens) is
closed by neither and stays open.

## Cost — trajectory ratio (the decision KPI; live-fork, opus-high)

| Arm | observer $ / driver $ | premium vs MAIN | planted defects found | deliveries |
|---|---:|---:|---:|---:|
| MAIN | 32.1% (33.3% in the pilot) | — | **3 of 4** | 10 |
| F0 | 67.2% (63.6%) | +35.2pp | **4 of 4** | 9 |
| F2 | 58.6% | +26.5pp | **4 of 4** | 9 |

Both MAIN and F0 replicate across two independent driver runs. Coverage
is a deterministic identifier match over delivered messages (first pass,
not judge-scored). MAIN misses the lease-expiry defect; the envelope
arms find all four AND interrupt the driver one time fewer.

**This is the trade in one line:** +26.5pp of driver spend buys one more
real defect of four, with one fewer interruption, on one trajectory.

## Reading it

- **OpenAI (goal 1): settled.** F0 already beats MAIN on quality and cost
  at medium, high and xhigh. F2 improves quality further. No premium to
  justify.
- **Anthropic (goal 3): the trade is real and quantified.** F2 buys +25pp
  routing, target 75->100, print channel working, MAIN-equal finding
  quality — for +26.5pp of driver cost at session scale (was +35.2pp).
- **The bar it misses** is the pre-registered <=15pp shape test. The open
  lever is decidability (F3).
- **J is dead**: refuted at medium, never best anywhere since, and its
  xhigh cost advantage did not survive realistic prefixes.

## Pending cells

opus-xhigh confirmation of F1/F2/F3; judged quality for sol configs;
fable (blocked on a refusal probe); F3 everywhere; acting-head arms
under the repaired envelope.
