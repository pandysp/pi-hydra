# OpenAI capstone producer — MAIN-SO2 vs ENUM-SO2 (2026-08-03)

The registered OpenAI production wave and its one permitted Sol pass are
complete. The cost result is decisive: **MAIN-SO2 is cheaper in all six task ×
effort cells.** The quality result is deliberately not decided: golden v2 is
still provisional and Opus has not judged these rows. No design winner follows
from this document.

Frozen producer input: `artifacts/2026-08-03-openai-capstone-producer/`.
Frozen Sol checkpoint: `artifacts/2026-08-03-openai-capstone-sol/` (raw logical
SHA-256
`d19a38b219e7dabc25f35e0b07624cff94f08e74786d221a5b5c205da85ceabe`).
The exact provisional catalog bytes for the matching Opus pass are frozen in
`artifacts/2026-08-03-openai-capstone-judge-basis/`.
Deterministic analysis: `openai-capstone-results.mjs`. The producer and judge
raw text were read in full before this distillation.

## Registered comparison table

The cost columns use successful, cache-comparable observations and exclude the
single observation point created after a failed driver turn. They follow the
same cost basis as `OPENAI-TRAJECTORY-RESULTS.md`: per-arm comparable observer
cost divided by that cell's full driver cost. Charged cache losses are reported
separately below rather than hidden.

Dataset: provisional `2b0a85843c9be981`. Quality cells marked — are
intentionally unscored.

| task | config | arm | cost / observation | observer / driver | blocking recall | any-harm recall | precision | absolute noise | quiet-span deliveries | weighted recall* |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| dispatcher | sol-high | MAIN-SO2 | $0.0200 | 61.7% | — | — | — | — | — | — |
| dispatcher | sol-high | ENUM-SO2 | $0.0273 | 84.4% | — | — | — | — | — | — |
| dispatcher | sol-xhigh | MAIN-SO2 | $0.0298 | 41.7% | — | — | — | — | — | — |
| dispatcher | sol-xhigh | ENUM-SO2 | $0.0425 | 65.7% | — | — | — | — | — | — |
| exporter | sol-high | MAIN-SO2 | $0.0276 | 48.3% | — | — | — | — | — | — |
| exporter | sol-high | ENUM-SO2 | $0.0381 | 66.7% | — | — | — | — | — | — |
| exporter | sol-xhigh | MAIN-SO2 | $0.0210 | 54.8% | — | — | — | — | — | — |
| exporter | sol-xhigh | ENUM-SO2 | $0.0302 | 73.3% | — | — | — | — | — | — |
| scheduler | sol-high | MAIN-SO2 | $0.0253 | 54.5% | — | — | — | — | — | — |
| scheduler | sol-high | ENUM-SO2 | $0.0298 | 76.3% | — | — | — | — | — | — |
| scheduler | sol-xhigh | MAIN-SO2 | $0.0284 | 58.1% | — | — | — | — | — | — |
| scheduler | sol-xhigh | ENUM-SO2 | $0.0439 | 94.0% | — | — | — | — | — | — |

\* Convenience value only: blockers count twice; quality and cost remain
separate.

Across all six cells, MAIN cost $0.0253 per comparable observation and 52.1%
of driver cost. ENUM cost $0.0356 and 77.0%: **40.8% more dollars per
observation and 24.9 percentage points more driver cost.** On the stricter 98
points where both arms had a comparable cache hit, MAIN cost $0.0257 per point
and ENUM $0.0375, a 45.5% ENUM premium. The order therefore does not come from
one arm losing more rows to the cache gate.

## Everything charged, including cache losses

Production paid for 130 observer calls per arm. These totals retain every
cache miss and the two observers accidentally called after the driver
WebSocket failure:

| arm | charged cost | charged $ / observation | charged observer / driver | comparable observations |
|---|---:|---:|---:|---:|
| MAIN-SO2 | $3.3062 | $0.0254 | 66.2% | 103/130 |
| ENUM-SO2 | $4.6596 | $0.0358 | 93.3% | 108/130 |

The six drivers cost $4.9950; total producer spend was $12.9608. Forty-seven
observer rows missed the registered cache floor. One dispatcher/sol-xhigh
driver turn failed with `WebSocket error` and yielded an illegitimate
zero-prefix observation point; its observer calls cost $0.0378 MAIN and
$0.2589 ENUM. They remain in charged spend and are excluded from comparison
and judging.

## ENUM really did use its array

The production ENUM implementation did not merely return a one-element array:

| arm | delivered responses | findings | multi-finding responses | findings / delivered response | maximum |
|---|---:|---:|---:|---:|---:|
| MAIN-SO2 | 96 | 96 | 0 | 1.00 | 1 |
| ENUM-SO2 | 100 | 171 | 46 | 1.71 | 6 |

ENUM's response-size histogram was 54× one finding, 27× two, 17× three, and
2× six. This corrects the earlier live count that accidentally measured routed
delivery batches rather than findings inside the response array.

## One-Sol pass: useful diagnostic, not a quality score

Eligibility policy `semantic-v2` admitted ordinary valid findings plus
cache-only-invalid findings and excluded the failed-driver point. The adapter
produced the exact registered 264 findings: 169 ENUM and 95 MAIN.

- Sol completed 264/264 judgments in 109 accepted batches.
- The two failed attempts were empty transport failures (`fetch failed` and
  `WebSocket error`). Both unanswered points resumed unchanged.
- All 109 accepted raw responses passed on their first answer. There were zero
  schema corrections and zero malformed accepted batches. The judge prompt
  therefore does **not** need a format-tuning change from this run.
- Sol split the findings into 378 atomic claims: 367 centrally supported, 11
  unsupported, and 14 supported with a material unsupported addition. Twenty-one
  process-only findings yielded no defect claim.
- Sol matched at least one supported claim to 31 distinct active catalog issues
  for ENUM and 26 for MAIN. This is not recall: it has not been reconciled with
  liveness, duplicate claims, Opus, or analyst deliberation.

The raw pass also reproduced the already-registered evaluator weakness. Forty-two
supported atomic claims matched more than one catalog entry, often because a
broad “missing tests” claim was credited to both a general coverage issue and a
specific boundary case. The pass remains frozen. Opus must answer the identical
questions first; only then may the flagged subset be revisited under the sharper
iteration-2 matching rule. Rewriting this Sol pass now would tune the evaluator
after seeing arm output.

## Supported unmatched material waiting for Opus

Sol marked 87 atomic claim occurrences supported but unmatched: 48 ENUM and 39
MAIN. They are highly repetitive and are **not 87 distinct bonus issues**. Raw
review found a smaller set of recurring candidate families:

- scheduler: ambiguous overlapping `running`/`expired` statistics, no automatic
  sweep caller, a documentation contradiction around swept ownership, and
  completion-storage errors entering handler retry/dead-letter accounting;
- exporter: the extra empty query after an exactly full final page, gaps in the
  literal paging/output documentation, and summary-document drift;
- dispatcher: partial redaction of valid apostrophe-containing email addresses,
  a synchronous-operation throw leaving the timeout timer behind, missing
  dispatch-level timeout propagation tests, and documentation gaps around
  duplicate submission risk.

Some are genuine-looking defects; others are task-progress notes, ambiguous
contract choices, or documentation detail below the dataset's threshold. They
stay `pending-opus`. No Sol-only promotion, extra Sol vote, or dataset edit is
permitted.

## Decision boundary

MAIN owns the OpenAI cost case. ENUM demonstrably delivers more independent
findings and Sol sees a modestly wider raw catalog footprint in some cells, but
that extra material has not yet proved higher blocking recall or sufficient
precision. The only honest next decision question is whether Sol + Opus
consensus shows that ENUM's added blocker coverage is worth a roughly 41–46%
OpenAI observation-cost premium. Until then, there is no OpenAI winner and no
provider split to lock.
