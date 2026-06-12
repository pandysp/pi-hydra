# pi-hydra

[![ci](https://github.com/pandysp/pi-hydra/actions/workflows/ci.yml/badge.svg)](https://github.com/pandysp/pi-hydra/actions/workflows/ci.yml)

> Extra heads for your coding agent.

hydra is a [pi](https://pi.dev/) extension that reviews your agent's work while the agent works. Each head is an observer with its own focus (quality, security, simplifier, API design, or anything you write) that sees exactly what the agent sees, judges every step, and answers with one of five decisions: stay quiet, print a note for you, queue feedback, steer the agent between turns, or interrupt and stop the run. Heads can act, too: by default a head may read, search, run, and write through the agent's own tools before it decides (a docs head keeps notes current while the agent codes). One body, many heads: the agent carries the context, and each additional head reads that context straight from the prompt cache for about 1% of what the agent paid to build it.

## Why

Review usually happens after the work. The PR is finished, a reviewer (human or agent) loads the whole trajectory into fresh context at full price, and the findings arrive when the design is already set, so fixing them means rework. The same goes for evaluating agent behavior: replaying a finished trajectory into an eval agent costs full input price and happens too late to change anything.

hydra inverts this. Observation happens during the run, at the exact moments the agent's own prompt cache commits, so a second perspective costs the observer prompt (~220 tokens) plus a cache read at 10% of input price. Concretely: an observation on a 17K-token session costs about half a cent and hits 99% cache; the decision usually lands while the agent's response is still streaming, early enough to steer the next step instead of rewriting a finished PR.

A bad assumption caught mid-implementation costs one correction message. Caught in review, it costs a refactor. Caught in production, an incident. The heads do not need to catch much to pay for themselves.

## Quick start

You need [pi](https://pi.dev/) with an Anthropic model (hydra's cache-parity replay is validated on the Anthropic Messages API).

```bash
pi install git:github.com/pandysp/pi-hydra
git clone https://github.com/pandysp/pi-hydra
mkdir -p ~/.pi/agent/hydra && cp pi-hydra/heads/*.md ~/.pi/agent/hydra/
pi
```

(Or skip the clone and ask your agent to write a head: the `hydra` tool teaches it the format. For development setup, see [CONTRIBUTING.md](CONTRIBUTING.md). To install for your whole team, `pi install -l` records the package in the repo's `.pi/settings.json`, and pi installs it for everyone on startup.)

The example `quality` head is marked `autostart`, so after the first agent run you will see observations arrive in the footer:

```
hydra:quality hit 98.5% (last 99.1%) $0.0234 (12 obs)
```

Add heads to taste:

```
/hydra-heads                     # multi-select picker over every head you have
/hydra-heads quality,security    # or set the active heads directly
```

### Heads are files

A head is one markdown file: frontmatter for identity and capabilities, body for the instruction.

```markdown
---
name: docs-keeper
description: Keeps docs/notes.md current with decisions as they happen
tools: read, write, edit, ls
---
You maintain docs/notes.md. When the conversation contains a decision,
constraint, or surprise not yet in the file, read it, add the missing
entry, and keep entries one line each. Your decision is usually noop:
the file is your work product. Do not edit anything else.
```

Your heads live in `~/.pi/agent/hydra/`; a repo can ship its own in `.pi/hydra/` (a project head overrides a same-named user head, so a team can specialize your generic heads with ones that know the codebase). Files are re-read at the start of every run, so editing a head tunes the very next observation. `tools:` defaults to everything the agent has; `tools: []` makes a judge-only head; a list narrows to a subset. `autostart: true` puts a head in the active set of every fresh session. The full format and a library of example perspectives are in [`docs/heads.md`](docs/heads.md).

### Commands

| command | what it does |
|---|---|
| `/hydra-heads [set\|none]` | no argument opens the picker; an argument sets the active heads declaratively |
| `/hydra-stats` | cache hit ratio, cost, recent decisions |
| `/hydra-debug` | dump driver/observer payload pairs for diffing |

The active head set persists per session and survives resume. For headless runs (`pi -p`), seed it with `--hydra-heads quality,security`. An explicit flag beats the saved session set; the saved set beats `autostart`.

### Decisions

Every observation ends in a decision that names the finding's delivery: when and how it reaches the agent, if at all.

- `noop`: nothing to report, nothing delivered.
- `print`: a note to you. Renders in the TUI, never enters the agent's context.
- `queue`: waits until the run ends, then joins the context of the agent's next turn.
- `steer`: injected as a real user message between turns of the current run, so the agent corrects course while still working.
- `interrupt`: the cord. The in-flight run is aborted and the finding opens the next one.

Queue against steer is a timeliness choice; interrupt is for findings that cannot wait for the run to end. There is no setting that caps any of this: when a head may pull the cord is part of its instruction, and the file is the audit trail.

### The agent manages its own heads

hydra registers a `hydra` tool the agent can call: `add` a head to the active set, `remove` one. Head files themselves the agent manages like any other file, with its ordinary tools: writing a head makes it available immediately (files are re-discovered on every tool call), and every change lands as a visible write in the session, auditable and diffable. A workflow can swap heads per phase the way an assembly line swaps tooling: design wants devil's-advocate thinking, execution wants quality and security, review wants simplifier.

The tool deliberately stops there. Everything the agent does to its heads is visible and reversible: set changes are announced, head files are plain markdown you can read and `git diff`. Turning hydra off entirely is pi's extension enable/disable, which stays yours.

## How it works

hydra captures the agent's provider requests byte-for-byte and replays them, with one observer prompt appended, at the moments the agent's own prompt cache commits. Each observation is therefore a near-pure cache read, fresh through the latest tool results, and the cache stays warm for the agent. Every mechanism behind that sentence is measured rather than assumed; the measurements live in [`experiments/`](experiments/README.md) and the design in [`docs/architecture.md`](docs/architecture.md).

## Where this is going

- **Mid-generation interrupts.** Every decision today is formed from a committed request snapshot, so a single long-running LLM call streams to completion unjudged; the cord can only be pulled between turns. Interrupting a runaway generation while it streams would mean reasoning over message deltas, with no cache parity since the content is mid-flight.

If that interests you, issues and PRs are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). The codebase is small on purpose: one extension file, one pure-logic module with tests, and an experiments harness that lets you re-verify every cache claim against the live API for under a dollar.

## History

hydra began as **andon**, named for Toyota's emergency cord: any worker can stop the line when they spot a defect. The original was a bash and tmux contraption that reverse-engineered Claude Code's prompt pipeline to get cache parity, and its only job was interrupting the agent on urgent findings. The project has since outgrown interrupt-only (observers steer, queue, act, or stay quiet), and the pi extension replaced all of the reverse engineering with first-class hooks. The original lives in [`archive/`](archive/README.md), including the manufacturing-inspired manifesto that still explains the philosophy.

## License

[MIT](LICENSE)
