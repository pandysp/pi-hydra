# pi-hydra

[![ci](https://github.com/pandysp/pi-hydra/actions/workflows/ci.yml/badge.svg)](https://github.com/pandysp/pi-hydra/actions/workflows/ci.yml)

> Extra heads for your coding agent.

hydra is a [pi](https://pi.dev/) extension that reviews your agent's work while the agent works. Each head is an observer with its own lens (quality, security, simplifier, API design) that sees exactly what the agent sees, judges every step, and answers with one of three decisions: stay quiet, queue feedback, or interrupt. One body, many heads: the agent carries the context, and each additional head reads that context straight from the prompt cache for about 1% of what the agent paid to build it.

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

The footer shows `hydra: quality | print | (no obs yet)`. Work normally; after the first agent run you will see observations arrive:

```
hydra:quality print hit 98.5% (last 99.1%) $0.0234 (12 obs)
```

hydra starts in `print` mode: decisions are rendered in the TUI but never injected into the agent's context. Watch it for a session, and when you trust the lens, let it act:

```
/hydra-delivery queue       # feedback joins the agent's next turn
/hydra-delivery interrupt   # urgent findings preempt the agent between turns
```

### Commands

| command | what it does |
|---|---|
| `/hydra` | toggle the observer |
| `/hydra-lens <name>` | pick the lens: `quality`, `security`, `simplifier`, `api-design` |
| `/hydra-delivery <mode>` | `print` (watch only), `queue` (feedback next turn), `interrupt` (steer between turns) |
| `/hydra-stats` | cache hit ratio, cost, recent decisions |
| `/hydra-debug` | dump driver/observer payload pairs for diffing |

Lens descriptions and boundaries live in [`docs/lenses.md`](docs/lenses.md).

Settings persist per session and survive resume. For headless runs (`pi -p`), where slash commands are unavailable, the same settings are CLI flags: `--hydra-lens`, `--hydra-delivery`, `--hydra-off`. Flags seed sessions that have no saved settings; saved settings win on resume.

## How it works

hydra captures the agent's provider requests byte-for-byte and replays them, with one observer prompt appended, at the moments the agent's own prompt cache commits. Each observation is therefore a near-pure cache read, fresh through the latest tool results, and the cache stays warm for the agent. Every mechanism behind that sentence is measured rather than assumed; the measurements live in [`experiments/`](experiments/README.md) and the design in [`docs/architecture.md`](docs/architecture.md).

## Where this is going

Today a head renders one of three verdicts. The architecture supports more than verdicts, and that is the direction:

- **Parallel heads.** Mid-run observations are pure cache reads, so running quality, security, and simplifier simultaneously costs three observer prompts, not three contexts.
- **Async heads.** A head that writes documentation as the agent codes. A head that updates project memory with decisions as they are made. A head that evaluates the trajectory in flight, instead of a post-hoc eval agent re-reading the whole transcript at full price. The head was there when it happened, and the cache already holds everything it saw.

If any of these interest you, issues and PRs are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). The codebase is small on purpose: one extension file, one pure-logic module with tests, and an experiments harness that lets you re-verify every cache claim against the live API for under a dollar.

## History

hydra began as **andon**, named for Toyota's emergency cord: any worker can stop the line when they spot a defect. The original was a bash and tmux contraption that reverse-engineered Claude Code's prompt pipeline to get cache parity, and its only job was interrupting the agent on urgent findings. The project has since outgrown interrupt-only (observers steer, queue, or stay quiet, and soon act asynchronously), and the pi extension replaced all of the reverse engineering with first-class hooks. The original lives in [`archive/`](archive/README.md), including the manufacturing-inspired manifesto that still explains the philosophy.

## License

[MIT](LICENSE)
