# Lenses

A lens is what a hydra head looks through: a focused review perspective with explicit boundaries, so multiple heads catch different things instead of repeating each other. Four ship as built-in lenses (`/hydra-lens`): quality, security, simplifier, and api-design. The rest are reference designs you can turn into custom lenses.

## Custom lenses

Drop a markdown file into `~/.pi/agent/hydra/lenses/`; the filename is the lens name, an optional frontmatter `description:` labels it in completions, and the body is the lens instruction:

```markdown
---
description: Flags wordy or repetitive agent output
---
Review through a BREVITY lens. Focus on verbose responses, repeated
explanations, and output the user did not ask for. Do not comment on
code correctness or style.
```

Custom lenses appear in `/hydra-lens` completions and work with `--hydra-lens`. A custom lens may override a built-in by using its name (the diagnostic lenses are not overridable). Lens files are re-read at the start of every agent run, so editing one applies to the next run without a reload: when a head flags too much or too little, tell the agent to tune the lens file, and the very next observation uses the tuned lens. The agent can also manage lenses itself through the `hydra` tool (write, remove, switch the active set); a lens it writes applies immediately, mid-run. Keep the instruction shaped like the built-ins below: one focus, explicit boundaries, and short, since the lens text is the only uncached part of each observation.

Several lenses observe at once: `/hydra-lens quality,security` fans out one head per lens in parallel. A set is any number of product lenses, or exactly one diagnostic lens; the two never mix.

## Acting lenses

A custom lens with `tools: true` in its frontmatter is an acting head: before its verdict, it may run the agent's own tools (read, bash, edit, write, grep, find, ls, and the `hydra` tool itself) through pi's agent loop. The built-ins stay verdict-only; acting is always a deliberate choice per lens.

```markdown
---
description: Keeps docs/notes.md current with decisions as they happen
tools: true
---
You maintain docs/notes.md. When the conversation contains a decision,
constraint, or surprise not yet in the file, read it, add the missing
entry, and keep entries one line each. Your verdict is usually noop:
the file is your work product. Do not edit anything else.
```

Authoring guidance, on top of the design principles below:

1. **Direct the tool use explicitly.** The wrapper permits tools; the lens says when and on what. A lens that only judges should stay `tools: false` and keep the snappy verdict path.
2. **Say what the verdict should usually be.** Acting heads typically end `noop` (the work product is their side effect) or `steer` (a research head delivering a finding).
3. **Avoid state-mutating bash mid-run.** The observer works while the agent works. File writes through write/edit serialize against the agent's own writes and are announced in the session; bash output does neither, so keep bash to reads (builds, greps, lookups) unless you accept the race.
4. **Loops are bounded, not budgeted.** A head that has not produced a verdict after 25 model turns is wound down with a warning. There is no cost ceiling; the lens text is the throttle.

## Built-in Lenses (minimal overlap)

### 1. Quality
**Lens:** correctness risks, missing verification, dangerous assumptions, obvious regressions, code that looks likely to break.
**Why:** The broadest net, and hydra's default. The driver believes its own code works; this lens asks what would prove it.
**Boundary:** Do NOT nitpick style.

### 2. Security
**Lens:** authentication, authorization, injection, data exposure, input validation, cryptographic choices.
**Why:** Catches things nobody else sees. Auth logic flaws, IDORs, weak crypto. The driver is thinking about functionality, not attack surface.
**Boundary:** Do NOT comment on code structure or test coverage.

### 3. Simplifier
**Lens:** unnecessary complexity, over-engineering, code that could be deleted, abstractions that don't earn their keep, redundant operations.
**Why:** Every other lens adds requirements. This one removes them. Argues for LESS code, which is rare and valuable. Catches DRY violations, redundant queries, dead code.
**Boundary:** Do NOT comment on bugs, security, or missing features. You argue for less, not more.

### 4. API Design
**Lens:** REST conventions, response consistency, status codes, error format, API ergonomics, backward compatibility.
**Why:** Consumer-facing issues are invisible from inside the code. PUT vs PATCH, inconsistent response shapes, missing pagination: the driver doesn't notice because they're thinking about implementation, not the contract.
**Boundary:** Do NOT comment on internal implementation, security, or testing.

## Extended Set (reference designs, add for complex projects)

### 5. Devil's Advocate
**Lens:** challenge the entire approach. "Why this way and not another?" Question assumptions. Prevent sunk cost fallacy.
**Why:** Zero overlap with code-level review. Asks strategic questions: should we build this at all? Is SQLite the right choice? Are we solving the right problem?
**Boundary:** Do NOT comment on code-level bugs or style. Think meta.

### 6. Observability
**Lens:** logging, monitoring, debugging in production, traceability, metrics, health checks. "Can you diagnose this at 3am?"
**Why:** Nobody thinks about production operations during development. Missing request IDs, no structured logging, silent failures: all invisible until the pager goes off.
**Boundary:** Do NOT comment on code structure, security, or testing.

## Situational Lenses

### Architecture
**When:** Large codebases, multi-service systems, early design phases.
**Lens:** structural design, coupling, SOLID, layer separation.
**Overlap risk:** Medium; overlaps with Simplifier on DRY, with Performance on design choices.

### Testing
**When:** Pre-merge, complex business logic.
**Lens:** coverage gaps, untested edge cases, error handling paths.
**Overlap risk:** High with Error Handling; pick one, not both.

### Performance
**When:** Data-heavy apps, high-traffic APIs, known scaling concerns.
**Lens:** algorithmic complexity, N+1 queries, pagination, blocking operations.
**Overlap risk:** Medium with Simplifier (both catch redundant queries).

### Compliance
**When:** Regulated industries, handling PII, EU AI Act, GDPR.
**Lens:** data retention, consent, audit trails, right to deletion, data minimization.

### Domain Expert
**When:** Complex business logic where correctness matters more than code quality.
**Lens:** business rule accuracy, edge cases in domain logic, terminology.

## Design Principles for Good Lenses

1. **Orthogonality:** A good lens catches things no other lens catches
2. **Counter-driver:** The best lenses think about what the driver naturally ignores
3. **Actionable:** Feedback must be specific enough to act on (not "consider security")
4. **Bounded:** Clear "do NOT comment on..." prevents overlap
5. **Testable:** Can you verify the lens works by running it on sample code?

## Overlap Rules

- Never run Testing + Error Handling together (>50% overlap)
- Simplifier + Performance overlap on redundant operations (~20%)
- Architecture + Security overlap on "design for security" (~10%)
- Devil's Advocate overlaps with nothing (meta-level)
- Observability overlaps with nothing (operations-level)
