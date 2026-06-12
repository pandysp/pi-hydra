# pi-hydra

[![ci](https://github.com/pandysp/pi-hydra/actions/workflows/ci.yml/badge.svg)](https://github.com/pandysp/pi-hydra/actions/workflows/ci.yml)

> Extra heads for your coding agent.

hydra is a [pi](https://pi.dev/) extension that reviews your agent's work while the agent works. Each head is an observer with its own lens (quality, security, simplifier, API design) that sees exactly what the agent sees, judges every step, and answers with one of four decisions: stay quiet, queue feedback, steer the agent between turns, or interrupt and stop the run. Heads can act, too: a lens marked `tools: true` reads, searches, runs, and writes through the agent's own tools before its verdict (a docs head keeps notes current while the agent codes). One body, many heads: the agent carries the context, and each additional head reads that context straight from the prompt cache for about 1% of what the agent paid to build it.

## Why

Review usually happens after the work. The PR is finished, a reviewer (human or agent) loads the whole trajectory into fresh context at full price, and the findings arrive when the design is already set, so fixing them means rework. The same goes for evaluating agent behavior: replaying a finished trajectory into an eval agent costs full input price and happens too late to change anything.

hydra inverts this. Observation happens during the run, at the exact moments the agent's own prompt cache commits, so a second perspective costs the observer prompt (~220 tokens) plus a cache read at 10% of input price. Concretely: an observation on a 17K-token session costs about half a cent and hits 99% cache; the verdict usually lands while the agent's response is still streaming, early enough to steer the next step instead of rewriting a finished PR.

A bad assumption caught mid-implementation costs one correction message. Caught in review, it costs a refactor. Caught in production, an incident. The heads do not need to catch much to pay for themselves.

## Quick start

You need [pi](https://pi.dev/) with an Anthropic model (hydra's cache-parity replay is validated on the Anthropic Messages API).

```bash
pi install git:github.com/pandysp/pi-hydra
pi
```

(For development, clone and symlink instead: see [CONTRIBUTING.md](CONTRIBUTING.md).)

The footer shows `hydra: quality | steer | (no obs yet)`. Work normally; after the first agent run you will see observations arrive:

```
hydra:quality steer hit 98.5% (last 99.1%) $0.0234 (12 obs)
```

hydra starts in `steer` mode: waitable findings queue for the agent's next turn, urgent ones are injected between turns of the current run. Adjust to taste:

```
/hydra-delivery print            # watch-only until you trust the heads
/hydra-delivery interrupt        # emergencies abort the in-flight run
/hydra-lens quality,security     # several heads at once; they fan out in parallel
```

### Commands

| command | what it does |
|---|---|
| `/hydra` | toggle the observer |
| `/hydra-lens <set>` | pick the lens set, comma-separated: `quality`, `security`, `simplifier`, `api-design`, plus your custom lenses |
| `/hydra-delivery <mode>` | cap how forcefully findings land: `print`, `queue`, `steer` (default), `interrupt` |
| `/hydra-stats` | cache hit ratio, cost, recent decisions |
| `/hydra-debug` | dump driver/observer payload pairs for diffing |

### Delivery modes

A head's verdict asks for a force level (`noop`, `queue`, `steer`, `interrupt`); the delivery mode caps it. A head can always choose less force than the mode allows, never more. The mode names are pi's own delivery vocabulary:

- `print`: findings render in the TUI but never enter the agent's context. Watch-only.
- `queue`: findings wait until the run ends, then join the context of the agent's next turn.
- `steer` (default): urgent findings are injected as a real user message between turns of the current run, so the agent corrects course while still working. Waitable findings still queue.
- `interrupt`: the cord. An `interrupt` verdict aborts the in-flight run, and the finding opens the next one. Lesser verdicts behave as in `steer` mode.

### Lenses

Lens descriptions and boundaries live in [`docs/lenses.md`](docs/lenses.md). You can add your own heads: a markdown file in `~/.pi/agent/hydra/lenses/` becomes a lens, is re-read at the start of every run, and may override a built-in. Editing a lens file mid-session tunes the head for the very next observation.

A lens whose frontmatter says `tools: true` is an **acting head**: instead of judging from the replayed context alone, it runs the agent's own tools (read, bash, write, grep...) through pi's agent loop before deciding. A docs head updates notes while the agent works and usually ends `noop`, because its work product is the files it wrote; a research head looks something up and steers the finding in. Every file write is announced in the session, every loop call replays the same cached prefix, and a loop that has not produced a verdict after 25 model turns is wound down. See [`docs/lenses.md`](docs/lenses.md) for authoring guidance.

Settings persist per session and survive resume. For headless runs (`pi -p`), where slash commands are unavailable, the same settings are CLI flags: `--hydra-lens quality,security`, `--hydra-delivery`, `--hydra-off`. Flags seed sessions that have no saved settings; saved settings win on resume.

### The agent configures its own heads

hydra registers a `hydra` tool the agent can call: list the setup, switch the lens set, write or remove custom lenses. A lens the agent writes applies to the very next observation in the same run, so a workflow can swap heads per phase the way an assembly line swaps tooling: design wants devil's-advocate thinking, execution wants quality and security, review wants simplifier. Every agent-made change is announced in the TUI, lands as a plain markdown file you can audit, and persists like any other settings change. The observers see the reconfiguration too, since they replay the agent's own context.

The tool deliberately stops at lenses. The agent shapes what its observers look for, and can silence hydra only by removing heads one by one, each removal visible. How forcefully findings reach the session (`/hydra-delivery`), the `/hydra` toggle, and pi's extension enable/disable stay user-level controls.

## How it works

hydra captures the agent's provider requests byte-for-byte and replays them, with one observer prompt appended, at the moments the agent's own prompt cache commits. Each observation is therefore a near-pure cache read, fresh through the latest tool results, and the cache stays warm for the agent. Every mechanism behind that sentence is measured rather than assumed; the measurements live in [`experiments/`](experiments/README.md) and the design in [`docs/architecture.md`](docs/architecture.md).

## Where this is going

- **Self-tuning heads** ([#5](https://github.com/pandysp/pi-hydra/issues/5)). The agent can already write and swap its lenses mid-session, and an acting head can retune its peers through the same `hydra` tool; the remaining piece is the habit loop, where "this head flags too much" becomes a lens edit without anyone asking.
- **Mid-generation verdicts.** Every verdict today is formed from a committed request snapshot, so a single long-running LLM call is never evaluated while it streams. That would mean reasoning over message deltas, with no cache parity since the content is mid-flight.

If any of these interest you, issues and PRs are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). The codebase is small on purpose: one extension file, one pure-logic module with tests, and an experiments harness that lets you re-verify every cache claim against the live API for under a dollar.

## History

hydra began as **andon**, named for Toyota's emergency cord: any worker can stop the line when they spot a defect. The original was a bash and tmux contraption that reverse-engineered Claude Code's prompt pipeline to get cache parity, and its only job was interrupting the agent on urgent findings. The project has since outgrown interrupt-only (observers steer, queue, or stay quiet, and soon act asynchronously), and the pi extension replaced all of the reverse engineering with first-class hooks. The original lives in [`archive/`](archive/README.md), including the manufacturing-inspired manifesto that still explains the philosophy.

## License

[MIT](LICENSE)
