# experiments/ — index

47 documents. This is the map. `README.md` documents the original cache
probes only and predates almost all of this; start here instead.

Convention: every measurement has a SPEC (pre-registered before data) and
a RESULTS doc. Where a spec has no results, the run has not happened or
was refuted before running.

## Start here

| doc | what it is |
|---|---|
| [DECISION-TABLE.md](DECISION-TABLE.md) | **The entry point.** Every arm, cost and quality, per config, with each block labelled by measurement basis. Carries the retractions. |
| [RUN-LEDGER.md](RUN-LEDGER.md) | Every run: date, script, args, commit, corpus hash, rows, spend, artifact paths. Generated — edit `RUN-LEDGER.jsonl`. |

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
| [CROSS-TASK-TRAJECTORY-RESULTS.md](CROSS-TASK-TRAJECTORY-RESULTS.md) | Run B done: MAIN &lt; ENUM &lt; F2 cost ordering holds 3/3 tasks; ENUM coverage advantage holds; precision drops to 54% on dispatcher; first false-interrupt data (F2 2, others 0) |
| [TERSE-ENUM-SPEC.md](TERSE-ENUM-SPEC.md) | QUEUED: bullets instead of prose — ENUM's premium is output volume |

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
| [GOLD-SET-SPEC.md](GOLD-SET-SPEC.md) | Earlier sketch, superseded by the design above |
| [GOLD-SET-DRAFT-FOR-REVIEW.md](GOLD-SET-DRAFT-FOR-REVIEW.md) | Draft severity ranking of the 10 planted defects; retired as a review artefact when Andreas delegated severity to the judges |
| [REFERENCE-REVIEW-RESULTS.md](REFERENCE-REVIEW-RESULTS.md) | 44 defects from 3 blind passes; 40 outside every prior reference set |

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

Every run's rows and judgments are frozen under `artifacts/<date>-<name>/`
with `SHA256SUMS`, mirrored to `~/dev/personal/pi-hydra-frozen-artifacts/`,
and listed in the run ledger. User prompts across both sessions:
`~/main-workspace/notes/side-projects/pi-hydra-user-messages-full.md`.
