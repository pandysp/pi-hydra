# Architecture

hydra is a small in-process pi extension. Pi remains the driver: it owns the conversation, model, and primary tool loop. hydra captures the provider context Pi already assembled and appends a specialist handoff for each active head. It records each accepted observation call in Pi's session; feedback is then delivered to the driver or withheld according to the decision.

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
6. Judging heads make one provider call; heads with tools use Pi's own agent loop.
7. Decisions pass through the delivery layer and become a driver-directed steer or noop.
8. Calls, configuration, and delivery receipts are persisted as Pi session entries.

## Commit-point observation

hydra reviews at two lifecycle points.

**Mid-run (`message_start`).** The captured request already contains the conversation through the latest tool results. On Anthropic, response start is the verified point where that request is immediately cache-readable. OpenAI uses the same lifecycle trigger, but its commit/read timing is looser. The first response of every run is skipped for active heads, also when none were active yet, so a head added later in the run does not lose its first check. Usually the preceding state was already reviewed at the previous run end. After a cancelled run it was not, and the next eligible snapshot or run end reviews it along with the rest. A fresh session likewise receives its first review at an eligible later snapshot or run end. One-off heads (`lifetime: "once"`) are held until the next review point, including the first response of a run, so their single check sees the request that asked for it; a run end serves as that point when no response follows. One-offs still held when their run is cancelled, the conversation switches branches or the session ends are dropped with a warning. A head still checking a cancelled run cannot add a one-off; the add call fails.

**Run end (`agent_end`).** No later driver request has carried the final assistant message yet, so hydra passes that message through Pi's own provider serialization and appends it before the head handoff. This keeps the observation current rather than one assistant message behind. A run the user cancelled gets no new review: its last message is not a final answer. Reviews still waiting for it do not start. Reviews already running for it finish and are saved, but feedback that would start a driver turn, including Hydra's own notices, is added to the conversation without one, so it cannot restart work the user just stopped. In print and json mode (`pi -p`), the session ends as soon as the main assistant stops, and a message only gets a turn while `agent_end` is still running. So a run there waits at its end, for at most 10 minutes, for the one-off checks it asked for; their feedback then wakes the main assistant, as it does in the TUI. A check that takes longer is reported with a warning. Cancelling the run ends the wait, since its feedback could no longer start a turn. Ongoing heads are not waited for.

Each captured request remembers the model that answered it, read from the answer: pi applies a model switch to the selection before a request it is already preparing goes out. A check is skipped if the selected model differs when it starts, so a check that waited behind a busy one does not replay one provider's request on another.

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
| ChatGPT sign-in | As Codex | JSON without tools; the `hydra` tool otherwise |
| ds4 (local) | As Anthropic | JSON, with or without tools |

The rule for every head is "split unless measured otherwise": Anthropic and ds4 measured better combined, so every other route, including a provider added later, gets the split. ds4 [moves developer messages to the top of the prompt](providers.md#ds4), which breaks the split's cache match. On all supported routes the head's instructions start with `HEAD INSTRUCTIONS:`. Without that label, Codex heads took their own instructions, sent as a separate user message, for the user's latest request.

A head added with `ends_when` is also told its condition and how to report `done`. No other head's handoff mentions `done`; the field still appears in the shared `hydra` tool definition, which has to stay identical for cache reuse.

The rules for heads without tools describe what `steer` does. pi uses its own description; a host whose delivery differs passes its own, as [flue-hydra](https://github.com/pandysp/flue-hydra) does for Flue agents.

The [shared feedback rules](heads.md#decisions-when-findings-land) ask heads to check evidence and consider work that may have moved on. They do not set a number of findings or favor silence. We have not measured whether the new wording reduces wrong or outdated findings.

## Payload merge

The observation request keeps the driver's captured content prefix and appends a fresh tail containing the final assistant message when needed, the specialist handoff, and any tool-loop turns.

For an Anthropic mid-run observation, the captured prefix remains byte-identical and Hydra appends a fresh handoff. The complete request is therefore longer; it is not itself byte-identical to the driver request. At Anthropic run end and during tool loops, Hydra deliberately relocates the deepest message-level cache marker onto the appended tail while preserving content-prefix parity.

All `openai-responses` and Codex routes use an append-only `input` merge and no explicit marker relocation. See [Provider payload mechanics](providers.md#provider-payload-mechanics) for the exact differences.

## Heads are files

A reusable head is fully defined by one Markdown file. A head added without a file is defined by its add call instead: Hydra keeps its instructions and tools only while it is active, and saves them with the active set. Discovery reads:

- `~/.pi/agent/hydra/*.md` for user heads;
- the nearest ancestor `.pi/hydra/*.md` for project heads.

Project heads shadow same-named user heads. Discovery runs at session start, every agent run, and every hydra tool call. Changes discovered at one of those points affect observations scheduled afterward; vanished or invalid files are pruned rather than observed with an empty instruction, and the main assistant is [told with a note](#messages-hydra-sends-for-a-head). Before each run Hydra also turns off heads that can't use their tools ([Tools](heads.md#tools)). A header key other than `name`, `description`, `tools` or `autostart` makes the file invalid, so a retired or misspelled setting is reported instead of ignored. A head file that appears under the name of an active head without a file is ignored, with a warning, until that head leaves.

The active set is session state. Startup precedence is an explicit `--hydra-heads` flag, then the saved session set, then `autostart` markers for a fresh session. Navigating to another point in the conversation starts from no heads, then applies that point's saved set, or the launch default (flag, else autostart) when it has none. Nothing of the branch left behind survives: saved heads that no longer exist, a damaged saved head or a flag that matches nothing leave fewer heads, with a warning, not the old ones. Full authoring behavior belongs in [Writing heads](heads.md).

## Per-head scheduling

Each head owns one running observation and one waiting slot. A new snapshot replaces the waiting one, so a busy head catches up to the newest state instead of draining an obsolete backlog.

```text
security: running ──► newest waiting snapshot
quality:  running independently
docs:     running independently
```

An in-flight observation runs to completion unless lifecycle shutdown aborts it. A waiting snapshot of a run the user cancelled is dropped instead of started. A one-off check uses the same lanes without joining the active set; Hydra refuses a second one under a name whose lane still has a check waiting or running, so one can never replace the other. A one-off that cannot start says so. Scheduling is per head, so a long tool loop does not occupy another head's scheduler lane.

## Heads with tools

Head files control [which tools a head may use](heads.md#tools): reading heads and writing heads both work as described here.

Heads without tools make one model call; heads with tools use Pi's `runAgentLoop`. See [Failed checks](#failed-checks) for errors and retries. Each model call keeps the copied part of the main assistant's request unchanged. Whether the provider reads it from cache depends on the provider.

How a head finishes depends on the provider; see [Completion channels](providers.md#completion-channels).

## Delivery

In an open session:

- `steer` sends the finding as a user message before the main assistant's next model request. If it is idle, the message starts a new run.
- No finding means no message. Hydra saves the result as `noop`.

During shutdown, and for reviews of a run the user cancelled, Hydra sends `steer` messages as a `note`: it adds them to the conversation without starting a turn. Hydra also tells the main assistant with a `note` when it turns a head off. `note` is Hydra's own route, never a head's choice.

All findings from a head's answer go in one `steer` message for the main assistant. Every accepted finding appears once.

The internal `print` route is deprecated and cannot be chosen by heads. Its delivery, grouping and history support remain. Older `print` receipts still identify the user as the recipient, so a head does not mistake that note for feedback the main assistant saw.

Hydra tracks which messages are waiting and which arrived. Heads are told who received each earlier message.

### Messages Hydra sends for a head

Hydra speaks for a head only when the head cannot: it changed the active heads (removing itself ends its turn), it reported `done` for its `ends_when` condition and was removed, or Hydra turned it off because its file disappeared or became invalid, or because the main assistant lacks a tool it needs ([Tools](heads.md#tools)). The first two go out as that head's `steer`, through the same route and with the same timing as a head's own steer, including waking an idle main assistant, unless they come from a review of a cancelled run (see above). A head Hydra turned off goes out as a `note`: that usually happens as a run starts, where a steer would start a second prompt, and it needs no answer. Before pi's first system message Hydra sends no note at all, only the user's warning ([why](providers.md#anthropic)). Steers reach the model as user messages, so every head message starts with `[pi-hydra <head>]`, and the ones Hydra sends for a head continue with `automatic notice:`. A head reports its own changes when the main assistant needs to know them; Hydra does not announce writes.

A missing saved head on resume is shown to the user only. That check runs while the main assistant is idle, and a steer there would start an unprompted response.

Pi 0.87.1 checks for waiting messages once more before a run ends, which closed the gap where a steer arriving at that moment was lost. A steer arriving after that final check can still be stranded. Hydra then warns the user when the run settles, also in headless runs; how often this happens is not known.

### Failed checks

A head with tools receives Pi's normal tool errors and can try again within its check. This includes requests for tools it is not allowed to use.

A head without tools gets no retry or further model call. Tool requests never run, even if they come with valid-looking JSON. One invalid finding makes Hydra reject the entire answer. Invalid or empty answers, unfinished or cut-short responses, provider errors and responses the provider reports as stopped are failed checks. An answer containing only thinking is still empty. Hydra records these failures as `noop`, not as a deliberate choice to say nothing. If Hydra cancels the check or switches conversation branches before it finishes, it drops the result instead.

A failed check sends nothing to the main assistant. Hydra warns you with the error type, saves it with the check, and `/hydra-stats` counts failed checks by type. Provider errors, provider-stopped responses and cut-short or unfinished responses take priority over any tool requests or JSON they contain. The saved record never includes rejected tool arguments; Hydra does not guess why a check failed.

A failed send is a warning; Pi reports asynchronous send errors through its extension error channel.

## State and observability

hydra has no external database. It stores three custom entry types in Pi's session log:

- `hydra-config` — explicitly saved active-head changes (autostart alone is not persisted), with the instructions and tools of active heads added without a file and the end conditions of heads added with `ends_when`;
- `hydra-call` — usage, action, timing, tools, the head's answer and any error, and `doneIgnored` when a head without an end condition said `done`;
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
- Heads send through pi's own request path (`modelRegistry.streamSimple`), so a provider's own code, such as pi-ds4 starting its server or an extension that shapes Anthropic requests, runs for heads as for the main assistant.
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
| `judge.ts` | Check answers from heads without tools and name how a failed one failed |
| `delivery.ts` | Delivery ledger and routing |
| `utils.ts` | Shared types and pure prompt, parsing, guard, and payload logic |

Setup and checks are in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Verifying cache parity

Use `/hydra-debug` to dump driver/observation pairs. Truncate the observation's `messages` (Anthropic) or `input` (OpenAI) to the driver's length; a mid-run pair then matches exactly. An Anthropic run-end pair also moves the driver's last cache marker onto the final assistant message, so compare it without cache markers.

Exact commands and expected provider accounting live in [Verification procedures](providers.md#verification-procedures).

## Verifying the tripwire

The unsafe live-fire procedure is maintained in [Verifying the Codex tripwire](providers.md#verifying-the-codex-tripwire). It intentionally breaks one request in a throwaway continuation session; never use it in real work.

## Compared to the archived andon (bash) version

The archived andon observer reconstructed Claude Code context through subprocesses, normalization rules, polling, and tmux delivery. pi-hydra instead captures provider payloads through a first-class hook, reuses Pi's own agent loop and serializer, responds to lifecycle events, persists facts in Pi's session log, and delivers through Pi APIs. The archive remains in [`archive/`](../archive/README.md).
