# experiments/ — index

51 mapped documents (52 Markdown files including this index). This is the map.
`README.md` documents the original cache probes only and predates almost all
of this; start here instead.

Convention: every measurement has a SPEC (pre-registered before data) and
a RESULTS doc. Where a spec has no results, the run has not happened or
was refuted before running.

## Start here

| doc | what it is |
|---|---|
| [DECISION-TABLE.md](DECISION-TABLE.md) | **The entry point.** Every arm, cost and quality, per config, with each block labelled by measurement basis. Carries the retractions. |
| [RUN-LEDGER.md](RUN-LEDGER.md) | Every completed or reconstructed run through the steer-only probe: date, script, commit, corpus, rows, spend and artifact paths. Generated — edit `RUN-LEDGER.jsonl`. The interrupted v2 build is not a completed run and remains outside the ledger. |

## Product decision (2026-08-02)

Andreas selected one ENUM-SO2 judge contract for Anthropic and OpenAI and
retired `queue` from model-facing prompts and schemas. The extension keeps its
queue parser and router dormant for compatibility. This is an explicit product
choice made before the unfinished v2 capstone, not a claim that ENUM already
wins on OpenAI; a provider text split remains the fallback if later evidence
shows the OpenAI premium does not buy enough recall. After inspecting the raw
ENUM deliveries, Andreas also selected recipient-preserving runtime triage:
one user-only `print` batch plus one agent `steer`/`interrupt` batch, rather
than the harness's urgency-max precedent. This changes delivery only; the
measured ENUM-SO2 model contract stays byte-identical.

## The contract screens (which API surface)

| doc | verdict |
|---|---|
| [DELIVERY-CONTEXT-ABC-RESULTS.md](DELIVERY-CONTEXT-ABC-RESULTS.md) | Frozen A/B/C verdict (arm C refuted) |
| [UNIFIED-API-SCREEN-RESULTS.md](UNIFIED-API-SCREEN-RESULTS.md) | v2. Footer beats JSON at medium across 4 families; J refuted |
| [XHIGH-SCREEN-SPEC.md](XHIGH-SCREEN-SPEC.md) → [XHIGH-SCREEN-RESULTS.md](XHIGH-SCREEN-RESULTS.md) | opus high+xhigh. Envelope arms breach the quality floor on ONE replicated case |
| [ANTHROPIC-COST-SWEEP-RESULTS.md](ANTHROPIC-COST-SWEEP-RESULTS.md) | Footer premium is effort-dependent thinking; fable policy-blocks security cases |
| [ACTING-CHANNEL-SMOKE-RESULTS.md](ACTING-CHANNEL-SMOKE-RESULTS.md) | Acting heads: two-field JSON; wide schema retired |

## The envelope repair (quality)

| doc | verdict |
|---|---|
| [ENVELOPE-REPAIR-SPEC.md](ENVELOPE-REPAIR-SPEC.md) → [ENVELOPE-REPAIR-RESULTS.md](ENVELOPE-REPAIR-RESULTS.md) | Defect fixed (target 75→100), replicates on both providers; E2 fails at opus-xhigh. **Carries a retraction of its own coverage numbers.** |

## The cost mechanism (why observations cost what they cost)

| doc | finding |
|---|---|
| [TRAJECTORY-COST-SPEC.md](TRAJECTORY-COST-SPEC.md) → [TRAJECTORY-PILOT-RESULTS.md](TRAJECTORY-PILOT-RESULTS.md) | Cost model validated; MAIN baseline ~33% of driver; envelope thinking premium is first-order |
| [ADAPTIVE-SKIP-SPEC.md](ADAPTIVE-SKIP-SPEC.md) → [ADAPTIVE-SKIP-RESULTS.md](ADAPTIVE-SKIP-RESULTS.md) | Thinking tracks DELIVERY TYPE; skip is stochastic; caching refuted; prefix length refuted |
| [NO-STEER-SPEC.md](NO-STEER-SPEC.md) → [NO-STEER-RESULTS.md](NO-STEER-RESULTS.md), [NO-STEER-V2-SPEC.md](NO-STEER-V2-SPEC.md) → [NO-STEER-V2-RESULTS.md](NO-STEER-V2-RESULTS.md) | Removing the steer label cuts MAIN's thinking (n=30, p=2.7e-05); does nothing to the envelope — the cost mechanisms dissociate |
| [ENUMERATE-SPEC.md](ENUMERATE-SPEC.md) → [ENUM-PLUS-SPEC.md](ENUM-PLUS-SPEC.md) → [ENUM-PLUS-RESULTS.md](ENUM-PLUS-RESULTS.md) | Enumeration: 2.3x recall at zero thinking; the support clause costs 2.8x from one sentence |
| [ENUM-TRAJECTORY-RESULTS.md](ENUM-TRAJECTORY-RESULTS.md) | ENUM on a live trajectory: cheapest-but-one, best coverage, more precise than MAIN |
| [ENUM-CONFIG-SWEEP-SPEC.md](ENUM-CONFIG-SWEEP-SPEC.md) → [ENUM-CONFIG-SWEEP-RESULTS.md](ENUM-CONFIG-SWEEP-RESULTS.md) | Zero thinking transfers to opus-xhigh; OpenAI structurally unmeasurable by replay |
| [ENUM-GENERALISATION-SPEC.md](ENUM-GENERALISATION-SPEC.md) → [OPENAI-TRAJECTORY-RESULTS.md](OPENAI-TRAJECTORY-RESULTS.md) | Run A done: ENUM's zero-thinking does NOT transfer to OpenAI (thinks the most there); delivery-type coupling is Claude-specific |
| [CROSS-TASK-TRAJECTORY-RESULTS.md](CROSS-TASK-TRAJECTORY-RESULTS.md) | Run B done: MAIN &lt; ENUM &lt; F2 cost ordering holds 3/3 tasks; ENUM coverage advantage holds; precision drops to 54% on dispatcher; first quiet-span delivery data (F2 2, others 0) |
| [TERSE-ENUM-SPEC.md](TERSE-ENUM-SPEC.md) | QUEUED: bullets instead of prose — ENUM's premium is output volume |
| [STEER-ONLY-SPEC.md](STEER-ONLY-SPEC.md) → [STEER-ONLY-RESULTS.md](STEER-ONLY-RESULTS.md) | Queue deleted (Andreas's proposal): ENUM absorbs it free (40/40 zero-thinking steer), MAIN needs a one-sentence wording repair then pays ~2× thinking, F2 indifferent; the silence was wording, not labels — deliberation attaches to committing a selection, not to the steer label |

## The quality metric (how to score an observation at all)

| doc | outcome |
|---|---|
| [SEVERITY-PROBE-SPEC.md](SEVERITY-PROBE-SPEC.md) → [SEVERITY-PROBE-RESULTS.md](SEVERITY-PROBE-RESULTS.md) | v1 NOT VIABLE (41.7% judge agreement), diagnosed |
| [SEVERITY-PROBE-V2-SPEC.md](SEVERITY-PROBE-V2-SPEC.md) → [SEVERITY-PROBE-V2-RESULTS.md](SEVERITY-PROBE-V2-RESULTS.md) | Decomposed judgment: 61.9%, marginal; structural fixes landed |
| [SEVERITY-V3-SPEC.md](SEVERITY-V3-SPEC.md) | **SUPERSEDED** — pairwise ranking, unnecessary once the scale collapsed |
| [SEVERITY-V4-BLOCKING-TIER.md](SEVERITY-V4-BLOCKING-TIER.md) | **RESOLVED.** Judges agree 90.5% blocking-vs-rest, 95.2% any-harm; 4 levels exceeded their resolution |
| [CONSENSUS-SPEC.md](CONSENSUS-SPEC.md) → [CONSENSUS-RESULTS.md](CONSENSUS-RESULTS.md) | Deliberation 42.9%→95.2%, ZERO authority-driven changes; revises the recall headline |

## The golden dataset

| doc | role |
|---|---|
| [GOLDEN-DATASET-DESIGN.md](GOLDEN-DATASET-DESIGN.md) | **The design of record**, incl. the three ruled conventions (reachability, individuation, source frame) |
| [GOLDEN-DATASET-V1-RESULTS.md](GOLDEN-DATASET-V1-RESULTS.md) | **v1 BUILT** (`golden-dataset.json`, version 4ea27b0018705940): 46 active (17 blocking) + 26 recorded rejections, 2 dissents verbatim; regression scores per arm |
| [GOLDEN-DATASET-V2-SPEC.md](GOLDEN-DATASET-V2-SPEC.md) | **PROVISIONAL** candidate version `2b0a85843c9be981`: 75 active (28 blocking), consensus below its registered bar. Recovery repaired the schema/build mechanics and the checker now passes 8/8, but no v2 results or freeze exists; resume consensus rather than restart. |
| [GOLD-SET-SPEC.md](GOLD-SET-SPEC.md) | Earlier sketch, superseded by the design above |
| [GOLD-SET-DRAFT-FOR-REVIEW.md](GOLD-SET-DRAFT-FOR-REVIEW.md) | Draft severity ranking of the 10 planted defects; retired as a review artefact when Andreas delegated severity to the judges |
| [REFERENCE-REVIEW-RESULTS.md](REFERENCE-REVIEW-RESULTS.md) | 44 defects from 3 blind passes; 40 outside every prior reference set |

## The capstone benchmark

| doc | role |
|---|---|
| [BENCHMARK-SPEC.md](BENCHMARK-SPEC.md) | Scoring design REGISTERED before data (lexicographic blocking rule, 2:1 weighted-recall convenience column, evaluator freeze). **IN PROGRESS:** Andreas approved producer-first OpenAI work: existing frozen rows get their first Sol judgment, fresh causal studies precede an exact dated OpenAI matrix, and raw OpenAI producer rows may freeze before v2. Scoring, promotion, and verdicts still wait for valid v2 + Sol + Opus; Anthropic production still waits for v2. |
| [CAPSTONE-JUDGE-SPEC.md](CAPSTONE-JUDGE-SPEC.md) | Registered replay-safe two-judge protocol for real trajectory deliveries. It splits every emitted finding into atomic claims, hides arm/tier labels, preserves raw responses, and treats the first Sol pass as one pending half rather than consensus. |
| [OPENAI-TRAJECTORY-SOL-PASS.md](OPENAI-TRAJECTORY-SOL-PASS.md) | **ONE JUDGE, NOT A SCORE:** 107/119 frozen OpenAI findings judged by Sol in 29 clean batches; 12 terminal findings honestly unjudgeable from an old evidence-freeze gap now fixed. Raw review registered an iteration-2 matching refinement; all unmatched claims remain pending Opus. |
| [OPENAI-PROTOCOL-STUDY-SPEC.md](OPENAI-PROTOCOL-STUDY-SPEC.md) | **CASES FROZEN; NO CALLS YET:** fresh OpenAI-only causal studies for terse ENUM and removing `interrupt`. Nine new cases are committed before candidate wording; exact prompts and matrix land in a second pre-spend checkpoint. |
| [CAPSTONE-FROZEN-INPUTS.json](CAPSTONE-FROZEN-INPUTS.json) | Deterministic SHA-256 inventory of the provisional dataset, all frozen scheduler/exporter/dispatcher/OpenAI trajectory inputs, and the scoring definitions. Regenerate after v2 freezes. |
| `render-capstone-table.mjs` | One plain comparison-table renderer with the registered separate cost, quality, noise, delivery, and weighted-recall columns. It intentionally renders unavailable quality as blank rather than inventing provisional values. |

## Superseded / historical

[COMPLETION-COST-CAUSAL-ABLATION.md](COMPLETION-COST-CAUSAL-ABLATION.md),
[TOOL-FREE-COMPLETION-AB.md](TOOL-FREE-COMPLETION-AB.md),
[MEDIUM-HIGH-DELIVERY-CONTEXT-AB.md](MEDIUM-HIGH-DELIVERY-CONTEXT-AB.md),
[STRUCTURED-CONTEXT-CONTRACT.md](STRUCTURED-CONTEXT-CONTRACT.md),
[DELIVERY-CONTEXT-GOLDEN-SPEC.md](DELIVERY-CONTEXT-GOLDEN-SPEC.md),
[README.md](README.md) (original cache probes).

## Retractions — read these before quoting any number

Three published claims were withdrawn after checking them against raw
text or a better reference set. All are recorded in place:

1. **Planted-defect coverage** (ENVELOPE-REPAIR-RESULTS.md, DECISION-TABLE.md)
   — keyword matching failed in both directions; withdrawn.
2. **"MAIN is the recall winner"** (DECISION-TABLE.md) — the consensus set
   adds a third blocking issue; MAIN and F tie on different issues.
3. **"J is dead"** as a global verdict (DECISION-TABLE.md) — true on
   Anthropic, false on OpenAI where J is the judged quality winner.

## Artifacts

Completed decision evidence is frozen under `artifacts/<date>-<name>/` where
available, mirrored to `~/dev/personal/pi-hydra-frozen-artifacts/`, and listed
in the run ledger with its provenance gaps. The interrupted v2 consensus/build
state remains in `~/scratch/2026-08-02-golden-v2/` until it is valid enough to
freeze. User prompts across both sessions:
`~/main-workspace/notes/side-projects/pi-hydra-user-messages-full.md`.
