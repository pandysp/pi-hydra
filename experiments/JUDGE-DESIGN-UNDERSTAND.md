# Judge design — UNDERSTAND phase (2026-08-04)

The evidence base for the judge redesign Andreas commissioned: goal from
the end use backward, the full decision inventory, the pain-and-patch
catalog, and the requirements. Produced by a three-reader + synthesis
workflow (opus-xhigh); reader reports frozen in
`artifacts/2026-08-04-judge-design-understand/`. No design proposals
appear here by construction — design options are generated AGAINST this
document. The synthesis follows verbatim.

**Selection update, 2026-08-04:** Andreas selected the expanded 2Q / dual
catalog architecture in `JUDGE-DESIGN-SELECTED.md`. This document remains the
evidence base; the four generated option drafts are now terse provenance
records rather than live alternatives.

---

# Judge design — UNDERSTAND (evidence, not proposals)

pi-hydra, repo `pi-hydra.piped-discovering-minsky`, state 2026-08-04. Synthesized from three readers (decisions / pain / constraints) plus my own reads of `INDEX.md`, `BENCHMARK-SPEC.md`, `CAPSTONE-JUDGE-SPEC.md`, `GOLDEN-DATASET-DESIGN.md`, `ITERATION1-DATA-PASS.md`, `CONSENSUS-SPEC.md`, `CONSENSUS-RESULTS.md`, `SEVERITY-V4-BLOCKING-TIER.md`, `CAPSTONE-SCORING-RESULTS.md`, `GOLDEN-V2-PROTOCOL-DECISION.md`, `ITERATION2-JUDGE-WAVE-SPEC.md`, the calibration `VERDICT.md.gz`, and the user-message archive. **No design proposals appear below.** Where a reader wrote advice, I converted it into the requirement or tension it implies.

---

## 1. Why judging exists — stated from the end use backward

Andreas has **already picked** a design: one ENUM-SO2 observer contract for both providers, with a provider text split as the named fallback (`INDEX.md` §Product decision 2026-08-02). Judging does not exist to rank observers in the abstract. It exists to **confirm or overturn that pick, and to settle split-or-not**, by filling the quality half of one table — cost per observation, observer cost as a percentage of driver cost, blocking recall, any-harm recall, precision, absolute noise, quiet-span deliveries, plus a weighted-recall convenience value (msg S2-118 item 11; `BENCHMARK-SPEC.md` §Scoring design). Cost and quality stay in separate columns because the tradeoff is Andreas's to make, not a formula's (`BENCHMARK-SPEC.md` §Reading rules).

The product semantics behind the whole metric is his, verbatim (msg S2-62): *"as a developer what I care about when I ask another developer to review my code is that from the ranking of 1 to 10 from most severe to least severe the reviewer finds the top ones. Missing top findings is worse than missing a low severity finding."* That sentence is the origin of the lexicographic blocking rule. So: **judging's job is to say, credibly and cheaply, whether an observer arm catches the issues that matter, without inventing coverage it did not earn** — credibly enough that a shipped contract can rest on it, cheaply enough that it can be re-run across 2–3 iterations before lock-in (`BENCHMARK-SPEC.md` §Iteration protocol).

Two hard framings follow from the end use, and they constrain design more than any integrity rule:

- The comparison is between **a terse prose arm and a verbose enumerating arm** at margins that are currently a few blocking issues wide. A metric that is not unit-comparable across those two shapes cannot decide the question it was built for.
- **Nothing published today is a lock-in number.** `CAPSTONE-SCORING-RESULTS.md` opens by saying so; the dataset is final only after an iteration whose data pass surfaces no dataset-label bugs, target iteration 3 (`BENCHMARK-SPEC.md` §Iteration protocol). Iteration 1 surfaced several.

---

## 2. The decision inventory, condensed to what a design must cover

The full inventory is 19 dataset-side decisions plus 14 scoring-side decisions plus 7 governance calls. Condensed to classes a design must answer — who decides, what the input/output is, and what it costs:

| class | the question | who decides today | cost basis today |
|---|---|---|---|
| **Eligibility** | which delivered text is judgeable at all | code, versioned policy (`strict-v1` → `semantic-v2`) | free |
| **Atomization** | how one delivered message becomes N defect claims | each judge, inside its own call | inside the judge call |
| **Individuation** | when two claims are the same defect (sets denominators) | **one judge, one call, no deliberation** | ~1–2 calls per pool |
| **Support** | is this claim backed by the visible evidence | each judge, calibrated `SUPPORT_POLICY` | inside the judge call |
| **Matching** | which catalog record this claim covers | each judge; **intersection** required to credit | inside the judge call |
| **Tiering** | blocking / harmful / not-real | **three participants, up to six rounds** | largest recurring draw |
| **Liveness** | was this defect present at this observation point | code (anchors) | free |
| **Alignment** | reconciling the two judges' independently split claim lists | 28 analyst agents (14 matchers + 14 adversarial verifiers) | 28 agent runs |
| **Dispute resolution** | what happens when a verifier refutes a credit | analyst alone, 4-value vocabulary | free |
| **Growth** | do new findings become dataset records | protocol says both judges + deliberation | **never executed** |
| **Reading** | which column outranks which | registered rules + analyst prose | free |
| **Freeze** | when the ruler stops moving | pre-registration + evaluator freeze | free |

**The load-bearing asymmetry, and it is the single most useful structural fact in the record:** individuation is decided by one judge, one call, no deliberation, no adversarial check — and it sets every denominator and decides whether a claim is coverage credit or a novel defect. Tiering the *same* issue costs three participants and up to six rounds. Effort is concentrated where agreement was already measured at 90.5% (`SEVERITY-V4-BLOCKING-TIER.md` §The finding), and withheld where nothing has ever been measured.

**Cost currency.** Only one dollar figure exists in the entire judge system: **$12.96 of producer spend** for the six OpenAI capstone driver cells (`BENCHMARK-SPEC.md` §Registered OpenAI production wave). All judging is $0 metered — Sol on the OpenAI subscription, Opus on the Claude subscription, analyst agents in-session (`CONSENSUS-RESULTS.md` head). The real budget is **judge calls, agent runs, and plan-window wall-clock**: ~276 judge calls and roughly 2–4 hours of judge wall-clock per iteration (measured: Opus 137.6 min for the fresh 264-finding input at concurrency 1; Sol 95.5 min). That constraint — not money — is why checkpoint-per-batch and drift-refusing resume exist (`ITERATION2-JUDGE-WAVE-SPEC.md` §Spend and interruption discipline).

---

## 3. How the current design approaches the goal, and what it honestly buys

**The shape.** A hybrid: a stable curated golden set per task (regression gate, cross-time comparability, zero API calls) plus a judged bonus category so the set grows from discovery rather than authoring (`GOLDEN-DATASET-DESIGN.md` §Why hybrid). Coverage is scored by two judges from different vendors independently reading each delivered finding, splitting it into atomic claims, deciding support, and matching against catalog statements — then an analyst stage reconciles them. Severity lives in the dataset, not in the scoring pass.

Its real advantages, each with the measurement that earns it:

1. **The judges' verdicts are not deferential.** Deliberation moved convergence 42.9% → 90.5% → 95.2%, then stalled cleanly at round 4 — **+52.3pp against a pre-registered 5pp "this is ceremony, drop it" bar** (`CONSENSUS-RESULTS.md` C1). Of 12 position changes: 8 evidence-driven, **0 authority-driven**, 4 unclassified by a deliberately conservative classifier (C2). This is the largest measured quality effect anywhere in the judging system.
2. **The analyst is checked, and the check fired.** 11 of the 12 changes were the analyst's, not the judges' — the analyst had labelled against seeded code while the judges read the final session state (`CONSENSUS-RESULTS.md` C4). A design without a pre-registered analyst-steering check would have shipped that error.
3. **The severity scale was narrowed by measurement, not by taste.** Four levels 61.9%, three 66.7%, blocking-vs-rest **90.5%**, any-harm **95.2%**, `inDeliverable` 38.1% — with adjacent-or-better agreement 100%, i.e. a scale finer than the judges' resolution (`SEVERITY-V4-BLOCKING-TIER.md`). The set now carries only the two axes judges can resolve.
4. **Disagreement survives instead of being averaged away.** The `s01` lease-clock 2-1 split surfaced the reachability convention the rubric never specified — which became RULING 1 — and `CONSENSUS-RESULTS.md` C3 states plainly that forcing it *"would have hidden the most useful thing the run found."* Four stable dissents are carried verbatim in v2.
5. **The instrument is replayable, and that has already paid off.** Frozen SHA-256 on rows, payloads and dataset; a pinned judge builder hash; atomic per-point checkpoints; resume that refuses drift and never overwrites another judge's file (`CAPSTONE-JUDGE-SPEC.md` §Identity and recovery). This is the *only* reason Opus could answer Sol's byte-identical questions weeks later, including on the old input at the pinned `369ed58` builder.
6. **Pre-registration has been exercised under pressure, twice.** The scoring design was registered before any judged coverage existed. And when the freeze bar failed at 63/67, the options and their exact rule text were registered *while every v2 quality cell was blank and both Opus columns were unspent* — so the choice could not be tuned toward an arm; the write-free dry run's projection then matched the build exactly (`GOLDEN-V2-PROTOCOL-DECISION.md` §Timing property, §Projected effect).
7. **Blinding is implemented, not just asserted.** Judges see catalog statements only — no tiers, votes, consensus, planted labels, producing arm, delivery route, cost, or expected result; findings within a point are ordered by a stable hash of the hidden source key (`CAPSTONE-JUDGE-SPEC.md` §Frozen questions; verified in `capstone-trajectory-judge-protocol.mjs`).
8. **Independent discovery catches what nobody planted.** Blind reference review, reviewers blind to the planted list, the golden set, prior findings and each other. It produced the most sobering number in the program: **34 of 46 v1 issues were found by no arm at all, 14 of them blocking** (`GOLDEN-DATASET-V1-RESULTS.md` §Per-arm scores). Without it, recall would be measured over the collectively-found set and would flatter every arm.
9. **The adversarial stage exists and does work.** 14 opus-xhigh verifiers instructed to refute scoring-critical credits and default to refusal when uncertain refuted 6 credits and skipped 1; each of the 7 got an explicit analyst resolution recorded in-band (`CAPSTONE-JUDGE-SPEC.md` §Cross-judge consensus execution record).

---

## 4. Disadvantages

### 4a. Structural weaknesses — a clean-sheet design making the same top-level choices would reproduce these

**S1. The intersection credit rule silently drops coverage, and the drop is not uniform.** Measured across all 18 cells: **30 catalog ids matched by exactly one judge and credited to neither, 8 of them blocking, affecting 16 of 18 cells** (`ITERATION1-DATA-PASS.md` §Unrecorded findings 1). Two published readings are not robust to it: the effort-dependent reversal shrinks from 5-vs-2 to 5-vs-4, and old scheduler/sol-high ENUM 6 vs MAIN 3 becomes a **6-vs-6 tie** — which touches the "ENUM dominates, F2 is dead" narrative directly. Plus one measured case where both judges supported the same behavior but credited *different* ids, so nothing survived. **Caveat, load-bearing: the union counterfactual is the synthesizer's own proxy** (raw judge matches filtered on `centralSupported !== false`, without adversarial verification) — an upper bound, and the evaluator freeze bars it from the iteration-1 table. The rule is defensible; its cost is currently invisible in the table, which is what makes it dangerous for lock-in.

**S2. Precision is in different units per arm.** Findings per delivering row: **MAIN-SO2 exactly 1.00** (95 rows → 95 findings, max 1) vs **ENUM-SO2 1.71** (99 → 169, max 6); old MAIN 1.00, F2 1.00, ENUM 2.46 (`ITERATION1-DATA-PASS.md` §Unrecorded findings 2). `raised` is *steer count* for prose arms and *enumerated items* for ENUM. One MAIN steer carrying three credited ids counts as one raised item; ENUM needs three, each separately at risk. This structurally favors the prose arm — in exactly the comparison the decision is about.

**S3. The eligibility policy taxes the terse arm, by arithmetic.** Cache-only-invalid findings are MAIN-SO2 14/95 (14.7%) vs ENUM-SO2 9/169 (5.3%), only 5 of 23 credited. Incidence per observation *point* is unbiased (26 vs 21, Fisher p=0.52) — the asymmetry is pure ratio arithmetic, because MAIN's denominator is 56% of ENUM's (`ITERATION1-DATA-PASS.md` verdict 7). It compounds with S2 in the *opposite* direction on the denominator. The data pass is explicit that this "will recur in every future run pairing a terse arm with a verbose one."

**S4. Judge-side claim splitting makes claim counts non-comparable between judges and between passes.** It was adopted to avoid a worse format bias — 78 delivered messages but 119 emitted findings; counting a response as one claim would penalize ENUM for having an array API (`CAPSTONE-JUDGE-SPEC.md` §Why a new adapter is necessary). It solved that and created a residual the program acknowledges in `JUDGE-TRANSPORT-AB-SPEC.md` §Metrics.

**S5. Every cell sits on a same-transport self-disagreement floor.** Same model, same transport, same prompts, same frozen bytes, re-run: **5 of 45 discordant on real/not-real (11%) and 9 of 45 on catalog match sets (20%)** (`JUDGE-TRANSPORT-AB-SPEC.md` final section). Cross-transport disagreement is at or below that floor on every field — verdict FLIPPABLE. The floor is a property of LLM judging, not of the carrier, and it is not addressed by any rule in the system.

**S6. One-sided judge silence acts as a precision suppressor.** Opus returned zero claims for an entire batch on **17 of 109 fresh batches (27 findings, all auto-not-real); the reverse happened 0 times** — well-formed model decisions, not transport damage (`ITERATION1-DATA-PASS.md` §Unrecorded findings 5). Under both-judges credit, one judge's silence is indistinguishable from a considered not-real. **Flag: reader-reported; the synthesizer did not re-derive the 17/109 count.** No registered remedy covers it beyond the 23 cache-only rows.

**S7. n=1 per cell.** Each cell is one trajectory; sol-high and sol-xhigh are *different* driver trajectories (22 vs 25 points); 2 of the headline 5-blocker gap turn on a single message at `r3/16` (`ITERATION1-DATA-PASS.md` verdict 5). On the dataset side the same thinness is stated twice: 3 unanimous blockers means one flip moves an arm 33pp (`CONSENSUS-RESULTS.md` §Limits); 2 blockers means 50pp (`SEVERITY-V4-BLOCKING-TIER.md` §Limits). The agreement numbers (n=21) are the solid part; the per-arm scores are not.

**S8. Individuation and matching are single-judge, single-call, undeliberated** — and they set the denominators. The clustering prompt itself names the failure mode it cannot guard against: a wrong match silently converts a new defect into coverage credit. Nothing checks it but an analyst reading `mapping.txt`.

**S9. Judges never see anchors**, so a record whose statement describes the wrong mechanism can still be credited. `EXP-o-xe-g21`'s statement names `totalCents`/`Math.round`, neither of which appears anywhere in that run; the actual trailer is `totalAmount += row.amount` → `.toFixed(2)`. Both judges credited on the consequence clause — zero of the 3 matched claims mentions cents or rounding — because the prompt renders `key: statement` only (`ITERATION1-DATA-PASS.md` B3, correcting the results doc's own surprise-3 wording).

**S10. Anchors as a class are broken enough to make liveness unresolvable for 44% of the catalog.** 33 of 75 active records carry no anchor at all — **scheduler 31 (9 blocking), exporter 1, dispatcher 1** — so scheduler is essentially unfiltered while exporter loses 3–4 (`ITERATION1-DATA-PASS.md` verdict 4; distribution exact, **liveness rate is an n=10 hand-sample, not a census**). Of the 42 anchored records, all three tasks' anchors transcribe **opus-high** driver runs while iteration 1 scores OpenAI Sol runs — so of seed 25 / start 3 / **end 14**, the end anchors cannot match by construction (verdict 3, class-level dataset-label bug).

**S11. Nothing has ever checked the judge system against Andreas's own judgment.** `SEVERITY-V4-BLOCKING-TIER.md` §Consequences named exactly one surviving job for the authored gold set — *does the judges' blocking set match his own top picks* — and `GOLD-SET-DRAFT-FOR-REVIEW.md` was retired as a review artifact when he delegated severity (`CONSENSUS-SPEC.md` §Mandate). That calibration has never run. Every agreement number in the program is judge-to-judge, never judge-to-Andreas. (My readers split on this: one called it the deepest gap, the other filed it as nice-to-have. I side with the first — see tension T6.)

**S12. The two instruments define "blocking" differently, and the program routes around it rather than fixing it.** The pool probe's `HARM_ANCHORS` files "a silent failure that will bite in normal operation" under **serious**, while the consensus `RUBRIC` enumerates "silent incorrect results" under **blocking**. Adding the RULINGS to the pool prompt flipped **0 of 3** issues; **0 of 56 judgments said blocking in either direction**, though the rulings were demonstrably read (11 of 28 rows moved elsewhere). Verdict text: *"a conventions block that never touches the boundary definition cannot close a definitional gap"* (`artifacts/2026-08-02-golden-v2-calibration/VERDICT.md.gz`). The standing rule that resulted is a routing rule — golden tier wins, pool tiers are advisory — so the system permanently maintains two instruments with incompatible severity definitions plus a rule about which to believe. The alignment factor test is registered and has never run.

### 4b. Patch-accumulated complexity — the count

**Counting rule (so the number is falsifiable): a "standing rule" is one in force today.** Registered-but-unrun items are excluded — everything in `ITERATION2-JUDGE-WAVE-SPEC.md` steps 1–6, A4 and A5 in `CAPSTONE-JUDGE-SPEC.md`, the broad-claim matching refinement, and the `HARM_ANCHORS` factor test. On that basis: **37 standing rules — 10 design-first, 3 earned by passing a pre-registered test they could have failed, 1 preventive with no triggering failure, and 23 that exist only because something broke. 62% patch.**

The three *earned* rules: three-participant deliberation to convergence; the analyst as an independently-labelling third participant; anonymised participants. The one *preventive* rule: the adversarial verification stage.

The 23 patches, and the depth of the chains they sit in:

| chain | depth | sequence |
|---|---|---|
| Severity scale | 3 | 4-level gate fails at 41.7% → decompose into 3 judged fields + 2 analyst blends → collapse to 2 binary axes, drop `inDeliverable`. Plus `SEVERITY-V3-SPEC.md`, a complete pairwise/Bradley-Terry design written, registered and **superseded without ever running**. |
| Pool construction | 5, tail open | message-clustering swallowed MAIN's only blocking finding → per-claim extraction with printed mapping → RULING 2 individuation → v1 audit splits bundled reports → broad-claim matching refinement (registered, unrun) |
| Source and frame | 4, tail open | wrong `sourceBlock` fed the seed instead of `codeContext(rows)` → RULING 3 → mechanical frame routing at pool time (a symptom filter missed the accept direction) → anchors as the unresolved tail |
| Eligibility | 4, tail open | `strict-v1` → `semantic-v2` (rescues 5 real findings) → documented non-neutrality → three printed precision variants + a one-sentence prompt clarification (registered, unrun) |
| Convergence bar | 3 | 95% unanimity → statement-repair with an eligibility test → Option A "addressed" gate |

**Two entries deserve separate weight.** First, **the same failure class occurred twice, weeks apart**: judges fed the wrong code state, once in the C2 consensus run (13 of 21 issues were about driver-written artifacts, so the run measured the analyst's prompt — `CONSENSUS-RESULTS.md` C4) and again in the v1 build (7 seed-authored issues rejected on driver-repair reasons, including a planted defect). That is the strongest single signal in the catalog. Second, **the analyst authors the four RULINGS, votes under them, and resolves disputes about them** — with no independent ratification step. Each is marked reversible with its consequence-if-wrong, which is honest, but the concentration is real. Alongside that: 7 of 13 runner-up bullets are split into 21 candidate statements by an analyst decision **hardcoded as a code constant** (`RUNNER_UP_SPLITS`), with the task assignment hardcoded too, no protocol, no schema, no second reader.

**The one counterexample.** The severity collapse (`SEVERITY-V4-BLOCKING-TIER.md`) is the only patch that made the design *smaller* — it removed a scale level, a judged field, and an entire superseded spec, using zero new judging. Everything else added machinery.

### 4c. What the patching has *not* fixed

Distinguish disclosure from repair, because iteration-2 commits read as closure and are not:

| pain | status |
|---|---|
| Intersection floor (30 one-sided ids, 8 blocking) | **disclosed, not fixed** — a one-judge-floor column now sits beside recall; the rule is unchanged |
| Per-arm precision units | **disclosed, not fixed** — three precision variants printed; `raised` still means different things |
| Opus one-sided silence (17/109) | **no patch at all** beyond the 23 cache-only rows |
| `HARM_ANCHORS` vs `RUBRIC` blocking boundary | **routed around**; alignment test never run |
| Judges never see anchors | registered, unrun |
| 33 anchor-less + 14 non-portable end anchors | registered, unrun |
| Cross-generation builder-hash residue | registered, unrun |
| Same-transport self-disagreement floor | measured, accepted, **unaddressed by any rule** |
| Promotion of 67 novel candidates | **never executed**; dedup against v2 actives *and* rejections is step one and has not run |

---

## 5. Requirements a judge design must satisfy

### MUST — a design failing any of these cannot support the lock-in decision

1. **Produce a per-arm quality number that means the same thing in every cell.** Today `raised` is steer-count for prose arms and item-count for ENUM (1.00 vs 1.71 findings per delivering row) — non-comparable across exactly the two arms the decision is between. `ITERATION1-DATA-PASS.md` §Unrecorded findings 2.
2. **Two independent judgments per finding; both required to credit; disagreement recorded verbatim, never averaged.** Written rationale: a one-judge promotion *"would let the set fill with unvetted opinion, and nobody could later tell which records were vetted how"* — `GOLDEN-DATASET-DESIGN.md` §Promotion; `BENCHMARK-SPEC.md` §Boundaries; `CAPSTONE-JUDGE-SPEC.md` §Scoring boundary.
3. **The credit rule's cost must be visible beside every recall cell, or the orderings must be stable under it.** 8 blocking ids currently credited to neither judge; two published orderings flip under a union proxy. `ITERATION1-DATA-PASS.md` §Unrecorded findings 1.
4. **Quality, cost and delivery-correctness stay separate columns; blocking recall outranks any-harm lexicographically.** msg S2-62 (his own framing), msg S2-118, `BENCHMARK-SPEC.md` §Reading rules.
5. **Score only on tiers the judges can resolve.** blocking-vs-rest 90.5%, any-harm 95.2%; 4-level 61.9%; `inDeliverable` 38.1%. `SEVERITY-V4-BLOCKING-TIER.md`.
6. **Register the metric and protocol before any judged cell exists; freeze the evaluator within an iteration; version changes between iterations.** `BENCHMARK-SPEC.md` §Scoring design and §Iteration protocol; `GOLDEN-V2-PROTOCOL-DECISION.md` as the worked precedent.
7. **Be replayable: frozen input hashes, pinned builder hash, per-batch atomic checkpoints, drift-refusing resume, fail-closed merges.** This is what let a second judge column be added weeks later. `CAPSTONE-JUDGE-SPEC.md` §Identity and recovery, §First registered input.
8. **Judges see statements only** — no tiers, votes, planted labels, arm, route, cost or expected result. Implemented today; must not regress. `CAPSTONE-JUDGE-SPEC.md` §Frozen questions.
9. **No known-case tuning, no answer keys, no evaluator change that rescues an arm.** msg 1182 (*"this is reward hacking that we absolutely don't want"*), msg 177, msg S2-118; `BENCHMARK-SPEC.md` §Boundaries.
10. **Promotion requires both judges plus the deliberation protocol; no agent promotes its own finding.** msg S2-78; `GOLDEN-DATASET-DESIGN.md` §Promotion; `ITERATION2-JUDGE-WAVE-SPEC.md` §Boundaries.
11. **Fit the operational envelope: ~$0 metered, ~276 judge calls and ~2–4 h judge wall-clock per iteration, survivable across a quota interruption via checkpoint-and-resume.** Measured; `ITERATION2-JUDGE-WAVE-SPEC.md` §Spend and interruption discipline. **Note: no numeric weekly quota exists anywhere in the record** — only evidence that the window has interrupted work. Any design whose feasibility depends on headroom needs that number measured, not assumed.
12. **Do not assume pi-native Opus judging works.** Only the `oauth-replay` production shape is confirmed to draw plan quota; three capped ablations off the working shape each still drew plan, so the field that classifies a request out of plan coverage remains unisolated. `JUDGE-TRANSPORT-AB-SPEC.md` §Route-level correction.

### SHOULD — materially improves trust; a design lacking these owes a stated reason

13. **Keep deliberation, or beat +52.3pp another way.** 42.9% → 95.2%, 0 authority-driven changes. `CONSENSUS-RESULTS.md` C1/C2.
14. **Make denominators comparable across the cells being compared.** Anchor backfill is named *"the single highest-leverage dataset fix for iteration 2"*; 33 anchor-less records, 31 on one task. `CAPSTONE-SCORING-RESULTS.md` surprise 4.
15. **Report effect sizes with their n and their sensitivity.** n=1 per cell, different trajectories per effort tier, two blockers hinging on one message. `ITERATION1-DATA-PASS.md` verdict 5.
16. **Put both generations on one eligibility policy and one prompt builder before writing any fresh-vs-old sentence — or write none.** Builder hashes differ (`df3cc0f5…` vs `5880bf01…`): an unmeasured residual on every fresh-vs-old sentence. `ITERATION1-DATA-PASS.md` finding 7.
17. **Make the eligibility policy arm-neutral, or report precision on both bases.** Verdict 7.
18. **Decide explicitly whether arms may be co-presented in one judge prompt.** The earlier judge deliberately drew batch items from *different* observation points because *"co-presentation nudges the judge toward treating X as the real one"* (`artifacts/wave8-designs/wave8-quality.md`); the capstone judge batches one point and renders all arms' findings together — **85 of 109 fresh batches co-present more than one arm** (constraints reader's own measurement from the frozen Opus checkpoint; I did not re-derive it). Order is hash-blinded and arm identity hidden, but arms sit side by side. The hazard is documented and plausible, **not directly evidenced** — the instance the wave8 doc cites is, on inspection, a target-metric disagreement. It has never been tested either way. Whichever way it goes, it should be a decision with a reason rather than an artifact of the batching unit.
19. **Give the support policy real provenance.** The calibrated `SUPPORT_POLICY` every judged number rests on traces to the `2026-07-29-evaluator-calibration` run, which per `RUN-LEDGER.md` was **judge-side only, never frozen, analysis scripts mirror-only** — the weakest provenance of any component in the chain.
20. **Reader-in-the-loop after every pass.** *"After each pass the analyst reads the original delivered messages, the atomic judgments, and the raw responses; summary numbers alone are insufficient"* (`CAPSTONE-JUDGE-SPEC.md` §Identity and recovery); msg S2-118 item 8. This is what produced every correction in §4.

### NICE

21. **Cross-provider judge mix specifically.** See T5 — no recorded requirement.
22. The 2:1 weighted-recall column, registered explicitly *"for scanning the table, never for verdicts."*
23. Quiet-span deliveries as a column. Vacuous in iteration 1; needs the payload-walker fix *and* a corrected span derivation — the minimum live-per-point is **3 in every one of the 8 cells**, so no cell is one fix from a span (`ITERATION1-DATA-PASS.md` 1b; per-point minima are reader-reported, not re-derived). Note the published *reason* for the zero column ("planted defects live from point 0") is wrong — an example of a disproven reason still sitting in a spec.

---

## 6. Open tensions a designer must resolve

**T1 — Independence vs deliberation.** Independence is what makes two judges worth having; deliberation is what makes them agree. Both are measured, and the measurement cuts both ways: round-1 independent agreement was **42.9%** — that is the *price* of independence — and deliberation bought +52.3pp. But deliberation is also the largest recurring cost item, and it is applied to tiering (already 90.5% independent) and withheld from individuation and matching (never measured). Any design must say where deliberation buys the most, and the record's answer is: nobody has checked.

**T2 — Coverage vs cost of a conservative credit rule.** Requiring both judges to match the same id costs 30 catalog matches, 8 of them blocking, across 16 of 18 cells, and makes two published orderings non-robust. Loosening it lets one judge's opinion become coverage — precisely what `GOLDEN-DATASET-DESIGN.md` §Promotion argues against. The counterfactual that shows the cost is an upper bound built without adversarial verification, so the true middle is unmeasured.

**T3 — Unanimity vs recorded dissent.** The 95% convergence bar was written to catch a sloppy pool; what it actually caught was four stable honest disagreements, which the protocol had *already* decided to record verbatim rather than average. The gate contradicted the protocol it was gating, and the bar became mathematically unreachable (`GOLDEN-V2-PROTOCOL-DECISION.md`). Option A restated it from "converged" to "addressed." Any future gate faces the same fork: a threshold that cannot distinguish noise from a real definitional split will eventually block on honesty.

**T4 — Evaluator freeze vs known-wrong numbers.** The freeze is what makes the numbers unfakeable, and it is why the metric could not be tuned toward an arm. It also forced iteration 1 to publish around two known harness bugs (all 18 noise cells computed on the wrong definition; the payload liveness walker blind — 0/131 payloads have `.messages`, 131/131 have `.input[]`) and cost the quiet-span column entirely. The data pass calls the handling protocol-correct. The tension is real and permanent: a stricter freeze buys credibility and ships known-wrong cells.

**T5 — Provider symmetry: grounded for two judges, ungrounded for two vendors.** This is the finding that most opens design space, so it is stated precisely. The **two-judge** rule has an explicit written rationale (`GOLDEN-DATASET-DESIGN.md` §Promotion). The **cross-provider** split has **no recorded rationale anywhere** — I searched `experiments/*.md` and the full user-message archive for independence, decorrelation, self-preference, vendor-diversity or same-family reasoning and found nothing. What the record actually shows: the original two judges were terra + sol, **both OpenAI**; the objection was model *strength* (msg 109: *"judge quality must be strong"*), not provider diversity. Opus arrived after that, and the recorded reason for routing it through Claude Code is **cost** (msg 163: *"simply because it's cheaper because it goes through the subscription instead of pay per use"*). Later messages name the pair as a directive with no reason attached (msg S2-115, S2-118: *"Use both sol and opus as judges"*). Every use of "independent" in the record means round-1 independent labelling or independent discovery in the blind review — procedural independence within a protocol, not vendor independence. **The trap to avoid:** `JUDGE-TRANSPORT-AB-SPEC.md` tested the *carrier* and found it doesn't matter (verdict FLIPPABLE). That is not evidence that the *provider* doesn't matter — that was never tested. The honest statement is "no recorded rationale," not "provider mix doesn't matter."

**T6 — Delegation vs external validity.** Andreas delegated severity completely: *"I do not want to review the set. It is your and the two judges' job. Please iterate until you all agree"* (msg S2-78, quoted as the mandate in `CONSENSUS-SPEC.md`). That delegation bought scale and cost nothing. It is also exactly what retired `GOLD-SET-DRAFT-FOR-REVIEW.md` and made unrunnable the one-time calibration that `SEVERITY-V4-BLOCKING-TIER.md` §Consequences identified as the authored set's only surviving job — *does the judges' blocking set match his own top picks?* So: the blocking definition that drives the lexicographic reading of the lock-in table has never been validated against the person making the lock-in call. My two readers disagreed on how to weight this (deepest gap vs nice-to-have); I file it here as a tension rather than a requirement because resolving it is a call about what "correct" means, not a measurement gap.

**T7 — Where to spend judgment.** Individuation is one call, no deliberation, and decides denominators and credit-vs-novel. Tiering is three participants and up to six rounds on a question already 90.5% agreed. No measurement anywhere justifies that allocation; it is an accident of the order in which problems surfaced.

**T8 — What a judge is allowed to see.** Judges see statements but not anchors, which is why a statement describing the wrong mechanism was credited by both. Showing anchors would leak dataset structure into the judgment; not showing them leaves statement/anchor mismatch structurally invisible. Both directions have a cost and neither has been measured.

---

## Evidence-quality flags — carry these or the evidence degrades to summary

- **Validation anchor:** the data-pass synthesizer independently reproduced all 18 published blocking-recall cells from frozen inputs before accepting any reader claim (`ITERATION1-DATA-PASS.md` head). Corrections in §4 are measured against a verified baseline.
- **Not re-derived, carried at reader confidence:** the Opus 17/109 zero-claim count; the `bothNotReal` support-reading correction (+1 in two cells); the per-point liveness minima behind the quiet-span analysis; the labels reader's per-point code reads for 10 sampled records (`ITERATION1-DATA-PASS.md` §Where the evidence is thin).
- **Sampled, not censused:** the 33 anchor-less records — 10 resolved by hand (7 live, 3 not). The 31-of-33 scheduler distribution is exact; the liveness rate is an n=10 estimate.
- **Synthesizer's own proxy:** the union-credit counterfactual — an upper bound, evaluator-freeze-barred from the iteration-1 table.
- **Reader measurement not re-derived here:** co-presentation at 85 of 109 fresh batches; the hazard it supports is documented and plausible but not directly evidenced.
- **Endorse/refute:** if an endorse-and-refute judge design is circulating, **it has zero repo grounding**. The word "endorse" appears exactly once in the entire repository, incidentally, inside a verifier's reason string in a workflow journal. It is live-conversation context, not repo record.
- **Provenance caveat on the constraints list:** the "Non-negotiable constraints" block in msg S2-118 sits inside a pasted session-continuation brief, not necessarily Andreas's own prose. Several items are independently corroborated in his own words (reward hacking msg 1182; severity delegation msg S2-78; steer semantics); others are the program's own accretions restated back to him. That distinction matters when grading a rule as load-bearing.
- **No reader contradicted another.** The apparent 12-vs-12 conflict resolved into two genuinely distinct diffs, both verified.
