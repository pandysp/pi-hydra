# No-steer probe — pre-registration (2026-08-01, before data)

## The idea (Andreas)

Remove `steer` from the model's vocabulary. Everything urgent is routed
as `queue`; the RUNTIME promotes those to steer, so driver-facing
behaviour is unchanged. If the decision to steer is what triggers
deliberation, cost collapses. If it is not, the avenue closes cheaply.

## Why this is the right next test

The skip study established a near-perfect coupling (steer 0/15 skipped,
mean 1001 thinking; queue 13/13 skipped, mean 0) and stated explicitly
that **causal direction is not established**. This probe MANIPULATES the
label rather than observing it, which is the only way to separate:
  (a) choosing steer triggers deliberation  -> removing the label helps
  (b) a serious situation triggers both     -> removing the label does
      nothing, and the premium is intrinsic to what the observer sees

## Arms (instruction text only; no runtime change in the probe)

- MAIN, F2: unchanged baselines (already measured on these prefixes).
- MAIN-NS: MAIN with `steer` removed from the action vocabulary and its
  description; remaining actions noop/print/queue/interrupt.
- F2-NS: F2's checklist with the steer rule folded into queue; the
  steer/queue distinction disappears, everything else byte-identical.

`interrupt` stays in both: emergencies are rare, distinct, and removing
them would confound an emergency-abort change into a cost test.

## Pre-registered questions

- **N1 (the causal test).** On the mid prefix where MAIN splits its own
  samples (5/10 skip, steer 5 / queue-none 5), 10 samples per variant:
  does MAIN-NS skip MORE than MAIN, and F2-NS more than F2 (0/10)?
  - CONFIRMED if MAIN-NS skips >= 8/10 or F2-NS >= 5/10.
  - REFUTED if MAIN-NS <= 6/10 AND F2-NS <= 2/10 — then the situation,
    not the label, drives deliberation, and this avenue is CLOSED. Say
    so plainly and stop; do not iterate on wording to rescue it.
  - Between: report as inconclusive at n=10 and state what n would
    settle it.
- **N2 (does the finding survive?).** Compare the delivered message
  content of MAIN-NS vs MAIN and F2-NS vs F2 on the same prefix: are the
  same issues raised? A cost win that comes from NOT NOTICING is a loss.
  Read the raw messages; do not infer from delivery labels.
- **N3 (does urgency survive?).** If the runtime promotes queue->steer,
  the message must still read as act-now. Judge (sol+opus) each NS
  message: "does this read as something the agent must address before
  continuing, or as deferrable follow-up?" A flattened message routed
  urgently is a worse product than an honest queue.
- **N4 (scoring adjustment, registered now).** With no steer label,
  expected-steer cases cannot be scored as before. On the frozen cases an
  NS arm's `queue` on an expected-steer row counts CORRECT (the runtime
  promotes it), and this relabelling is applied to NS arms only and
  stated wherever those numbers appear.

## Cost and stopping

Recorded-payload replay only (`adaptive-skip-probe.mjs` takes arbitrary
prompt strings). 10 samples x 2 new variants x 1 prefix = 20 calls,
~$0.40. If N1 refutes, STOP — no frozen-case run, no judging.

## Amendment (Andreas, 2026-08-01, before N3 data)

N3 is DEMOTED from a gate to a descriptive note. Andreas: a flattened
message routed urgently is not a big deal — the message is delivered
anyway, just earlier than planned. He is right on that axis: the urgency
information lives in the message TEXT, not in the channel label, and the
driver is an agent that can triage content on arrival. My original
framing implied the signal lives in the label; it mostly does not.

What survives is a DIFFERENT concern on a different axis, recorded as an
open question rather than a gate:

**DRIVER-SIDE INTERRUPTION COST (unmeasured).** On the C2 trajectory arms
delivered on ~9-10 of 18 observations but steered on only ~2. Promoting
every queue to steer means the driver is interrupted mid-work ~9 times
instead of ~2, and each interruption costs DRIVER tokens (re-reading,
re-planning, possibly abandoning good work). Driver turns cost multiples
of an observation, so this lands on the expensive side of the ledger.

Our harness cannot see it: the trajectory design is open-loop by
construction (deliveries recorded, never injected). So "promoting
everything to steer is cheap on the OBSERVER side" is measurable today;
"and costs nothing on the DRIVER side" is not. Any recommendation coming
out of this probe must carry that limit explicitly, and a closed-loop
run is the only way to settle it.
