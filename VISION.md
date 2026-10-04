# Vision

Hydra adds heads to a Pi session: extra model calls that review the work while it happens and send feedback to the main assistant. Each head reads the same request the main assistant sends to the model, so it needs no briefing. The [README](README.md) describes how it works, and [CONTRIBUTING.md](CONTRIBUTING.md) how to contribute. This file helps decide whether a change belongs in Hydra.

## Principles

- Prompt caching is sacred. Hydra does not accept a change that makes the start of a head's request differ from the main assistant's.
- Complexity has to pay for itself. Every field, flag, setting, branch or file is something more to understand and maintain. First check whether something that exists already does the job.
- Report every failure. Hydra rejects bad input and says why.

## Out of scope

- Delegated work that needs its own context. That is what subagents are for ([heads and subagents](README.md#heads-and-subagents-solve-different-problems)).
- Providers whose cache behavior nobody has measured ([providers](docs/providers.md)).
