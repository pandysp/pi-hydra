# Heads

A head is a helper that checks the main assistant's work. It can report a finding or say nothing. A reusable head has one Markdown file with its name, allowed tools and instructions; a head needed only for a moment can be added without a file ([Heads for a moment](#heads-for-a-moment)). The session records which heads are active. If a head is busy, Hydra keeps only the newest waiting copy of the conversation for its next check.

## Head files

```markdown
---
name: quality
description: Correctness risks, missing verification, dangerous assumptions
autostart: true
tools: []
---
Check code quality. Focus on correctness risks, missing
verification, dangerous assumptions, and code that looks likely to break.
Do NOT nitpick style.
```

Frontmatter keys:

| key | required | meaning |
|---|---|---|
| `name` | yes | the head's identity; what `/hydra-heads` and the `hydra` tool refer to. Files without a name are skipped with a warning. |
| `description` | yes | one line, shown in completions, the picker, and tool replies. Files without one are skipped with a warning. |
| `tools` | no | comma-separated tool names the head may execute (`tools: read, grep`). Omitted means the same tools as the main assistant; `tools: []` means none (the head judges, never acts). See [Tools](#tools). |
| `autostart` | no | `true` joins the active set at session start; `false` is the same as leaving it out. Any other value makes the file invalid. Only consulted when the session has no saved head set and no `--hydra-heads` flag. |

The filename is only storage: identity comes from `name`. By convention, name the file after the head.

There is no supported `model` key: a head replays the agent's provider context, and prompt caches are model-specific. Every head runs on the agent's model and thinks at the agent's thinking level. Matching the model is required for cache reuse—though provider timing and session routing still determine the actual hit—and is why a head cannot be assigned a stronger model than the driver's.

## Where heads live

- `~/.pi/agent/hydra/*.md`: your heads, on every project.
- `.pi/hydra/*.md`: the project's heads, shipped with the repo.

A project head with the same name as a user head wins, like project agents and presets elsewhere in pi, so a repo can replace your generic `quality` with one that knows the codebase conventions. Project files are repo-controlled prompts and run under the same consent as everything else in `.pi/`: pi's folder trust. When hydra loads project heads it says so in the TUI, and once more when a project head shadows one of yours.

Head files are re-read at the start of every agent run and on every `hydra` tool call. Changes apply to observations scheduled after that discovery point without reloading Pi: tune a noisy head before the next run, or follow a write with a `hydra` call when it must take effect during the current run. Duplicate names within one directory warn and keep the first file. If a file behind an active head disappears, the head is dropped from the active set with a notice, never silently.

There are no built-in product heads; the extension has only hidden one-shot diagnostics for delivery smoke tests. The [`heads/`](../heads) directory in this repo holds ready-to-use examples (the quality, security, simplifier, api-design, and navigator reviewers, plus the foreman and tuner below); the [quick start](../README.md#quick-start) copies them into `~/.pi/agent/hydra/`.

Or skip the copy and tell your agent what you want watched. The `hydra` tool teaches it both ways: a head without a file for help needed now, and a head file, which you can read, edit, and delete, for a head worth reusing.

## Activating heads

The active set is session state: which heads observe right now.

- `/hydra-heads` opens a multi-select picker over every discovered head.
- `/hydra-heads quality,security` sets the active set directly; `/hydra-heads none` clears it (a head cannot be named `none`; the command uses it to mean clear).
- `--hydra-heads quality,security` seeds headless runs (`pi -p`).
- The agent uses `hydra` with `action: "manage_heads"` to add or remove one head at a time, optionally for a moment only ([Heads for a moment](#heads-for-a-moment)).

Several heads observe at once: each active head gets its own observation in parallel and reuses the agent's cached context instead of rebuilding it. Multiple heads still add material, provider-dependent session cost; see [Economics and measurements](providers.md#economics-and-measurements).

Adding a head is refused while a diagnostic head holds the active set, or while a check under the same name is still waiting or running, for example right after removing that head; the error says to try again once it has finished.

Precedence at session start: an explicit `--hydra-heads` flag wins; otherwise a resumed session restores its saved set; otherwise the heads marked `autostart: true` form the set. Moving to another point in the conversation gives that point's saved heads, or the same starting heads when nothing was saved there; never heads from where you came from. A saved head that no longer exists or whose saved entry is damaged is left out with a warning. Saved state never leaks across sessions; autostart is only the cold-start default.

## Heads for a moment

A head written for one task and left on keeps checking, and paying, after every response, and its file stays behind. When help is needed only now, the agent adds a head with an end instead:

| Call (`manage_heads`, `operation: "add"`) | What happens |
|---|---|
| `head: "security"` | today's default (`lifetime: "ongoing"`): the head checks after every response until it is removed |
| `head: "security", lifetime: "once"` | one check of the head file, then it switches off again |
| `head: "cache-check", lifetime: "once", instructions: "…"` | one check by a head without a file; nothing is written or saved |
| `head: "refactor-review", instructions: "…", ends_when: "the refactor is committed"` | a head without a file that checks after every response until its condition is met or it is removed |
| `head: "security", ends_when: "the auth PR is merged"` | the same with a head file; the file is not changed |

Use `once` for a job: check or do something, then report. Use `ends_when` for watching over several steps. `tools` sets what a head without a file may use, with the same meaning as in a head file.

A `once` check starts with the main assistant's next response, so it sees the request that asked for it, and runs in the background like any other check. It also runs on the first response of a run, which Hydra otherwise skips for heads that already reviewed the run before it. If the run that asked for it is cancelled, the conversation switches branches, the model is switched or the session ends before the check starts, it does not start, and you get a warning. A head still checking after you cancel cannot ask for a `once` check: it gets an error, so nothing it asks for starts in your next run. A check already running when you cancel does finish, including any file edits it makes. In `pi -p` the run [waits at its end](architecture.md#commit-point-observation) for `once` checks it asked for, so the main assistant can still act on their feedback.

A head with `ends_when` is told the condition at every check. When it holds, the head adds `"done": true` to its answer ([Decisions](#decisions-when-findings-land)): Hydra delivers its findings, then removes the head and tells the main assistant why. It judges the condition from the conversation, or checks it with its tools: a PR merged on GitHub stays invisible to a judging head until someone mentions it. You or the main assistant can remove it by name at any time. A head without a file and its end condition are saved with the session, so they survive a resume, and they are gone once the head leaves the active set. `/hydra-heads` lists such a head as "no file"; setting the heads with `/hydra-heads quality,security` switches it off for good.

A head without a file must have an end: `once` or `ends_when`. The `hydra` tool rejects any other combination it cannot honor with an error that says why, and changes nothing.

## Tools

A head can use pi's standard tools (read, bash, edit, write, grep, find, ls) and the `hydra` tool itself, through pi's own agent loop, before it completes. Those eight are the only tools Hydra can run; other extensions' tools and MCP tools are not supported. A docs head updates notes while the agent works and usually completes with `none`, because its work product is the files it wrote; a research head looks something up and steers the finding in.

A head's tools decide what it can do:

| Kind | `tools:` | What it can do |
|---|---|---|
| **Judging head** | `[]` | Judge what's in the conversation. One model call, no tools. |
| **Reading head** | only `read`, `grep`, `find`, `ls` | Also read and search the project's files, without changing anything. pi turns `grep`, `find` and `ls` off by default, so add `"+grep", "+find", "+ls"` to `defaultTools` in pi's `settings.json`. |
| **Writing head** | at least one of `write`, `edit`, `bash` | Also change files or run commands. `bash` counts because it can do anything. |

`hydra` doesn't change the kind: it lets a head turn heads on and off ([Heads that manage heads](#heads-that-manage-heads)), so `read, grep, hydra` is a reading head that may also manage heads. A head without a `tools:` line gets the main assistant's tools, and nothing more, so with pi's defaults (`read`, `bash`, `edit`, `write`) it is a writing head.

`tools:` limits what a head can run; for a head without a file, the add call's `tools` does the same. For example, `tools: read, grep` allows only those tools; `tools: []` allows none. See [Failed checks](architecture.md#failed-checks) for errors and retries.

A head can only use tools the main assistant has. Its request reuses the main assistant's, tool definitions included, so the cache keeps working; those definitions don't grant permission to run a tool, its own list does. A tool the head may use but the main assistant lacks has no definition there, and the head never calls it. Measured on 2026-10-04 with a head allowed `read, grep, find, ls` while the main assistant lacked `grep`, `find` and `ls` (pi turns them off by default): on Opus 5.5 and gpt-6-astra the head gave up in 4 of 4 runs; with the tools, it found the file in 4 of 4. In the gpt-6-astra runs with the tools, the main assistant also lacked `hydra`, so those checks couldn't be handed in ([records](https://github.com/pandysp/pi-hydra/blob/81d3549d95383a8da837b7e62bd0186ccac8388a/experiments/README.md#tools-a-head-knows-only-by-name-october-2026)).

So Hydra doesn't run a head that can't use its tools. Before each run and whenever heads change, it checks every active head; a head is turned off, with a warning and, once the session has started, a note to the main assistant, when:

- its list names a tool the main assistant doesn't have, whether `grep` or `write`;
- its list names a tool Hydra can't run, such as another extension's;
- it finishes its check through the `hydra` tool (on OpenAI Codex and ChatGPT sign-in, see [Completion channels](providers.md#completion-channels)) and the main assistant doesn't have `hydra`;
- `codemode` is active with `codemode.mode: "only"`, which hides every tool from the model.

`manage_heads` refuses such a head instead. Turning a head off is saved like removing it, so it stays off until someone turns it on again. Hydra never switches tools on by itself; the warning names the missing tools and the fix.

A head can use `manage_heads` only if its `tools` includes `hydra`, or it has no list and the main assistant has `hydra`.

Authoring guidance for heads with tools:

1. **Say what to do.** State the head's purpose, when it should act, what work to do, and who needs the result. `PURPOSE / ACT WHEN / WORK / DELIVER` is a useful outline, not special syntax. Prefer clear rules over a growing list of exceptions.
2. **Report what the main assistant needs, not routine work.** Hydra does not announce a head's writes; each head with tools is told to report changes the main assistant needs to know about and to keep routine notes, logs or scores to itself.
3. **Prefer write/edit over bash for file changes.** Pi coordinates `write` and `edit` calls from the head and main assistant. Bash changes bypass that protection. Use bash only to read files unless you accept that risk.
4. **No turn or cost limit.** Hydra does not stop a head just because it has made a set number of model or tool calls. Model-call counts and cost are shown in `/hydra-stats`. Finishing the check, turning the head off, closing the session, or unsafe cache sharing still stops it. Provider and tool limits still apply.

When a head uses `manage_heads` to change the active heads, Hydra steers what changed and the head's explanation to the main assistant, as that head. Failed calls and calls that change nothing send nothing. A head whose `tools` list includes `hydra` also sees the active heads when its check starts; later tool results may show a newer list.

## Decisions: when findings land

A head with tools must finish its checks and tool work before reporting. See [Completion channels](providers.md#completion-channels) for how to finish on each provider.

A head without tools returns one JSON object:

```json
{"findings":[{"action":"steer","reason":"≤120 chars","message":"≤240 chars"}]}
```

This head's instructions define what to check and how much to report. Return one entry per finding, or an empty array if there are none. Support each finding with a short quote or exact reference. If evidence is missing, say what is missing. A quote lets someone check the finding; it does not prove the finding is right.

Use `steer` when the main assistant needs the feedback, even if it can wait. The user-only `print` route is deprecated and is no longer accepted from heads.

See [Delivery](architecture.md#delivery) for how Hydra groups findings, handles old checks, and delivers messages during work, idle time, shutdown and after you cancel a run.

A head added with `ends_when` reports that its condition is met with `"done": true` next to its findings, or `done: true` in `complete_observation`. Only such a head is told about `done`. If another head sends it anyway, Hydra keeps the head running, delivers its findings, and records `doneIgnored` for that check.

Use `none` only when finishing through the `hydra` tool with nothing to report. Heads using the findings JSON instead return an empty array; `none` is not a valid finding action. Invalid answers follow the [failed-check rules](architecture.md#failed-checks).

The main assistant may have moved on while the head was checking. Do not repeat its plan or doubts, or suggest work it already plans to do unless the plan itself is the problem. Do not repeat feedback still waiting for delivery or a problem that is fixed. Follow up only with evidence that the problem still applies after checking the visible response, or with new evidence that changes the finding. A problem that remains does not prove the feedback was ignored.

## Heads that manage heads

A head's job can be the other heads. Two ship as examples in [`heads/`](../heads):

The **foreman** ([`heads/foreman.md`](../heads/foreman.md)) reads the task and staffs the line: it infers what the session is doing, matches the active set to the phase, and re-crews at transitions. For a risk of the moment it adds a head without a file, with `once` or `ends_when`, and writes a head file only for a head worth reusing. Marking it `autostart: true` makes it part of the cold-start set when no explicit flag or saved session set takes precedence.

The **tuner** ([`heads/tuner.md`](../heads/tuner.md)) reads your reactions and maintains the head files: a head whose findings get dismissed is sharpened for every future session.

The examples use the [management rules](#tools) described above. A foreman can activate the tuner when needed.

## Example heads (minimal overlap)

The five review examples are designed to catch different things rather than repeat each other:

### Quality
**Lens:** correctness risks, missing verification, dangerous assumptions, obvious regressions, code that looks likely to break.
**Why:** The broadest net and the recommended default. The agent believes its own code works; this head asks what would prove it.
**Boundary:** Do not nitpick style.

### Security
**Lens:** auth, authorization, secret handling, injection risk, unsafe shelling-out, data exposure, trust boundaries.
**Why:** Auth logic flaws, leaked secrets, and unsafe shell calls are easy for general-purpose lenses to miss while the agent is focused on functionality rather than attack surface.
**Boundary:** Do not comment on style or product scope.

### Simplifier
**Lens:** unnecessary complexity, abstractions that do not earn their keep, code that could be deleted, over-built solutions.
**Why:** Every other head adds requirements. This one argues for removing code instead.
**Boundary:** Do not comment on unrelated bugs or security. You argue for less, not more.

### API Design
**Lens:** contract clarity, compatibility, consistency, error shapes, naming, ergonomics.
**Why:** Consumer-facing issues are invisible from inside the code. Inconsistent response shapes, breaking changes, awkward names: the agent is thinking about the implementation rather than the contract.
**Boundary:** Do not comment on internal code structure.

### Navigator
**Lens:** done declared without proof, moved goalposts, quietly dropped requirements, guesses where a question was owed, unchecked assumptions, building before understanding, symptom fixes where the user wants the cause.
**Why:** The other reviewers judge the code; this one judges the trajectory against the ask, like the non-typing partner in pair programming. In human-AI sessions the human plans and the agent executes, and the common failure is the plan quietly coming apart: requirements dropped, wrong problem solved, victory declared on green tests alone.
**Boundary:** Do not comment on the code itself. Steer at the level of the goal.

## More head ideas

Ideas for heads to write yourself, grouped by the shape a head takes. The grouping is loose. Many good heads fit none of these shapes.

**Watchdog heads** judge against a standard the head file carries. Most are judging heads (`tools: []`) and stay quiet until the standard is violated:

- **Observability**: logging, monitoring, traceability, whether an incident at 3am could be diagnosed from what the code emits. Long-running services and anything with an on-call rotation.
- **Testing**: coverage gaps, untested edge cases, error handling paths. Pre-merge and complex business logic.
- **Performance**: algorithmic complexity, N+1 queries, blocking operations. Data-heavy apps; overlaps with Simplifier on redundant operations.
- **Compliance**: data retention, consent, audit trails, data minimization. Regulated industries and PII.
- **Domain Expert**: business rule accuracy, edge cases in domain logic, terminology. When correctness matters more than code quality.
- **Architecture**: structural design, coupling, layer separation. For large codebases and early design phases; overlaps with Simplifier on DRY.

**Navigator heads** judge against the task. Their yardstick lives in the session: the spec, the ask, the agreed scope. A general-purpose navigator ships in [`heads/`](../heads); these are narrower variants:

- **Scope-keeper**: flags work nobody asked for (gold-plating, drive-by refactors, rabbit holes) and steers the run back to the ask.
- **Spec-alignment**: compares the work against the requirements as stated in the conversation. Catches quiet reinterpretation of the task.

**Caretaker heads** act through tools and usually complete with `none` because the files they maintain are the work product:

- **Docs-keeper**: keeps a notes file current with decisions as they happen (the example in the README).
- **Changelog**: appends user-facing changes as they land, so the notes exist by release time.
- **Glossary**: maintains the project's terms as the domain language grows.

**Red-team heads** attack the premises of the work. They are most useful during design and usually muted during execution:

- **Devil's Advocate**: challenge the entire approach. "Why this way and not another?" Zero overlap with code-level review. Do NOT comment on code-level bugs or style; think meta.
- **Threat-modeler**: attacks the design the way an adversary would, before the code exists.

**Evaluator heads** save assessments for later study instead of sending findings to the main assistant. Their instructions say to complete with none, so their log writes are not reported:

- **Behavior-annotator**: scores each run against a rubric and appends the scores to an eval log. This is how you run live evals without full-price trajectory replay.
- **Failure-collector**: records dead ends, retries, and error loops for later analysis of where the agent wastes time.

Heads whose subject is the other heads (the foreman and tuner) are covered in [Heads that manage heads](#heads-that-manage-heads).

## Design principles for good heads

1. **Orthogonality:** A good head catches things no other head catches.
2. **Against the grain:** The best heads watch what the agent naturally ignores.
3. **Actionable:** Feedback must be specific enough to act on (not "consider security").
4. **Bounded:** Clear "do NOT comment on..." prevents overlap.
5. **Short:** The head instruction is fresh input, so keep it tight. Provider-specific run-end accounting lives in [Provider lifecycle](providers.md#provider-lifecycle).

Overlap notes: Simplifier and Performance both catch redundant operations, so run one or the other; Devil's Advocate and Observability do not overlap with the five review examples.
