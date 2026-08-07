# ENUM generalisation — pre-registration (2026-08-01, before data)

ENUM is established at opus-high and opus-xhigh, on ONE task
(scheduler), on ONE trajectory each. Two gaps, both real, both now
funded (Andreas: budget is not a constraint).

## Gap 1 — OpenAI is structurally unmeasured

Recorded payloads ARE Anthropic API requests; `mergeObservationPayload`
is Anthropic-typed. An Anthropic driver payload cannot be replayed
against GPT. Measuring ENUM on OpenAI needs a REAL codex driver run.

**Production already knows how to do this.** PR #8 shipped exactly this:
observations riding the driver's prompt cache on GPT-5.6, with
OpenAI packaging (raw lens in user + developer envelope,
entitlement-forced). The harness must MIRROR `index.ts`'s OpenAI path,
not invent one. Cache mechanics differ — OpenAI does prefix caching with
no explicit markers — so the Anthropic cache-parity assertions do not
port; equivalent OpenAI assertions must be written, not skipped.

Configs: sol-high, sol-xhigh (Andreas's guiding OpenAI configs).

## Gap 2 — one task

Every trajectory result in this program is the scheduler. The corpus has
three seeded tasks; exporter and dispatcher have never been driven.
Cross-task variance is unmeasured, and the scheduler is the task whose
docs the driver wrote — the one with a known leak.

## Runs

A. OpenAI: scheduler trajectory driven by sol-high and by sol-xhigh,
   arms MAIN / F2 / ENUM observing paired at production points.
B. Cross-task (Anthropic, already supported): exporter and dispatcher
   trajectories at opus-high, same three arms.

## Pre-registered questions

- **N1 (provider).** Does ENUM's zero-thinking hold on OpenAI? Report
  skip rate, findings/message, format validity per arm. A provider split
  is live: framing helped Claude and hurt GPT on the user-actor corpus.
- **N2 (cost shape).** Observer/driver ratio per arm per provider, beside
  the Anthropic baselines (MAIN 23.0%, F2 42.6%, ENUM 32.5% at
  opus-high).
- **N3 (task).** Does ENUM's coverage advantage hold on exporter and
  dispatcher? Score on the resolved binary axes. The scheduler pool had
  ONE blocking issue; these tasks must be scored on their own pools.
- **N4 (the honest one).** Report every cell where an arm's contract is
  NOT followed (findings/message ~1.00 for ENUM, or parse failures).
  A broken arm is not a cheap arm.

## Rules

Mirror production packaging per provider; write OpenAI cache assertions
rather than dropping the Anthropic ones; read messages, never
keyword-match; freeze artifacts with manifests and ledger entries.
Budget: generous — correctness and coverage over frugality. Report
actual spend per run.
