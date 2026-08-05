# pi-hydra — decision table (updated 2026-08-05, live evidence inventory)

Every measured arm, its cost and its quality, in one place. Cells are only
compared within a named measurement basis. Completed measurements trace to
RUN-LEDGER.md; the failed-threshold golden-v2 candidate is not frozen evidence.

> **CURRENT STATUS.** Golden v3 (`d176183abab2d211`, 2026-08-05) is the valid
> ruler: the iteration-2 fold applied 27 byte-verified settled outcomes to v2
> (75 active, 26 blocking, checker 8/8; ledger row
> `2026-08-05-golden-dataset-v3-fold`). Every number in this table was
> computed against v2 (`0aadc215658a775b`) or v1 and stays valid as recorded
> history; nothing here has been rescored against v3 yet. Golden v2 was built
> under the prospectively adopted protocol decision
> (`GOLDEN-V2-PROTOCOL-DECISION.md`, Option A — Andreas, before any arm was
> scored against v2; raw convergence 63/67 stays recorded, four dissents
> carried verbatim). Golden v1 (`4ea27b0018705940`) remains the basis of the
> historical golden-v1 blocks.
> Both Opus columns, the 371-finding cross-judge consensus, and the first
> 18-cell capstone table are complete. That table is a shakedown, not lock-in
> evidence: the mandatory data pass found material anchor, denominator,
> precision-unit, eligibility, and one-sided-judge-silence problems.
> Andreas selected the expanded 2Q / dual-catalog judge architecture
> (`JUDGE-DESIGN-SELECTED.md`); it is implemented and mechanically verified
> (45-finding sample terminally valid), and the iteration-2 recovery is
> executed: golden v3 folded (`GOLDEN-DATASET-V3-RESULTS.md`), the blinded
> human queue holds 11 items, and the v3 rescore is split by provider quota
> (Opus half done, Sol half pending). On 2026-08-02 Andreas made the product
> choice:
> ENUM-SO2 for both providers, with queue removed from model-facing prompts and
> schemas but retained internally. This is a deliberate choice under OpenAI
> uncertainty, not a benchmark verdict; a provider text split remains open if
> the later capstone shows ENUM's OpenAI premium does not earn its keep.
>
> **CURRENT STOP LINE.** Preserve iteration 1 exactly. Before any iteration-2
> score is read: Andreas rules the blinded queue (11 dataset-repair items +
> 12 sample disagreements, including the requested-test vs process-advice
> rule), the Sol half of the v3 sample completes, and both catalogs are
> frozen. Known-case tuning remains forbidden; repeated calls never become
> extra consensus votes.

## READ FIRST — quality bases differ

The early screen blocks use `findingQuality`: whether the message identifies
the one pre-localised seeded finding and supports the claim. That measures
precision on short cases, not recall across a real trajectory. One target per
case, a median 949-character trajectory, and penalties for extra findings make
those blocks structurally unable to answer “which arm finds the most real
issues?”

The later trajectory blocks and golden-v1 section use deliberated issue sets
and message-level credit. They can report blocking recall, any-harm recall and
precision, but they still predate the unfinished v2 expansion. Routing and cost
remain separate axes throughout. Read each block under its stated basis; never
carry a screen ranking into a trajectory or production claim.

## The arms

| Arm | What it is | Status |
|---|---|---|
| MAIN | main's shipped 3-field JSON + minimal instructions (120/240-char caps) | baseline, re-benchmarked |
| J | MAIN's JSON shape + the unified envelope | refuted at medium (sonnet routing never moved) |
| F0 | natural finding + DELIVERY footer + the unified envelope | incumbent challenger; carries the user-actor defect |
| F1 | F0 + the semantic repair (selection, print, dedup scope, re-liveness) | quality fixed, thinking-neutral |
| F2 | F1's semantics as an ordered first-match checklist + "do not deliberate" | historical screen leader; not a lock-in verdict |
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

### Historical coverage retraction — later superseded by golden v1

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

At this stage no coverage claim was defensible without judged scoring. Golden
v1 later supplied that ruler and rescored the frozen rows; see the current
golden-v1 section below. The retraction remains here because it explains why
keyword coverage must never return.

## Historical reading before golden v1 and provider generalisation

- The short screens made F0/F2 look settled on OpenAI and quantified an
  Anthropic routing-versus-cost trade. Those are screen-scoped findings, not a
  final product decision.
- F3 failed as a cost lever. J was refuted on Anthropic but later won the judged
  OpenAI screen, so “J is dead” remains withdrawn as a global verdict.
- Later real trajectories changed the picture: ENUM is cheap on Claude but the
  expensive arm on OpenAI, and cross-task precision varies sharply.

Do not lock a design from this historical reading. The current decision waits
for valid v2 and the capstone table.

## Remaining cells

Completed later in this document: opus-high/xhigh cost work, judged sol screens,
real OpenAI trajectories, cross-task trajectories, golden v1 and steer-only.
Still open or deferred: valid golden v2, the Opus and Anthropic capstone columns
and benchmark iterations, fable's refusal-gated verdict, acting-head
confirmation, and the final shipped-text confirmation.

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

So: screens measure precision on a salient, pre-localised finding; trajectories
are where recall across a real haystack becomes measurable. The screens are not
wrong, but their scope systematically favours snap judgment. The earlier 3/4
versus 4/4 planted comparison was itself withdrawn after the raw messages were
read; golden-v1 credit later replaced it.

Consequence at the time: build a judged trajectory ruler before further
contract iteration. That work produced golden v1. The current consequence is
to finish v2 and run the already-registered capstone.

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
- Driver-side effect and cost of promoting every queue to steer is an untested
  hypothesis (open-loop harness cannot see it).

Hypothesis it raises, bigger than the label: the expensive act is
SELECTION (pick one most urgent finding under the old high-bar delivery
wording), not FINDING. Enumeration is cheaper and more complete. If that holds,
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
quiet-span delivery rate is unmeasurable here; both baselines shifted vs C2
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

**At this stage OpenAI was not measured.** Recorded payloads are Anthropic API
requests and cannot be replayed against GPT, so the comparison required a real
codex driver run. That run later completed; the next block records the result.
The refused shortcut was still correct: the frozen-case sol harness answers on
~800-token prefixes, while every cost effect here moves with prefix length.

**ENUM's established scope: opus-high and opus-xhigh; cross-task
generalisation measured 2026-08-02 — see the cross-task block below.**

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

## Cross-task trajectories (2026-08-02): the ordering generalises, precision does not

(experiments/CROSS-TASK-TRAJECTORY-RESULTS.md, artifacts
2026-08-02-cross-task-trajectory; opus-high, arms paired, within-run
comparisons only — driver cost is the denominator and moves per task.)

| task | MAIN | ENUM | F2 |
|---|---:|---:|---:|
| scheduler (ref) | **23.0%** | 32.5% | 42.6% |
| exporter | **47.4%** | 61.4% | 73.5% |
| dispatcher | **37.4%** | 47.3% | 61.4% |

Cost ordering MAIN < ENUM < F2 on 3 of 3 tasks; ENUM undercuts F2 by
10-14pp everywhere. ENUM's zero-thinking mostly transfers (16/17
dispatcher, 13/15 exporter zero-think) but is not unconditional.

Coverage (per-task judged pools; golden-v1 blocking recall in
parentheses):

| task | arm | any-harm | precision | golden blocking |
|---|---|---:|---:|---:|
| exporter | MAIN | 2/18 | 50% | 0/3 |
| exporter | F2 | 7/18 | 78% | 1/3 |
| exporter | **ENUM** | **15/18** | 67% | **2/3** |
| dispatcher | MAIN | 5/12 | 73% | 2/3 |
| dispatcher | F2 | 7/12 | 75% | 2/3 |
| dispatcher | **ENUM** | **10/12** | **54%** | 2/3 |

ENUM was the only arm to raise golden exporter blockers (the CR
quote-class and NaN-limit defects). **Disclosed cost: ENUM's precision
drops to 54% on the dispatcher** (13/28 not-real, mostly test-coverage
nitpicks) — "more precise than MAIN" was a scheduler observation, not a
property of enumeration. First quiet-span delivery data in the program: F2
steered twice inside the dispatcher's quiet span; MAIN and ENUM zero on
both tasks. Known open calibration item: this run's two-judge pools sit
one tier below golden-v1 (serious vs blocking) on all three exporter
blockers; flagged, neither instrument preferred. 2 of 6 planted defects
across the two tasks were missed by every arm.

## Steer-only — queue deleted from the vocabulary (2026-08-02)

(experiments/STEER-ONLY-RESULTS.md, artifacts 2026-08-02-steer-only;
recorded-payload point L=20,165, n=10/cell, opus-high AND opus-xhigh,
$5.70. Andreas's proposal: steer absorbs queue.)

| variant | delivery | thinking |
|---|---|---|
| MAIN-SO (original wording) | none 20/20 — **SILENT** | 0, nothing delivered |
| MAIN-SO2 (one-sentence repair) | steer 20/20, grounded | **~2× same-run MAIN** (696/870 vs 349/463) |
| ENUM-SO and ENUM-SO2 | steer 20/20 each | **0 on all 40 rows** |
| F2-SO | steer 10/10, unchanged | usual band |

Reading: the label collapse is FREE for ENUM, costs MAIN ~2× thinking
(every delivery now pays the selection-commitment that queue used to
avoid), and F2 is indifferent. MAIN's total silence under the original
wording was the PROMPT (a high act-on bar beside the interrupt ladder,
nothing saying steer is the normal channel), not the label set — the
repair is one sentence: "Steering is the normal and only way to reach
the agent and folds in at its next checkpoint." Mechanism refinement:
deliberation attaches to COMMITTING a selected delivery, not to the
steer label itself. Both vocabularies are instruction text over the
same footer parser — no code branch either way. Benchmark carries
MAIN-SO2 and ENUM-SO2 as the steer-only arms. Runtime wording sites for
after lock-in: utils.ts:394/402/433/446.

## Golden dataset v1 — the regression ruler exists (2026-08-02)

(experiments/GOLDEN-DATASET-V1-RESULTS.md, `golden-dataset.json` version
`4ea27b0018705940`; scoring is deterministic and free.)

46 active issues (17 blocking, 29 harmful) + 26 recorded rejections;
convergence 45.8%→95.4% plus a 7/7-unanimous re-judged slice, zero
authority-driven changes, two dissents recorded verbatim. Whole-set
blocking recall from frozen artifacts: MAIN 2, F 2, F2 1 of the 11
scheduler blockers arms ever observed — and **25 of 37 scheduler issues
(8 blocking) were found by NO arm**. That blind spot, not the 1-issue
differences between arms, is the headline: contract tuning moves recall
by single issues while the pool holds eight blockers nobody surfaces.
Heterogeneous lenses (his "different heads") and coverage-first contracts
are the levers that could reach it.

## Golden dataset v2 — historical failed checkpoint (2026-08-02/03)

This block preserves the state before Andreas's prospective Option A decision.
It is superseded by final v2 and the iteration-1 block below; do not read its
present-tense sentences as the live plan.

Local checkpoint `d96123b` contains provisional version
`2b0a85843c9be981`: 75 active issues (28 blocking, 47 harmful) and 61 recorded
rejections across scheduler, exporter and dispatcher. It must not be cited as
golden v2. The precision pass completed on 2026-08-03: CL52 converged, but CL38
held a stable 2–1 tier dissent through all three allowed rounds. Novel
consensus is now 63/67 (94.0%), below the unchanged 95% freeze bar.
The recovery repaired full-schema coverage, rejection-reason vocabulary and
frame-aware anchor resolution; `golden-dataset.check.mjs` now passes 8/8.
The normal builder fails closed at that exact count. There is no
`GOLDEN-DATASET-V2-RESULTS.md`, freeze or ledger entry, and no fourth pressure
round or post-result denominator/statement adjustment is legitimate.
The final freeze is now mechanically staged by
`golden-dataset-v2-freeze-stage.mjs`, but its fail-closed gate cannot run until
an explicit prospective protocol decision produces a qualifying,
non-provisional dataset and results document. The provisional artifact remains
immutable; any eventual final freeze will use a new run id.

## Capstone benchmark — historical producer-first checkpoint

This block preserves what was known before Opus, consensus, and iteration-1
scoring completed. The current evidence begins at the iteration-1 block below.

`BENCHMARK-SPEC.md` freezes the scoring design and 2–3 iteration protocol.
The steer-only input is complete. The producer-first OpenAI amendment is now
complete and frozen; Anthropic production still waits for valid v2. No scored
baseline/arm table against v2 exists. Andreas selected
unified ENUM-SO2 as the implementation direction before that evidence and will
revisit a provider-specific text branch if the OpenAI result is not worth its
measured cost premium. Raw-response review then confirmed that mixed per-finding
actions are common: the runtime therefore partitions ENUM output by recipient
into at most one user-only print and one agent steer/interrupt delivery. The
agent batch interrupts only when one of its own findings chose interrupt. This
is a product routing decision, not a new producer result; prompt hashes and the
frozen arm evidence do not change.

The first registered Sol trajectory-judgment pass is now complete over 107 of
119 frozen OpenAI findings; 12 terminal findings are explicitly unjudgeable
because the old artifact omitted their final-assistant evidence. This is one
judge column, not a score: Opus, valid v2, and final issue grouping are absent.
Raw review also registered an iteration-2 matching refinement for broad claims
that otherwise inherit specific unstated consequences. The immutable v1 pass
produced no promotion and no arm verdict; see
`OPENAI-TRAJECTORY-SOL-PASS.md`.

The fresh OpenAI protocol study is complete. Its nine cases were committed in
`95a8f4d` before the exact terse and no-interrupt prompts existed; all 144
registered calls completed for $3.37301 and the blinded Sol pass accepted
436/444 findings. Both exact simplifications are refuted. Terse cuts characters
per finding by about 40% but increases output by 41% overall and loses planted
blocking recall. No-interrupt increases output by 22%; it correctly steers four
proposed-danger findings but can only steer eight genuine in-flight emergencies
that control correctly interrupts. The interaction arm also sends planted
driver findings to `print`. One supposedly quiet case was invalid and remains
excluded rather than relabeled; its final eight-finding judge batch remains
strictly unaccepted after repeatable opaque-key transcription failures. See
`OPENAI-PROTOCOL-STUDY-RESULTS.md`. The unchanged ENUM-SO2 control is the only
study arm admitted to the OpenAI capstone matrix.

The exact OpenAI production matrix was registered before spend in
`OPENAI-CAPSTONE-PRODUCER-SPEC.md` and all six cells completed for $12.9608.
MAIN is cheaper in every task/config cell. Across comparable rows MAIN costs
$0.0253/observation and 52.1% of driver cost; ENUM costs $0.0356 and 77.0%.
On the 98 strictly paired comparable points ENUM is 45.5% more expensive.

ENUM nevertheless uses its actual capability: 46 of 100 delivered responses
contain multiple findings, for 171 findings total against MAIN's 96. The one
Sol pass judged exactly 264 eligible findings and saw a modestly broader raw
catalog footprint for ENUM, but this is not recall or precision: Opus,
liveness reconciliation, duplicate grouping, and valid v2 are absent. Sol's 87
supported-unmatched claim occurrences remain pending Opus, and 42 multi-match
claims confirm the already-registered evaluator refinement is necessary in the
next iteration. See `OPENAI-CAPSTONE-PRODUCER-RESULTS.md`. No quality number or
design verdict exists until both judge columns and a valid dataset exist.

## Iteration-1 capstone scores — BOTH JUDGES, golden v2 final (SHAKEDOWN)

Basis: golden v2 `0aadc215658a775b` · consensus artifact
`2026-08-04-capstone-consensus` (both-judge credit, adversarially verified,
7 analyst resolutions in-band) · scorer `capstone-score.mjs` · iteration 1
of the registered 2–3 shakedown passes — NOT a lock-in table. Full tables,
derivation notes, and the 7-item surprise list: `CAPSTONE-SCORING-RESULTS.md`.

Fresh generation (MAIN-SO2 vs ENUM-SO2, 3 tasks × sol-high/sol-xhigh),
unweighted per-task means: ENUM-SO2 blocking 39.4% / any-harm 31.8% /
precision 80.6% at $0.027–0.044 per observation (66–94% of driver cost);
MAIN-SO2 blocking 30.2% / any-harm 24.1% / precision 69.8% at $0.020–0.030
(42–62%). Per the lexicographic rule ENUM-SO2 found strictly more blockers
in 3 of 6 cells (scheduler+dispatcher sol-xhigh, exporter sol-high), tied in
2, and LOST scheduler sol-high (2/15 vs 5/15) — an effort-dependent reversal
on the shakedown surprise list, unread raw rows, not yet a verdict.

Old generation (scheduler only): ENUM blocking 40.0%/53.3% (high/xhigh)
still leads MAIN 20.0%/26.7% and F2 20.0%/13.3%; F2 is dominated in every
column and stays dead. ENUM-SO2 fresh ≈ old ENUM on scheduler xhigh recall
(7/15 vs 8/15) — the queue removal cost ENUM no measurable recall.

Quiet-span deliveries are vacuous this iteration (payload-walker
harness-bug; files-basis spans are empty by construction). The registered data
pass subsequently reproduced all 18 blocking cells and found enough
measurement-design friction to prevent lock-in; see `ITERATION1-DATA-PASS.md`.

## Post-table status — data pass, partial iteration 2, judge redesign

Between iterations, the payload walker, span close rule, anchor-state handling,
noise rendering, precision basis, one-judge floor, and staged unified-basis
re-judges landed without changing iteration-1 numbers. The data pass's most
consequential findings are structural: 30 one-sided catalog matches (8
blocking), different precision units for MAIN and ENUM, 33 anchor-less records,
14 cross-run-fragile end-state anchors, and 17 of 109 fresh Opus batches with
zero claims where Sol did not show the reverse pattern.

Iteration 2 steps 1–2 then produced a recoverable scratch checkpoint but did
not modify the live dataset or scores; steps 3–6 remain unspent. Four
perspective drafts were produced before the review/synthesis workers hit the
Claude session limit. Andreas subsequently selected an expanded 2Q design with
versioned real and false-positive catalogs, code-counted severe/minor buckets,
judgment only for unmatched central claims, and blinded human disagreement
resolution. A full audit found only one clear material false elaboration among
371 findings, so the selected contract deliberately drops `unsupportedExtra`.
There is still no lock-in verdict: the selected architecture needs its cheap
matching and false-severity checks before implementation.
