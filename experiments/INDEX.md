# experiments/ — index

61 mapped documents (62 Markdown files including this index). This is the map.
`README.md` documents the original cache probes only and predates almost all
of this; start here instead.

Convention: every measurement has a SPEC (pre-registered before data) and
a RESULTS doc. Where a spec has no results, the run has not happened or
was refuted before running.

## Start here

| doc | what it is |
|---|---|
| [DECISION-TABLE.md](DECISION-TABLE.md) | **The entry point.** Every arm, cost and quality, per config, with each block labelled by measurement basis. Carries the retractions. |
| [RUN-LEDGER.md](RUN-LEDGER.md) | Every completed or reconstructed run through the steer-only probe: date, script, commit, corpus, rows, spend and artifact paths. Generated — edit `RUN-LEDGER.jsonl`. The failed-threshold v2 candidate is not a completed frozen dataset run and remains outside the ledger. |

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
| [GOLDEN-DATASET-V2-SPEC.md](GOLDEN-DATASET-V2-SPEC.md) → [GOLDEN-DATASET-V2-RESULTS.md](GOLDEN-DATASET-V2-RESULTS.md) | **v2 BUILT** (`0aadc215658a775b`): 75 active (27 blocking) + 61 recorded rejections, checker 8/8. Raw novel convergence 63/67 (94.0%) below the original 95% unanimity bar; final under the prospectively adopted Option A (four stable dissents carried verbatim, nothing forced). |
| [DRIVER-PROMPT-REALISM-SPEC.md](DRIVER-PROMPT-REALISM-SPEC.md) | **ANSWERED same day.** The minimal driver prompt is a validated non-factor for observer behavior (12-point NATIVE-vs-MINIMAL probe sits inside the same-variant repeat floor). Carries the classifier confirmation: pi's "Pi documentation" block alone flips OAuth billing from plan to extra usage (single-variable, request ids recorded), plus the proxy ground-truth capture appendix. |
| [JUDGE-DESIGN-UNDERSTAND.md](JUDGE-DESIGN-UNDERSTAND.md) | **The judge-redesign evidence base (verbatim synthesis).** Goal from the end use backward, the 12-class decision inventory, the measured advantages of the current design, the pain/patch catalog, requirements must/should/nice, and the open tensions. Sharpest fact: individuation — which sets every denominator — is decided by one judge in one call, while tiering, where agreement is already 90.5%, gets three participants and six rounds. |
| [ITERATION2-JUDGE-WAVE-SPEC.md](ITERATION2-JUDGE-WAVE-SPEC.md) | **REGISTERED, unspent.** The one remaining judge wave: dataset repairs and the anchor rule through the consensus protocol, the staged cache-only and old-basis re-judges, the 67 promotion candidates, then assemble v3 and the iteration-2 rescore. Checkpoint-per-batch against quota interruption. |
| [ITERATION1-DATA-PASS.md](ITERATION1-DATA-PASS.md) | **Registered data pass over the shakedown table (verbatim synthesis).** All 18 blocking-recall cells independently reproduced; 7 surprises triaged (2 harness bugs, 2 dataset-label bugs incl. the end-anchor class defect, 2 real effects, 1 comparison-level artifact) plus 7 unrecorded findings — the intersection-credit floor and the per-arm precision-unit mismatch are the load-bearing ones. Carries the three-lane iteration-2 work list. |
| [GOLDEN-V2-PROTOCOL-DECISION.md](GOLDEN-V2-PROTOCOL-DECISION.md) | **ADOPTED: Option A (Andreas, 2026-08-04).** The prospective options after the failed bar, with exact rule text; registered and decided while every v2 quality cell was still blank, so the choice could not be tuned toward an arm. The builder executed `--adopt-decision A` the same day; the projection matched the build exactly. |
| `golden-dataset-v2-freeze-stage.mjs` | Zero-call final-freeze gate, prepared but not yet run. It refuses provisional/sub-threshold/incomplete data or a dirty tree, preserves every judgment and build input, and emits the hashed source for a new immutable final artifact rather than overwriting the provisional checkpoint. |
| [GOLD-SET-SPEC.md](GOLD-SET-SPEC.md) | Earlier sketch, superseded by the design above |
| [GOLD-SET-DRAFT-FOR-REVIEW.md](GOLD-SET-DRAFT-FOR-REVIEW.md) | Draft severity ranking of the 10 planted defects; retired as a review artefact when Andreas delegated severity to the judges |
| [REFERENCE-REVIEW-RESULTS.md](REFERENCE-REVIEW-RESULTS.md) | 44 defects from 3 blind passes; 40 outside every prior reference set |

## The capstone benchmark

| doc | role |
|---|---|
| [BENCHMARK-SPEC.md](BENCHMARK-SPEC.md) | Scoring design REGISTERED before data (lexicographic blocking rule, 2:1 weighted-recall convenience column, evaluator freeze). **IN PROGRESS:** the registered OpenAI producer wave and its single Sol column are frozen; final v2 scoring, promotion, Opus judging, Anthropic production, and benchmark iterations remain. No OpenAI cost result is a product verdict yet. |
| [CAPSTONE-JUDGE-SPEC.md](CAPSTONE-JUDGE-SPEC.md) | Registered replay-safe two-judge protocol for real trajectory deliveries. **BOTH JUDGE COLUMNS COMPLETE (2026-08-04):** Opus judged the fresh 264-finding input 264/264 at Sol's exact builder, and the old 119-finding input 107+12-unjudgeable (identical unjudgeable set to Sol) at the pinned `369ed58` builder under the registered concurrency-3 amendment. Zero failures across both. Consensus has not run. |
| [JUDGE-TRANSPORT-AB-SPEC.md](JUDGE-TRANSPORT-AB-SPEC.md) | **REGISTERED, not yet run:** does the carrier change Opus's verdicts? Claude Code CLI vs pi/anthropic, model pinned, three sequential passes (A, A-repeat noise floor, B) over a deterministic ~40-finding sample of the frozen capstone input; sharded ≤3 workers per pass. The Sol arm was descoped by Andreas before any call. Diagnostic only. |
| `capstone-consensus-packet.mjs` | Zero-call bridge from two completed judge checkpoints to analyst deliberation. It refuses input or evidence-hole drift and renders stable side-by-side claim references without automatically deciding semantic agreement. |
| [OPENAI-TRAJECTORY-SOL-PASS.md](OPENAI-TRAJECTORY-SOL-PASS.md) | **ONE JUDGE, NOT A SCORE:** 107/119 frozen OpenAI findings judged by Sol in 29 clean batches; 12 terminal findings honestly unjudgeable from an old evidence-freeze gap now fixed. Raw review registered an iteration-2 matching refinement; all unmatched claims remain pending Opus. |
| [OPENAI-PROTOCOL-STUDY-SPEC.md](OPENAI-PROTOCOL-STUDY-SPEC.md) → [OPENAI-PROTOCOL-STUDY-RESULTS.md](OPENAI-PROTOCOL-STUDY-RESULTS.md) | **COMPLETE:** 144 fresh OpenAI calls plus a blinded Sol pass refute both exact simplifications. Terse findings are shorter but use more output and lose recall; removing `interrupt` fixes proposed-action routing only by losing real abort capability. One invalid quiet case and one unaccepted eight-finding judge batch remain explicit. |
| [OPENAI-CAPSTONE-PRODUCER-SPEC.md](OPENAI-CAPSTONE-PRODUCER-SPEC.md) → [OPENAI-CAPSTONE-PRODUCER-RESULTS.md](OPENAI-CAPSTONE-PRODUCER-RESULTS.md) | **OPENAI PRODUCER + ONE SOL PASS COMPLETE:** six live driver cells, 260 observer calls, $12.9608 producer spend, and 264/264 eligible findings judged. MAIN is cheaper in all six cells; quality remains deliberately blank pending valid v2 + Opus. |
| [CAPSTONE-SCORING-RESULTS.md](CAPSTONE-SCORING-RESULTS.md) | **ITERATION 1 SHAKEDOWN SCORED (2026-08-04):** first full both-judge table against final v2 over all 18 cells (fresh MAIN-SO2/ENUM-SO2 ×6, old MAIN/F2/ENUM ×2). ENUM-SO2 means: blocking 39.4%, precision 80.6%; MAIN-SO2 30.2%/69.8% at ~2/3 the cost. 7-item surprise list (payload-walker harness-bug, 33 anchor-less records, 3 anchor-mismatch candidates, effort-dependent scheduler reversal) feeds the registered data pass. NOT a lock-in table. |
| [OPENAI-CAPSTONE-COMPARISON.json](OPENAI-CAPSTONE-COMPARISON.json) | Machine-readable input for the one plain capstone table. It contains measured OpenAI cost rows and intentionally no quality fields. |
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
in the run ledger with its provenance gaps. The failed-threshold v2
consensus/build state remains preserved in `~/scratch/2026-08-02-golden-v2/` as
the immutable failed run and as input to any prospectively versioned follow-up.
User prompts across all three archived project sessions:
`~/main-workspace/notes/side-projects/pi-hydra-user-messages-full.md`.
