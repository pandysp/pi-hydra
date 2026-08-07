# Iteration 1 — look-at-the-data pass (2026-08-04)

The registered iteration-protocol step 2 for the shakedown scoring pass
(CAPSTONE-SCORING-RESULTS.md). Three focused readers (labels / effects /
harness, opus-xhigh) over the raw frozen rows, payloads, judgments, and
dataset records; one synthesizer that independently REPRODUCED all 18
published blocking-recall cells from the frozen inputs before accepting any
reader claim. Full reader reports and the workflow journal are frozen in
`artifacts/2026-08-04-iteration1-data-pass/`. Nothing in the repo was
changed by this pass; per the evaluator freeze, nothing here touches the
iteration-1 table. The synthesis follows verbatim.

---

# Look-at-the-data pass, iteration 1 — synthesis triage

Nothing in the repo was changed. I independently reproduced the readers' load-bearing numbers from the frozen inputs rather than accepting them; probes at `/Users/spannagel/scratch/2026-08-04-synth-triage/`. **Validation anchor: my pipeline reproduces all 18 published blocking-recall cells exactly** (1/3, 1/3, 2/3, 1/3, 3/7, 1/7, 2/6, 2/6, 2/15, 5/15, 7/15, 5/15 fresh; 6/15, 3/15, 3/15, 8/15, 2/15, 4/15 old), so the corrections below are measured against a verified baseline.

## Verdicts

| # | Surprise | Verdict | Deciding evidence |
|---|---|---|---|
| 1 | Payload liveness walker blind | **harness-bug** | `trajectory-ground-truth.mjs:121` iterates `payload?.messages`; measured over the frozen tarball: **0/131 payloads have `.messages`, 131/131 have `.input[]`, `payloadChunks()` returns 0 across all 131**. Top-level keys are `model, store, stream, instructions, input, …`. |
| 1b | Quiet-span column vacuous | **no-issue** on the recording, **documentation defect** on the stated reason | Column correctly reads 0 in all 18 rows and no verdict leans on it. But the doc's reason ("planted defects live from point 0") is wrong: quiet requires *zero* plants live, and the minimum live-per-point is **3 in every one of the 8 cells**. No cell is one fix from a span; every cell is three. |
| 2 | "Absolute noise" wording vs renderer | **harness-bug** | `render-capstone-table.mjs:19` computes `raised − real`; `BENCHMARK-SPEC.md:35-38` registers both-judges-not-real. `capstone-score.mjs:161` *does* compute `bothNotReal` but writes it only to `details-*.json`. **All 18 cells differ.** Iteration-1 handling was protocol-correct — both readings published. |
| 3 | Anchors that never match | **dataset-label-bug** (class-level, one root cause) | `frame-sources.json.gz` verified: all three tasks' anchors transcribe **opus-high** driver runs (`scheduler/opus-high/a1/r3/18`, `exporter/…/r3/14`, `dispatcher/…/r3/19`). Iteration 1 scores OpenAI sol runs, whose emergent code differs — so `state:"end"` anchors cannot match by construction. Confirmed structurally: of 42 anchored actives, **seed 25 / start 3 / end 14**, and every never-live record in the fresh cells is `state=="end"`. |
| 4 | 33 anchor-less records | **dataset-label-bug** (hygiene) | Reproduced exactly: **33 anchor-less of 75 active — scheduler 31 (9 blocking), exporter 1, dispatcher 1.** Only **4 of 42** anchored records populate `absent[]`. No ordering flips under either bracket, so zero iteration-1 impact; the damage is cross-task comparability (scheduler essentially unfiltered while exporter loses 3-4). |
| 5 | Effort-dependent blocking reversal | **real-effect** (numbers correct under the registered rule; the doc's causal label is not supported) | Credited sets reproduce exactly. But: n=1 trajectory per cell; sol-high and sol-xhigh are *different driver trajectories* (22 vs 25 points); 2 of the 5-blocker gap turn on a single message at `r3/16`; and under a union credit rule the gap collapses from 5-vs-2 to **5-vs-4** (below). "Effort-dependent reversal" overstates what one trajectory pair can show. |
| 6 | Fresh MAIN-SO2 precision 64.7% vs old 81.8% | **harness-bug** (comparison-level) | The two packets sit on **different bases in two independent ways**, both verified. Under any alignment the gap vanishes or reverses: as-scored 64.7% vs 81.8% → valid-source-only **84.6% (11/13) vs 81.8% (9/11)**. Not an SO2 wording effect. |
| 7 | Cache-only-invalid eligibility policy | **real-effect** (the policy is not arm-neutral) | Verified: cache-only-invalid-sourced findings are **MAIN-SO2 14/95 (14.7%) vs ENUM-SO2 9/169 (5.3%)**, only **5 of 23 credited**. Incidence per *point* is not biased (26 vs 21, Fisher p=0.52); the asymmetry is arithmetic — precision is a ratio and MAIN-SO2's denominator is 56% of ENUM-SO2's, so the terse arm pays roughly double for the same policy. |

### The two "12"s in surprise 6 are different diffs, not a transcription error

The readers reported different 12-finding gaps and both are real:

- `buildFindingItems(old, strict-v1)` = **119**, but the old packet holds **107**. The missing 12 are exactly the final `run-end` point of each cell (`scheduler/sol-high/a1/r3/19` ×4, `scheduler/sol-xhigh/a1/r3/18` ×8) — the old artifact fails closed on a cell's last run.
- `buildFindingItems(old, semantic-v2)` = **131** vs strict-v1 **119**; those 12 are cache-only-invalid rows (ENUM 2+8, MAIN 1+1, F2 0 — matches the harness reader exactly).

**These compound.** The old packet is neither a clean strict-v1 nor a semantic-v2 basis. Fresh reconstructs to 244/264 with the packet at 264 and `eligibilityPolicy: "semantic-v2"` declared; the old basis has no such key. Old MAIN also had **zero** cache-only-invalid findings, which is *why* it never paid the tax that surprise 7 describes — surprises 6 and 7 are one mechanism seen from both ends.

## Unrecorded findings (not on the surprise list)

Ranked by consequence. The first two are the highest-value output of this pass.

**1. Every blocking-recall number in both tables is an intersection *floor*, and the floor is not uniform — table-wide.** The registered rule credits a catalog id only when both judges match it. Measured from the raw judge match lists across all 18 cells: **30 catalog ids matched by exactly one judge and credited to neither, 8 of them blocking, affecting 16 of 18 cells.** A union proxy moves 5 cells and produces two ordering consequences:

| cell | published (intersection) | union proxy |
|---|---|---|
| fresh scheduler/sol-high ENUM-SO2 | 2/15 | **4/15** (+`SCHED-r-d07`, `SCHED-r-d08`) |
| fresh exporter/sol-high MAIN-SO2 | 1/7 | **2/7** (+`EXP-c-11`) |
| old scheduler/sol-high MAIN | 3/15 | **6/15** (+`SCHED-requeue-resets-attempts`, `r-d07`, `r-d08`) |
| old scheduler/sol-high F2 | 3/15 | **4/15** (+`SCHED-r-d05`) |
| old scheduler/sol-xhigh ENUM | 8/15 | **9/15** (+`SCHED-o-g07`) |

Two published readings are not robust to the credit rule: **surprise 5's reversal shrinks from 5-vs-2 to 5-vs-4**, and **old scheduler/sol-high ENUM 6 vs MAIN 3 becomes a 6-vs-6 tie** — which directly touches the "ENUM dominates, F2 is dead" narrative. This is a *sensitivity note only*: my union proxy is raw judge matches filtered on `centralSupported !== false`, without the consensus protocol's adversarial verification, so it is an upper bound, and `BENCHMARK-SPEC`'s evaluator freeze forbids it touching the iteration-1 table. But it must be recorded, because the registered rule's cost is currently invisible.

One rarer sub-flavor, measured and genuinely small: **1 case** where both judges supported the same behavior but credited *different* catalog ids, so nothing survived (`…/scheduler/sol-high/a1/r1/7/ENUM-SO2/f2`, Sol → `SCHED-r-d06`, Opus → `SCHED-r-d07`).

**2. The precision column is in different units per arm — verified, and it affects every precision cell in both tables.** Measured findings-per-delivering-row: **MAIN-SO2 exactly 1.00 (max 1, 95 rows → 95 findings)** vs **ENUM-SO2 1.71 (max 6, 99 rows → 169 findings)**; old MAIN 1.00, F2 1.00, ENUM 2.46. `raised` is *steer count* for the prose arms and *enumerated items* for ENUM. One MAIN steer carrying three credited ids counts as one raised item; ENUM needs three, each separately at risk. The metric structurally favors the prose arm, and it compounds with surprise 7 in the opposite direction on the denominator.

**3. `anchorLiveAtPoint` never reads `issue.anchors.state`** (`capstone-score.mjs:70-81`), though the dataset populates it on all 42 anchored records. A foreign-frame anchor is reported `never-live` instead of `unknown`. **The error is directional** — never-live shrinks the denominator and inflates recall. Credit-based re-admission rescues only credited ids, which is exactly why four never-credited records slipped through.

**4. Grep-output window close in the same walker.** A `grep -C` hit line showing only a declaration closes a defect window while the disk state stays live (`dispatcher-sol-high-a1-r2-q15.json` `input[79]`; `scheduler-sol-xhigh-a1-r1-q11.json` `input[60]`). Present in the original Anthropic walker too — latent only because `defectStateInPayload` had never run on real data.

**5. Opus one-sided zero-claim batches: 17 of 109 fresh batches, 27 findings, all auto-not-real; the reverse happened 0 times.** All well-formed model decisions (`recovered: false`, ids `j01…jNN`), not transport damage. A systemic precision suppressor that hits arms unevenly by which points they steer at. Reader-reported; I did not re-derive the 17/109 count.

**6. `bothNotReal` tests presence of claim refs, not support** — claim refs attach even when `centralSupported: false`. The faithful spec reading moves two cells by +1 (`exporter/sol-xhigh/ENUM-SO2` 2→3, `dispatcher/sol-high/ENUM-SO2` 2→3). Reader-reported.

**7. `judgeBuilderHash` differs between generations** (old `df3cc0f57a725965` vs fresh `5880bf010bbb428e`) — confirmed in the packet bases. The eligibility difference fully accounts for the finding-set difference, but the judges also saw differently-constructed prompts. Unmeasured residual on every fresh-vs-old sentence.

## Iteration-2 work list

### A. Harness fixes — land immediately, no protocol gate

1. **Payload walker + grep-close, in the same pass.** Parse `payload.input[]`: bare-`{role,content}` *and* `{type:"message"}` shapes (both occur; dispatching only on `item.type` silently drops the first); `function_call` with `arguments` as a **JSON string** requiring `JSON.parse` (`write`→authoritative, `edit`→`newText` authoritative / `oldText` **non**-authoritative, else `tool-args`); `function_call_output.output` authoritative; `reasoning` skipped. Reuse `visiblePayload()` at `capstone-trajectory-judge-protocol.mjs:84-102`, which already walks this exact shape and is frozen. **Ordering is binding: fixing the walker alone manufactures spans** — the harness reader's probe spans (dispatcher/sol-high 14–24, scheduler/sol-xhigh 20–24) are pure artifacts of the grep-close bug. The `oldText` decision is what prevents every repair from reading as a re-plant; 8 of 80 expression×edit hits in the corpus are oldText-only.
2. **`anchorLiveAtPoint` must read `anchors.state`** — return `unknown`, not `never-live`, for a foreign-frame anchor. **Must land with or before the anchor backfill (B1)**, since until it does the error only ever inflates recall.
3. **Wire `bothJudgesNotReal` into the renderer.** The dead guard at `render-capstone-table.mjs:20-22` was built for exactly this mismatch and has never armed because the producer omits the field. Fix `bothNotReal` to test support, not claim-ref presence, in the same change.
4. **Put both generations on one eligibility policy and one prompt builder before any fresh-vs-old sentence is written again.** Re-adapt old to semantic-v2 (this also needs `recoverRunEndAssistant`, else the 12 run-end findings stay missing).
5. **Tell the judges that cache-only-invalid rows are fully judgeable, and re-run those 23.** Opus's 78% silence on them (18/23 vs 31/241 on valid rows) is the actual lever. Do **not** revert to strict-v1 — the policy also rescues 5 real findings.
6. **Report precision twice (valid-only and semantic-v2), and normalize the raised unit across arms** so a cost assertion cannot tax a low-volume arm and so `raised` means the same thing in every cell.
7. **Record the intersection floor beside every recall cell** — the count of one-sided catalog matches — so the credit rule's cost is visible without changing the rule.

### B. Dataset label/anchor fixes — consensus protocol only, never on a finder's authority

**Everything in this section is a statement-semantics judgment call, not a mechanical fact.** Stating that per-item so none gets cherry-picked as settled:

1. **Anchor backfill (highest leverage).** 33 records with no anchor plus 14 `state:"end"` anchors of which only 2 are portable. The proposed rule — *an anchor may pin only seed bytes, or a declaration regex that survives driver edits, never bytes that exist solely after one driver's edit* — is evidenced, not asserted: `EXP-o-xe-g14`/`g19` survived a run change using the seed's own import line plus `absent[]`, while `DISP-o-xd-g20`/`g26` used the identical form against a *post-edit* import and failed. The `absent[]` machinery already exists and is used on only 4 of 42 records.
2. **`DISP-o-xd-g03`, `EXP-o-xe-g17` — anchor repair only.** Crediting is sound and the statements are correct; only the anchor bytes are from the wrong run. g17's true window in this run is a **single point** (`exporter/sol-xhigh/a1/r3/14`), which a prose quote cannot express — needs a two-sided predicate (code construct present AND doc still contradicting).
3. **`EXP-o-xe-g21` — anchor *and* statement.** This corrects the results doc's surprise-3 wording ("the anchor bytes, not the issues, look wrong"): true for g03/g17, **incomplete for g21**. Neither `totalCents` nor `Math.round` appears in this run's exporter at any point; the run's trailer is `totalAmount += row.amount` → `.toFixed(2)`, a different mechanism with the same consequence. Both judges credited on the consequence clause — zero of the 3 matched claims mentions `Math.round` or cents — and judges never see anchors (`capstone-trajectory-judge-protocol.mjs:170` renders only `key: statement`), so this was invisible to them.
4. **Re-examine `EXP-o-xe-g22`, `EXP-o-xe-g27`, `SCHED-c-13`** — their statements likewise describe the opus-high run's implementation rather than the issue. Note `g22` and `g21` currently share a byte-identical anchor expression.
5. **The exporter blocking-denominator correction (7/6 → 9) is a proposal, not a finding.** It rests on reading `g22`/`g27` "by consequence" — a semantics call the consensus protocol owns. If adopted it shifts fresh means MAIN-SO2 blocking 30.2→27.8% and ENUM-SO2 39.4→35.9% with **no verdict sentence changing**. Iteration-2 flag, not an iteration-1 rescore.

### C. Real effects — enter the results, with their limits attached

1. **Surprise 7 (policy is not arm-neutral) is the finding that generalizes.** It is structural arithmetic, not this corpus's cache behavior, and will recur in every future run pairing a terse arm with a verbose one under semantic-v2.
2. **Surprise 5 enters as a recorded observation, not as an arm×effort interaction.** Write it as: at sol-high ENUM-SO2 spent the r3 window on test-prescriptions (4 of 6 points → all `SCHED-c-14`) while at sol-xhigh it paired behavioral assertions with them; the content mix differs at equal exposure. Attach all four limits: n=1 per cell, different driver trajectories per effort, two blockers hinging on one message at `r3/16`, and 5-vs-4 under a union rule.
3. **Delete the "Generations" bullet's claim that "the steer-only collapse did not damage ENUM's recall."** It is not supportable across a basis boundary this wide. Old ENUM sol-high's dropped `r3/19` finding is textually the `SCHED-o-g07` assertion — a blocking id it was not credited with — so old-generation blocking counts are depressed by an unknown non-zero amount.

## Where the evidence is thin, or readers pulled apart

- **The 33 anchor-less records were sampled, not censused.** 10 of 33 resolved by hand (7 live, 3 not). "Denominators approximately right, inflated by ~3 harmful on the scheduler" is an **n=10 estimate**, not a measurement. The distribution finding (31 of 33 scheduler) is exact; the liveness rate is not.
- **No reader contradicted another.** The apparent 12-vs-12 conflict resolved into two genuinely distinct diffs, both verified. Surprise 6 called `harness-bug` (effects) and surprise 7 called `real-effect` (harness) are not in tension — they are different surprises about one mechanism.
- **Findings I did not independently re-derive**, flagged at reader confidence rather than reproduced: the Opus zero-claim batch count (17/109), the `bothNotReal` support-reading correction (+1 in two cells), the per-point liveness minima behind the quiet-span analysis, and the labels reader's per-point code reads for the 10 sampled records.
- **The union-rule counterfactual is mine and is a proxy** — raw judge matches without adversarial verification. It is an upper bound and cannot touch the iteration-1 table under the evaluator freeze. I raise it because it shows the published orderings are less robust than the table implies, which is precisely what a shakedown pass exists to surface.