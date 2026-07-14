# pi-hydra

[![ci](https://github.com/pandysp/pi-hydra/actions/workflows/ci.yml/badge.svg)](https://github.com/pandysp/pi-hydra/actions/workflows/ci.yml)

> Extra heads for your coding agent.

![A pi session: the head picker adds a security head, then as the agent builds a Flask app the security head catches debug=True (a Werkzeug RCE) and an open-redirect risk and steers the fix into the conversation](docs/assets/demo.gif)

hydra is a [pi](https://pi.dev/) extension that adds live oversight to your coding agent: heads that review the agent's work while the agent is still working. Each head watches with its own focus (quality, security, simplifier, API design, or anything you write). It sees exactly what the agent sees, judges every step, and answers with one of five decisions: stay quiet, print a note for you, queue feedback, steer the agent between turns, or interrupt and stop the run. Heads can act, too: by default a head may read, search, run, and write through the agent's own tools before it decides (a docs head keeps notes current while the agent codes). One body, many heads: the agent carries the context, and each additional head reads that context straight from the prompt cache. An observation costs about 1% of what the agent paid to build the context it reads; a session with an always-on head costs roughly 30% more ([What it costs](#what-it-costs)).

## Why

Review usually happens after the work. The PR is finished, a reviewer (human or agent) loads the whole trajectory into fresh context at full price, and the findings arrive when the design is already set, so fixing them means rework. The same goes for evaluating agent behavior: replaying a finished trajectory into an eval agent costs full input price and happens too late to change anything.

hydra inverts this. Observation happens during the run, at the exact moments the agent's own prompt cache commits, so a second perspective costs the observation prompt plus a cache read instead of a full context rebuild (numbers in [What it costs](#what-it-costs)). The decision usually lands while the agent's response is still streaming, early enough to steer the next step instead of rewriting a finished PR.

A bad assumption caught mid-implementation costs one correction message, and the same assumption caught in review costs a refactor.

## What it costs

An observation costs its prompt (~220 tokens) plus a cache read at 10% of input price. On a 17K-token session that is about half a cent, or roughly 1% of what the driver paid to build the same context. Measured cache hit rates are 97%+ across real Anthropic sessions (the 17K reference measurement hits 99%); codex measures ~84–87% ([why](docs/architecture.md)).

A session costs more than the per-observation number suggests. An always-on head observes at every cache commit, and a session has many of those. Measured across real sessions, one head adds roughly 30% to total session cost: a driver session that would cost $1.00 costs about $1.30.

Every number above is measured: the harness in [`experiments/`](experiments/README.md) re-verifies the cache behavior against the live API, and `/hydra-stats` shows the same numbers live for your own sessions.

## Compared to subagents

pi's core ships four tools and no subagents; heads and subagents both arrive as extensions, and they sit at opposite ends of two coupled choices: where the reviewer's context comes from, and how its run relates to the driver's. On context, a head rides the driver's exact prompt cache, so it is locked to the driver's model and costs a cache read; a subagent ([pi-subagents](https://github.com/tintinweb/pi-subagents)) rebuilds context from scratch, so it picks any model and pays full input price. On the run, a head *watches in place*, replaying at the driver's commit points and able to act on what it sees live; a subagent is *spawned and returns*: it runs on its own clock and hands back a result the parent reads when it is done.

| | subagents | hydra heads |
|---|---|---|
| Context | fresh, isolated by default; zero anchoring to the driver's assumptions | the driver's payload byte-for-byte; fully anchored to the driver's assumptions |
| Model | free: a stronger model for a real second opinion, or a cheap one for grunt work | locked to the driver's, always (the cache is model-specific) |
| Cost | a full-price context rebuild per task | ~1% of build cost per observation; ~30% per session always-on |
| Timing | on its own clock: Explore, Plan, a parallel worktree refactor, or a finished-artifact audit | live, at the driver's commit points, in time to steer the next step |
| Direction | spawned downward; can be `steer`ed downward (parent → child) and returns a final message | watches the same run; can `steer` or pull the cord upward (head → agent) |
| What crosses | passive data, inert until the parent reads and acts on it | an act: a `steer` or `interrupt` that fires whether the agent agrees or not |

Reach for a subagent when fresh eyes, a stronger model, or heavy isolated work is the point; reach for a head to catch a bad turn during the run. The two stack around the driver: heads steer it from above, and it spawns subagents for the isolated work below.

## Quick start

You need [pi](https://pi.dev/) with an Anthropic model or an OpenAI Codex (ChatGPT subscription) GPT-5.6 model — hydra's cache-parity replay is validated on those two; the cache economics differ per provider ([details](docs/architecture.md)).

```bash
pi install git:github.com/pandysp/pi-hydra
mkdir -p ~/.pi/agent/hydra && cp ~/.pi/agent/git/github.com/pandysp/pi-hydra/heads/*.md ~/.pi/agent/hydra/
pi
```

(The copy reads from the clone `pi install` just made, so the examples match the installed version. Or skip the copy and ask your agent to write a head: the `hydra` tool teaches it the format. For development setup, see [CONTRIBUTING.md](CONTRIBUTING.md). To install for your whole team, `pi install -l` records the package in the repo's `.pi/settings.json`, and pi installs it for everyone on startup.)

The example `quality` head is marked `autostart`, so after the first agent run you will see observations arrive in the footer:

```
hydra:quality hit 98.5% (last 99.1%) $0.0234 (12 obs)
```

Add or remove heads at any time:

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
| `/hydra-debug` | dump driver/observation payload pairs for diffing |

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

hydra registers a `hydra` tool the agent can call: `add` a head to the active set, `remove` one. Head files themselves the agent manages like any other file, with its ordinary tools: writing a head makes it available immediately (files are re-discovered on every tool call), and every change lands as a visible write in the session, auditable and diffable. A workflow can swap heads per phase: design wants devil's-advocate thinking, execution wants quality and security, review wants simplifier.

The tool deliberately stops there. Everything the agent does to its heads is visible and reversible: set changes are announced, head files are plain markdown you can read and `git diff`. Turning hydra off entirely is pi's extension enable/disable, which the agent cannot touch.

## How it works

hydra captures the agent's provider requests byte-for-byte and replays them, with one observation prompt appended, at the moments the agent's own prompt cache commits. Each observation is therefore a near-pure cache read, fresh through the latest tool results, and on Anthropic (and codex in shared mode) the cache stays warm for the agent too. Every mechanism behind that sentence is measured; the measurements live in [`experiments/`](experiments/README.md) and the design in [`docs/architecture.md`](docs/architecture.md).

## Limitations

- Two providers for now: Anthropic (Messages API) and OpenAI Codex (ChatGPT backend, GPT-5.6). Anthropic delivers the 97%+ hit ratio; codex measures ~84–87%, and sharing the driver's cache from the first observation needs pi's `"transport": "websocket"` setting — under the default `"auto"`, hydra falls back to its own cache scope to keep the driver's delta continuation safe ([measured](docs/architecture.md)). Nothing else is verified — hydra targets subscription auth on both providers; the OpenAI API-key path shares the code but stays disabled unless someone measures it.
- A head always runs the driver's model. The cache is model-specific, so a head cannot use a stronger or cheaper model than the driver's; that is what subagents are for.
- A long generation streams to completion unjudged. Decisions form on committed request snapshots, so the cord is pulled between turns, never mid-stream ([Where this is going](#where-this-is-going)).
- An always-on head adds roughly 30% to session cost ([What it costs](#what-it-costs)). On subscription codex that spend comes out of the same account quota as the agent's own work.

## Where this is going

- **Mid-generation interrupts.** Every decision today is formed from a committed request snapshot, so a single long-running LLM call streams to completion unjudged; the cord can only be pulled between turns. Interrupting a runaway generation while it streams would mean reasoning over message deltas, with no cache parity since the content is mid-flight.

If that interests you, issues and PRs are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). The codebase is small on purpose: one extension file, one pure-logic module with tests, and an experiments harness that re-verifies every cache claim against the live API. A full run costs under a dollar.

## History

hydra began as **andon**, named for Toyota's emergency cord: any worker can stop the line when they spot a defect. The original was a bash and tmux contraption that reverse-engineered Claude Code's prompt pipeline to get cache parity, and its only job was interrupting the agent on urgent findings. The project has since outgrown interrupt-only (heads steer, queue, act, or stay quiet), and the pi extension replaced all of the reverse engineering with first-class hooks. The original lives in [`archive/`](archive/README.md), including the manufacturing-inspired manifesto that still explains the philosophy.

## License

[MIT](LICENSE)
