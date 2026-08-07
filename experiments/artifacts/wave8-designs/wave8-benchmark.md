## TASK 2 — Trajectory cost benchmark: runnable design

### 0. Read this first (friction, before you fund the run)

**The ~30%-per-head prior is probably low, and the metric is not a constant — it rises with context length.** Two independent signals:

1. **Price-structure arithmetic.** Per point, observer ≈ `0.5·L + 5·P + 25·O` (µ$/Mtok units, opus-5: input 5 / output 25 / cacheRead 0.5 / cacheWrite 6.25, no `cost.tiers` → flat, from `~/.pi/agent/models-store.json`). Per driver request ≈ `0.5·L + 6.25·Δ + 25·D`. Observation count ≈ driver-request count (one piggyback per request, `index.ts:1545-1564`), so the `0.5·L` cache-read term enters numerator and denominator **1:1**. As L grows with fixed per-turn output, the ratio rises monotonically toward 100%, it does not shrink. What shrinks with length is the *arm contrast*, exactly as the brief says — but the *level* per head grows.
2. **Real recorded pi sessions** (`~/.pi/agent/sessions`, 22 sessions with ≥10 `hydra-call` entries, codex terra/luna, 6-24 driver turns, 4-15k max context): observer cost / driver cost per head **median 64%, range 26-100%**. Not a result — wrong provider, writes unreported on that backend, per-head division assumes equal head cost — but it points the same way as the arithmetic. No Anthropic hydra sessions exist on this machine (checked all 200 session files), so there is no free Anthropic data point.

Consequence for the design: **do not ship a scalar.** Ship a per-point curve `r(L, D)` plus the point estimate at the measured trajectory length. That is what makes n=3 trajectories transferable to the user's real sessions, and it answers "stays 30 / shrinks / grows to 40" as a mechanism rather than a coin flip.

---

### 1. Architecture: live fork, no replay, no warm calls

Do **not** record-then-replay. Run the driver once per (trajectory, config) and fire the three arms *inside the driver's own event stream*, at production's trigger points. Rationale:

- The driver's request commits its cache entry at TTFT (`docs/architecture.md:73-83`, verified e2e: read 4995 / write 0 / M-write 342). Arms firing right after that are guaranteed pure cache reads at **zero warm spend**.
- Kills every TTL problem: no 5-min expiry between a warm and N arm calls, no 1024-token floor issue (real prefixes are 5k+ from turn 1), no cache-write cascade from prefix growth.
- `runAgentLoop`'s emit callback is awaited (`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:238,151,172`) and carries `message_start` with the assistant message and `agent_end` with `newMessages` — i.e. the exact two triggers `index.ts` uses. Awaiting the arms inside emit blocks the driver's next request; that is a wall-clock deviation only, cache state and payload bytes are unaffected.
- Snapshot each captured payload to disk anyway (`payloadHash` + file) as re-run insurance and for the byte-identity assertions.

**Fidelity upgrade over the frozen harness:** call the real `mergeObservationPayload` (`utils.ts:810`) instead of `payloadTransform`'s hand-rolled splice (`delivery-context-golden-ab.mjs:296-320`). The arm call is then byte-for-byte the production judge path — copy `index.ts:1013-1027` verbatim: `streamSimple(model, { systemPrompt: "", messages: [M?, prompt], tools: [] }, { onPayload: built => mergeObservationPayload(captured, built.messages, envelope), signal })`. Everything except `built.messages` is discarded; tools and system come from the captured driver payload, so `visibleDriverTools` (`delivery-context-evaluation.mjs:209`) is no longer needed.

**Observation points, mirroring production exactly:**
- piggyback: every assistant `message_start` **except the first of each run** (`index.ts:1560-1564`), tail `[prompt]`, marker unmoved (`utils.ts:812-830`) → write 0 for all arms.
- run-end: one per run at `agent_end`, tail `[M, prompt]`, marker moves onto M.

**Run-end M-write asymmetry — solved by accounting, not by a warm call.** All three arms send an identical prefix+M key; whichever fires first writes |M| at 6.25, the other two read it at 0.5 (~$0.009 skew per point on a 1.5k M). A warm that replays `merge(captured, [M])` is *not* available: that request is assistant-terminal (prefill), which Anthropic rejects under extended thinking. Instead compose from measured tokens — zero estimation:

```
mTokens        = cacheWrite of the arm that wrote at this point   (measured)
composedCost   = (cacheRead - mTokensIfReader)*0.5/1e6
               + mTokens*6.25/1e6
               + input*5/1e6
               + output*25/1e6
assert: readerArm.cacheRead - writerArm.cacheRead == mTokens       (consistency check)
```
Every arm is then charged production's single-head economics. Still randomize arm order per point and record `armOrderIndex` so the ordering is auditable.

---

### 2. Cell structure

| dimension | value |
|---|---|
| trajectories | 3 coding tasks (+1 optional) |
| configs | `opus-5 high`, `opus-5 xhigh` — driver **and** observer at the same effort (hard constraint) |
| driver runs | 1 per (trajectory, config) = **6**, shared by all arms |
| arms | A0 (`screen-a0`), J (`screen-json`), F (`screen-footer`) — Anthropic prompt builders already in `delivery-context-evaluation.mjs`, used at `delivery-context-golden-ab.mjs:243-262` |
| head | one judge-only head, fixed lens, constant across all points and arms |
| points per run | ~15: 4 scripted user prompts → ~15 driver requests → ~11 piggyback + 4 run-end |
| samples | 1 per (point, arm). n comes from points; pairing is byte-exact (identical prefix), so the arm contrast needs no repeats |

Rows: 6 × (15 driver-turn + 45 observation) = **360 rows**, zero warm rows.

Statistics: report per-trajectory ratios (6 per arm) plus the pooled per-point curve. The *level* has trajectory variance (n=3 → wide); the *contrast* is paired at identical prefixes → tight. Bootstrap the contrast over points, report levels as a range not a mean.

**Tool-schema confound: ignore it, footnote it.** The driver prefix can carry only one hydra schema. Pin it to the shipped wide schema (`protocol.ts`, what main runs today). J/F would in reality shave ~200-400 tokens of tool schema, read at 0.5/Mtok ≈ $0.0002/obs — conservative against J/F, not worth a second driver run.

---

### 3. Trajectory source

**Primary: (ii) real driver runs.** Seed each `mkdtempSync` workspace by copying a real subtree of this repo (`experiments/*.mjs`, `index.ts`, `utils.ts`, `docs/`) — instant token mass, real files worth reading. Reuse `WORK_TOOL_FACTORIES` (`experiments/acting-channel-arms.mjs:365`: read/write/edit/ls) plus a minimal `grep` so the driver behaves like an agent instead of slurping whole files. Tasks must force multi-file reading to reach ≥15 turns / ≥25k context, e.g. "add a per-arm cost column to `summarize-delivery-context-golden.mjs` and update its test", scripted as 4 fixed user prompts (same user side for both configs).

**Validation: a real `pi -p` session with the shipped extension**, opus-5 xhigh, one head, A0 only (production ships one contract, so the comparison is A0-to-A0). Derive the ratio from `hydra-call` entries + assistant `usage` in the session JSONL — the exact query I ran above. This black-boxes `index.ts`, not the harness. Two gotchas: `HYDRA_SHUTDOWN_GRACE_MS=120000` or headless truncates the run-end observation and understates the numerator (`docs/architecture.md:161`); use `pi -p` then `pi -p -c` so multiple runs produce multiple run-end points. ~$2.

Frozen stitched transcripts (iii): **skip**. They cannot produce a driver denominator at all, which is the whole metric.

---

### 4. Row schema

One JSONL, two record kinds, common header `{runId, trajectoryId, model, thinking, taskSeed, ts}`.

`kind:"driver-turn"`: `runIndex, requestIndex, turnIndex, firstRequestOfRun, prefixTokens(=input+cacheRead+cacheWrite), input, cacheRead, cacheWrite, cacheWrite1h, output, reasoning, costTotal, toolCalls[], payloadHash, payloadPath`.

`kind:"observation"`: `pointId, pointKind("piggyback"|"run-end"), arm, armOrderIndex, head, lensHash, promptHash, capturedPayloadHash (must equal the driver row's), prefixTokens (copied), input, cacheRead, cacheWrite, cacheWrite1h, output, reasoning, costTotal, hitRatio, mTokens, composedCost, providerCalls, recoveryAttempted, decision{action,message}, responseText, stopReason, error, ms`.

`responseText` and `decision` are non-negotiable: the quality half of the study reuses these rows without re-running. `reasoning` on both kinds (opus-5 has `forceAdaptiveThinking: true`, so effort is a hint, not a budget — thinking must be measured, never assumed). Record each run's first-request `cacheRead` so the *without-hydra* denominator (no M pre-warm from the run-end fork) is computable without a re-run; the primary denominator is the with-hydra one, which is what the user actually pays.

Derived metric, no post-hoc estimation anywhere:
`R(arm, trajectory) = Σ_points composedCost(arm) / Σ_turns driver costTotal`.

---

### 5. Budget and runtime

Per (trajectory, config), 15 requests / 4 runs / 25k final context:

| | xhigh | high |
|---|---:|---:|
| driver: reads ~195k @0.5 | $0.10 | $0.10 |
| driver: writes ~30k @6.25 | $0.19 | $0.19 |
| driver: output (2.0k / 1.2k per turn) @25 | $0.75 | $0.45 |
| **driver total** | **$1.04** | **$0.74** |
| obs × 45 (mean $0.023 / $0.019) | $1.04 | $0.86 |
| **cell total** | **$2.1** | **$1.6** |

3 trajectories × 2 configs ≈ **$11**, + pilot $1 + production validation $2 = **~$14**, leaving a full re-run inside $30. A 4th trajectory adds $3.7.

Per-obs breakdown at 15k mean prefix: read $0.0075 + prompt input (measured: A0 186 tok, J 382, F 386 with a 194-char lens; add ~250 for a production-length lens) + output. Expected arm spread $0.021 / $0.023 / $0.026.

**The real constraint is wall clock and subscription quota, not dollars** — pi's Anthropic auth rides Claude-Code identity headers, so these are list-price equivalents. ~70s/point serial → ~18 min per cell → ~1.8h serial. Run **2-3 driver processes in parallel** (independent workspaces), not six: three concurrent arm calls each already means 9 concurrent opus-xhigh requests.

---

### 6. Code to build

| file | status | content |
|---|---|---|
| `experiments/trajectory-cost-ab.mjs` | new | the runner. Reuses `argOf` (`lib.mjs`), `resolveModel` (`model-catalog.mjs`), `WORK_TOOL_FACTORIES` (`acting-channel-arms.mjs:365`), the three Anthropic prompt builders (`delivery-context-evaluation.mjs`), `mergeObservationPayload` (`utils.ts:810`), `parseDecision` (`utils.ts:180`), `parseFooterDecision` (`utils.ts:455`), and A0's fail-open parse (`delivery-context-golden-ab.mjs:378-390`). Resume key `${trajectory}/${config}` at driver-run granularity (a partial run cannot be resumed mid-trajectory — its points are gone). |
| `experiments/trajectory-cost-tasks.mjs` | new | 3 tasks: repo-subtree workspace seeder + 4 scripted user prompts each. |
| `experiments/summarize-trajectory-cost.mjs` | new | per-arm/trajectory/config ratio, per-point `r(L)` curve, and the two-parameter fit against `0.5L+5P+25O` / `0.5L+6.25Δ+25D`. |
| `experiments/trajectory-cost.test.mjs` | new | zero-spend invariants (below). |

**Pre-spend invariants** (must pass before any paid run, in the `.test.mjs`):
1. `mergeObservationPayload(captured, tail)` leaves `merged.messages[0..n-1]` byte-identical to `captured.messages` — `JSON.stringify` compare.
2. Point enumeration on a recorded event log matches production's rules: no observation on a run's first assistant message; exactly one run-end per run with M selected by timestamp identity (`index.ts:1595-1604`).
3. The three arm prompts differ only in the contract region for a fixed lens (hash the lens separately from the contract).

**Live assertions during the run** (fail the row, don't silently absorb):
- piggyback rows: `cacheWrite === 0` and `cacheRead ≥ 0.95 × prefixTokens` — a miss means cache parity broke, and every dollar figure after it is meaningless.
- run-end rows: `readerArm.cacheRead − writerArm.cacheRead === mTokens`.
- `capturedPayloadHash` on every observation row equals the driver row's.

---

### 7. Pre-register before data (repo convention, `XHIGH-SCREEN-SPEC.md`)

- **T1 (structure):** per-point ratio rises monotonically with prefix length, fitting `r(L) = (0.5L + 5P + 25O)/(0.5L + 6.25Δ + 25D)` within ±15% at both configs. If the measured curve is flat or falling, the cost model is wrong and no point estimate should be quoted.
- **T2 (level):** at ~25k context, per-head A0 trajectory ratio is 25-45% at xhigh; the point estimate alone never gets reported without L and D alongside.
- **T3 (contrast):** F − A0 in trajectory ratio ≤ 5pp of driver cost at both configs; larger means the footer contract's premium is material at session scale, not just per observation. J sits between.
- **T4 (config):** the high-vs-xhigh difference in ratio is dominated by driver output `D`, not by observer output `O` — i.e. raising effort raises the denominator faster than the numerator, so the ratio *falls* at xhigh even though both arms cost more.

### 8. Named limitations

Deliveries are recorded, never routed: with one driver run shared by three arms, no arm can change the driver's trajectory. This measures *cost of observing a fixed trajectory*, which is the right cost-side question, but it cannot see an arm that pays for itself by shortening the driver (or costs double by interrupting it). That belongs to the quality/outcome study, not here. Also: judge-only heads only — an acting head with a tool loop multiplies the numerator by its iteration count (`index.ts:runObservationLoop`), and the codex sessions above include such loops, which is one reason their 64% is not comparable.