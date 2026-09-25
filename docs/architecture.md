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

Each prompt combines the head's instructions with Hydra's rules:

- The head file says what to check and how much to report.
- Hydra says first that the head is not the main assistant and must not continue its task, then explains which tools are allowed, how to finish, who receives feedback, and what feedback has already been sent.

`observationHandoffFor()` chooses the format below. Hidden test heads use a fixed prompt.

| Provider | Where the instructions go | How the head finishes |
|---|---|---|
| Anthropic | Head instructions and Hydra's rules in one user message | JSON, with or without tools |
| OpenAI Codex | Head instructions in a user message; Hydra's rules in a developer message | JSON without tools; the `hydra` tool otherwise |

The [shared feedback rules](heads.md#decisions-when-findings-land) ask heads to check evidence and consider work that may have moved on. They do not set a number of findings or favor silence. We have not measured whether the new wording reduces wrong or outdated findings.

## Payload merge

The observation request keeps the driver's captured content prefix and appends a fresh tail containing the final assistant message when needed, the specialist handoff, and any acting-loop turns.

For an Anthropic mid-run observation, the captured prefix remains byte-identical and Hydra appends a fresh handoff. The complete request is therefore longer; it is not itself byte-identical to the driver request. At Anthropic run end and during acting loops, Hydra deliberately relocates the deepest message-level cache marker onto the appended tail while preserving content-prefix parity.

Codex uses an append-only `input` merge and no explicit marker relocation. See [Provider payload mechanics](providers.md#provider-payload-mechanics) for the exact differences.

## Heads are files

A head is fully defined by one Markdown file. Discovery reads:

- `~/.pi/agent/hydra/*.md` for user heads;
- the nearest ancestor `.pi/hydra/*.md` for project heads.

Project heads shadow same-named user heads. Discovery runs at session start, every agent run, and every hydra tool call. Changes discovered at one of those points affect observations scheduled afterward; vanished files are pruned rather than observed with an empty instruction, and the main assistant is [told as that head's steer](#messages-hydra-sends-for-a-head). A header key other than `name`, `description`, `tools` or `autostart` makes the file invalid, so a retired or misspelled setting is reported instead of ignored.

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

Head files control [which tools a head may use](heads.md#tools-acting-heads).

Heads without tools make one model call; heads with tools use Pi's `runAgentLoop`. See [Failed checks](#failed-checks) for errors and retries. Each model call keeps the copied part of the main assistant's request unchanged. Whether the provider reads it from cache depends on the provider.

How a head finishes depends on the provider; see [Completion channels](providers.md#completion-channels).

## Delivery

In an open session:

- `print` shows a note in Pi's interactive interface. It shows nothing in `pi -p`, and the main assistant never sees it.
- `steer` sends the finding as a user message before the main assistant's next model request. If it is idle, the message starts a new run.
- `interrupt` stops active work and starts a new run with the finding. If already idle, it just starts the new run.
- No finding means no message. Hydra saves the result as `noop`.

During shutdown, Hydra uses its internal `queue` route to save `steer` and `interrupt` messages instead of starting idle work. `queue` also supports older sessions, but is not offered to heads.

Hydra groups findings from each answer into at most two messages. All `print` findings go in one user-only note. All `steer` and `interrupt` findings go in one message for the main assistant, which interrupts if any finding chose it. Every accepted finding appears once; user-only findings never reach the main assistant. An interrupt based on an old copy of the conversation becomes a steer, so it does not stop newer work.

Hydra tracks which messages are waiting and which arrived. Heads are told who received each message; a user-only note does not mean the main assistant saw it.

### Messages Hydra sends for a head

Hydra speaks for a head only when the head cannot: its check failed, it changed the active heads (removing itself ends its turn), or its file disappeared while it was active. Each message goes out as that head's `steer`, through the same route and with the same timing as a head's own steer, including waking an idle main assistant. A head reports its own file changes; Hydra does not announce writes, and a head changing a file through bash was never tracked.

A missing saved head on resume is shown to the user only. That check runs while the main assistant is idle, and a steer there would start an unprompted response.

Pi 0.87.1 checks for waiting messages once more before a run ends, which closed the gap where a steer arriving at that moment was lost. A steer arriving after that final check can still be stranded. Hydra then warns the user when the run settles, also in headless runs; how often this happens is not known.

### Failed checks

A head with tools receives Pi's normal tool errors and can try again within its check. This includes requests for tools it is not allowed to use.

A head without tools gets no retry or further model call. Tool requests never run, even if they come with valid-looking JSON. One invalid finding makes Hydra reject the entire answer. Invalid or empty answers, unfinished or cut-short responses, provider errors and responses the provider reports as stopped are failed checks. An answer containing only thinking is still empty. Hydra records these failures as `noop`, not as a deliberate choice to say nothing. If Hydra cancels the check or switches conversation branches before it finishes, it drops the result instead.

Only two failures produce an error notice, sent as the head's steer so its next check sees it: a tool request, or a completed, nonempty answer that does not match the required findings JSON. Provider errors, provider-stopped responses and cut-short or unfinished responses take priority over any tool requests or JSON they contain; they produce no such notice. The notice explains the mistake without repeating rejected arguments, answer text or thinking. Other failures stay in the error log; Hydra does not guess why they happened.

Each head gets at most one error notice for each error type while Pi runs, so a failure that repeats every check does not flood the conversation. Every failed head check is still logged. A failed send is a warning; Pi reports asynchronous send errors through its extension error channel.

## State and observability

hydra has no external database. It stores three custom entry types in Pi's session log:

- `hydra-config` — explicitly saved active-head changes (autostart alone is not persisted);
- `hydra-call` — usage, action, timing, tools, the head's answer and any error;
- `hydra-delivery` — successful delivery receipts.

Messages Hydra sends for a head are saved like that head's steers; the entries above are not model-visible. Switching conversation branches restores the records from the chosen branch. `/hydra-stats` and the footer use those same records. `/hydra-debug` saves the main assistant's request and the head's request so you can compare them.

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
| `judge.ts` | Check answers from heads without tools and track their error notices |
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
