# Heads

A head watches with its own perspective: it sees exactly what the agent sees, judges every step, and answers with one of five decisions (noop, print, queue, steer, interrupt). A head is fully defined by one markdown file. The file carries the head's identity, its capabilities, and its instruction; there is nothing else to configure.

## Head files

```markdown
---
name: quality
description: Correctness risks, missing verification, dangerous assumptions
autostart: true
tools: []
---
Review through a QUALITY lens. Focus on correctness risks, missing
verification, dangerous assumptions, and code that looks likely to break.
Do NOT nitpick style.
```

Frontmatter keys:

| key | required | meaning |
|---|---|---|
| `name` | yes | the head's identity; what `/hydra-heads` and the `hydra` tool refer to. Files without a name are skipped with a warning. |
| `description` | yes | one line, shown in completions, the picker, and tool replies. Files without one are skipped with a warning. |
| `tools` | no | comma-separated tool names the head may execute (`tools: read, grep`). Omitted means all of the agent's tools; `tools: []` means none (the head judges, never acts). |
| `autostart` | no | `true` joins the active set at session start. Only consulted when the session has no saved head set and no `--hydra-heads` flag. |

The filename is only storage: identity comes from `name`. By convention, name the file after the head.

There is no `model` key and there cannot be one: a head replays the agent's prompt cache, and the cache is model-specific. Every head runs on the agent's model; that is what makes observation cost ~1% of what the agent paid.

## Where heads live

- `~/.pi/agent/hydra/*.md`: your heads, on every project.
- `.pi/hydra/*.md`: the project's heads, shipped with the repo.

A project head with the same name as a user head wins, like project agents and presets elsewhere in pi, so a repo can replace your generic `quality` with one that knows the codebase conventions. Project files are repo-controlled prompts and run under the same consent as everything else in `.pi/`: pi's folder trust. When hydra loads project heads it says so in the TUI, and once more when a project head shadows one of yours.

Head files are re-read at the start of every agent run and on every `hydra` tool call, so edits apply to the next observation without a reload: when a head flags too much or too little, tune the file and the very next run uses the tuned head. Duplicate names within one directory warn and keep the first file. If a file behind an active head disappears, the head is dropped from the active set with a notice, never silently.

There are no built-in heads. The [`heads/`](../heads) directory in this repo holds ready-to-use examples (the quality, security, simplifier, and api-design reviewers, plus the foreman and tuner below); copy what you want:

```bash
mkdir -p ~/.pi/agent/hydra && cp heads/*.md ~/.pi/agent/hydra/
```

Or skip the copy entirely and tell your agent what you want watched; the `hydra` tool teaches it the file format, and a head the agent writes is a file you can read, edit, and delete.

## Activating heads

The active set is session state: which heads observe right now.

- `/hydra-heads` opens a multi-select picker over every discovered head.
- `/hydra-heads quality,security` sets the active set directly; `/hydra-heads none` clears it (`none` is reserved as a head name).
- `--hydra-heads quality,security` seeds headless runs (`pi -p`).
- The agent uses the `hydra` tool to `add` or `remove` one head at a time.

Several heads observe at once: each active head gets its own observation in parallel, and each reads the agent's context from the prompt cache, so each additional head costs a cache read instead of a context rebuild.

Precedence at session start: an explicit `--hydra-heads` flag wins; otherwise a resumed session restores its saved set; otherwise the heads marked `autostart: true` form the set. Saved state never leaks across sessions; autostart is only the cold-start default.

## Tools: acting heads

By default a head may use the agent's standard tools (read, bash, edit, write, grep, find, ls) and the `hydra` tool itself, through pi's own agent loop, before it decides. Those eight are what hydra can execute; a call to anything else the agent carries (another extension's tool, MCP) returns pi's standard error result and the head moves on. A docs head updates notes while the agent works and usually ends `noop`, because its work product is the files it wrote; a research head looks something up and steers the finding in.

`tools:` narrows this. A list (`tools: read, grep`) is enforced at execution: the head's prompt states the allowance, and a call outside the list gets pi's standard unknown-tool error, costing the head one recovery turn. `tools: []` makes a judge-only head: a hard no-tools wrapper and the single-call fast path. The provider payload always advertises the agent's exact tool schemas regardless (byte parity is what keeps observations on the cache), so narrowing changes what a head can execute, never what the request looks like.

Authoring guidance for heads that act:

1. **Direct the tool use explicitly.** The wrapper permits tools; the head's instruction says when and on what. A head that only judges should carry `tools: []` and keep the single-call fast path.
2. **Say what the decision should usually be.** Acting heads typically end `noop` (the work product is their side effect), `print` (a note for you), or `steer` (a research head delivering a finding).
3. **Avoid state-mutating bash mid-run.** The head works while the agent works. File writes through write/edit serialize against the agent's own writes and are announced in the session; bash output does neither, so keep bash to reads (builds, greps, lookups) unless you accept the race.
4. **Loops are bounded.** A head that has not produced a decision after 25 model turns is wound down with a warning. There is no cost ceiling; the head's instruction is the throttle.

## Decisions: when findings land

Every observation ends in a decision. The decision names the finding's delivery: when and how it reaches the agent, if at all.

- `noop`: nothing to report. Nothing is delivered anywhere; a head that mostly noops is a quiet head, and `/hydra-stats` shows it.
- `print`: a note to you. The message renders in the TUI and never enters the agent's context. A watch-only head simply always prints.
- `queue`: the finding waits until the run ends, then joins the context of the agent's next turn.
- `steer`: the finding is injected as a real user message between turns of the current run, so the agent corrects course while still working.
- `interrupt`: the cord. The in-flight run is aborted and the finding opens the next one.

Queue against steer is a choice about timing: queue when the feedback can wait for the run to finish, steer when the agent should correct course now. Delivered to an idle session, steer and interrupt simply open the next run. There is no setting that caps any of this. When a head may pull the cord is part of its instruction: a head that should never interrupt is a head whose file says so. This holds for project heads and agent-written heads too; the file is the audit trail, and pi's folder trust is the consent boundary.

## Heads that manage heads

A head's job can be the other heads. Two ship as examples in [`heads/`](../heads):

The **foreman** reads the task and staffs the line: it infers what the session is doing, matches the active set to the phase, and re-crews at transitions. Mark it `autostart: true` and it staffs every fresh session.

```markdown
---
name: foreman
description: Matches the active heads to the work at hand
tools: hydra, read, write
---
You manage which heads observe this session. Early in the session, infer
what the work is (designing, implementing, reviewing, debugging) and staff
accordingly: add heads that fit the phase, remove ones that do not, and
write a new head file when no existing head covers a risk you see coming.
When the work shifts phase, re-crew. Print the change and the reason
whenever you re-crew; otherwise noop.
```

The **tuner** reads your reactions and maintains the head files: a head whose findings get dismissed is sharpened for every future session.

```markdown
---
name: tuner
description: Judges the other heads' findings and tunes their files
tools: read, write, edit, ls
---
You maintain the head files in ~/.pi/agent/hydra/. When the user dismisses,
contradicts, or ignores another head's finding, sharpen that head's file:
narrow its focus, add a boundary, shorten its instruction. When the user
acts on a finding, leave the head alone. Edit one head per observation at
most, and never edit your own file. Print the edit you made; otherwise
noop.
```

Their decisions deliver to you: a print renders in the TUI and never enters the agent's context, so every re-crewing and every tuning edit is visible as it happens. The tuner's file edits also get the standard write notice the agent sees; the notice records the change and carries no finding. The two combine well: a foreman can activate the tuner when a session warrants it.

## Example heads (minimal overlap)

The four review examples are designed to catch different things rather than repeat each other:

### Quality
**Focus:** correctness risks, missing verification, dangerous assumptions, obvious regressions, code that looks likely to break.
**Why:** The broadest net and the recommended default. The agent believes its own code works; this head asks what would prove it.
**Boundary:** Do not nitpick style.

### Security
**Focus:** auth, authorization, secret handling, injection risk, unsafe shelling-out, data exposure, trust boundaries.
**Why:** Auth logic flaws, leaked secrets, and unsafe shell calls are invisible to every other lens. The agent is thinking about functionality rather than attack surface.
**Boundary:** Do not comment on style or product scope.

### Simplifier
**Focus:** unnecessary complexity, abstractions that do not earn their keep, code that could be deleted, over-built solutions.
**Why:** Every other head adds requirements. This one argues for removing code instead.
**Boundary:** Do not comment on unrelated bugs or security. You argue for less, not more.

### API Design
**Focus:** contract clarity, compatibility, consistency, error shapes, naming, ergonomics.
**Why:** Consumer-facing issues are invisible from inside the code. Inconsistent response shapes, breaking changes, awkward names: the agent is thinking about the implementation rather than the contract.
**Boundary:** Do not comment on internal code structure.

## More head ideas

Ideas for heads to write yourself, grouped by the shape a head takes. The grouping is loose. Many good heads fit none of these shapes.

**Watchdog heads** judge against a standard the head file carries. Most run judge-only (`tools: []`) and stay quiet until the standard is violated:

- **Observability**: logging, monitoring, traceability, whether an incident at 3am could be diagnosed from what the code emits. Production operations rarely get attention during development.
- **Testing**: coverage gaps, untested edge cases, error handling paths. Pre-merge and complex business logic.
- **Performance**: algorithmic complexity, N+1 queries, blocking operations. Data-heavy apps; overlaps with Simplifier on redundant operations.
- **Compliance**: data retention, consent, audit trails, data minimization. Regulated industries and PII.
- **Domain Expert**: business rule accuracy, edge cases in domain logic, terminology. When correctness matters more than code quality.
- **Architecture**: structural design, coupling, layer separation. For large codebases and early design phases; overlaps with Simplifier on DRY.

**Navigator heads** judge against the task. Their yardstick lives in the session: the spec, the ask, the agreed scope.

- **Scope-keeper**: flags work nobody asked for (gold-plating, drive-by refactors, rabbit holes) and steers the run back to the ask.
- **Spec-alignment**: compares the work against the requirements as stated in the conversation. Catches quiet reinterpretation of the task.

**Caretaker heads** act through tools and usually end noop because the files they maintain are the work product:

- **Docs-keeper**: keeps a notes file current with decisions as they happen (the example in the README).
- **Changelog**: appends user-facing changes as they land, so the notes exist by release time.
- **Glossary**: maintains the project's terms as the domain language grows.

**Reporter heads** print notes for you and never write into the agent's context:

- **Narrator**: prints a running summary of a long autonomous run: what was decided and what was skipped.
- **Assumption-flagger**: prints assumptions the agent acts on without stating them.

**Red-team heads** attack the premises of the work. They are most useful during design and usually muted during execution:

- **Devil's Advocate**: challenge the entire approach. "Why this way and not another?" Zero overlap with code-level review. Do NOT comment on code-level bugs or style; think meta.
- **Threat-modeler**: attacks the design the way an adversary would, before the code exists.

**Evaluator heads** measure and never intervene. Their findings go to a file or log for later analysis:

- **Behavior-annotator**: scores each run against a rubric and appends the scores to an eval log. This is how you run live evals without full-price trajectory replay.
- **Failure-collector**: records dead ends, retries, and error loops for later analysis of where the agent wastes time.

Heads whose subject is the other heads (the foreman and tuner) are covered in [Heads that manage heads](#heads-that-manage-heads).

## Design principles for good heads

1. **Orthogonality:** A good head catches things no other head catches.
2. **Against the grain:** The best heads watch what the agent naturally ignores.
3. **Actionable:** Feedback must be specific enough to act on (not "consider security").
4. **Bounded:** Clear "do NOT comment on..." prevents overlap.
5. **Short:** The instruction is the only uncached part of each observation; keep it tight.

Overlap notes: Simplifier and Performance both catch redundant operations, so run one or the other; Devil's Advocate and Observability overlap with nothing.
