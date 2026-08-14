# pi-hydra

[![ci](https://github.com/pandysp/pi-hydra/actions/workflows/ci.yml/badge.svg)](https://github.com/pandysp/pi-hydra/actions/workflows/ci.yml)

> Extra heads for your coding agent.

![A Pi session where the head picker adds a security head; while Pi builds a Flask app, that head catches debug mode and an open-redirect risk and steers the fixes into the conversation](docs/assets/demo.gif)

hydra is a [pi](https://pi.dev/) extension for live oversight. Pi remains the one coding agent doing the work; specialist **heads** watch the same trajectory through different lenses and can stay quiet, show you a note, steer Pi at its next checkpoint, interrupt an unsafe run, or use permitted tools before deciding.

```text
                         security head
                              │
user ─────► Pi driver ────────┼──────► code and tool work
              │               │
              │          quality head
              │
              └──── shared cached context
```

One body, many heads.

## Why

A normal second agent first has to learn the project, task, conversation, and recent work. That duplicates context and creates a handoff before the reviewer contributes anything.

hydra attaches another perspective to context that already exists:

```text
capture Pi's request → append a specialist handoff → review → deliver
```

The head receives Pi's real provider trajectory, not a summary. Most of that trajectory can be read from the prompt cache, so the fresh input is mainly the head's instruction and recent tail. A consequential mistake can therefore be caught while correction is still one message rather than a refactor.

## How it works

1. Pi prepares a model request containing its conversation, tools, and results.
2. hydra captures that provider payload rather than rebuilding the context.
3. At a review point, hydra appends a short handoff for each active head.
4. Every head reviews independently through its own Markdown instruction.
5. hydra validates the result and routes it to you or Pi.
6. The footer and `/hydra-stats` record observations, cache use, and cost.

Anthropic and OpenAI Codex need different handoffs and have different cache behavior. The system flow is in [Architecture](docs/architecture.md); provider mechanics, measurements, and economics have one canonical home in [Providers and measurements](docs/providers.md).

## Quick start

You need [pi](https://pi.dev/) with an Anthropic model or an OpenAI Codex model supported by the measured provider gate.

```bash
pi install git:github.com/pandysp/pi-hydra
mkdir -p ~/.pi/agent/hydra
cp ~/.pi/agent/git/github.com/pandysp/pi-hydra/heads/*.md ~/.pi/agent/hydra/
pi
```

The example `quality` head is marked `autostart`, so observations begin in a fresh session. For team-wide installation, `pi install -l` records the package in the repository's `.pi/settings.json`. Development setup is in [CONTRIBUTING.md](CONTRIBUTING.md).

Choose heads at any time:

```text
/hydra-heads                     open the picker
/hydra-heads quality,security    set the active heads
/hydra-heads none                observe with no heads
```

For headless runs, use `--hydra-heads quality,security`.

## Heads are Markdown files

```markdown
---
name: docs-keeper
description: Keeps docs/notes.md current with decisions
tools: read, write, edit
after-change: noop
---
PURPOSE: Maintain docs/notes.md as durable project memory.
ACT WHEN: The trajectory establishes an unrecorded decision or constraint.
WORK: Add one concise entry and edit nothing else.
DELIVER: Complete with none; the file is the work product.
```

Heads live in two places:

- `~/.pi/agent/hydra/*.md` — your heads, available everywhere.
- `.pi/hydra/*.md` — project heads, which override same-named user heads.

Tool permissions are intentionally explicit in their meaning:

- omit `tools:` to grant every standard tool hydra can execute;
- list names to narrow access, such as `tools: read, grep`;
- use `tools: []` for a judge-only head with no executable tools.

hydra can execute Pi's standard read, bash, edit, write, grep, find, and ls tools plus its own `hydra` tool. It cannot execute arbitrary MCP or other-extension tools. See [Writing heads](docs/heads.md) for the complete format and examples.

## Decisions

A judge-only head can return several independent findings in one review. hydra groups them by recipient so user-only notes never leak into the agent's context.

| decision | effect |
|---|---|
| `print` | Show a note in the TUI; Pi never sees it. |
| `steer` | Deliver a real user message at Pi's next checkpoint. This is the normal agent-directed route. |
| `interrupt` | Abort the current run and deliver the finding. This is the emergency cord. |
| no finding | Deliver nothing; `/hydra-stats` records a noop. |

Acting heads can inspect or change the workspace through their allowed tools before making that decision. The old queue route remains internal for compatibility but is not offered to current heads.

## Heads and subagents solve different problems

| | hydra head | subagent |
|---|---|---|
| Purpose | Watch the live trajectory | Perform delegated work |
| Context | Reuses the driver's provider context | Builds separate context |
| Timing | Reviews at the driver's checkpoints | Runs on its own clock |
| Model | Must use the driver's model | May use another model |
| Direction | Can steer or stop the driver | Returns a result to its parent |
| Independence | Inherits the driver's framing | Can provide fresher eyes |

Use a head when you want another perspective **during** the work. Use a subagent for isolated implementation, model diversity, or an independent context. They complement each other.

## Commands

| command | what it does |
|---|---|
| `/hydra-heads [set\|none]` | Pick or set active heads. |
| `/hydra-stats` | Show cache hit ratio, cost, and recent decisions. |
| `/hydra-debug` | Dump driver/observation payload pairs for parity checks. |

The active set is session state and survives resume and branch navigation. The agent can also add or remove a head through hydra's `manage_heads` tool; real changes print an automatic receipt.

## What it costs

Cache-backed does not mean free. Each observation pays for a fresh handoff, output, and anything the provider does not read from cache. Total session overhead grows with providers, models, turns, active heads, and output volume; an always-on head can add material cost.

The current measured ranges, dated evidence, model coverage, and provider-specific caveats live only in [Providers and measurements](docs/providers.md#economics-and-measurements). `/hydra-stats` reports the same accounting for your session.

## Limitations

- **Shared framing:** heads see the driver's context, so they inherit many of its assumptions and blind spots. hydra is continuous review, not independent assurance.
- **One model:** a head must use the driver's model because the cache is model-specific.
- **Measured providers only:** unverified provider/API pairs are skipped rather than risk unsafe or full-price replay.
- **Between-call review:** a single long generation is not judged token by token. Findings act at checkpoints.
- **Variable overhead:** multiple always-on heads can cost more in aggregate than the driver.
- **Tool defaults:** a head with omitted `tools:` receives all hydra-supported standard tools; use `tools: []` when review alone is intended.

## Where this is going

The main open direction is mid-generation observation. Today hydra judges committed request snapshots, so it can steer between turns but cannot evaluate an unfinished response while it streams. Doing that would require reasoning over partial output without prompt-cache parity.

## History

hydra began as **andon**, a bash and tmux observer around Claude Code. The pi extension replaced its hand-maintained prompt normalization with first-class provider hooks and Pi's own agent loop. The archived implementation and original manufacturing metaphor live in [`archive/`](archive/README.md).

## License

[MIT](LICENSE)
