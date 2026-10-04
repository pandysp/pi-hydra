# Vision

pi-hydra gives a Pi session extra perspectives while the work happens, from the context the session already has. What it does and how is in the [README](README.md); how to contribute is in [CONTRIBUTING.md](CONTRIBUTING.md). This file is the test for whether a change fits.

## Principles

- **Reuse the context, never rebuild it.** A head sees the main assistant's real provider request. Anything that changes the part heads share with the main assistant, such as the `hydra` tool definition, costs cache reuse.
- **Measure before claiming.** Provider and cache behavior is a measurement, not an assumption. Unmeasured provider paths are skipped, not guessed ([providers](docs/providers.md)).
- **The smallest mechanism that works.** Before adding a field, flag, mode or file, name the existing path that already gives the same outcome. A second path is justified only when the first cannot express the need.
- **Fail loudly.** Invalid input is an error with its reason. Anything Hydra drops, skips or cannot restore is reported. Broken state is not silently repaired.
- **Heads advise; the main assistant and the user decide.** Heads send feedback or nothing. They do not block the main assistant's work, and their messages are marked as theirs, never passed off as the user's words.
- **Every head costs money on every response.** Help for one task ends with that task: a one-off check or a head with an end condition, not a file that keeps running.

## What this project refuses

- It does not become a subagent framework. Delegated work with its own context belongs to subagents ([heads and subagents](README.md#heads-and-subagents-solve-different-problems)).
- It does not add provider paths without a cache measurement.
