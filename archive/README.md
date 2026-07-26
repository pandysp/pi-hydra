# Archive: the original andon

Everything in this directory is the project [pi-hydra](../README.md) grew out of: a bash and tmux observer system around Claude Code, plus a codex variant, kept verbatim for the record. None of it is maintained. The living implementation is the pi extension at the repo root.

Contents: `andon-observer.sh` (the observer loop), `andon-cache-fix.mjs` (the fetch patch that bought cache parity with Claude Code), `cache-debug.sh`, `codex-companion.sh` (the codex experiment), `fork-per-epoch-plan.md` (planning notes), and `research-claude-code-cache-2026-04-15.md` (the research session that started it all). The original README follows unchanged.

---

> Everything below this line is the original andon README, reproduced as it stood in April 2026.
> Andon has been retired and replaced by pi-hydra. The commands below drive that old system, not
> this one. For the current project see [../README.md](../README.md).

# Andon

> Pull the cord on bad AI code — real-time observers for AI coding sessions.

## Why

AI coding sessions have no production line. The agent writes code, you review it afterward, maybe run `/simplify`, maybe catch a bad assumption during PR review. Mistakes compound silently during implementation and get expensive to fix later.

This is the same problem manufacturing solved decades ago. Toyota's insight: build quality INTO the process, don't inspect it in at the end. Their tools — jidoka (stop the line when something's wrong), the Andon cord (any worker can halt production), poka-yoke (make mistakes impossible by design) — all follow one principle: **catching a defect at the source is orders of magnitude cheaper than catching it at final inspection.**

Software development has been rediscovering this under the banner of "shift left" — move testing, security, and review earlier in the pipeline. We already shift left significantly by spending most effort in exploration and design, so that code falls off as an artifact. The mob observer pushes this one step further: **dissolve review INTO implementation.** Review doesn't happen after coding; it happens during coding, continuously.

## What

One driver codes. Multiple observers watch — each through a specialized lens (quality, security, simplifier, API design). They see the full conversation context and decide on every turn: stay quiet, queue feedback, or pull the Andon cord.

```
Driver (interactive)          Observers (headless forks)
┌────────────────────┐        ┌──────────────┐
│ Human + Claude Code │◄──────│ quality lens  │  noop / queue / interrupt
│ writing code        │       └──────────────┘
│                     │       ┌──────────────┐
│                     │◄──────│ security lens │  noop / queue / interrupt
│                     │       └──────────────┘
│                     │       ┌──────────────┐
│                     │◄──────│ simplifier   │  noop / queue / interrupt
└────────────────────┘       └──────────────┘
```

Each observer fork is stateless — it gets the driver's full conversation, makes one judgment call as JSON, then exits. Practical memory (queue, dedup, recent decisions) lives in a local state file.

## Why It's Not Crazy Expensive

Running multiple observers that mostly say "noop" sounds wasteful. It's actually cheap, for two reasons:

**1. Prompt cache sharing (~98% hit rate)**

The Anthropic API caches repeated prompt prefixes. If the observer sends the same system prompt, tools, and conversation history as the driver, it only pays for the new tokens — the observer's own prompt and the model's short JSON response. In practice: **~$0.02 per observation instead of ~$0.20.** An observer polling every conversation change costs roughly 2% of what the driver costs.

Achieving this required significant reverse-engineering of Claude Code's prompt construction pipeline (see [Cache Economics](#cache-economics) below), because interactive and headless modes produce subtly different API requests. Different bytes = different cache = full price.

**2. Shift-left economics**

A bad assumption caught mid-implementation costs one correction message. The same assumption caught during review costs a refactor. Caught in production, it costs an incident. The observer doesn't need to catch many mistakes to pay for itself — the asymmetry between early and late detection is enormous.

## The Bigger Vision

The current observer flags issues for the human to fix. But the real potential is in **self-improving development** — Toyota's kaizen applied to AI coding:

- **Poka-yoke observers** — instead of just flagging a recurring mistake, update CLAUDE.md or create a skill that makes the mistake impossible in future sessions. Fix the production line, not just the current car.
- **Task-specific mobs** — different work needs different observers. Feature development might run quality + architecture lenses. Bug fixing runs regression + root-cause. Infrastructure runs security + reliability. The mob composition becomes part of the workflow definition.
- **Pipeline-aware observers** — a structured development workflow (explore → design → plan → implement → verify → simplify → reflect) has different quality concerns at each phase. Observers could adapt their lens to the current phase.

---

## Implementation: Claude Code (v2) — `andon-observer.sh`

### Prerequisites

1. **npm Claude Code install** (isolated from the native binary):
   ```bash
   mkdir -p ~/.andon-observer && cd ~/.andon-observer
   pnpm init && pnpm add @anthropic-ai/claude-code
   ```

2. **tmux** — driver runs in a tmux session, observer runs in another terminal.

3. **Cache preload** — `andon-cache-fix.mjs` normalizes the API request prefix so driver and observer share the same prompt cache. Both driver and observer must load it via `NODE_OPTIONS`.

4. **Driver config** — two settings required for cache sharing:
   - `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` — match thinking config between interactive and --print
   - Disable Claude in Chrome via `/config` globally — removes MCP-dependent prompt section that --print doesn't have

### Quick Start

Start the driver in tmux via the npm install with the required env vars:

```bash
cd /your/project
tmux new-session -s andon \
  'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1 \
   NODE_OPTIONS="--import $(pwd)/andon-cache-fix.mjs" \
   ANDON_DUMP_PATH=/tmp/andon-drv.json \
   node ~/.andon-observer/node_modules/@anthropic-ai/claude-code/cli.js \
   --dangerously-skip-permissions'
```

Note the bridge session ID from Claude Code's greeting line (requires `/remote-control` enabled via `/config` globally or in the session):
```
Code in CLI or at https://claude.ai/code/session_XXXXX
```

Do some work in the driver. Then in another terminal:

```bash
cd /your/project
ANDON_DUMP_PATH=/tmp/andon-obs.json \
  ./andon-observer.sh andon session_XXXXX --lens quality
```

`ANDON_DUMP_PATH` is optional on both sides — captures the final API request body for cache debugging. Compare with `diff <(jq '.system' /tmp/andon-drv.json) <(jq '.system' /tmp/andon-obs.json)`.

### Usage

```
./andon-observer.sh <tmux-session> <bridge-session-id> [options]

Arguments:
  tmux-session               Name of the tmux session running Claude Code
  bridge-session-id          Bridge session ID from Claude Code greeting
                             (e.g. session_01BEJEX6VP6NVN6xPDzaRzBa)

Options:
  --lens NAME                  quality | security | simplifier | api-design
  --delivery MODE              queue | interrupt | print
  --poll-interval SECONDS      Default: 4
  --cooldown-seconds N         Default: 0
  --full-access                Give observer full tool access (read files, run commands)
```

### How It Works

1. Resolves the bridge session ID to an internal session UUID by scanning `~/.claude/sessions/*.json`.
2. Waits for the session to become active (JSONL conversation file appears after first message).
3. Creates a headless fork: `claude --resume <sid> --fork-session --print --no-session-persistence --output-format json`
4. The fork inherits the driver's full conversation context — no terminal scraping needed.
5. Model and effort level are inherited from the driver via `--resume`. Overriding either breaks cache sharing.
6. Observer prompt uses `/btw`-style `<system-reminder>` framing to prevent identity confusion.
7. Response is parsed as JSON (`{"action":"noop|queue|interrupt", "reason":"...", "message":"..."}`).
8. Recent decisions (last 3) are injected into the prompt so the observer doesn't repeat itself.
9. Polls for conversation changes via JSONL mtime — only forks when the driver's conversation actually changes.

### Cache Economics

The observer shares the driver's prompt cache via `andon-cache-fix.mjs`, a standalone fetch interceptor loaded on both sides via `NODE_OPTIONS`. No npm cache-fix package dependency (see [Reference](#cache-reference) below).

The preload normalizes 8 differences between interactive (driver) and `--print` (observer) mode so their API requests produce byte-identical prefixes:

| # | Fix | Direction | What diverges |
|---|-----|-----------|---------------|
| 1 | Entrypoint `cli` → `sdk-cli` | Down | Billing header |
| 2 | Identity "Claude Code" → "Agent SDK" | Down | System prompt identity |
| 3 | `TodoWrite` → `TaskCreate` | Up | Tool name in instructions |
| 4 | Strip `! <command>` tip | Down | Interactive-only system prompt line |
| 5 | Strip `claude-code-guide` agent | Down | Interactive-only agent type |
| 6 | Sort agent types | Neutral | Non-deterministic plugin ordering |
| 7 | Strip `gitStatus` | Strip | Memoized at process start, diverges after any git activity |
| 8 | Strip `<system-reminder>` from tool_results | Strip | Runtime injections not persisted to JSONL |

"Down" = normalize driver to match observer's natural `--print` values. "Up" = normalize observer to match driver's value. "Strip" = remove from both sides — content is volatile or not persisted, so neither side can reliably match it. These are hacks; the [capture approach](#cache--planned-refactor) should eliminate the need for all of them.

Two env-level requirements on the driver:
- `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` — thinking config is part of the cache key; interactive uses `{"type":"adaptive"}`, `--print` uses `{"budget_tokens":63999,"type":"enabled"}`.
- Disable Claude in Chrome via `/config` — removes a ~3.5KB Chrome automation section from the system prompt that `--print` mode doesn't include.

**Observed hit rate: 98%** (~32K tokens cached, ~600 tokens uncached = observer's own prompt + driver's response from conversation history).

### Cache — Planned Refactor

The normalization approach works but is fragile — a game of whack-a-mole. Fixes 7-8 were discovered during live testing when cache hit rate dropped unexpectedly. Each CC update or runtime behavior change can introduce new divergences requiring new regex fixes.

The principled fix is to serialize the driver's exact API request to disk after each call and have the observer read it — the same approach CC uses internally for `/btw`. Key source files in the leaked CC codebase (v2.1.88, `src/`):
- `utils/forkedAgent.ts` — `CacheSafeParams` type, `saveCacheSafeParams()` / `getLastCacheSafeParams()` singleton, `runForkedAgent()` query loop
- `utils/sideQuestion.ts` — `runSideQuestion()` wraps forkedAgent with tool denial and single-turn cap
- `commands/btw/btw.tsx` — `buildCacheSafeParams()` reads the saved params or rebuilds from scratch as fallback
- `constants/prompts.ts:368` — `getIsNonInteractiveSession()` gate for interactive-only prompt content

Plan:
1. Driver preload writes `{ system, tools, thinking, model, messages }` to `$STATE_DIR/driver-prefix.json` after each API call (already has the fetch hook via `ANDON_DUMP_PATH`).
2. Observer preload reads this file and replaces its own request with the driver's exact bytes (system, tools, thinking, model, and message prefix up to the fork point).
3. In theory, no normalization needed — byte-identical by construction, version-independent. Should eliminate all 8 current fixes plus any future divergences. Not yet validated.

### Cache Reference

The community `claude-code-cache-fix` npm package (`~/.andon-observer/node_modules/claude-code-cache-fix/preload.mjs`) solves related cache bugs for general Claude Code usage. We investigated it during development and decided to own the normalization code instead, because its "pick latest block" heuristic for resume relocation actively harmed the fork scenario (replaced a correct messages[0] deferred tools block with a degraded one from the fork). It remains installed for reference — useful for understanding CC's internal cache structure.

### Known Limitations

- **SessionStart hooks bust the cache.** Any `SessionStart` hooks inject content into the first user message that the fork doesn't reproduce. Disable SessionStart hooks for the driver session.
- **Driver loses minor features** due to normalization: the `! <command>` tip, `claude-code-guide` subagent, and `gitStatus` overview are stripped. Low-impact for expert users (model can run `git status` via Bash).
- **Claude in Chrome must be disabled** on the driver — its ~3.5KB system prompt section has no `--print` equivalent.
- **Observer may ignore tool restrictions.** The prompt says tools are blocked, but the model can see tools in its context and sometimes uses them anyway. `--full-access` leans into this; without it, tool calls fail on permissions.
- **`recent_decisions` state can create hallucination loops.** The observer fabricated a driver quote, persisted it in state, then built on it in subsequent epochs. Clear state file between test runs.
- `queue` mode is the safe default; `interrupt` is experimental.
- The observer reacts to its own injections (one extra epoch per delivery, usually noop).

State is persisted under:
```
${XDG_STATE_HOME:-$HOME/.local/state}/andon-observer/
```

## Experimental: Codex — `codex-companion.sh`

> **Highly experimental.** Same fork-per-epoch idea targeting OpenAI's Codex CLI instead of Claude Code. Included to show the approach is model-agnostic, but this has not been thoroughly tested and may not work reliably.

```bash
./codex-companion.sh start mob
tmux attach -t mob
# Do some work, then in another terminal:
./codex-companion.sh observe mob --continuous --lens quality
```

## Lenses

See [`lenses.md`](lenses.md) for the full lens reference. Available lenses: `quality`, `security`, `simplifier`, `api-design`.

## Architecture

The fork-per-epoch design is documented in [`fork-per-epoch-plan.md`](fork-per-epoch-plan.md). Deep research into Claude Code internals (prompt caching, `/btw` architecture, cache-fix preload) is in [`research-claude-code-cache-2026-04-15.md`](research-claude-code-cache-2026-04-15.md).

## History

Originally developed as "mob-observer" inside a private workspace. The fork-per-epoch design replaced an earlier long-lived-session prototype that suffered from context window bloat. Open-sourced as "andon" to share the approach and the cache engineering work.
