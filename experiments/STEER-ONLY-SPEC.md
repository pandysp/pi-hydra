# Steer-only vocabulary probe (SPEC, 2026-08-02 — pre-registered before data)

Funded by Andreas, 2026-08-02: "I really believe that we should remove
queue as label at all from the entire harness. Steer is the new steer +
queue. We should make some cheap verifications here to see if the
no-thinking anomaly of opus on high and xhigh holds if we switch the
labels." This probe is that cheap verification. Harness measurement
only; no runtime change.

## Question

On Claude, thinking tracks the delivery decision: steer rows think
~1000 tokens, queue rows think ~0, the skip is stochastic per call
(ADAPTIVE-SKIP-RESULTS), and deleting the STEER label collapsed MAIN's
thinking (28/30 skips, p=2.7e-05, NO-STEER-V2). The proposed runtime
shape deletes QUEUE instead and lets steer absorb it. Two mechanisms
compete:

- **Escalation:** former-queue content now routes as steer, every steer
  pays steer-thinking, and the cheap arm shapes (MAIN's frequent skips,
  ENUM's zero) degrade.
- **Demotion:** the model holds the (unchanged) higher bar for steer,
  routes former-queue content to print/none with no deliberation, and
  the shapes survive — at the price of driver-directed feedback becoming
  user-directed or silent.

Which one happens, per arm, per effort, is the measurement.

## Design

- **Variants** (`steer-only-variants.mjs`, committed with this spec;
  guards assert no "queue" survives, interrupt stays, parents differ):
  MAIN / MAIN-SO / F2 / F2-SO / ENUM / ENUM-SO. The SO edits, exactly:
  - MAIN-SO: grammar enum `noop|print|queue|steer|interrupt` →
    `noop|print|steer|interrupt`; routing "Queue if useful but waitable.
    Steer to correct the agent between turns." → "Steer anything the
    agent should act on, whether it can wait or not." (−10 chars)
  - F2-SO: grammar list "print, queue, steer, or interrupt" → "print,
    steer, or interrupt"; rules 3+5 merge into "3. Anything the agent
    itself must carry out: steer. This covers both work currently
    underway that would be left incorrect, unsafe, incomplete, or
    unverified, and genuinely deferrable follow-up."; rules renumber.
    (−53 chars)
  - ENUM-SO: per-finding action list `print|queue|steer|interrupt` →
    `print|steer|interrupt`; same routing collapse as MAIN-SO.
    (−10 chars)
  Steer ABSORBS queue's semantics in every variant (the runtime
  proposal), mirroring NO-STEER's absorption design; deleting the
  sentence without absorption would remove a capability instead of a
  label.
- **Originals re-run in the same cells** — the skip is stochastic and
  day-sensitive; prior MAIN/F2/ENUM numbers at this point are a
  different day's basis. Paired same-run comparison is the readable one.
- **Runner:** `adaptive-skip-probe.mjs` (unchanged; it already records
  per-row reasoning, skip, routed delivery, cost).
- **Basis:** recorded payload, pilot point `scheduler/opus-high/a1/r1/6`
  (mid prefix, L=20,165 — the point every prior skip probe used),
  piggyback tail. Recorded-payload discipline applies: absolute dollars
  are fresh-prefix basis; thinking tokens, skip rates and routing are
  the readable outputs.
- **Cells:** 6 variants × {opus-high, opus-xhigh} × n=10 samples =
  120 calls. A 1-sample smoke per config validates plumbing first and
  is frozen separately (smoke-*.jsonl), not pooled into cells.
- **Long prefix (L=37,892) is NOT in this run.** If the mid signal is
  ambiguous, a long-prefix follow-up needs its own pre-registration —
  this spec's n is the budget cap.

## Hypotheses and refutation thresholds

- **H1 (the funding question): ENUM's zero-thinking survives
  steer-only.** Holds if ENUM-SO skips ≥8/10 with mean thinking <50 at
  BOTH configs (prior basis: ENUM 10/10, mean 0, at both). Refuted at a
  config if ENUM-SO skips ≤5/10 or mean >200 there.
- **H2: MAIN under steer-only — two-sided, honestly.** Escalation
  reading if MAIN-SO mean thinking ≥1.5× same-run MAIN and its steer
  share rises; demotion reading if ≤0.67× MAIN without a steer-share
  rise. Anything between is INCONCLUSIVE at n=10 and is reported as
  such, not rounded to a story.
- **H3: where former-queue content goes.** Per arm and config, from the
  routed-delivery distribution: escalation share E = steer(SO) −
  steer(original); demotion share D = [print+none](SO) −
  [print+none](original). If E > 0.5·queue(original), steer-only
  escalates the majority of former-queue content — each such delivery
  is an interruption the driver would not have received, the
  false-interrupt implication of the collapse. If D > E, steer-only
  mainly SUPPRESSES driver-directed feedback (capability loss), which
  the results doc must name as the product cost.
- **H4: format validity unchanged.** Refuted for a cell if >1/10 rows
  fail to parse or emit `queue` as the routed label despite its removal.

## Rules

Whole distribution per cell (mean, median, min/max, skip rate, raw
values — the probe prints them; the results doc carries them). Anomaly
pass on raw rows BEFORE distillation: read the SO messages to see what
the former-queue findings became (text, not keyword match); triage
every surprise harness-bug | dataset-label-bug | real-effect.

## Spend

Expected ~$3–5 harness-priced, cap $8. Anthropic producer spend,
plan-window metered, deliberate and pre-registered per standing
constraint. If quota truncates a cell, the partial cell is frozen and
marked partial; no silent downsizing.

## Deliverables

`STEER-ONLY-RESULTS.md` (per-cell tables, H1–H4 verdicts, and the
implication for the benchmark arms: if the cheap shapes survive, the
benchmark carries a steer-only variant; if they do not, the runtime
proposal pays a measured premium and the table says how much);
artifacts under `artifacts/2026-08-02-steer-only/` with SHA256SUMS,
mirror, and a ledger entry.
