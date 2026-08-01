# TASK 3 — Recommended trajectory-level quality design

**Recommendation: (c) hybrid, but with the gate on precision, not recall.** Planted defects supply ground truth cheap enough to author, but at K≈10 defects they cannot carry a pre-registered verdict. Deliveries are the plentiful event (~40/arm). So: planted issues fix the *recall floor* descriptively, per-delivery precision carries the *gate*, and blind forced-choice preference is a pre-registered secondary (not a conditional stage — conditional firing after a null primary is a forking path this repo's pre-registration culture exists to block).

---

## 0. Prerequisite that this design shares with the cost benchmark (surface, do not bury)

**Shadow replay: one recorded driver run per (task, config); all three arms observe the same recorded provider payloads; no delivery is ever injected.**

Defend it, don't apologize for it. Under live delivery A0's send rate (7/8 improper sends on quiet rows, `XHIGH-SCREEN-RESULTS.md`) derails the driver into a different trajectory — the denominator moves *because of* the numerator's behavior, and the talkative arm's ratio goes perversely *down*. At n=3 trajectories, fixed-driver replay is the only design where "observer % of driver" means what the user means. It also gives paired observation points, which is where all statistical power at this n comes from, and makes defect-visibility indices arm-independent (computed once per trajectory).

Reframing risk the user must see stated: this measures the ratio **for a fixed driver trajectory**. Report the **injection tax as a computed column, not a footnote** — exact arithmetic from data the run produces: `Σ(delivered message tokens) × remaining driver requests × cache-read price + one cache write per injection`, arm-dependent. The driver's *reaction* to an injected message (extra turns, rework) is **unmeasured** — label it so.

Head count: **one** frozen generic MECE head (GOLDEN_HEADS lens, names no defect — same non-leakage discipline as `experiments/delivery-context-screen-cases.mjs:11-20`). Per-head is faithful because the ledger's `contextFor()` shows own-head deliveries only; per-observation cache reads make the ratio roughly additive across heads — **state additivity as an assumption, not a measurement**. Plant a *mix* of defect kinds (correctness / resource / security) so the lens does not pre-target the ground truth.

Cost and quality **must come from the same rows**. That forces the high-fidelity producer: replay the recorded provider payload (`index.ts:1516` `structuredClone(event.payload)`), not text-flattened pseudo-cases.

---

## 1. Corpus (option (a) component)

3 tasks × seeded workspace, `mkdtemp` pattern from `experiments/acting-channel-smoke.mjs:111` (`snapshot()` gives the file-state timeline for free).

- Each repo carries **3-4 planted defects** with canonical target strings, exactly the `SCREEN_FINDING_TARGETS` shape (`experiments/delivery-context-screen-cases.mjs:40-52`).
- Defects sit in code the task **forces** the driver to read or modify. Never pre-introduced by hoping the LLM writes the bug — that is nondeterministic and is rejected.
- **Archetypes disjoint** from golden/development/screen corpora. The F envelope was *screened on* the rate-limiter defects; reusing them re-imports the selection bias the frozen-corpus rule prevents. Candidates: job-scheduler TOCTOU on a claim/lease, report exporter with unbounded pagination + N+1, retry loop re-POSTing a non-idempotent call with a swallowed error.
- Task prompt never names the defect area. No ground-truth leakage into the driver.
- **One quiet stretch per trajectory** (≥3 consecutive observation points with no live defect visible: routine refactor, test run, doc edit). This is the false-interrupt denominator and needs no judge.

Observation points come from production scheduling: piggyback per assistant `message_start` except the first of a run (`index.ts:1564`) plus one run-end (`index.ts:1604`), both via `scheduleObservations` (`index.ts:1427`). Budget ~18 points/trajectory → **324 observation completions** (3 traj × 2 configs × 3 arms × 18) on top of 6 real opus-high/xhigh driver runs.

## 2. Ground truth, derived deterministically — and verified

**Anchor on the defective expression, not the identifier.** `grep -n clientKeyFor` prints the name with none of the defective body; a line-range read shows the defective expression with the name outside the window. Identifier-grep visibility corrupts both the recall denominator and the latency zero-point.

Per defect d:
- `firstVisible(d)` = first observation point whose **recorded provider payload bytes** contain the defective expression (e.g. the literal `headers['x-forwarded-for']` inside the key derivation). Payload bytes, not "the transcript" — those are what the head conditions on.
- `firstFixed(d)` = first point whose payload shows the corrected expression.
- **Liveness window** `[firstVisible, firstFixed)`. Empty window ⇒ d leaves the denominator.
- **Verification, mandatory before any judging:** ~10 one-shot manual confirmations (one per defect per trajectory) of the computed index against the payload. Ten checks convert a heuristic into verified ground truth for the entire study.

Quiet spans = points where no defect is live. False interrupt = a `steer`/`interrupt` delivery inside a quiet span **that fails the no-hit follow-up judgment** (S5) — a quiet-span send that survives S5 is a real unplanted find, not noise.

## 3. Judge streams

| # | Metric | Ground truth? | Item | Batching |
|---|---|---|---|---|
| S1 | **coverage** (NEW question, multi-label) | planted list | each delivered message | 2-4 items from **different** points |
| S2 | **support** (VERBATIM) | none | each delivered message | 2-4 items from **different** points |
| S3 | **repeat** (VERBATIM question) | none | deterministically-flagged repeat candidates only | 4-8 items |
| S4 | **preference** (NEW, co-presented) | none | each contested point | 1-2 points/call |
| S5 | **no-hit follow-up** (NEW, list-free) | none | delivered messages that hit no planted target | 2-4 items |

**S1 coverage** — one judgment per delivered message against the *whole* planted-target list: `{"id","reasoning","targets":["d2"],"other":false}`. Keeps `questionFor("target")`'s clause verbatim (`experiments/delivery-context-judge-protocol.mjs:36`): *"or a different defect that is concretely evidenced and at least as consequential."* Recall and latency are then computed from labels — **no additional calls**. Redundancy is also derived from labels: same arm hitting the same target twice = repeat *candidate*.

**S2 support** — `SUPPORT_POLICY` and the split-support question reused byte-identically (`:15-21`, `:28-31`). This is the false-alarm axis.

**Never co-present arms in S1/S2/S5.** If two arms name X and one names Y at the same point, co-presentation nudges the judge toward treating X as the real one — systematically penalizing the arm that found something *different*. That failure is already on record: A0 names credential rotation, both envelope arms name git-history scrubbing, both judges side with rotation (`XHIGH-SCREEN-RESULTS.md`, `dev-security-user-only`). Preserve the existing shuffle property (`experiments/delivery-context-golden-judge.mjs:164`): batch items drawn from **different observation points**, each with its own full-prefix-to-point transcript. Token duplication is free — both judges are subscription-billed (`judgeSpecs`, `:41-44`), so the constraint is wall-clock.

**Never window the transcript for support.** A claim can reference material 15 turns back; windowing manufactures false FALSEs, and more of them for arms that reference older material. Full prefix, 1-2 items/call when prompts get long. Note `maxTokens: 2500` (`:87`) — batch size must keep the JSON inside it.

**S3 repeat** — deterministic screen (same target label twice by the same arm) then the verbatim repeat question (`:39`), which carries the necessary carve-out *"without a visible rejection, material change, or incomplete fix."* Deterministic labels alone cannot see that carve-out; the judge is applied only to the small candidate set.

**S4 preference** — the one place co-presentation is the point. At each point where ≥2 arms delivered: transcript-to-point + all arms' messages blind-shuffled → *"which single message would you rather have received at this point, or NONE if none is worth sending now."* Forced choice removes absolute-scale calibration, which is (b)'s real weakness.

**S5 no-hit follow-up** — showing the coverage judge a target list biases it against `other:true`, penalizing arms that find unplanted real defects. On the no-target-hit subset only, list-free: *"is this a concretely-evidenced defect in the visible material, and how consequential (blocking / worth-knowing / not-a-defect)?"* Doubles as quiet-span adjudication.

**Expected judgment counts** (18 points, ~8 delivered/arm/traj/config → 144 delivered messages):

| Stream | Judgments (×2 judges) | Calls |
|---|---:|---:|
| S1 coverage | 288 | ~96 |
| S2 support | 288 | ~96 |
| S3 repeat | ~44 | ~12 |
| S4 preference | ~120 | ~80 |
| S5 no-hit | ~86 | ~30 |
| **Total** | **~830** | **~315** |

Subscription-billed on both judges; at sol conc 4 / opus conc 2 (`XHIGH-SCREEN-SPEC.md` guards) this is an overnight run, zero API dollars. The API spend is the 324 observation completions + 6 driver runs — **estimate it before launch** from measured prefix sizes × cache-read price; do not launch on a guess.

## 4. Pre-registrable rules

Validity gates (no verdict without them):
- **Q0a** every trajectory has ≥1 defect with a non-empty liveness window and ≥1 quiet span ≥3 points; the ~10 visibility-index confirmations all pass.
- **Q0b** `judgedComplete` per cell and unanimity across sol+opus, same discipline as `experiments/summarize-delivery-context-golden.mjs:211`; split items are excluded **and reported**, never silently.
- **Q0c** **cache-hit floor: per-cell mean `hitRatio` ≥ 90%** (`experiments/delivery-context-golden-ab.mjs:222`). Under shadow replay whichever arm runs first pays the cache write and the others read it — reuse the warm call, `--no-warm`, and the randomized per-case arm order verbatim, and pre-register both. Below the floor rows are **invalid, not noisy**; without this gate the headline ratio can be a pure ordering artifact invisible in the number itself.
- **Q0d** cost and quality are computed from the same rows. Any separately-produced cost number voids the joint table.

Verdict rules:
- **Q1 (PRIMARY — precision).** An arm's premium is refuted at a config iff, pooled over trajectories, it has **more false interrupts than A0** OR `unsupportedExtra` rate ≥10pp above A0. Confirmed as a precision win iff false interrupts ≤ A0 − 1 per trajectory with no recall breach (Q2).
- **Q2 (recall floor — descriptive).** An arm is refuted iff it misses **≥2 more live planted defects than A0** pooled across both configs. Stated up front: at K≈10 with the same defects at both configs (correlated, not 2× independent), **non-firing of Q2 is uninformative** — it catches gross regression only.
- **Q3 (latency).** Median points from `firstVisible` to first naming. **Reported, never gated** — too few events.
- **Q4 (SECONDARY — preference).** An arm wins the preference axis at a config iff its forced-choice win rate exceeds A0's by ≥15pp with ≥40 contested points. Threshold registered now, not after Q1 reads null.
- **Q5 (worth-it, the joint rule).** The premium is JUSTIFIED at a config iff it wins Q1 or Q4 without breaching Q2. Otherwise UNJUSTIFIED and **ranking falls to the cost ratio** — a decision-useful outcome, registered as the explicit null.
- **Q6 (scope).** Per config. Never "replicated" at n=3 trajectories.

## 5. Joint presentation — quality per dollar

One table per config, arms as columns:

| Row | Source |
|---|---|
| observer $ / driver $ (**the metric**) | `usageOf` sums, shadow replay |
| injection tax, $ and pp of driver | computed column (see §0) |
| marginal $ vs A0, per trajectory | derived |
| planted defects surfaced / live | S1 labels |
| median latency (points) | S1 + `firstVisible` |
| **false interrupts / trajectory** | quiet spans + S5 |
| unsupportedExtra rate | S2 |
| improper repeats | S3 |
| preference win rate | S4 |
| unplanted real finds | S5 `other` |
| mean cache-read share (validity) | `hitRatio` |

Headline derived figure: **marginal dollars per additional planted issue surfaced** = `(cost_arm − cost_A0) / (issues_arm − issues_A0)`, **with the raw counts always printed**; when the denominator ≤ 0 print `"no additional issues, +$X"` — never divide. Keep false interrupts as its **own column**, not folded into a composite: abstention economics is a trade the user makes explicitly. **Build no composite quality score.**

## 6. Reuse map

Verbatim, no edits:
- `experiments/delivery-context-judge-protocol.mjs` — `SUPPORT_POLICY` (`:15`), `questionFor` support (`:28`) and repeat (`:39`), `schemaFor` (`:43`), `parseCases`/`parseSupportJudgments`/`parseBinaryJudgments` (`:88`, `:106`), `buildJudgePrompt` skeleton (`:49`).
- `experiments/delivery-context-golden-judge.mjs` — both transports (`:58` pi/sol, `:85` claude-cli/opus), correction-retry, resume set (`:148`), shuffle (`:164`), `judgeBatch` (`:186`), `recordBatchFailure` (`:229`).
- `experiments/delivery-context-golden-ab.mjs` — A0/J/F prompt+envelope builders and the parse chain (`parseDecision`/`parseFooterDecision`/`failOpenJsonDecision`), `usageOf` (`:206`), `hitRatio` (`:222`), warm call / `--no-warm` / randomized arm order / resume (`:622`).
- `experiments/acting-channel-smoke.mjs` — `mkdtemp` workspace + `snapshot()` (`:111`) for the file-state timeline that yields `firstFixed`.
- `experiments/summarize-delivery-context-golden.mjs` — unanimity + `judgedComplete` machinery (`:211`), gate-comparison table renderer (`:333`).

**Not reused:** `messagesFor` (`experiments/delivery-context-golden-ab.mjs:187`). Text-flattened messages would break payload-identical replay and therefore the cost half of the study.

New code, all small:
1. **Trajectory recorder** — real `runAgentLoop` driver in a seeded workspace, persisting every captured provider payload per observation point plus the file-state timeline.
2. **Point producer** — iterates recorded payloads × 3 arms × 2 configs through the existing arm builders, emitting rows in the golden-ab row schema.
3. **Tool-call/result flattener for `renderTrajectory`** (`experiments/delivery-context-judge-protocol.mjs:23` handles `{role,text}` only) — the one genuinely new rendering piece.
4. **Three new judge questions + parsers** — coverage (multi-label), preference (co-presented forced choice), no-hit follow-up.
5. **Ground-truth deriver** — expression-anchored `firstVisible`/`firstFixed` over payload bytes, with the manual confirmation harness.

## 7. Known biases, register them before producing

- Shadow replay measures a fixed-driver ratio; driver reaction to injected feedback is unmeasured (§0).
- S4 co-presents arms by design; S1/S2/S5 must not (§3).
- Per-item `state` differs by arm at the same point and partially correlates with arm identity — unavoidable, since redundancy judging requires it. Blindness here has always been about the *arm label*, not the state (`experiments/delivery-context-golden-judge.mjs` hides arm while rendering state).
- Planted defects are authored by the same party that reads the results; disjointness from the screening corpora is the only guard, and it is a weak one. Say so.