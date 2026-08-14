# Architecture

hydra is a small in-process pi extension. Pi remains the driver: it owns the conversation, model, and primary tool loop. hydra captures the provider context Pi already assembled and appends a specialist handoff for each active head. It records each accepted observation call in Pi's session; feedback is then shown only to the user, delivered to the driver, or withheld according to the decision.

```text
Pi request → capture → append head handoff → cache-reusing review where available → deliver
```

This document explains the system. Detailed provider behavior, economics, dates, and evidence live in [Providers and measurements](providers.md).

## System flow

1. `before_provider_request` captures the driver's provider payload.
2. `message_start` schedules a mid-run observation after the first response of a run.
3. `agent_end` schedules a final observation carrying the last assistant message.
4. The per-head scheduler runs each active head independently.
5. The observation engine chooses a provider- and mode-specific handoff.
6. Judge-only heads make one provider call; acting heads use Pi's own agent loop.
7. Decisions pass through the delivery layer and become a user-only note, driver-directed steer or interrupt, or noop.
8. Calls, configuration, and delivery receipts are persisted as Pi session entries.

## Commit-point observation

hydra reviews at two lifecycle points.

**Mid-run (`message_start`).** The captured request already contains the conversation through the latest tool results. On Anthropic, response start is the verified point where that request is immediately cache-readable. Codex uses the same lifecycle trigger, but its commit/read timing is looser. The first response of every run is skipped unconditionally; on later runs the preceding state was already reviewed at the previous run end, while a fresh session still receives its first review at an eligible later snapshot or run end.

**Run end (`agent_end`).** No later driver request has carried the final assistant message yet, so hydra passes that message through Pi's own provider serialization and appends it before the head handoff. This keeps the observation current rather than one assistant message behind.

The provider-specific timing and cache consequences are canonical in [Provider lifecycle](providers.md#provider-lifecycle).

## Prompt construction

There is no universal head prompt. A handoff combines two responsibilities:

```text
head Markdown body       Hydra protocol
(specialist policy)  +   (tools, completion, delivery)
```

`observationHandoffFor()` chooses one of four paths for product heads (hidden diagnostic heads use a fixed test prompt):

| | Judge-only | Acting |
|---|---|---|
| Anthropic | Combined lens and protocol | Combined acting prompt and JSON completion |
| OpenAI Codex | User lens plus developer envelope | User lens plus developer envelope and typed completion |

The head file alone defines scope, intervention criteria, and suppression. Hydra's protocol defines mechanism: tool allowance, delivery context, output shape, and completion rules.

## Payload merge

The observation request keeps the driver's captured content prefix and appends a fresh tail containing the final assistant message when needed, the specialist handoff, and any acting-loop turns.

For an Anthropic mid-run observation, the captured prefix remains byte-identical and Hydra appends a fresh handoff. The complete request is therefore longer; it is not itself byte-identical to the driver request. At Anthropic run end and during acting loops, Hydra deliberately relocates the deepest message-level cache marker onto the appended tail while preserving content-prefix parity.

Codex uses an append-only `input` merge and no explicit marker relocation. See [Provider payload mechanics](providers.md#provider-payload-mechanics) for the exact differences.

## Heads are files

A head is fully defined by one Markdown file. Discovery reads:

- `~/.pi/agent/hydra/*.md` for user heads;
- the nearest ancestor `.pi/hydra/*.md` for project heads.

Project heads shadow same-named user heads. Discovery runs at session start, every agent run, and every hydra tool call. Changes discovered at one of those points affect observations scheduled afterward; vanished files are pruned rather than observed with an empty instruction.

The active set is session state. Startup precedence is an explicit `--hydra-heads` flag, then the saved session set, then `autostart` markers for a fresh session. Full authoring behavior belongs in [Writing heads](heads.md).

## Per-head scheduling

Each head owns one running observation and one waiting slot. A new snapshot replaces the waiting one, so a busy head catches up to the newest state instead of draining an obsolete backlog.

```text
security: running ──► newest waiting snapshot
quality:  running independently
docs:     running independently
```

An in-flight observation runs to completion unless lifecycle shutdown aborts it. Scheduling is per head, so a long acting loop does not occupy another head's scheduler lane.

## Acting heads

Tool permissions come from the head file:

- omitted `tools:` grants all tools hydra can execute;
- a list narrows execution to that subset;
- `tools: []` creates a judge-only head.

Judge-only heads make one call with no executable tools and may return several findings. Acting heads run through `runAgentLoop` from Pi's agent core, preserving Pi's argument validation, tool errors, execution policy, and cancellation behavior. Every loop iteration still replays the captured driver prefix; whether that replay is a cache hit remains provider-dependent.

OpenAI acting heads normally finish with the typed `hydra` completion action; successful self-removal is terminal without a second call. Anthropic acting heads return a compact validated JSON decision; their actual work and head management still use tools. Provider rationale and measured comparisons live in [Completion channels](providers.md#completion-channels).

## Delivery

Evaluation and delivery are separate:

- `print` renders a user-only TUI note in interactive mode and never enters the driver's context;
- `steer` sends a real user message at the driver's next checkpoint;
- `interrupt` aborts an active run and delivers the finding; when idle, it simply starts the next run with that message;
- a valid quiet decision is persisted as a noop.

Judge findings are grouped into at most one user-only batch and one agent-directed batch. An interrupt based on a stale snapshot is demoted to steer: one turn of delay is safer than aborting newer work from an old judgment.

A delivery ledger tracks pending and successful messages so heads receive factual context about what has already reached the driver. The old queue route remains internal for compatibility but is not offered in current prompts or schemas.

## State and observability

hydra has no external database. It stores three custom entry types in Pi's session log:

- `hydra-config` — explicitly saved active-head changes (autostart alone is not persisted);
- `hydra-call` — observation usage, action, timing, and tools;
- `hydra-delivery` — successful delivery receipts.

Branch navigation rebuilds this state from the selected session branch. `/hydra-stats` and the footer use the same persisted calls. `/hydra-debug` dumps captured and merged payload pairs for manual parity verification.

## Cache hit ratio

Detailed hit-rate tables, session costs, measurement dates, and interpretation are maintained in [Economics and measurements](providers.md#economics-and-measurements). The architectural point is narrower: an observation pays for its fresh tail while reusing as much of the captured driver prefix as the provider makes cache-readable.

## Observation timing

The lifecycle summary is in [Commit-point observation](#commit-point-observation). Exact timing probes, run-end accounting, and re-verification history are in [Provider lifecycle](providers.md#provider-lifecycle).

## OpenAI Codex support

Codex shares the architecture above but has different handoff, session, transport, and cache behavior. In brief: full-input transports may safely share the driver's provider session; continuation transports make hydra fall back monotonically to its own session; a continuation-error tripwire is the final backstop. The complete and canonical behavior is in [OpenAI Codex](providers.md#openai-codex).

## Limitations & roadmap

- Only measured provider/API pairs observe; others warn and skip.
- Heads use the driver's model and inherit its framing.
- Long-running head tools cannot always be hard-aborted mid-execution.
- Headless shutdown may need a longer `HYDRA_SHUTDOWN_GRACE_MS` for run-end observations.
- Decisions judge complete captured requests, not partial generations.
- Multi-head fan-out favors low feedback latency over coordinating every run-end cache write.

Provider-specific limits and evidence are in [Provider limits](providers.md#provider-limits). Mid-generation observation remains future work because partial output has no cache-parity prefix.

## Module map

There is no build step; Pi loads the TypeScript through jiti.

| Module | Responsibility |
|---|---|
| `index.ts` | Pi hooks, observation engine, commands, and UI wiring |
| `heads.ts` | Discovery, shadowing, and active-set registry |
| `scheduler.ts` | Conflating per-head scheduler |
| `stats.ts` | Observation log and session-entry parsing |
| `protocol.ts` | Hydra tool wire contract |
| `delivery.ts` | Delivery ledger and routing |
| `utils.ts` | Shared types and pure prompt, parsing, guard, and payload logic |

Setup and checks are in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Verifying cache parity

Use `/hydra-debug` to dump driver/observation pairs. A mid-run Anthropic pair should match after removing the appended handoff. A run-end pair additionally carries the final assistant message and deliberate marker relocation, so compare content after removing the tail and cache markers. A Codex pair should match after truncating the observation `input` to the driver's input length.

Exact commands and expected provider accounting live in [Verification procedures](providers.md#verification-procedures).

## Verifying the tripwire

The unsafe live-fire procedure is maintained in [Verifying the Codex tripwire](providers.md#verifying-the-codex-tripwire). It intentionally breaks one request in a throwaway continuation session; never use it in real work.

## Compared to the archived andon (bash) version

The archived andon observer reconstructed Claude Code context through subprocesses, normalization rules, polling, and tmux delivery. pi-hydra instead captures provider payloads through a first-class hook, reuses Pi's own agent loop and serializer, responds to lifecycle events, persists facts in Pi's session log, and delivers through Pi APIs. The archive remains in [`archive/`](../archive/README.md).
