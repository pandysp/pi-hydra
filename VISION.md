# Vision

Hydra adds heads to a Pi session: extra model calls that review the work while it happens and send feedback to the main assistant. Each head reads the same request the main assistant sends to the model, so it needs no briefing. The [README](README.md) describes how it works, and [CONTRIBUTING.md](CONTRIBUTING.md) how to contribute. This file helps decide whether a change belongs in Hydra.

## Principles

- Heads read the real request. Hydra passes it on as it is and does not rebuild or summarize it. A change to what heads and the main assistant share, such as the `hydra` tool definition, stops the provider's prompt cache from reusing earlier requests. Such a change has to be worth that extra cost.
- Add as little as possible. Before you add a field, flag, setting or file, check whether something that exists already does the job.
- Report every failure. Hydra rejects bad input and says why. It tells the user about anything it drops or skips.
- Heads only advise. A head sends feedback or nothing, and it never stops the main assistant from working. Its messages should never read as if the user wrote them. Today they sometimes can ([#31](https://github.com/pandysp/pi-hydra/issues/31)).

## Out of scope

- Delegated work that needs its own context. That is what subagents are for ([heads and subagents](README.md#heads-and-subagents-solve-different-problems)).
- Providers whose cache behavior nobody has measured ([providers](docs/providers.md)).
