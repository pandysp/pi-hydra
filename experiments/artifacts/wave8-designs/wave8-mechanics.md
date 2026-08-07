## (a) Firing model

**Two triggers, both at driver cache-commit points.**

- **Piggyback** — `pi.on("message_start")` (index.ts:1529), fires per *assistant message* (index.ts:1564), not per tool batch. The run's first assistant response is skipped (index.ts:1560-1562, gate armed at `agent_start` index.ts:1480) because the previous run-end observation already covered everything before it. The replayed bytes are the payload captured at `before_provider_request` (index.ts:1516).
- **Run-end** — `pi.on("agent_end")` (index.ts:1582), once per run, only if a usable final assistant M exists (index.ts:1600-1603).

So the *ceiling* per head per run is `K` observations for `K` assistant messages (`K−1` piggyback + 1 run-end).

**The conflating scheduler.** `scheduleObservations` overwrites `runner.pending` unconditionally (index.ts:1436) and only starts a drain if none is running (index.ts:1449). `runHead` consumes the slot and nulls it (index.ts:1393-1394). That is **one in flight + one waiting slot per head**: every snapshot arriving while an observation is running and a newer one already waits is silently dropped. Slots are also dropped on head deactivation or branch change (index.ts:1395-1397). So

    N_obs ≈ min(T, run_wall_time / obs_latency)

**Measured, from 559 real hydra-call records (82 head-sessions):** **0.74 mean / 0.83 median observations per driver assistant turn per head**; 392 piggyback vs 167 run-end (70/30). Conflation sheds ~20% of the ceiling.

**Load-shedding does NOT get worse with context length** — I regressed `durationMs` on `cacheRead+input` across 509 single-iteration calls: `dur = 3902ms + 53ms/1k tokens`, **R²=0.001** over a 2.7k–8.7k context range. Latency is generation-bound, not prefix-bound. So `N_obs/T` stays ~0.8 as trajectories grow rather than falling — it does not offset the ratio growth in (b). (Range-limited: no data above ~9k context.)

**What one observation pays on Anthropic** — the decisive detail is in the merge doc comment, utils.ts:786-806, implemented at utils.ts:817-827:

| tail shape | kind | marker action | billing |
|---|---|---|---|
| `[prompt]` | **piggyback** | `anchored=false`, `loopTurns=false` → `target=undefined`, **nothing moves** | prefix L = pure **cache-read**; handoff = **uncached input**; **zero cache write** |
| `[M, prompt]` | **run-end** | marker (with driver's TTL) rides M's last markable block | prefix = cache-read; **write = driver delta + M**, which pre-warms the driver's next turn; handoff still uncached input |
| `[M?, prompt, …turns]` | acting loop | plain ephemeral on tail frontier | each loop turn written once, read after |

**Consequence for the arms: the arm-dependent handoff tokens are never cache-written in production, in either kind.** The `cw` column in the screen artifacts (A0 588 / J 839 / F 808 at xhigh) is a *harness* artifact — a token count, not a production price. The cost sweep's "prompt at input rates" reconstruction is the correct production basis. Arm cost is `H·$5/M + O·$25/M`.

## (b) Trajectory-ratio formula

    ObserverCost(head)   N_obs   L·p_cr + H_arm·p_in + O_arm·p_out
    ─────────────────── = ───── · ─────────────────────────────────
    DriverCost             T       L·p_cr + Δ·p_cw + O_drv·p_out

opus-5: p_in $5/M, p_out $25/M, p_cr $0.5/M, p_cw $6.25/M. Δ = driver's per-turn cache write (its own output + the tool result) — **Δ does not grow with L**.

**Arm-independent:** `L·p_cr` (both numerator and denominator), `N_obs/T`, the entire denominator, the run-end write. **Arm-dependent:** only `H_arm` and `O_arm` — a few hundred tokens.

**The asymptote is the headline: as L → ∞ the bracket → 1 and every arm converges to N_obs/T ≈ 80%.** The ~30% prior is not wrong, it is **length-scoped**: it holds at short transcripts with a talkative driver and decays toward 80% as the transcript grows. Direction per head: **grows, past 40%.**

Two effects run opposite and must not be conflated: the **per-head ratio grows** with L; the **arm spread shrinks** with L (from ~16pp at 10k to ~2pp at 150k).

`H_arm, O_arm` from `experiments/artifacts/2026-07-31-{high,xhigh}-screen/producer.jsonl.gz` (n=34/arm): xhigh A0 (588,314) / J (839,356) / F (808,413); high A0 (613,207) / J (817,293) / F (810,277).

**I will not give single-point predictions.** The ratio is most sensitive to `O_drv` (driver output+thinking per turn), which is unmeasured on Anthropic — the mined `drvOut` (~34 tok/turn) is trivial synthetic codex tasks and is not a usable anchor. Parameterized, N_obs/T = 0.80, Δ = O_drv + 500:

**opus-5 HIGH — per-head observer/driver ratio**

| L | O_drv | A0 | J | F | F−A0 |
|---:|---:|---:|---:|---:|---:|
| 10k | 300 | 60.5% | 75.0% | 73.0% | +12.5pp |
| 10k | 1000 | 26.9% | 33.3% | 32.5% | +5.6pp |
| 10k | 3000 | 10.4% | 12.9% | 12.5% | +2.1pp |
| 50k | 300 | 70.9% | 77.7% | 76.7% | +5.8pp |
| 50k | 1000 | 44.8% | 49.1% | 48.5% | +3.7pp |
| 50k | 3000 | 21.8% | 23.9% | 23.6% | +1.8pp |
| 150k | 300 | 76.1% | 79.0% | 78.6% | +2.5pp |
| 150k | 1000 | 60.9% | 63.2% | 62.9% | +2.0pp |
| 150k | 3000 | 38.7% | 40.2% | 40.0% | +1.3pp |

**opus-5 XHIGH**

| L | O_drv | A0 | J | F | F−A0 |
|---:|---:|---:|---:|---:|---:|
| 10k | 300 | 72.2% | 82.7% | 88.5% | +16.3pp |
| 10k | 1000 | 32.1% | 36.8% | 39.3% | +7.3pp |
| 10k | 3000 | 12.4% | 14.2% | 15.2% | +2.8pp |
| 50k | 300 | 76.4% | 81.3% | 84.0% | +7.6pp |
| 50k | 1000 | 48.2% | 51.3% | 53.0% | +4.8pp |
| 50k | 3000 | 23.5% | 25.0% | 25.8% | +2.3pp |
| 150k | 300 | 78.4% | 80.5% | 81.7% | +3.3pp |
| 150k | 1000 | 62.7% | 64.4% | 65.4% | +2.6pp |
| 150k | 3000 | 39.9% | 41.0% | 41.6% | +1.7pp |

Absolute per-observation cost, production-priced, xhigh: L=800 (the frozen screen) A0 $0.0112 / J $0.0135 / F $0.0148 → L=150k A0 $0.0858 / J $0.0881 / F $0.0894. The arm delta is a flat **+$0.0023 (J) / +$0.0036 (F)** at every length; everything else is the shared prefix read.

**Analytical prior the benchmark must test:** the contract choice is a **third-order** term behind L and O_drv. At the guiding configs and realistic length (≥50k, O_drv ≥1000) all three arms land in a **48–65% per-head band** and differ by **<5pp**. Two heads at 150k on a quiet driver approach cost parity with the driver.

Small correction to the naive sum-ratio: the run-end write covers driver-delta+M, which the driver would have paid on its next turn anyway (utils.ts:790-793) — 30% of observations carry a partial credit, so the true marginal ratio is slightly below the table.

## (c) Real-session mining

**Source:** `~/.pi/agent/sessions/` — 200 jsonl files, **559 `hydra-call` records** across 43 session dirs, shape at index.ts:165-189, populated by `flattenUsage` at index.ts:748-756.

**There are ZERO Anthropic hydra sessions on this machine.** Driver assistant messages: 1272 `openai-completions` (deepseek-v4-flash local), 879 `openai-codex-responses`, 5 `anthropic-messages` — and none of those 5 carry hydra activity. All 559 hydra-calls are `gpt-5.6-{terra,luna,sol}` codex.

**Comment defect, index.ts:170-173:** it claims api-absent entries "were all Anthropic." All 51 api-absent records are `gpt-5.6-luna` codex sessions under `--Users-spannagel-.claude-jobs-755fdcf3-tmp-hydra-verify--` (2026-07-13/14) — pre-*field*, not pre-*codex*. Anyone mining these the way I just did misclassifies 51 rows.

**What the codex ratios show, and why they don't validate the prior.** Per-head observer/driver cost across 82 head-sessions runs **14%–199%**, median ~63%, with many sessions >100% (e.g. `--private-tmp-pi-hydra-demo-exp3--` sid `019f6655-64f3-7ea5-8828-d4b162bc4028`: quality 119.5%, security 81.0%; `--private-tmp-pi-hydra-primary-19--` sid `019f668e-…`: 50.3%/61.3%; `--private-tmp-pi-hydra-webhook-natural-1--`: 63.9%/72.6%). But several of these are **cache-share-lost** sessions — e.g. sid `019f5b73-ebd8-7bcc-9c49-5c65821b74e2` has observer `in=17559` vs `cr=9216`, uncached input exceeding cache read, the exact degraded state index.ts:835-841 warns about. Those dollar ratios reflect broken codex cache scope, not Anthropic replay economics. **They neither validate nor refute the ~30% prior; they are the wrong provider.**

**What does transfer, provider-independently:** the **0.74/0.83 obs-per-driver-turn** firing rate and the latency regression. Both are pure scheduler mechanics.

**`/hydra-stats` never computed this metric** — it reports observer total cost, mean hit ratio, and mean duration (index.ts:1891-1918), never a ratio against driver cost. The ~30% prior did not come from instrumentation; it is an unrecorded impression, which is consistent with it being length-scoped and formed on short sessions.

**Next-best empirical anchor:** `experiments/acting-channel-smoke.mjs` — it already drives a real `runAgentLoop` on synthetic tasks in mkdtemp workspaces, so it is the only harness that produces both driver-side and observer-side usage from the same trajectory. It needs (1) an Anthropic opus-5 driver with heads active at the shared thinking level, (2) tasks long enough to reach ≥50k transcript (the current synthetic tasks bottom out around 5–8k, exactly where the ratio is least informative), and (3) driver-side `O_drv` recorded per turn — that parameter, not the contract, is what the measurement must pin down first.