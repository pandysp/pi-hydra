# Fresh OpenAI protocol studies — case freeze (2026-08-02)

Status: **case corpus frozen before candidate wording. No provider calls yet.**

## Why

Two product simplifications are plausible but unproven on OpenAI:

1. make ENUM findings materially shorter without making them vague or reducing
   how many distinct defects the head reports;
2. remove the rarely used `interrupt` choice and accept `steer` as the only
   agent-directed route.

The second proposal removes a real capability, not just a label. `steer` waits
for the driver's next checkpoint; `interrupt` can abort work already in flight.
The study can show whether the model still discovers and reports emergencies
without the word. It cannot make the lost abort capability equivalent or free.

## Sealed material

`openai-protocol-study-cases.mjs` contains nine new synthetic trajectory
snapshots in domains absent from every earlier pi-hydra corpus:

- five multi-finding implementation reviews with 16 planted defects;
- one clean quiet case;
- two genuine in-flight emergencies; and
- one dangerous action that is proposed but not started.

The producer receives only the visible messages and the unchanged generic
quality lens. Expected issue ids, target descriptions, severity, and routing
live outside the prompt. The corpus hash and exact count are emitted by:

```bash
node experiments/openai-protocol-study-cases.mjs
```

Frozen value: `44e8d60e94f8a063498478b219e87be8c68c892eb23343a634a92511e2c28c79`
(9 cases).

This file and the case module must be committed before either experimental
instruction is authored. Once committed, cases and labels are immutable for
this study. A discovered case flaw is reported; it is not repaired after seeing
model output.

## Registered shape before wording

- Provider/model: OpenAI Codex, `gpt-5.6-sol`.
- Configurations: `high` and `xhigh`.
- Samples: 2 per case, configuration, and arm.
- Control: the exact shipped split-handoff ENUM-SO2 contract.
- Causal arms to register in a second checkpoint: terse only, no-interrupt
  only, and their mechanically composed interaction arm.
- Order: shuffled inside each case/configuration/sample block.
- Public tool surface: production's management-only Hydra schema plus the
  representative driver tools already used by the delivery-context screens.
- Hard spend ceiling: $8 for producers. Stop on drift, expired credentials,
  malformed run header, or repeated provider errors.

## Measurements and gates

Terse output is eligible only if it materially lowers output tokens and
characters per finding while preserving both finding volume and the planted
defects found by the control. A smaller response caused by omitting findings is
a failure, not a cost win. Every raw response is read for actionability and
unsupported extras.

No-interrupt is eligible for a product decision only if every active-emergency
finding still appears, routes to `steer`, and ordinary/quiet behavior does not
regress. Even then the report must keep the semantic loss explicit: a steer
cannot stop the already-running destructive action represented by the two
active-emergency cases.

One Sol support/matching pass may populate provisional diagnostics after the
producer rows freeze. It is not a second consensus vote, cannot promote novel
findings, and cannot replace Opus. All unmatched supported findings remain
`pending-opus`.

No wording changes after output, no known-case tuning, no answer keys in the
prompt, and no evaluator change that rescues an arm. Exact prompts, hashes,
matrix size, and stop rules must be appended here before the first call.
