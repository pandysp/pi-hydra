# Heads

A head is a helper that checks the main assistant's work. It can report a finding or say nothing. Each head has one Markdown file with its name, allowed tools and instructions. The session records which heads are active. If a head is busy, Hydra keeps only the newest waiting copy of the conversation for its next check.

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
| `tools` | no | comma-separated tool names the head may execute (`tools: read, grep`). Omitted means every standard tool hydra can execute; `tools: []` means none (the head judges, never acts). |
| `autostart` | no | `true` joins the active set at session start; `false` is the same as leaving it out. Any other value makes the file invalid. Only consulted when the session has no saved head set and no `--hydra-heads` flag. |

The filename is only storage: identity comes from `name`. By convention, name the file after the head.

There is no supported `model` key: a head replays the agent's provider context, and prompt caches are model-specific. Every head runs on the agent's model. Matching the model is required for cache reuse—though provider timing and session routing still determine the actual hit—and is why a head cannot be assigned a stronger model than the driver's.

## Where heads live

- `~/.pi/agent/hydra/*.md`: your heads, on every project.
- `.pi/hydra/*.md`: the project's heads, shipped with the repo.

A project head with the same name as a user head wins, like project agents and presets elsewhere in pi, so a repo can replace your generic `quality` with one that knows the codebase conventions. Project files are repo-controlled prompts and run under the same consent as everything else in `.pi/`: pi's folder trust. When hydra loads project heads it says so in the TUI, and once more when a project head shadows one of yours.

Head files are re-read at the start of every agent run and on every `hydra` tool call. Changes apply to observations scheduled after that discovery point without reloading Pi: tune a noisy head before the next run, or follow a write with a `hydra` call when it must take effect during the current run. Duplicate names within one directory warn and keep the first file. If a file behind an active head disappears, the head is dropped from the active set with a notice, never silently.

There are no built-in product heads; the extension has only hidden one-shot diagnostics for delivery smoke tests. The [`heads/`](../heads) directory in this repo holds ready-to-use examples (the quality, security, simplifier, api-design, and navigator reviewers, plus the foreman and tuner below); copy what you want:

```bash
mkdir -p ~/.pi/agent/hydra && cp ~/.pi/agent/git/github.com/pandysp/pi-hydra/heads/*.md ~/.pi/agent/hydra/
```

(That path is where `pi install` keeps the clone; from your own checkout, `cp heads/*.md ~/.pi/agent/hydra/`.)

Or skip the copy entirely and tell your agent what you want watched; the `hydra` tool teaches it the file format, and a head the agent writes is a file you can read, edit, and delete.

## Activating heads

The active set is session state: which heads observe right now.

- `/hydra-heads` opens a multi-select picker over every discovered head.
- `/hydra-heads quality,security` sets the active set directly; `/hydra-heads none` clears it (a head cannot be named `none`; the command uses it to mean clear).
- `--hydra-heads quality,security` seeds headless runs (`pi -p`).
- The agent uses `hydra` with `action: "manage_heads"` to add or remove one head at a time.

Several heads observe at once: each active head gets its own observation in parallel and reuses the agent's cached context instead of rebuilding it. Multiple heads still add material, provider-dependent session cost; see [Economics and measurements](providers.md#economics-and-measurements).

Precedence at session start: an explicit `--hydra-heads` flag wins; otherwise a resumed session restores its saved set; otherwise the heads marked `autostart: true` form the set. Saved state never leaks across sessions; autostart is only the cold-start default.

## Tools: acting heads

By default a head may use the agent's standard tools (read, bash, edit, write, grep, find, ls) and the `hydra` tool itself, through pi's own agent loop, before it completes. Those eight are the only tools Hydra can run; other extensions' tools and MCP tools are not supported. A docs head updates notes while the agent works and usually completes with `none`, because its work product is the files it wrote; a research head looks something up and steers the finding in.

`tools:` limits what a head can run. For example, `tools: read, grep` allows only those tools; `tools: []` allows none. `grep`, `find` and `ls` let a head search without `bash`, which can run any command. See [Failed checks](architecture.md#failed-checks) for errors, retries and notices.

A head can use `manage_heads` only if `tools` is omitted or includes `hydra`. Its request still contains the main assistant's original tool definitions so that cache reuse remains possible. These definitions do not grant permission to run those tools. The reverse also holds: a tool the head may use but the main assistant lacks (`grep`, `find` and `ls` are off by default in Pi) has no definition there, so the head knows it only by name. See [Completion channels](providers.md#completion-channels) for how each provider accepts the final answer.

Authoring guidance for heads that act:

1. **Say what to do.** State the head's purpose, when it should act, what work to do, how to know it is done, and who needs the result. `PURPOSE / ACT WHEN / WORK / DONE WHEN / DELIVER` is a useful outline, not special syntax. Prefer clear rules over a growing list of exceptions.
2. **Report what the main assistant needs, not routine work.** Hydra does not announce a head's writes; each acting head is told to report changes the main assistant needs to know about and to keep routine notes, logs or scores to itself.
3. **Prefer write/edit over bash for file changes.** Pi coordinates `write` and `edit` calls from the head and main assistant. Bash changes bypass that protection. Use bash only to read files unless you accept that risk.
4. **No turn or cost limit.** Hydra does not stop a head just because it has made a set number of model or tool calls. Model-call counts and cost are shown in `/hydra-stats`. Finishing the check, turning the head off, closing the session, or unsafe cache sharing still stops it. Provider and tool limits still apply.

When a head uses `manage_heads` to change the active heads, Hydra steers what changed and the head's explanation to the main assistant, as that head. Failed calls and calls that change nothing send nothing. A head whose `tools` list includes `hydra` also sees the active heads when its check starts; later tool results may show a newer list.

## Decisions: when findings land

A head with tools must finish its checks and tool work before reporting. See [Completion channels](providers.md#completion-channels) for how to finish on each provider.

A head without tools returns one JSON object:

```json
{"findings":[{"action":"print|steer|interrupt","reason":"≤120 chars","message":"≤240 chars"}]}
```

This head's instructions define what to check and how much to report. Return one entry per finding, or an empty array if there are none. Support each finding with a short quote or exact reference. If evidence is missing, say what is missing. A quote lets someone check the finding; it does not prove the finding is right.

Choose an action for each finding:

- `print` when only the user needs the note.
- `steer` when the main assistant needs the feedback, even if it can wait.
- `interrupt` for an emergency that must stop the run.

The head's instructions decide when it may interrupt. Say so explicitly if it must never interrupt.

See [Delivery](architecture.md#delivery) for how Hydra groups findings, handles old checks, and delivers messages during work, idle time and shutdown.

Use `none` only when finishing through the `hydra` tool with nothing to report. Heads using the findings JSON instead return an empty array; `none` is not a valid finding action. Invalid answers follow the [failed-check rules](architecture.md#failed-checks).

The main assistant may have moved on while the head was checking. Do not repeat its plan or doubts, or suggest work it already plans to do unless the plan itself is the problem. Do not repeat feedback still waiting for delivery or a problem that is fixed. Follow up only with evidence that the problem still applies after checking the visible response, or with new evidence that changes the finding. A problem that remains does not prove the feedback was ignored.

## Heads that manage heads

A head's job can be the other heads. Two ship as examples in [`heads/`](../heads):

The **foreman** reads the task and staffs the line: it infers what the session is doing, matches the active set to the phase, and re-crews at transitions. Marking it `autostart: true` makes it part of the cold-start set when no explicit flag or saved session set takes precedence.

```markdown
---
name: foreman
description: Matches the active heads to the work at hand
tools: hydra, read, write
---
PURPOSE: Keep the active heads matched to the work at hand.
ACT WHEN: The current phase or risks are not fully covered by the active heads.
WORK: Add fitting heads, remove irrelevant heads, and write then activate a new
head when no existing head covers a current risk.
DONE WHEN: The active heads cover every current phase and risk without
irrelevant heads.
DELIVER: Explain each crew change in manage_heads.
Otherwise complete with none.
```

The **tuner** reads your reactions and maintains the head files: a head whose findings get dismissed is sharpened for every future session.

```markdown
---
name: tuner
description: Judges the other heads' findings and tunes their files
tools: read, write, edit, ls
---
PURPOSE: Maintain the other head files in ~/.pi/agent/hydra/ from the user's
reactions to their findings.
ACT WHEN: The user dismisses, contradicts, or ignores another head's finding.
WORK: Sharpen that head's file by narrowing its focus, adding a boundary, or
shortening its instruction. Edit at most one head and never your own.
DONE WHEN: The edited head excludes the kind of finding the user rejected.
DELIVER: Print the edit you made; complete with none when the act condition is
not met.
```

The examples use the [management rules](#tools-acting-heads) described above. A foreman can activate the tuner when needed.

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
**Boundary:** Do not comment on the code itself. Steer at the level of the goal; interrupt only when the whole direction is wrong.

## More head ideas

Ideas for heads to write yourself, grouped by the shape a head takes. The grouping is loose. Many good heads fit none of these shapes.

**Watchdog heads** judge against a standard the head file carries. Most run judge-only (`tools: []`) and stay quiet until the standard is violated:

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

**Reporter heads** print notes for you and never write into the agent's context:

- **Narrator**: prints a running summary of a long autonomous run: what was decided and what was skipped.
- **Assumption-flagger**: prints assumptions the agent acts on without stating them.

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
