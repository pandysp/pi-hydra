# Envelope repair — phase 1 results (2026-08-01)

Pre-registered in ENVELOPE-REPAIR-SPEC.md (commits d9ae0de, 28601c3,
9db1114 — all before data). Arms differ in instruction text only:
MAIN (main's shipped contract) / F0 (current envelope) / F1 (semantic
repair) / F2 (repair + first-match framing). Instrument: hardened harness
(a092cdb). Configs: opus-high, sol-high, sol-xhigh. Judges sol+opus,
unanimous, judgedComplete true in every scored cell.

## The defect is fixed, and the current envelope was the worst arm

Fresh user-actor corpus (8 cases x 2 samples, authored blind to the fix by
two independent agents, adversarially leakage-hunted; the driver states
the FACT, never the REMEDY — the confound that disqualifies the old case).

opus-high, judged (n=12 judged feedback rows/arm):

| Arm | findingQuality | support | target | routing | thinking |
|---|---:|---:|---:|---:|---:|
| MAIN | 91.7 | 100.0 | 91.7 | 56.3 | 197 |
| F0 | 66.7 | 75.0 | 75.0 | 56.3 | 409 |
| F1 | 83.3 | 83.3 | **100.0** | 75.0 | 311 |
| F2 | **91.7** | 91.7 | **100.0** | **81.3** | 289 |

`target` — the metric that carried the entire refutation at opus high AND
xhigh — goes 75 -> 100 for both repaired arms. F2 matches MAIN on finding
quality, beats it by 25pp on routing, and thinks 30% less than F0.

Routing replicates across providers (bucket-correct of 16):

| Config | MAIN | F0 | F1 | F2 |
|---|---:|---:|---:|---:|
| opus-high | 9 | 9 | 12 | **13** |
| sol-high | 5 | 4 | **13** | 12 |
| sol-xhigh | 7 | 3 | **13** | 11 |

F0 is the WORST arm on user-actor routing at every config measured,
including main's own contract. The repair is +8 to +10 rows over F0 on
OpenAI and +3 to +4 on Anthropic.

Print emission (the previously dead channel), user-actor rows of 16:
MAIN 3-6, F0 0-3, F1 9-10, F2 7-11. The channel works now; it did not
before, for any arm.

## Pre-registered gates

- E1 (repair): PASS for F2 (91.7 >= MAIN 91.7). FAIL for F1 as literally
  written (83.3 < 91.7) — F1's shortfall is entirely `support`, not
  `target`, and is one row at n=12. Reported both ways; not rewritten.
- E2 (quiet suppression, opus-high): PASS. MAIN 2/8, F0 6/8, F1 5/8
  (-1, inside the bar), F2 6/8 (= F0).
- E2b (must-speak): PASS, 8/8 for every arm — no arm went silent on
  explicit-rejection, material-change, fresh, or emergency rows.
- E3 print over-fire watch: ZERO prints on fresh/material-change/
  emergency rows at any config. The pre-registered worst failure mode did
  not occur.
- E4 (framing safety): PASS — F2 quality is ABOVE F1, not below.
- Regression guard replicates on OpenAI: F2 is the best arm at both sol
  configs (14/16 sol-high, 13/16 sol-xhigh vs MAIN 9 and 8).

## Cost: framing is a real lever; the semantic repair is thinking-neutral

C1, 19 recorded real driver payloads (19-38k prefixes), opus-high:

| Arm | thinking | vs F0 |
|---|---:|---:|
| MAIN | 59 | — |
| F0 | 663 | — |
| F1 | 691 | +4% |
| F2 | **511** | **-23%** |

- C1 formal bar (F2 <= 0.5 x F0) FAILS, exactly as pre-registered in the
  honest bet (predicted 350-550; measured 511).
- The pre-registered DECISIVE test PASSES: F2 thinks 23% less than F0
  while being 43% LONGER. Framing is causal; length is not the driver.
- The semantic repair alone is thinking-neutral (F1 = F0 + 4%): quality
  fixes do not cost deliberation.
- MAIN still thinks ~10x less than any envelope arm. That gap is
  structural and unexplained by framing alone — it motivates F3
  (decidability, pre-registered 9db1114).

Replay cost caveat: a replayed observation does not share the live
driver's cache lineage, so REPLAY COST is not comparable to live-fork
cost and is not reported. Thinking is cache-independent and stands.

## Anomaly pass (raw rows, before this distillation)

- The two fresh expected-none guards are CONTESTED LABELS, not
  over-firing: on both, every arm INCLUDING MAIN and F0 raises a
  different, still-live, agent-actionable finding rather than re-raising
  the handled one (on the mailed-batch case all four arms warn that the
  July run repeats an unauthorized live call, which the user's "I already
  have this one" does not cover). Dataset-label branch of the triage;
  the established quiet families carry E2 instead.
- One sol judge batch failed, leaving 3 rows unjudged; judgedComplete
  correctly refused to score the cell until the metric was re-run.
- A docs-only commit mid-run tripped the resume guard's codeCommit
  comparison (correct but over-strict; filed in the spec).

## Open

- opus-xhigh confirmation of F2 vs MAIN/F0 (spec step 4).
- C2 live-fork trajectory ratio with F2 (running).
- F3 decidability probe (Andreas's hypothesis: ambiguity, not length,
  drives thinking).
- Judged quality for the sol configs (routing only so far).

## C2 — live-fork trajectory ratio (the headline KPI)

One driver run (scheduler, opus-high, 19 points), three arms paired at
identical observation points. Rows: ~/scratch/2026-08-01-hydra-c2-trajectory.

| Arm | observer $ / driver $ | observer $ | marginal vs MAIN |
|---|---:|---:|---:|
| MAIN | **32.1%** | $0.3190 | — |
| F0 | 67.2% | $0.6689 | +$0.3499 |
| F2 | **58.6%** | $0.5836 | +$0.2646 |

- MAIN's baseline REPLICATES (32.1% here vs 33.3% in the pilot, different
  driver run) — the instrument is stable and Andreas's ~30% field prior
  holds at this trajectory length.
- F2 cuts the envelope's trajectory premium from +35.2pp to +26.5pp
  (-25% of the premium).
- C2 pre-registered bar (F2 - MAIN <= 15pp): **FAILS** at 26.5pp.
  Reported as registered; no goalposts moved.
- Deliveries: MAIN 10, F0 9, F2 9 — the repaired arm is not talking more,
  it is talking better (see the quality table above).

Consequence: after the repair, quality is fixed and routing is far
better, but the cost SHAPE still does not meet the bar at opus-high.
The remaining lever is decidability (F3, pre-registered 9db1114); if it
does not close the gap, G1 is a genuine judgment call with the premium
and the quality delta both on the table.

## F3 — decidability REFUTED (pre-registered D1, 9db1114)

F3 = F2's semantics at maximum decidability (explicit test per rule,
precedence for every colliding pair, tie-breaks, evidence rule), 3407
chars vs F2's 2102 (+62%).

Thinking, 19 recorded payloads, opus-high, paired re-measure:

| Arm | thinking | vs F2 |
|---|---:|---:|
| F2 | 487 | — |
| F3 | **524** | **+7.6%** |

Frozen-corpus thinking is flat too: opus-high 292 vs 295, sol-high 228 vs
253, sol-xhigh 361 vs 344.

**D1 fires: F3 >= F2, so the ambiguity hypothesis is refuted as a further
lever.** What survives is the narrower F2-vs-F0 result, which held
semantics constant and changed STRUCTURE AT EQUAL LENGTH (-23%). F3
changed structure AND added 62% length; the design cannot separate a
decidability benefit that is cancelled by a length cost from no benefit
at all. Named as a confound, not explained away.

D2 (safety) PASSES: F3 routing 13/16 vs F2 12/16 (user-actor, opus-high),
15/16 vs 14/16 (guard) — inside noise, no regression. So F3 is safe but
pointless: +62% contract text for no cost or quality gain. **F2 remains
the lead; simplicity breaks the tie.**

### The open structural gap

MAIN thinks 59 tokens where every envelope arm thinks ~500 on the same
prefixes. Neither framing nor decidability closes it, and MAIN's
240-char cap is already present in F2, so caps are not the explanation
either. Remaining untested hypothesis: it is the presence of an explicit
RULE SURFACE at all — MAIN never tells the model how to choose, so there
are no rules to check against evidence. Testing that means removing the
routing rules, which removes the abstention win with them; it is a real
question with an expensive answer, and it is left open rather than
guessed at.

## Why MAIN is cheap: it SKIPS, it does not think less

Per-observation thinking on the 19 recorded payloads (opus-high) is
bimodal, and the means hide it:

| Arm | observations with ZERO thinking | median | mean |
|---|---:|---:|---:|
| MAIN | **13 of 15** | 0 | 59 |
| F0 | 2 of 15 | 716 | 663 |
| F2 | 2 of 15 | 623 | 511 |

The two points where MAIN does think, beside F2 at the same points:

| point | prefix | MAIN | F2 |
|---|---:|---:|---:|
| r1/5 | 18,891 | 680 | 704 |
| r3/14 | 35,214 | 210 | 214 |
| the other 13 | — | **0** | 153-955 |

When MAIN thinks it thinks the SAME amount as the envelope arm (within
2-4%), at the same two moments. So: the SITUATION sets how much thinking
a hard observation takes; the CONTRACT sets whether routine observations
get any thinking at all. MAIN skips 13 of 15; the envelope skips 2.

This reframes the premium: it is not depth, it is the absence of a skip.
It also explains why both cost levers failed — framing (F2) and
decidability (F3) change HOW the model deliberates, when the gap is
WHETHER it deliberates. The untested lever that follows from the
mechanism is an explicit fast path: permission to answer immediately
when nothing in the trajectory is contentious, rather than a better
rulebook. Registered as the next candidate; not yet measured.

## The caching hypothesis, tested — and the trade completed

**Semantic caching is DISFAVORED by direct evidence.** The C1 replay
re-sent near-identical requests to ones the pilot sent hours earlier.
Result over the 15 shared points: decisions agreed **15/15** (every
noop/queue/steer identical), but thinking DIFFERED (509 vs 680 at one
point; 0 vs 210 at another). A cache returns the same response with the
same or absent token accounting; this is a model recomputing and
reliably reaching the same conclusion. The prompt cache (cacheRead/
cacheWrite, explicit in usage) is a different, visible mechanism.

**The steer-costs-thinking hypothesis is REFRAMED, not confirmed.** The
same points are hard in both runs, and EVERY arm thinks hard at them
(MAIN 680, F0 725, F2 704 at the same observation). So thinking and
steering are both downstream of "this moment is contentious" — the
trajectory sets the hard moments. The real anomaly is the inverse of the
original framing: why does the envelope deliberate at the EASY moments
MAIN answers instantly?

**What the envelope buys with that thinking (raw rows, C1):** at points
where MAIN thinks 0 and says noop/queue, F2 spends 550-760 tokens and
produces the planted TOCTOU ("sweepExpired flips state to pending but
leaves claimedBy set, while claimNext..."), the syntax-broken-files
warning, and the never-executed-code warning. One clear waste case in
the same set: 955 thinking tokens to conclude DELIVERY: none.

**Planted-defect coverage on the C2 trajectory** (deterministic
identifier match over delivered messages — a first pass, NOT judged
coverage; the S1 judging is built but unfunded):

| Arm | cost (% of driver) | planted defects named | deliveries |
|---|---:|---:|---:|
| MAIN | 32.1% | **3 of 4** | 10 |
| F0 | 67.2% | **4 of 4** | 9 |
| F2 | 58.6% | **4 of 4** | 9 |

MAIN misses `sched-lease-caller-clock`. The envelope arms find every
planted defect AND interrupt the driver less often.

**The trade, complete on this trajectory:** the repaired envelope costs
+26.5pp of driver spend and catches one more real defect of four, with
one fewer interruption. That is G1's decision with both sides measured.
Limits: n=1 trajectory, identifier-match coverage not judge-scored.

## opus-xhigh confirmation — E2 FAILS for the repaired arms

Fresh user-actor corpus, opus-xhigh (16 rows/arm):

| Arm | routing | prints | think mean | zero-think rows |
|---|---:|---:|---:|---:|
| MAIN | 9/16 | 6 | 332 | 6/16 |
| F0 | 7/16 | 1 | 713 | 0/16 |
| F1 | **12/16** | 10 | 445 | 0/16 |
| F2 | **12/16** | 10 | 424 | 0/16 |

Routing replicates at the primary config: F0 is again the WORST arm, the
repaired arms beat MAIN by 3 rows and F0 by 5.

Regression guard, opus-xhigh:

| Arm | quiet suppression | must-speak | think mean |
|---|---:|---:|---:|
| MAIN | 1/8 | 8/8 | 109 |
| F0 | **7/8** | 8/8 | 389 |
| F1 | 5/8 (-2) | 8/8 | 518 |
| F2 | **4/8 (-3)** | 8/8 | 612 |

**E2 FAILS at opus-xhigh for both repaired arms** (bar: >= F0 - 1 per
category). At opus-high F2 matched F0 exactly (6/8); at xhigh it gives up
three rows. Per the pre-registered rule an arm that breaks abstention is
refuted REGARDLESS of its quality gains. Reported as registered; the gate
is not rewritten.

Anomaly pass — what F2 says on the rows it loses: it does NOT re-nag. It
raises DIFFERENT, real, first-time findings (the in-process rate-limit
fallback resets each key to zero during an outage; per-IP counters are
defeated by an address pool on IPv6/cloud egress). Same contested-label
pattern as the fresh corpus's none-guards, and the same never-re-nag vs
surface-new-issues tension Andreas raised: the corpus answers it by
fiat, the product has not decided it. Recorded as a product question,
NOT used to excuse the gate failure.

**Second finding, against my earlier claim:** at xhigh on SHORT frozen
cases F2 thinks MORE than F0 (612 vs 389) — the opposite of the recorded
real-payload result (-23%). The framing win is prefix-length dependent,
not universal. Any statement that "F2 is cheaper" must name the context.

Net at the primary config: quality and routing gains replicate; the
abstention gate fails; the cost win does not transfer to short prefixes.
F2 is NOT clear to ship at opus-xhigh on this evidence.
