# Fresh OpenAI protocol studies — case freeze (2026-08-02)

Status: **cases and exact matrix registered in separate checkpoints. No
provider calls yet.**

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

Case-freeze checkpoint: `95a8f4d`.

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

That pass is frozen before producer output in
`openai-protocol-study-judge-protocol.mjs`: arm, tier, sample, and action are
hidden; transcript evidence is closed-world; support, material extras,
registered-issue matches, and actionability are separate fields; and a generic
mechanism cannot inherit a specific unstated consequence. The runner uses one
`gpt-5.6-sol` xhigh pass in batches of at most eight, preserves each raw reply,
resumes by batch id, and stops at $6 or three consecutive errors.

No wording changes after output, no known-case tuning, no answer keys in the
prompt, and no evaluator change that rescues an arm. Exact prompts, hashes,
matrix size, and stop rules must be appended here before the first call.

## Exact pre-spend matrix and prompts

Status: **REGISTERED; still no provider calls.**

The control is the exact current `buildEnumeratedJudgeObservationEnvelope`
rendering with an empty factual delivery context. OpenAI receives the unchanged
quality lens as the user item and this contract as the following developer
item, matching production's split handoff.

The terse arm makes exactly two rendering edits:

- `reason` cap 120 → 80 characters and `message` cap 240 → 120;
- append: “Keep each reason and message to one short sentence. State the
  concrete defect and consequence; omit preambles, code restatement, hedging,
  and prose transitions.”

The no-interrupt arm makes exactly two deletions:

- remove `interrupt` from the per-finding action enum;
- remove “Interrupt only for emergencies that must stop the line.”

No replacement threshold is added. The surviving rule already says that
`steer` delivers to the agent whether the finding can wait or not. The fourth
arm mechanically applies the no-interrupt deletion to the terse arm; it tests
whether the two individually simple changes interact.

| arm | SHA-256 of lens + envelope | envelope chars |
|---|---|---:|
| ENUM-SO2 | `220a85efb36be699c5645a8691551582adbf46c6cd0e67e37c56e17f2ee7c196` | 1,736 |
| ENUM-SO2-TERSE | `292e933183ba794328f811ed46832845596520ae5b0e93a5177fd61ec0500406` | 1,896 |
| ENUM-SO2-NOINT | `40072e33d55708ff15a1755ccc2c736c91d5c63d8c41268de0db533bcba7ab68` | 1,670 |
| ENUM-SO2-TERSE-NOINT | `9afbdd2f40eda4faa432bb813b4c2b26cb820ff5e9b4e0ec1d00d7849fa6a2d7` | 1,830 |

Exact matrix: 9 cases × 2 configs (`sol-high`, `sol-xhigh`) × 2 samples ×
4 arms = **144 producer calls**. Order is deterministic-shuffled within the
registered blocks. Rows are append-only and resume by exact cell key. The run
stops at the $8 producer ceiling, after three consecutive provider errors, or
on any header/hash/credential drift.

Pre-spend dry run:

```bash
node experiments/openai-protocol-study.mjs --dry-run
```

Registered execution path:

```bash
mkdir -p ~/scratch/2026-08-02-openai-protocol-studies
node experiments/openai-protocol-study.mjs \
  --output ~/scratch/2026-08-02-openai-protocol-studies/rows.jsonl
```
