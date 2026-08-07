# Adaptive-thinking skip — study results (2026-08-01)

Pre-registered in `ADAPTIVE-SKIP-SPEC.md` (3c2168e, corrected 555bb7a,
Q5 added 7b69427 — all before data). Instrument:
`experiments/adaptive-skip-probe.mjs`, which replays arbitrary prompt
strings against the pilot's recorded driver payloads through the
production `mergeObservationPayload` path. 50 probe calls, zero errors,
**$1.36 spent** against a ~$2 budget. Rows frozen in
`experiments/artifacts/2026-08-01-adaptive-skip/`.

## Headline: the framing that motivated this study is WRONG, and the
## replacement is more useful

"MAIN skips thinking" is not a property of MAIN's contract. Thinking
tracks **which delivery the model is about to route**. A `steer` is
always preceded by thinking; a `queue` never is. The contract only moves
cost by moving how often each delivery gets chosen.

## Q1 DETERMINISM — the skip is STOCHASTIC. Say it loudly.

Ten byte-identical requests, one fixed prefix (L=20,165), opus-high:

| variant | n | mean | median | skip rate | raw reasoning values |
|---|---:|---:|---:|---:|---|
| MAIN | 10 | 569 | 485 | **5/10** | `0 1295 0 1166 0 1134 0 970 1123 0` |
| F2 | 10 | 933 | 915 | 0/10 | `806 901 1043 928 1017 902 989 761 1100 878` |

The pre-registered prediction (MAIN skips >= 8/10) FAILS. On a fixed
prefix MAIN is a **coin flip**, and when it does think it thinks ~1,138
tokens — more than F2's 933, not less.

Consequences, stated as the spec requires:
1. **The original 13-of-15 observation is one draw from a stochastic
   process, not a stable rate.** Every per-arm mean in this program that
   rests on one sample per point needs error bars it does not have.
2. **The contract effect is nevertheless real**: 5/10 vs 0/10, Fisher
   one-sided **p = 0.016**. MAIN and F2 differ in skip RATE; they do not
   differ in whether any single observation skips.
3. The distribution is genuinely **bimodal** — values cluster at 0 or
   near ~1,000, with nothing in between (MAIN's non-zero values:
   970-1295). The bimodal reading survives; what does not survive is
   attributing the mode to the contract.

## Q2 TRIGGER — NOT RUN. The design cannot answer it.

Given p ~ 0.5, the pre-registered cell (3 prefixes x 2 samples = 6 rows
per variant) with a "moves >= 4 of 6 rows" threshold has a **10.9%
false-trigger rate per variant**; across 8 variants that is **0.88
expected spurious triggers**. A 3-of-6 observation carries a 95% CI of
roughly 0.12-0.88. Running it would have manufactured a trigger.

The six variants were built and are committed
(`experiments/adaptive-skip-variants.mjs`, each a single byte-precise
edit from MAIN toward F2, self-asserting that its edit landed): a-routing
(+881 chars), b-discipline (+57), c-tooldenial (+103), d-grammar (+104),
e-capprose (+62), f-nocaps (-15). Re-running Q2 properly needs ~40
samples per variant (~$8-10 at these prefixes) and a new
pre-registration. **Not done; the budget line is binding.**

The pre-registered guess (a-routing is the trigger) is neither confirmed
nor refuted. It is untested.

## Q3 CACHING — REFUTED, from Q1's own data, no extra spend

Ten byte-identical MAIN requests produced ten *different* outcomes: five
skips and five thinking runs of 1295, 1166, 1134, 970, 1123 tokens. A
semantic cache returning a stored result cannot produce five distinct
token counts for one input. **No caching. The model samples.** The
dedicated nonce cell was therefore not run.

## Q4 PREFIX DEPENDENCE — prefix length does NOT explain the skip

MAIN, 10 samples at each of three prefixes:

| prefix | skip rate | mean | median | raw values | deliveries |
|---|---:|---:|---:|---|---|
| short L=4,230 | **10/10** | 0 | 0 | `0 0 0 0 0 0 0 0 0 0` | none x10 |
| mid L=20,165 | **5/10** | 569 | 485 | `0 1295 0 1166 0 1134 0 970 1123 0` | steer 5, queue 3, none 2 |
| long L=37,892 | **10/10** | 0 | 0 | `0 0 0 0 0 0 0 0 0 0` | queue x10 |

Non-monotonic (85% -> 25% -> 100% pooled). Length is not the variable.
F2 at the short prefix skipped 7/10 (`0 151 0 0 299 0 0 0 280 0`) — so
even F2 skips freely when there is nothing to report.

## Q5 DELIVERY TYPE — this is the explanation

Pooled contingency, all 50 probe rows:

| routed delivery | n | skipped | thought | skip rate | mean reasoning |
|---|---:|---:|---:|---:|---:|
| queue | 13 | **13** | 0 | **100%** | 0 |
| none | 22 | 19 | 3 | 86% | 33 |
| steer | 15 | 0 | **15** | **0%** | 1001 |

Independent replication in the ORIGINAL C1 run (different day, one
sample per point, 60 rows), re-analysed through the same lens:

| arm | delivery | n | skipped | thought |
|---|---|---:|---:|---:|
| MAIN | steer | 2 | 0 | **2** |
| MAIN | queue | 5 | **5** | 0 |
| MAIN | none | 8 | **8** | 0 |
| F0 | steer | 10 | 0 | **10** |
| F1/F2 | print | 6 | 0 | **6** |
| F0/F1/F2 | none | 16 | 6 | 10 |

MAIN's two famous "thinking points" (r1/5 and r3/14) are exactly its two
`steer` points. The coupling holds across both runs and all arms.

**Which explains the skip better?**
- **Delivery type: yes.** 28 of 28 `steer`/`print` rows thought; 13 of 13
  `queue` rows skipped. Near-perfect separation, replicated.
- **Prefix length: no.** Non-monotonic across three prefixes.
- **Contract: only indirectly.** On the SAME prefix MAIN split its own
  samples 5 steer (thought) / 5 queue-none (skipped). The contract moves
  P(steer); thinking follows the delivery, not the text.
- **Effort: not tested here** (opus-high only).

Andreas's hypothesis — *seeing the defect is cheap, deciding to intervene
is what costs deliberation* — is **CONFIRMED and sharpened**: `queue`
findings are real, specific, first-time findings routed with **zero**
thinking. It is not "found something vs not". The expensive decisions are
the ones that reach someone NOW: `steer` (interrupts the driver) and
`print` (goes to the user). Deferring costs nothing.

**Causal direction is not established.** Thinking and steering co-occur
perfectly; observational data cannot say whether deliberation produces
the steer or the nascent steer triggers deliberation. Both are consistent
with everything measured.

## What this implies for the contract

The envelope's cost premium is **not rumination that better wording can
remove**. It is the price of intervening more often. At the mid prefix
F2 routed `steer` 10/10 where MAIN routed it 5/10 — and every steer costs
~1,000 thinking tokens for both arms alike.

That explains the two failed levers directly: F2's framing (-23%) and
F3's decidability (+7.6%) both tried to change HOW the model deliberates,
when the cost is set by HOW OFTEN it decides to interrupt. It also means
a cheap-but-equally-interventionist envelope is likely unreachable by
rewording: **the remaining honest choices are to accept the premium as
the price of the intervention rate, or to change the intervention rate
itself** — which is a product decision about how often an observer should
stop the driver, not a prompt-engineering one.

Corollary worth testing before any such decision: if thinking is
delivery-bound, then an arm's trajectory cost should be predictable from
its steer rate alone. That is checkable against rows already frozen, at
zero spend, and is the natural next analysis.

## Limits

- One trajectory, one head, one lens, opus-high only. Effort untested as
  an explanator.
- Three prefixes at n=10; the mid prefix is the only cell showing a mixed
  delivery distribution, so the perfect steer/queue separation rests
  most heavily on it plus the C1 replication.
- Q2 untested: which contract feature moves P(steer) is exactly the open
  question, and this study did not earn an answer to it.
- Causal direction between thinking and delivery unresolved.

## Provenance notes

- Frozen via `hydra-lab freeze` to
  `experiments/artifacts/2026-08-01-adaptive-skip/` (6 files, 12 hashes
  verified) and mirrored. Ledger entry `2026-08-01-adaptive-skip`.
- **`duplicateRows: 42` in the ledger is expected, not corruption.** This
  study deliberately fires the SAME cell ten times — that repetition is
  the measurement. The ledger's cell key (one row per unit of work) reads
  every repeat past the first as a duplicate. A sampling study will
  always look like this in the ledger.
- The ledger initially recorded this run as **$0**: `harnessSpend` summed
  only the nested `usage.cost` shape, while replay-shaped rows carry the
  priced figure flat. Fixed in `run-ledger.mjs` with a regression test;
  the entry now reads the measured $1.3586. Every prior replay-shaped run
  (the C1 and F3 instruments) was ledgered under the same gap.

## Derived-metric verification (the discipline 96eff06 demands)

`delivery` is a DERIVED field, and this study's headline rests entirely
on it, so it was read against its raw text BEFORE being quoted — not
after.

- **Independent re-derivation agrees on 50/50 rows.** The probe parses
  with the production parsers (`parseFooterDecision`, `parseDecision`);
  the check re-extracted the literal `DELIVERY: <x>` trailing match and
  the literal `"action":"<x>"` field and compared. Zero disagreements.
- The raw texts were read, not just counted. Representative rows:
  - MAIN, **0 thinking**, parsed `queue`:
    `{"action":"queue","reason":"Task 1's test claims verification but was
    never run; MAX_ATTEMPTS/attempts/dead are unused in scheduler.js",
    "message":"Two notes: (1) you added the pluralize test without
    running node --test..."}` — a real, specific, two-part finding routed
    with zero deliberation. This is the claim of the study, in the
    model's own words.
  - F2, **806 thinking**, parsed `steer`: a substantive stranded-claim
    finding about `sweepExpired`/`claimNext`.
  - MAIN, **0 thinking**, parsed `none`: `{"action":"noop",...,
    "message":""}`.
  - F2, **151 thinking**, parsed `none`: `DELIVERY: none` — thinking
    without a finding does occur; it is the 3-of-22 minority in the
    `none` row of the contingency, and it is why `none` is 86% and not
    100%.
