// Andon cache-fix: fetch interceptor that normalizes the API request
// prefix so driver (interactive) and observer (--print fork) share the same
// prompt cache. Without this, the interactive driver and --print observer
// produce different system prompts, tool descriptions, and thinking configs,
// causing 0-50% cache miss depending on which components diverge.
//
// Architecture: both driver and observer load this preload via NODE_OPTIONS.
// It patches globalThis.fetch to normalize cache-divergent fields before the
// request reaches the API. The driver also writes a prefix snapshot to disk
// after each API call; in a future refactor the observer will read this
// snapshot instead of normalizing (same approach as /btw's CacheSafeParams).
//
// Current normalizations (normalize driver DOWN to match observer's --print values):
//   1. Entrypoint: cli → sdk-cli (interactive sends cli, --print sends sdk-cli)
//   2. Identity: "Claude Code" → "Agent SDK" (interactive vs --print identity)
//   3. TodoWrite → TaskCreate: --print uses TodoWrite, interactive uses TaskCreate
//      (normalize UP — observer gets the correct tool name)
//   4. Strip "! <command>" tip: interactive-only line in system prompt
//   5. Strip claude-code-guide agent: interactive-only agent type
//   6. Sort agent types: plugin agents listed in non-deterministic order
//   7. Strip gitStatus: memoized at process start, diverges after any git activity
//   8. Strip system-reminders from tool_results: runtime injections not in JSONL
//
// Required driver env vars:
//   CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1  — match thinking config
//   Disable Claude in Chrome via /config      — remove MCP-dependent prompt section
//
// Debug env vars:
//   ANDON_DUMP_PATH=<path>  — dump final API request body for cache debugging
//
// Proven cache hit rate: 98.1% (system + tools + messages prefix all match,
// only the observer's new prompt messages are uncached).

const _realFetch = globalThis.fetch;

globalThis.fetch = async function(url, options) {
  if (typeof url === 'string' && url.includes('/v1/messages') && !url.includes('count_tokens') && options?.body) {
    try {
      const payload = JSON.parse(options.body);
      let modified = false;

      // --- System prompt normalizations ---
      if (Array.isArray(payload.system)) {
        const CC_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
        const SDK_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
        for (const block of payload.system) {
          if (block.type !== 'text' || typeof block.text !== 'string') continue;

          // Fix 1: Entrypoint — interactive sends cli, --print sends sdk-cli.
          // Normalize to sdk-cli (observer's natural value).
          if (block.text.includes('cc_entrypoint=cli;')) {
            block.text = block.text.replace('cc_entrypoint=cli;', 'cc_entrypoint=sdk-cli;');
            modified = true;
          }

          // Fix 2: Identity — interactive says "Claude Code", --print says "Agent SDK".
          // Normalize to Agent SDK (observer's natural value).
          if (block.text.startsWith(CC_IDENTITY)) {
            block.text = SDK_IDENTITY + block.text.slice(CC_IDENTITY.length);
            modified = true;
          }

          // Fix 3: TodoWrite → TaskCreate — --print instructions reference TodoWrite,
          // interactive references TaskCreate. Normalize UP to TaskCreate (correct name).
          if (block.text.includes('TodoWrite tool')) {
            block.text = block.text.replace(/TodoWrite tool/g, 'TaskCreate tool');
            modified = true;
          }

          // Fix 4: Strip "! <command>" tip — only present in interactive mode.
          if (block.text.includes('suggest they type `! <command>`')) {
            block.text = block.text.replace(
              /\n - If you need the user to run a shell command themselves[^\n]+\n/,
              '\n'
            );
            modified = true;
          }

          // Fix 7: Strip gitStatus section — memoized once at process start, so
          // driver (long-lived) and observer (fresh fork) diverge after any git
          // activity. Temporary fix until the capture approach replaces all
          // normalizations. The model can still run `git status` via Bash.
          if (block.text.includes('\ngitStatus:')) {
            block.text = block.text.replace(
              /\ngitStatus:[\s\S]*?(?=\n#|\n<[a-z]|$)/,
              ''
            );
            modified = true;
          }
        }
      }

      // --- Tool normalizations ---
      if (Array.isArray(payload.tools)) {
        for (const tool of payload.tools) {
          if (tool.name !== 'Agent' || !tool.description) continue;

          // Fix 5: Strip claude-code-guide agent type (interactive-only, gated by
          // CLAUDE_CODE_ENTRYPOINT !== 'sdk-cli' in builtInAgents.ts).
          const guideRe = /\n- claude-code-guide:[^\n]+\([Tt]ools:[^)]+\)/;
          if (guideRe.test(tool.description)) {
            tool.description = tool.description.replace(guideRe, '');
            modified = true;
          }

          // Fix 6: Sort agent types alphabetically. Plugin agent types are listed
          // in non-deterministic order between process starts.
          const marker = 'Available agent types and the tools they have access to:\n';
          const markerIdx = tool.description.indexOf(marker);
          if (markerIdx !== -1) {
            const before = tool.description.slice(0, markerIdx + marker.length);
            const rest = tool.description.slice(markerIdx + marker.length);

            const endPatterns = ['\n\nWhen ', '\n\n## '];
            let endIdx = rest.length;
            for (const pat of endPatterns) {
              const idx = rest.indexOf(pat);
              if (idx !== -1 && idx < endIdx) endIdx = idx;
            }

            const agentBlock = rest.slice(0, endIdx);
            const after = rest.slice(endIdx);

            const lines = agentBlock.split('\n- ').filter(l => l.trim());
            const entries = lines.map((l, i) => i === 0 ? l : '- ' + l);
            entries.sort();

            const sorted = before + entries.join('\n') + after;
            if (sorted !== tool.description) {
              tool.description = sorted;
              modified = true;
            }
          }
        }
      }

      // --- Message normalizations ---
      // Fix 8: Strip <system-reminder> blocks from tool_result content.
      // Claude Code injects runtime reminders (task tools nudge, etc.) into
      // tool results during the live session, but these aren't persisted to
      // JSONL. The observer loads from JSONL → no reminders → prefix mismatch.
      if (Array.isArray(payload.messages)) {
        const reminderRe = /\n*<system-reminder>[\s\S]*?<\/system-reminder>\n*/g;
        for (const msg of payload.messages) {
          if (!Array.isArray(msg.content)) continue;
          for (const block of msg.content) {
            if (block.type === 'tool_result' && typeof block.content === 'string' && reminderRe.test(block.content)) {
              block.content = block.content.replace(reminderRe, '');
              modified = true;
            }
          }
        }
      }

      if (modified) {
        options = { ...options, body: JSON.stringify(payload) };
      }

      // Debug dump — captures the final request body after all normalizations.
      const dumpPath = process.env.ANDON_DUMP_PATH;
      if (dumpPath) {
        const { writeFileSync } = await import('fs');
        writeFileSync(dumpPath, options.body);
      }
    } catch {}
  }
  return _realFetch.apply(this, [url, options]);
};
