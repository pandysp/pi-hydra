# Navigator Lenses — Reference

## Recommended Default Set (3 lenses, minimal overlap)

### 1. Security
**Lens:** authentication, authorization, injection, data exposure, input validation, cryptographic choices.
**Why:** Catches things nobody else sees. Auth logic flaws, IDORs, weak crypto. The driver is thinking about functionality, not attack surface.
**Boundary:** Do NOT comment on code structure or test coverage.

### 2. Simplifier
**Lens:** unnecessary complexity, over-engineering, code that could be deleted, abstractions that don't earn their keep, redundant operations.
**Why:** Every other lens adds requirements. This one removes them. Argues for LESS code, which is rare and valuable. Catches DRY violations, redundant queries, dead code.
**Boundary:** Do NOT comment on bugs, security, or missing features. You argue for less, not more.

### 3. API Design
**Lens:** REST conventions, response consistency, status codes, error format, API ergonomics, backward compatibility.
**Why:** Consumer-facing issues are invisible from inside the code. PUT vs PATCH, inconsistent response shapes, missing pagination — the driver doesn't notice because they're thinking about implementation, not the contract.
**Boundary:** Do NOT comment on internal implementation, security, or testing.

## Extended Set (add for complex projects)

### 4. Devil's Advocate
**Lens:** challenge the entire approach. "Why this way and not another?" Question assumptions. Prevent sunk cost fallacy.
**Why:** Zero overlap with code-level review. Asks strategic questions: should we build this at all? Is SQLite the right choice? Are we solving the right problem?
**Boundary:** Do NOT comment on code-level bugs or style. Think meta.

### 5. Observability
**Lens:** logging, monitoring, debugging in production, traceability, metrics, health checks. "Can you diagnose this at 3am?"
**Why:** Nobody thinks about production operations during development. Missing request IDs, no structured logging, silent failures — all invisible until the pager goes off.
**Boundary:** Do NOT comment on code structure, security, or testing.

## Situational Lenses

### Architecture
**When:** Large codebases, multi-service systems, early design phases.
**Lens:** structural design, coupling, SOLID, layer separation.
**Overlap risk:** Medium — overlaps with Simplifier on DRY, with Performance on design choices.

### Testing
**When:** Pre-merge, complex business logic.
**Lens:** coverage gaps, untested edge cases, error handling paths.
**Overlap risk:** High with Error Handling. Pick one, not both.

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
