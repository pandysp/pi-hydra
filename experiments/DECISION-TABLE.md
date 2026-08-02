# pi-hydra — decision table (2026-08-01, live document)

Every measured arm, its cost and its quality, in one place, so the keep/
drop decision is readable without re-reading the wave docs. Every number
traces to a frozen artifact via RUN-LEDGER.md. Cells are only compared
within a measurement basis; bases are named per block.

## READ FIRST — every "quality" number here uses the OLD definition

`findingQuality` = the message identified THE ONE seeded finding for that
case, and the claim is supported. Both judges must agree. That is
PRECISION ON A PRE-LOCALISED FINDING. It is structurally unable to
express recall (one `findingTarget` per case across all 35 judged cases;
extra real findings are penalised by the strict variant, never rewarded;
median case 949 chars vs 19-38k-token real trajectories).

So every quality claim below should be read as "best at identifying the
single planted finding", NOT "finds the most real issues". This
definition is UNDER ACTIVE CHALLENGE (SEVERITY-PROBE-SPEC v1/v2). If
severity pooling becomes viable, the frozen artifacts should be
RE-SCORED under it — zero producer spend, every delivered message is
already stored.

Not affected: routing/bucket numbers (judge-free comparison of chosen vs
expected delivery) — though those depend on corpus expected-labels, which
are assigned by fiat and have produced contested cases twice.

Directional hint against MAIN that the current metric cannot see
(severity v1): MAIN raised 5 issues both judges called NOT REAL, vs F 2
and F2 1. A precision-aware metric would charge for that.

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
| sol-high | MAIN(A0) | 67.6 | 76.9 | — |
| sol-high | J | 73.5 | **92.3** | — |
| sol-high | F0 | 73.5 | 80.8 | — |
| sol-xhigh | MAIN(A0) | 58.8 | 84.6 | — |
| sol-xhigh | J | **79.4** | **92.3** | — |
| sol-xhigh | F0 | 70.6 | 80.8 | — |

**J IS NOT DEAD ON OPENAI (2026-08-01).** Judged at both sol configs it
is the QUALITY winner (92.3 fq, 100 support at both) and matches or beats
F0 on routing. Its refutation was Anthropic-medium-specific (sonnet
routing never moved). My "J is dead" line below is withdrawn for OpenAI
and stands only for Anthropic.

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
| MAIN | 32.1% (33.3% in the pilot) | — | see below | 10 |
| F0 | 67.2% (63.6%) | +35.2pp | see below | 9 |
| F2 | 58.6% | +26.5pp | see below | 9 |

Both MAIN and F0 replicate across two independent driver runs.

### COVERAGE: RETRACTED TWICE, NOW UNSCORED PENDING JUDGES

I published planted-defect coverage from a KEYWORD MATCH (does the
delivered message contain the defect's function name while the defect is
live). Reading all 28 delivered messages shows the matcher fails in BOTH
directions:
- it credited the envelope arms with `sched-lease-caller-clock` because
  their messages say "renewLease" while describing a DIFFERENT bug
  (stats() dropping NaN leases);
- it credited MAIN with `sched-requeue-resets-attempts` because the word
  "requeues" appears inside a sentence about the sweep.

Scored by READING the messages against each planted target:

| Arm | precisely named | which |
|---|---:|---|
| **MAIN** | **2 of 4** | the TOCTOU race ("claimNext has a check-then-await race (two workers can claim the same job)") AND the stranded-claim bug |
| F0 | 1 of 4 | the stranded-claim bug |
| F2 | 1 of 4 | the stranded-claim bug |

**MAIN is the BEST arm on planted-defect recall on this trajectory, not
the worst.** It alone named the concurrency race precisely. The envelope
arms found the stranded-claim defect and then spent 5-6 observations on
stats() NaN-lease bucketing — real, well-described bugs, but not the
planted ones, and repeatedly re-described across successive points.

So the earlier claims "the envelope catches the defect MAIN misses" and
"F2 alone is 4/4" are BOTH WITHDRAWN. They were artifacts of the keyword
matcher, published three times before I read the underlying text.

What stands: no coverage claim is defensible without JUDGED scoring. The
S1 multi-label coverage judge ("which of these planted defects does this
message identify?") makes neither error. It is built and unfunded, and it
is now a precondition for any recall claim in this program.

## Reading it

- **OpenAI (goal 1): settled.** F0 already beats MAIN on quality and cost
  at medium, high and xhigh. F2 improves quality further. No premium to
  justify.
- **Anthropic (goal 3): the trade is real and quantified.** F2 buys +25pp
  routing, target 75->100, print channel working, MAIN-equal finding
  quality — for +26.5pp of driver cost at session scale (was +35.2pp).
- **The bar it misses** is the pre-registered <=15pp shape test. The open
  lever is decidability (F3).
- **J is dead ON ANTHROPIC ONLY**: refuted at sonnet-medium, and its
  xhigh cost advantage did not survive realistic prefixes. On OPENAI it
  is the judged quality winner at high and xhigh (92.3 fq vs F0's 80.8).
  Withdrawn as a global verdict.

## Pending cells

opus-xhigh confirmation of F1/F2/F3; judged quality for sol configs;
fable (blocked on a refusal probe); F3 everywhere; acting-head arms
under the repaired envelope.

## Instrument limitation found 2026-08-01 — why the screens could not see this

The frozen-case screens and the trajectory benchmark measure DIFFERENT
things, and every quality verdict before today came from the former.

Verified in code and corpus:
1. **One expected finding per case.** All 35 judged cases carry exactly
   one `findingTarget`; ZERO carry more (checked programmatically). The
   judge asks "does the delivered message identify THIS issue?"
   (`delivery-context-judge-protocol.mjs:40`). There is no way to express
   "and it also found three other real defects".
2. **Extra findings are penalised, not rewarded.** `findingQualityStrict`
   fails a row on `unsupportedExtra` — the only sensitivity to finding
   MORE points the wrong way for recall.
3. **Cases are tiny and pre-localised.** Median case trajectory is 949
   characters, max 2158. Real driver trajectories are 19-38k TOKENS. In a
   949-char case the defect is legible in one pass — exactly the
   condition under which MAIN answers correctly with ZERO thinking.

So: screens measure PRECISION on a salient, pre-localised finding;
the trajectory measures RECALL across a real haystack. MAIN is genuinely
good at the first (91.7-96.2 findingQuality) and worse at the second
(3/4 planted defects vs the envelope's 4/4). The screens are not wrong —
they are scoped to a question that systematically favours snap judgment.

Consequence: the trajectory benchmark's planted-defect coverage (built,
S1 judging unfunded) is the metric that matches what observers are FOR.
Funding it is the highest-value next measurement in this program, ahead
of any further contract iteration.

## No-steer probe (2026-08-01) — the cost mechanisms DISSOCIATE

Removing `steer` from the vocabulary (runtime would promote queue->steer),
10 samples, mid prefix L=20,165, opus-high:

| variant | skips | mean thinking | planted defects named/sample |
|---|---:|---:|---:|
| MAIN | 5/10 | 569 | 1.4 |
| **MAIN-NS** | **8/10** | **132 (-77%)** | **2.5** |
| F2 | 0/10 | 933 | 1.6 |
| F2-NS | 0/10 | 838 (unchanged) | 1.4 |

**The label is MAIN's cost driver; it is NOT the envelope's.** F2 is
unmoved by removing steer — its cost is the RULE SURFACE, which is why
framing (-23%) and decidability (+7.6%) both failed on it. Two distinct
cost mechanisms, previously conflated.

The MAIN win is not blindness: coverage ROSE (1.4 -> 2.5 planted defects
per sample) and deliveries rose (10/10 vs 2 noops). One zero-thinking
sample named three planted defects; MAIN's most expensive sample (1295
tokens) named one.

SETTLED AT n=30 (no-steer v2, e731a37): MAIN 13/30 skips vs MAIN-NS
**28/30**, Fisher **p=2.7e-05**. The fresh n=20 run had MAIN-NS emit ZERO
reasoning on all 20 samples. The label effect on MAIN is established.
Transfer to a code-writing moment is UNINFORMATIVE, not negative: both
arms skipped 10/10 there because MAIN routed zero steers — already at the
floor, nothing for the label to remove.

SECOND EFFECT, not obviously good: removing the label also moves the
SPEAK/STAY-SILENT threshold. At the code moment MAIN is silent 10/10
while MAIN-NS delivers 7/10 grounded observations. Whether that extra
speech helps is the chattiness question, which has no evidence either
way.

Still open:
- One prefix, one task moment, and that moment is a DOC-WRITING task
  where enumeration is the natural response. Transfer to a code-writing
  moment is untested.
- Driver-side cost of promoting every queue to steer is an untested
  hypothesis (open-loop harness cannot see it).

Hypothesis it raises, bigger than the label: the expensive act is
SELECTION (pick the one most urgent thing AND justify interrupting),
not FINDING. Enumeration is cheaper and more complete. If that holds,
the cheap high-coverage design lets observers enumerate and lets the
runtime triage — a product direction, not a wording tweak.


## Judged quality on OpenAI — fresh user-actor corpus (n=12 judged/arm)

| Config | metric | MAIN | F0 | F1 | F2 |
|---|---|---:|---:|---:|---:|
| sol-high | finding quality | **33.3** | 66.7 | **75.0** | 58.3 |
| sol-high | routing | 31.3 | **25.0** | **81.3** | 75.0 |
| sol-xhigh | finding quality | 41.7 | 58.3 | **66.7** | 58.3 |
| sol-xhigh | routing | 43.8 | **18.8** | **81.3** | 68.8 |

MAIN COLLAPSES on OpenAI user-actor cases (33-42 quality vs the repaired
arms' 67-75). F0's routing is catastrophic there (18.8-25%); the repair
lifts it to 81%.

**Provider split, unexpected:** the framing arm F2 is best on Anthropic
opus-high (91.7 fq) but WORSE than the unframed repair F1 on OpenAI
(58.3 vs 75.0), consistently at both sol configs. Framing appears to help
Claude and hurt GPT. Thin (2 rows at n=12) but consistent. Consequence:
the contract FAMILY generalises across providers; WHICH repaired variant
may not. That is an instruction-text choice, so it stays inside the
branch-cost rule either way.

## ENUM — enumeration dominates on the resolved metric (2026-08-01)

One observation point (mid prefix L=20,165), 10 samples/arm, opus-high,
scored on the RESOLVED metric (blocking/anyHarm binary axes; judge
harmIfExecuted agreement 72.7% in this cell, better than v2's 61.9%):

| arm | blocking | any-harm | precision | claims/msg | thinking | $/obs |
|---|---:|---:|---:|---:|---:|---:|
| MAIN | 2/2 | 3/8 | 95.0% | 3.67 | 289 | $0.0214 |
| F2 | 1/2 | 1/8 | 90.0% | 3.00 | 785 | $0.0474 |
| **ENUM** | **2/2** | **7/8** | 92.0% | **7.30** | **0** | **$0.0220** |
| ENUM+D | 2/2 | 5/8 | 91.7% | 9.00 | 1466 | $0.0613 |

ENUM: both blocking issues, 2.3x MAIN's any-harm recall, zero thinking on
10/10 samples, at MAIN's price and under half F2's. Precision -3pp.

**The support clause is a cost catastrophe, not a precision lever.** One
57-character sentence took thinking 0 -> 1466 and cost 2.8x. Its
pre-registered precision test FAILED (not-real 2 -> 2). Largest
single-sentence cost effect measured in this program.

Honest qualifications:
- The precision lever was tested where the problem was absent (MAIN: 5
  not-real in the C2 pool, 1 here). P2 is refuted as written; the
  tradeoff is NOT established as intrinsic.
- The "noise" is mostly not fabrication: 1 of 3 not-real issues was
  raised by ALL FOUR arms (stale, the driver fixed it later); the other
  two are process complaints, not invented defects.
- ONE POINT sampled 10x, not a trajectory. Recall = "surfaced at least
  once in ten tries" — fair across arms, but not the trajectory
  measurement. ENUM needs a live-fork trajectory run before it takes the
  lead in this table.

## Top-tier recall — CONSENSUS SET (supersedes the v4 numbers, fa0e34c)

The deliberated set (3 participants, 95.2% convergence) contains THREE
unanimous blocking issues, one more than v2 found:

| issue | found by |
|---|---|
| swept jobs keep `claimedBy` | MAIN, F, F2 |
| `requeue`/`deadLetter` skip the owner check -> permanent deletion | **F only** |
| `claimNext` check-then-await race | **MAIN only** |
| caller-supplied lease expiry | **nobody** (unresolved 2-1) |

| arm | top-tier (of 3) | claims | both-judges-not-real |
|---|---:|---:|---:|
| MAIN | **2** | 14 | **7** |
| F | **2** | 9 | 4 |
| F2 | 1 | 7 | **2** |

**MAIN and F TIE on top-tier recall and find DIFFERENT issues.** The
earlier "MAIN is the recall winner" reading (v4, from a 2-issue set) is
WITHDRAWN — v2 missed the owner-check defect because only one judge
called it blocking there. What separates the arms is precision: 7 / 4 / 2
not-real claims.

Consensus quality: 42.9% independent -> 95.2% deliberated (+52.3pp, far
above the 5pp ceremony bar); 12 position changes, 8 evidence-driven,
**0 authority-driven**. One issue stays UNRESOLVED 2-1 and is recorded as
dissent, never averaged: opus holds not-blocking because nothing calls
`renewLease`; sol and the analyst hold blocking because it is exported
public API. That is the reachability convention the rubric still does not
specify — the same gap that broke v1.

**Untested product implication, and it is specific to what pi-hydra IS.**
This is a MOB tool: several heads observe at once. Two contracts with
different blind spots each caught a top-tier defect the other missed, so
a mob of HETEROGENEOUS observers should strictly beat a mob of identical
ones. Every screen in this program compared arms as SUBSTITUTES; none
tested them as COMPLEMENTS. Cheap to test on rows we already have: union
the top-tier finds of any two arms and compare against either alone.

## ENUM on a live trajectory (opus-high) — cost AND coverage

One driver run, 15 points, three arms paired
(experiments/ENUM-TRAJECTORY-RESULTS.md, artifacts 2026-08-01-enum-trajectory):

| arm | observer $/driver $ | deliveries | mean thinking | zero-think | output tok |
|---|---:|---:|---:|---:|---:|
| MAIN | **23.0%** | 8 | 0 | 12/12 | 111 |
| F2 | 42.6% | 9 | 579 | 4/14 | 644 |
| **ENUM** | 32.5% | **11** | **0** | **13/13** | 410 |

| arm | blocking-tier | any-harm | claims | not-real | precision |
|---|---:|---:|---:|---:|---:|
| MAIN | 0/1 | 5/12 | 27 | 4 | 42.9% |
| F2 | 0/1 | 5/12 | 22 | 1 | — |
| **ENUM** | **1/1** | **11/12** | 91 | 7 | **73.1%** |

ENUM alone found the unanimously-blocking TOCTOU race. It is MORE precise
than MAIN (73.1% vs 42.9%) while making 3.7x the claims — saying more did
not make it noisier than the shipped baseline, only than F2 (quieter,
costlier, blind to the blocking issue). Its cost premium over MAIN is
VOLUME (410 vs 111 output tokens), both at zero thinking.

Shape: ENUM 4.09 findings/message; both baselines exactly 1.00 — MAIN's
single `message` field and F2's "write ONE concise lens finding" are the
same ceiling reached two ways.

Limits: n=1 trajectory; ONE blocking issue in the pool, so that column
flips on a single judgment; quiet span 2 points vs 3 required, so
false-interrupt rate is unmeasurable here; both baselines shifted vs C2
(different driver run) — the paired within-run comparison is the load-
bearing one.

## ENUM config sweep — zero thinking transfers to opus-xhigh

(experiments/ENUM-CONFIG-SWEEP-RESULTS.md, artifacts 2026-08-01-enum-config-sweep)

| prefix | MAIN | F2 | ENUM |
|---|---|---|---|
| mid 20k | 4/10 skips, mean 688 | 1/10, mean 788 | **10/10, mean 0** |
| long 38k | 10/10, mean 0 | 0/10, mean 804 | **10/10, mean 0** |

ENUM is the ONLY arm that skips at both prefixes. At mid, MAIN
deliberates on 6 of 10 samples where ENUM deliberates on none — at
opus-xhigh ENUM is CHEAPER THAN MAIN on the axis that drives cost, not
merely inheriting MAIN's cheapness. Volume transfers (3.50 and 5.00
findings/message vs baselines' 0.80-1.00), so the contract is followed
and the thinking number is interpretable. Format validity 10/10 every arm
every cell; the one parse failure was F2's.

Cost, long prefix: MAIN $0.0233, ENUM $0.0339, F2 $0.0653 — ENUM 48%
below F2.

**OpenAI NOT measured, structurally.** Recorded payloads ARE Anthropic
API requests and the merge path is Anthropic-typed, so replay against GPT
is impossible; it needs a real codex driver run. Funded and running
(ENUM-GENERALISATION-SPEC). The agent correctly refused the available
shortcut — the frozen-case harness supports sol but answers on ~800-token
prefixes, and every cost effect here moves with prefix length.

**ENUM's established scope: opus-high and opus-xhigh, one task
(scheduler). Unmeasured on exporter/dispatcher** — running.

## ENUM on OpenAI — real sol trajectories (2026-08-02): the cost shape INVERTS

(experiments/OPENAI-TRAJECTORY-RESULTS.md, artifacts
2026-08-02-openai-trajectory; basis: live sol driver trajectories,
scheduler, arms paired at production points — not comparable cell-by-cell
to the Anthropic trajectory block, whose driver costs 2x per turn.)

| cell | arm | observer $/driver $ | $/obs | mean thinking | skip | findings/msg |
|---|---|---:|---:|---:|---:|---:|
| sol-high | MAIN | **51.1%** | $0.0212 | 253 | 0/16 | 1.00 |
| sol-high | F2 | 57.3% | $0.0223 | 227 | 1/17 | 1.00 |
| sol-high | ENUM | 69.1% | $0.0270 | 402 | 1/17 | 2.12 |
| sol-xhigh | MAIN | **58.7%** | $0.0269 | 405 | 0/14 | 1.00 |
| sol-xhigh | F2 | 64.0% | $0.0293 | 401 | 0/14 | 1.00 |
| sol-xhigh | ENUM | 87.5% | $0.0401 | 775 | 0/14 | 3.00 |

**N1 REFUTED: ENUM's zero-thinking is Anthropic-only.** 2 zero-reasoning
rows in 92 valid sol observations across ALL arms. On sol, thinking does
not track delivery type (`queue` rows think MORE than `steer`, and `none`
rows think) — the skip mechanism the whole Anthropic cost story rests on
is Claude adaptive-thinking behavior, not a contract property. GPT-5.6
reasoning at high/xhigh is effectively always-on; no contract earns a
skip discount there, and every label/anti-deliberation lever is
Anthropic-scoped.

Reading: **enumeration is the cheap arm on Anthropic and the expensive
arm on OpenAI** (MAIN +60-90% thinking, most output). Second provider
split of this kind (framing was the first). A per-provider contract
choice stays instruction-text-cheap and allowed; a unified recommendation
assuming ENUM's cost profile generalises is refuted. ENUM's sol premium
is unjustified until judged sol coverage shows its extra findings earn
18-29pp of driver cost. Contracts were followed everywhere (format 92/92,
ENUM genuinely enumerating at 2.12-3.00 findings/msg, below its Anthropic
4.09).
