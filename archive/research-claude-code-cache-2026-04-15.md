# Mob v2 Research Session — 2026-04-15

## Context

This document captures the full research session that explored how to build a Claude Code-native version of the mob programming observer system. The session started with researching Claude Code's `/btw` command internals via the leaked source code, and progressively uncovered the architecture needed for mob v2.

## Part 1: /btw Internals (from the Claude Code Source Leak)

### The Leak

On March 31, 2026, Anthropic accidentally shipped a 59.8 MB source map file (`cli.js.map`) inside npm package `@anthropic-ai/claude-code` v2.1.88, exposing ~1,900 TypeScript files / 512K+ lines of code. The source map was pulled but mirrors proliferated.

Key mirror: `ChinaSiro/claude-code-sourcemap` — clean extraction with full TypeScript tree under `restored-src/src/`.

### /btw Architecture

**Files:**
- `src/commands/btw/index.ts` — command registration (`type: 'local-jsx'`, `immediate: true`)
- `src/commands/btw/btw.tsx` — React/Ink UI component + cache param builder
- `src/utils/sideQuestion.ts` — core logic: wraps question, calls `runForkedAgent`
- `src/utils/forkedAgent.ts` — generic forked agent infrastructure

**How it works:**
1. `/btw` is a **command** (not a tool) — operates at the UI layer, invisible to the model
2. `buildCacheSafeParams()` captures the exact system prompt / user context / system context bytes from the driver's last API call (saved by `saveCacheSafeParams()` in `stopHooks.ts`)
3. `stripInProgressAssistantMessage()` removes partial responses if driver is mid-generation
4. `runSideQuestion()` calls `runForkedAgent()` with:
   - `maxTurns: 1` — single turn only
   - `canUseTool: () => deny` — all tools blocked at permission layer (not prompt-level)
   - `querySource: 'side_question'`
   - `skipCacheWrite: true` — ephemeral, no cache entries written
5. System reminder injected in the user message (NOT the system prompt) to preserve cache key:
   - "You are a separate, lightweight agent"
   - "The main agent is NOT interrupted"
   - "You have NO tools available"
   - "NEVER say 'Let me try...'"
6. Response shown in dismissible overlay, never written to conversation history
7. Dismissed with Escape/Enter/Space — `onDone(undefined, { display: 'skip' })`

**Key design decisions:**
- Tool schemas ARE sent to the API (to match cache key) but denied at permission layer
- Thinking config is NOT overridden (it's part of cache key)
- Content replacement state is cloned (not fresh) to preserve cache key alignment
- The `CacheSafeParams` singleton is shared by `/btw`, `promptSuggestion`, and `postTurnSummary`

### Why /btw Is a Command, Not a Tool

If `/btw` were an AgentTool subagent, the main conversation would contain `tool_use` and `tool_result` blocks. The model would see its own side questions in the conversation history, consuming context and breaking the "leaves no trace" property. Commands operate at the UI layer — the model never knows `/btw` happened.

## Part 2: Comparing /btw to Mob

### Architecture Comparison

| Aspect | /btw | Mob (Codex v1) |
|--------|------|----------------|
| Fork mechanism | In-process (`runForkedAgent`) | External process (`codex fork`) |
| Context source | Live conversation messages | Terminal scrape (120 lines) |
| Tool denial | Hard (permission layer) | Soft (prompt text) |
| Cache sharing | Yes (same `CacheSafeParams`) | No (separate process) |
| Identity framing | Explicit system-reminder | Missing |
| Persistence | Ephemeral | Persistent state file |
| Delivery | Overlay UI | tmux injection |

### Gotchas from /btw That Mob Should Implement

1. **Hard tool denial** — `/btw` denies tools at the permission layer, not via prompt. The model sometimes ignores "don't use tools" in the prompt.
2. **Identity confusion framing** — prevents the model from saying "As I was saying..." when it's not the driver
3. **In-progress response stripping** — don't let the observer judge incomplete thoughts
4. **Thinking block extraction** — with adaptive thinking, the API returns thinking and text as separate messages. Old code used `.find()` which grabbed the thinking-only message.
5. **Tool call fallback** — model sometimes tries to call tools despite instructions. `/btw` has explicit handling for this.

## Part 3: Design Evolution

### The Hybrid Design (Final)

After exploring multiple approaches, we converged on:

- **TUI**: Claude Code runs normally in tmux — native Ink rendering, human types normally
- **Context**: `claude --resume $sid --fork-session --print` gives full conversation context
- **Analysis**: Observer evaluates through a lens using the fork's inherited context
- **Delivery**: tmux send-keys for queue, tmux send-keys Escape for interrupt

### Approaches Explored and Rejected

1. **SDK mode + PTY multiplexer**: Would require building a custom terminal renderer. Rejected — UX would feel different.
2. **Session file parsing**: Read the `.jsonl` conversation file directly. Rejected — `--resume --fork-session` does this for us.
3. **WebSocket/bridge injection**: Claude Code's bridge is outbound-only. IDE integration makes Claude a client, not server. No local listener exists. Rejected — architecturally impossible.
4. **Hook-based injection**: `UserPromptSubmit` hook reads from a file and injects context. Viable fallback but can't interrupt mid-turn.

### Key CLI Flags Discovered

```bash
claude --resume "$session_id" \   # Load driver's conversation
  --fork-session \                 # Create new session ID, don't mutate original
  --print \                        # Headless mode, exit after response
  --no-session-persistence \       # Don't save fork to sessions directory
  --effort low \                   # Minimal thinking for observer
  --output-format json \           # Structured output with usage stats
  -p "$observer_prompt"            # Observer's evaluation prompt
```

Verified working: fork sees full conversation, `--no-session-persistence` leaves no trace, `--fork-session` doesn't mutate the original.

### Driver Session Discovery

Sessions stored at `~/.claude/sessions/<pid>.json` with metadata:
```json
{"pid": 52471, "sessionId": "...", "cwd": "...", "kind": "interactive"}
```

Auto-detection: find session files for current cwd where `kind === "interactive"` and process is alive (`os.kill(pid, 0)`).

## Part 4: The Prompt Caching Challenge

### The Problem

Prompt cache sharing requires **byte-identical prefixes** (system prompt + tools + messages). Between separate Claude Code processes, multiple sources of non-determinism break cache sharing:

1. **System prompt prefix**: `--print` mode uses `"You are a Claude agent, built on Anthropic's Claude Agent SDK."` while interactive mode uses `"You are Claude Code, Anthropic's official CLI for Claude."` — hardcoded in `constants/system.ts:30-45`, no override exists.

2. **Tool/skill/agent ordering**: Plugins, MCP tools, skills, and agent types load in non-deterministic order between processes.

3. **Persisted-output paths**: When hook output exceeds the inline threshold, Claude Code saves it to a file with a random session UUID in the path. This path becomes part of the message content.

4. **cc_version fingerprint**: The `cch=` hash in the attribution header is computed from characters at indices 4, 7, 20 of `messages[0]` text. When message content changes (due to above issues), the hash changes, busting the system prompt cache.

### Cache Sharing Between Observer Forks (Proven)

With stripped flags (`--tools "" --strict-mcp-config --disable-slash-commands`), consecutive `--print` forks share cache at **100% hit rate**. Cost: $0.36 cold start (Opus), $0.03/epoch warm.

### Cache Sharing with Driver (The Hard Problem)

Sharing the driver's cache from a `--print` fork is impossible via CLI flags alone because:
- `isNonInteractiveSession` is hardcoded based on `--print` flag (no env var override)
- The system prompt prefix differs between modes
- No `cache_reference` mechanism exists in the API

### Community Solutions

- **`claude-code-cache-fix`** (cnighswonger): Node.js preload module that monkey-patches `globalThis.fetch` to normalize API requests. Fixes resume cache regressions. Achieves 99.7-99.9% cache hit.
- **`simpolism` gist**: Source code patcher that suppresses non-deterministic attachments.

Key limitation: `claude-code-cache-fix` requires the npm install of Claude Code (not the native Bun binary). Native binary bypasses Node.js preload.

## Part 5: The Breakthrough — Custom Fetch Preload

### Root Cause Analysis

Using `claude-code-cache-fix`'s `CACHE_FIX_PREFIXDIFF` feature and a custom fetch interceptor, we identified the exact sources of cache-busting non-determinism:

1. **Agent tool description**: Plugin agent types listed in random order within the `Agent` tool's description string
2. **Skills listing in messages**: `- skill-name: description` lines in non-deterministic order
3. **Deferred tools listing in messages**: MCP tool names in non-deterministic order
4. **Semgrep plugin SessionStart hook**: Outputs 31.6KB (duplicated content) → exceeds inline threshold → persisted to file with random UUID path

Additionally confirmed: `metadata.user_id` (containing random `session_id`) does NOT affect the cache key.

### The Fix: `/tmp/mob-fetch-fix.mjs`

A Node.js preload module (71 lines) that intercepts `globalThis.fetch` and normalizes three non-deterministic fields:

1. **Agent tool description**: Sorts agent type entries alphabetically within the "Available agent types" section
2. **Skills listing**: Sorts all `- name:` lines alphabetically
3. **Deferred tools listing**: Sorts tool name lines alphabetically

**Result: 100% cache hit rate between consecutive calls.**

```
Call 1: read=0     create=33117  cost=$0.2064  hit=0.0%    (cold)
Call 2: read=33117 create=0     cost=$0.0167  hit=100.0%  (warm)
```

### Installation

```bash
# Isolated install (no PATH collision with native claude binary)
mkdir -p ~/.mob-observer && cd ~/.mob-observer
pnpm init && pnpm add @anthropic-ai/claude-code claude-code-cache-fix

# Run claude via npm + preload
NODE_OPTIONS="--import /tmp/mob-fetch-fix.mjs" \
  node ~/.mob-observer/node_modules/@anthropic-ai/claude-code/cli.js [args...]
```

### Remaining Issue: Semgrep Plugin

The Semgrep plugin's `SessionStart` hook (`semgrep mcp -k inject-secure-defaults`) outputs the "Secure-by-Default Libraries" guidance text **twice** (duplicated content), pushing it over the inline threshold. Claude Code persists it to a file with a random UUID path, which busts the cache.

**Workaround**: Remove the `SessionStart` hook from the Semgrep plugin (the `UserPromptSubmit` hook provides the same guidance on every prompt anyway):
```bash
# Backup and patch
HOOKS="~/.claude/plugins/cache/semgrep/semgrep-plugin/0.5.1/hooks/hooks.json"
# Remove SessionStart entry from hooks.json
```

## Part 6: Resolved Questions

1. **Can the observer fork share the DRIVER's cache?** **Yes — 99.9% hit rate.** The npm/Node version of Claude Code uses the same `DEFAULT_PREFIX` for both interactive and `--print` modes (unlike the native Bun binary, which switches to `AGENT_SDK_PREFIX`). With the preload normalizing non-deterministic ordering and trailing whitespace, driver↔observer cache sharing works out of the box. Tested against a real session: 2.26M tokens read from cache, only 2.4K created.

2. **Implementation**: **Done.** `mob-observer.sh` (839 lines) implements the full observer: session discovery, fork execution, JSON parsing with fallback extraction, tmux delivery, state management, dedup/cooldown. See `mob/README.md`.

3. **TDD**: Not yet done. The testable layers remain:
   - Observer prompt builder (lens + /btw-style framing)
   - Response parser (JSON extraction, edge cases)
   - Decision router (noop/queue/interrupt → delivery)
   - Cache preload (the fetch interceptor)

4. **Native binary support**: Still open. The preload only works with the npm install. Options:
   - Building a Claude Code plugin instead
   - Using mitmproxy as an alternative capture mechanism
   - Patching the Bun binary directly (fragile)

## Files Created This Session

| File | Purpose |
|------|---------|
| `mob/mob-cache-fix.mjs` | Fetch preload that normalizes non-deterministic fields for cache sharing (originally `/tmp/mob-fetch-fix.mjs`) |
| `mob/mob-observer.sh` | Claude Code v2 observer — full implementation |
| `~/.mob-observer/package.json` | Dependencies: @anthropic-ai/claude-code, claude-code-cache-fix |
| `/tmp/claude-code-sourcemap/` | Cloned leaked source (temporary) |

## Key Metrics

| Scenario | Cache Hit | Cost (Opus) |
|----------|-----------|-------------|
| Stripped fork, cold | 0% | $0.36 |
| Stripped fork, warm | 100% | $0.03 |
| Full fork (no fix), consecutive | 0% | $0.21 |
| Full fork (with preload fix), cold | 0% | $0.21 |
| Full fork (with preload fix), warm | 100% | $0.017 |
| Driver↔observer (npm+preload), warm | 99.9% | $0.017 |
| Haiku (any), warm | 100% | $0.008 |

## Key Insight

The entire prompt caching problem boils down to **non-deterministic ordering** of dynamically loaded components (plugins, MCP tools, skills, agent types). The fix is trivially simple — sort the lists before sending to the API. But finding the exact sources required binary-level request interception and byte-by-byte diffing of API payloads.
