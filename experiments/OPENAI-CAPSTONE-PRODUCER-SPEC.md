# OpenAI capstone producer matrix (registered 2026-08-03)

Status: **REGISTERED BEFORE SPEND. No provider call has run.**

## Purpose and boundary

Produce the OpenAI half of the later capstone on fresh live trajectories. The
producer heads see only the driver trajectory and the generic quality lens;
they never see golden-v2 records, judge answers, planted labels, or scores.
These rows may therefore freeze while Opus and golden v2 are pending, but they
cannot yield a score, promotion, design verdict, or provider split by
themselves.

The fresh protocol study admits only the unchanged contracts. Its terse and
no-interrupt variants are not in this matrix.

## Exact matrix

- Tasks: scheduler, exporter, dispatcher.
- Task seed hashes: scheduler `85958c9b760f6eab`; exporter
  `d86f49320389d884`; dispatcher `93444fea6a703141`.
- Configs: `sol-high` and `sol-xhigh`, both `gpt-5.6-sol` over the
  `openai-codex` subscription transport.
- Arms at every production observation point: `MAIN-SO2`, `ENUM-SO2`.
- Live drivers: one per task × config = six driver cells. The two observer arms
  fork from every captured point of the same driver, so arm comparisons are
  paired and no extra driver is run for either arm.
- Concurrency: 1.
- Driver limit: 8 assistant turns per requested change, 8,000 output tokens per
  turn.
- Spend ceiling: $20 charged producer cost. A cell already in flight finishes;
  no new cell starts at or above the ceiling. With concurrency 1, overshoot is
  bounded to one registered cell.
- Runner checkpoint: `2751f64`.
- Matrix SHA-256:
  `0913b5090b046a0b67e30564ac15e86e4a2c127351e5a8118f3d2b005cdbf44d`.

The matrix header is the first append-only output row. Resume refuses any
matrix-hash or runner-commit drift; an incomplete cell reruns whole under a new
attempt and completed cells are not replayed.

## Exact OpenAI handoffs

Both arms send the identical raw quality lens as the user item (SHA-256
`9f238868aa8ece41921a3f6dba8beb1e23ecc3a96b7eeff9ca4a9aed1e8cf55d`,
183 characters). They differ only in the adjacent developer envelope.

| arm | envelope SHA-256 | envelope chars | full handoff SHA-256 |
|---|---|---:|---|
| MAIN-SO2 | `9c541b269a99e59d96acbd308a4e12c7980600da3fd61733fad9f66da0fec0b6` | 611 | `e019c8df3dbd02cf464a93a8c0ba33cf5f6fefbf9210db14234e684656eaae9a` |
| ENUM-SO2 | `d8fc67cefd9c6a5757c56564e301178d3070e5e2c8c65a741de6b2c83cd1a7e5` | 1,736 | `03de2abcfb394be262bb87d611be98ec97c1319666ec6ce9e0c67edd63e996ba` |

`MAIN-SO2` is A0's split OpenAI carrier with exactly the registered queue
removal and steer-delivery wording repair. `ENUM-SO2` is the exact current
production `buildEnumeratedJudgeObservationEnvelope` with an empty factual
delivery context. The runner uses production's strict ENUM parser and records
both recipient-preserving deliveries when a response mixes `print` with
`steer` or `interrupt`.

## Pre-spend command

```bash
node experiments/trajectory-cost-ab.mjs --dry-run \
  --matrix-id 2026-08-03-openai-capstone-producer-v1 \
  --matrix-date 2026-08-03 \
  --trajectories scheduler,exporter,dispatcher \
  --configs sol-high,sol-xhigh \
  --arms MAIN-SO2,ENUM-SO2 \
  --concurrency 1 \
  --max-turns 8 \
  --driver-max-tokens 8000 \
  --spend-ceiling 20
```

Registered execution path:

```bash
mkdir -p ~/scratch/2026-08-03-openai-capstone/payloads
node experiments/trajectory-cost-ab.mjs \
  --matrix-id 2026-08-03-openai-capstone-producer-v1 \
  --matrix-date 2026-08-03 \
  --output ~/scratch/2026-08-03-openai-capstone/rows.jsonl \
  --payload-dir ~/scratch/2026-08-03-openai-capstone/payloads \
  --trajectories scheduler,exporter,dispatcher \
  --configs sol-high,sol-xhigh \
  --arms MAIN-SO2,ENUM-SO2 \
  --concurrency 1 \
  --max-turns 8 \
  --driver-max-tokens 8000 \
  --spend-ceiling 20
```

## After production

Read every raw observer response and driver trajectory, freeze rows and
payloads with hashes, and render cost-only rows while quality remains blank.
Then run one blinded Sol pass under `CAPSTONE-JUDGE-SPEC.md`. Supported
unmatched claims remain `pending-opus`; no extra Sol call can turn them into
consensus. Opus later answers the same frozen questions after access returns.
