# Trajectory cost benchmark — pre-registration (2026-08-01, before any data)

Decision metric (Andreas): total observer cost per head summed across an
entire trajectory, as a percent of driver cost for that trajectory —
jointly with observation quality — at opus-5 high and especially xhigh.
Baseline = main's implementation re-benchmarked inside this harness, not
the ~30% field prior (which the mechanics analysis shows is
length-scoped) and not the screens' harmonized A0.

## Architecture (decided from the Wave 8 scout designs)

- LIVE FORK, no replay, no warm calls: the driver runs once per
  (trajectory, config) via runAgentLoop; at production's observation
  points (piggyback per assistant message_start except a run's first;
  one run-end per run, per index.ts:1560-1604) the three arms fire
  inside the awaited emit callback against the just-committed cache.
  Payloads snapshotted to disk with hashes for byte-identity assertions.
- Production merge path: mergeObservationPayload (utils.ts:810) exactly
  as index.ts:1013-1027 — not the harness text splice.
- Arms: MAIN (shipped 3-field JSON contract, buildShippedMain*), J, F.
  Driver prefix carries the shipped wide hydra schema for all arms
  (single driver run; conservative against J/F by ~$0.0002/obs —
  footnoted, not modeled). Arms are stateless per point; main's runtime
  dedup and per-arm injection tax are DERIVED columns from labels.
- Configs: opus-high, opus-xhigh; driver and observer at the same effort
  (hard constraint: cache validity).
- One frozen generic MECE judge-only head; lens names no defect.

## Corpus

3 fresh tasks, seeded mkdtemp workspaces (repo-subtree seeding for token
mass), 4 scripted user prompts each, >=15 driver requests and >=25k
final context per trajectory. 3-4 planted defects per task with
canonical target strings; archetypes DISJOINT from golden/dev/screen
corpora (candidates: scheduler TOCTOU, unbounded pagination + N+1,
non-idempotent retry with swallowed error). One quiet stretch (>=3
consecutive points with no live defect) per trajectory. Ground truth
derived from payload bytes: firstVisible(d)/firstFixed(d) anchored on
the defective EXPRESSION (not identifiers); ~10 manual confirmations
mandatory before judging (Q0a).

## Measurement

Row schema per the benchmark design (driver-turn rows + observation rows
incl. reasoning, composedCost, payload hashes). Run-end M-write
asymmetry solved by composed accounting with the reader/writer
consistency assert; arm order randomized per point and recorded.
Live assertions (fail the row): piggyback cacheWrite === 0 AND
cacheRead >= 0.95 x prefixTokens; run-end readerArm.cacheRead -
writerArm.cacheRead === mTokens; capturedPayloadHash matches driver row.
R(arm, trajectory) = sum composedCost / sum driver costTotal. Also
reported: per-point r(L) curve, injection tax as a computed column
(delivered tokens x remaining requests x cache-read + one write),
marginal $ vs MAIN.

## Pre-registered rules

Cost (T):
- T1 (structure): per-point ratio rises with prefix length and fits
  r(L) = (0.5L + 5P + 25O)/(0.5L + 6.25D + 25Ddrv) within +-15% at both
  configs; if flat or falling, the cost model is wrong and NO point
  estimate is quoted.
- T2 (level): at ~25k context, MAIN per-head trajectory ratio lands in
  25-45% at xhigh; the point estimate is never reported without L and
  driver-output alongside.
- T3 (contrast): F - MAIN <= 5pp of driver cost at both configs; J
  between. Larger = the contract premium is material at session scale.
- T4 (config): the high-vs-xhigh ratio difference is driver-output
  dominated (ratio FALLS at xhigh despite costlier observations).

Quality (Q), from the same rows (Q0d):
- Q0a corpus validity (liveness windows non-empty, quiet spans exist,
  10/10 ground-truth confirmations pass). Q0b judgedComplete + sol/opus
  unanimity; splits excluded AND reported. Q0c cache-validity floor via
  the live assertions (rows failing them are invalid, not noisy).
- Q1 (PRIMARY, precision): an arm's premium is refuted at a config iff
  more false interrupts than MAIN or unsupportedExtra >= +10pp vs MAIN;
  confirmed as precision win iff false interrupts <= MAIN - 1 per
  trajectory without breaching Q2.
- Q2 (recall floor, descriptive): refuted iff misses >= 2 more live
  planted defects than MAIN pooled; non-firing is UNINFORMATIVE at K~10.
- Q3 latency: reported, never gated. Q4 (secondary): preference win
  rate >= MAIN + 15pp with >= 40 contested points. Q5 (worth-it): the
  premium is JUSTIFIED at a config iff Q1-win or Q4-win without a Q2
  breach; else ranking falls to the cost ratio (explicit null outcome).
- Q6: per config; never "replicated" at n=3 trajectories.

Judge streams: S1 coverage (multi-label vs planted list), S2 support
(verbatim policy), S3 repeat (deterministic candidates then verbatim
question), S4 preference (co-presented forced choice — the ONLY
co-presented stream), S5 no-hit follow-up (list-free). Arms never
co-presented in S1/S2/S5; transcripts never windowed for support.
No composite quality score; false interrupts stay their own column;
marginal-$-per-additional-issue printed with raw counts, never divided
through zero.

## Named biases and limits (registered)

Fixed-driver shadow economics: driver reaction to deliveries is
unmeasured; injection tax is computed, reaction cost is not. Talkative
arms are flattered by this design (one-directional bias, stated in the
results). Planted defects authored by the analyst; disjointness from
screening corpora is the only (weak) guard. Judge-only head; acting
heads multiply the numerator. Additivity across heads is an assumption.
n=3 trajectories: levels get ranges, contrasts get paired bootstrap.

## Execution gates

Pilot = 1 trajectory x opus-high x 3 arms; all live assertions + Q0a
must pass before the remaining cells are funded. Budget ~$14 + pilot;
abort and redesign if the pilot's driver run misses >=15 requests or
25k context. Zero-spend invariant tests (merge byte-identity, point
enumeration vs production rules, lens/contract hash separation) must
pass before the pilot.
