#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKDIR="$(pwd)"

DRIVER_MODEL="gpt-5.4"
OBSERVER_MODEL="gpt-5.4"
OBSERVER_EFFORT="low"
LENS="quality"
DELIVERY_MODE="queue"
CONTINUOUS=false
POLL_INTERVAL=4
PROMPT_WINDOW_LINES=120
COOLDOWN_SECONDS=90
DRIVER_SESSION_ID=""
COMMAND="observe"
TMUX_SESSION=""

SESSIONS_ROOT="$HOME/.codex/sessions"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/codex-companion"
RECENT_HASH_LIMIT=20

STATE_QUEUED_MESSAGE=""
STATE_QUEUED_REASON=""
STATE_QUEUED_HASH=""
STATE_COOLDOWN_UNTIL=0
STATE_LAST_REVIEW_HASH=""
STATE_LAST_DELIVERED_HASH=""
STATE_LAST_DRIVER_SESSION_ID=""
STATE_LAST_INPUT_TOKENS=0
STATE_LAST_CACHED_INPUT_TOKENS=0
STATE_LAST_CACHE_HIT_RATIO=0
declare -a STATE_RECENT_MESSAGE_HASHES=()

declare -A LENS_PROMPTS=(
  ["quality"]="You are the QUALITY companion. Focus on correctness risks, missing verification, dangerous assumptions, obvious regressions, and code that looks likely to break. Do not nitpick style."
  ["security"]="You are the SECURITY companion. Focus on auth, authorization, secret handling, injection risk, unsafe shelling-out, data exposure, and trust boundaries. Do not comment on style or product scope."
  ["simplifier"]="You are the SIMPLIFIER companion. Focus on unnecessary complexity, abstractions that do not earn their keep, code that could be deleted, and over-built solutions. Do not comment on unrelated bugs or security."
  ["api-design"]="You are the API DESIGN companion. Focus on contract clarity, compatibility, consistency, error shapes, naming, and ergonomics. Do not comment on internal code structure."
)

log() {
  printf "[codex-companion %s] %s\n" "$(date +%H:%M:%S)" "$*" >&2
}

usage() {
  cat <<'EOF'
Usage:
  ./codex-companion.sh start <tmux-session> [--driver-model MODEL]
  ./codex-companion.sh observe <tmux-session> [options]
  ./codex-companion.sh <tmux-session> [options]

Options for observe:
  --continuous                 Keep monitoring until stopped
  --lens NAME                  quality | security | simplifier | api-design
  --observer-model MODEL       Default: gpt-5.4-mini
  --observer-effort LEVEL      Default: low
  --delivery MODE              queue | interrupt | print
  --driver-session-id ID       Override auto-detected Codex driver session id
  --poll-interval SECONDS      Default: 4
  --prompt-window-lines N      Default: 120
  --cooldown-seconds N         Default: 90

Notes:
  - Driver tmux session must run Codex with --no-alt-screen.
  - Each review uses a fresh codex fork from the driver, then discards it.
  - Queue, cooldown, and dedupe state live in a persisted local state file.
  - queue mode is the safe default. interrupt mode is still experimental.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    start|observe)
      COMMAND="$1"
      shift
      ;;
    --continuous)
      CONTINUOUS=true
      shift
      ;;
    --lens)
      LENS="${2:?missing lens}"
      shift 2
      ;;
    --observer-model)
      OBSERVER_MODEL="${2:?missing model}"
      shift 2
      ;;
    --observer-effort)
      OBSERVER_EFFORT="${2:?missing effort}"
      shift 2
      ;;
    --driver-model)
      DRIVER_MODEL="${2:?missing model}"
      shift 2
      ;;
    --delivery)
      DELIVERY_MODE="${2:?missing delivery mode}"
      shift 2
      ;;
    --driver-session-id)
      DRIVER_SESSION_ID="${2:?missing session id}"
      shift 2
      ;;
    --poll-interval)
      POLL_INTERVAL="${2:?missing seconds}"
      shift 2
      ;;
    --prompt-window-lines)
      PROMPT_WINDOW_LINES="${2:?missing line count}"
      shift 2
      ;;
    --cooldown-seconds)
      COOLDOWN_SECONDS="${2:?missing cooldown}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -z "$TMUX_SESSION" ]]; then
        TMUX_SESSION="$1"
      else
        echo "Unexpected argument: $1" >&2
        usage
        exit 1
      fi
      shift
      ;;
  esac
done

if [[ -z "$TMUX_SESSION" ]]; then
  usage
  exit 1
fi

if [[ -z "${LENS_PROMPTS[$LENS]:-}" ]]; then
  echo "Unknown lens: $LENS" >&2
  exit 1
fi

DRIVER_PANE="${TMUX_SESSION}:0.0"
WORKDIR_HASH="$(printf '%s' "$WORKDIR" | shasum -a 256 | awk '{print $1}' | cut -c1-12)"
SESSION_SLUG="$(printf '%s' "$TMUX_SESSION" | tr -cs 'A-Za-z0-9._-' '_')"
STATE_FILE="$STATE_DIR/${SESSION_SLUG}-${WORKDIR_HASH}.json"
TMUX_SESSION_CREATED_AT=0

require_tmux_session() {
  if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    echo "tmux session '$TMUX_SESSION' not found" >&2
    exit 1
  fi
}

hash_text() {
  printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
}

shell_quote() {
  printf '%q' "$1"
}

cache_hit_ratio() {
  local input_tokens="$1"
  local cached_tokens="$2"
  awk -v input="$input_tokens" -v cached="$cached_tokens" 'BEGIN {
    if (input > 0) {
      printf "%.4f", cached / input
    } else {
      printf "0"
    }
  }'
}

ensure_state_file() {
  if [[ -f "$STATE_FILE" ]]; then
    return 0
  fi

  mkdir -p "$STATE_DIR"
  local tmp_file
  tmp_file="$(mktemp -t codex-companion-state)"
  cat >"$tmp_file" <<'EOF'
{"queued_message":"","queued_reason":"","queued_hash":"","cooldown_until":0,"last_review_hash":"","last_delivered_hash":"","recent_message_hashes":[],"last_driver_session_id":"","last_metrics":{"input_tokens":0,"cached_input_tokens":0,"cache_hit_ratio":0}}
EOF
  mv "$tmp_file" "$STATE_FILE"
}

load_state() {
  ensure_state_file

  STATE_QUEUED_MESSAGE="$(jq -r '.queued_message // ""' "$STATE_FILE")"
  STATE_QUEUED_REASON="$(jq -r '.queued_reason // ""' "$STATE_FILE")"
  STATE_QUEUED_HASH="$(jq -r '.queued_hash // ""' "$STATE_FILE")"
  STATE_COOLDOWN_UNTIL="$(jq -r '.cooldown_until // 0' "$STATE_FILE")"
  STATE_LAST_REVIEW_HASH="$(jq -r '.last_review_hash // ""' "$STATE_FILE")"
  STATE_LAST_DELIVERED_HASH="$(jq -r '.last_delivered_hash // ""' "$STATE_FILE")"
  STATE_LAST_DRIVER_SESSION_ID="$(jq -r '.last_driver_session_id // ""' "$STATE_FILE")"
  STATE_LAST_INPUT_TOKENS="$(jq -r '.last_metrics.input_tokens // 0' "$STATE_FILE")"
  STATE_LAST_CACHED_INPUT_TOKENS="$(jq -r '.last_metrics.cached_input_tokens // 0' "$STATE_FILE")"
  STATE_LAST_CACHE_HIT_RATIO="$(jq -r '.last_metrics.cache_hit_ratio // 0' "$STATE_FILE")"
  mapfile -t STATE_RECENT_MESSAGE_HASHES < <(jq -r '.recent_message_hashes[]?' "$STATE_FILE")
}

save_state() {
  mkdir -p "$STATE_DIR"

  local recent_json metrics_json tmp_file
  recent_json="$(printf '%s\n' "${STATE_RECENT_MESSAGE_HASHES[@]-}" | jq -Rsc 'split("\n") | map(select(length > 0))')"
  metrics_json="$(
    jq -n \
      --argjson input "$STATE_LAST_INPUT_TOKENS" \
      --argjson cached "$STATE_LAST_CACHED_INPUT_TOKENS" \
      --argjson ratio "$STATE_LAST_CACHE_HIT_RATIO" \
      '{input_tokens:$input, cached_input_tokens:$cached, cache_hit_ratio:$ratio}'
  )"
  tmp_file="$(mktemp -t codex-companion-state)"
  jq -n \
    --arg queued_message "$STATE_QUEUED_MESSAGE" \
    --arg queued_reason "$STATE_QUEUED_REASON" \
    --arg queued_hash "$STATE_QUEUED_HASH" \
    --arg last_review_hash "$STATE_LAST_REVIEW_HASH" \
    --arg last_delivered_hash "$STATE_LAST_DELIVERED_HASH" \
    --arg last_driver_session_id "$STATE_LAST_DRIVER_SESSION_ID" \
    --argjson cooldown_until "$STATE_COOLDOWN_UNTIL" \
    --argjson recent_message_hashes "$recent_json" \
    --argjson last_metrics "$metrics_json" \
    '{
      queued_message: $queued_message,
      queued_reason: $queued_reason,
      queued_hash: $queued_hash,
      cooldown_until: $cooldown_until,
      last_review_hash: $last_review_hash,
      last_delivered_hash: $last_delivered_hash,
      recent_message_hashes: $recent_message_hashes,
      last_driver_session_id: $last_driver_session_id,
      last_metrics: $last_metrics
    }' >"$tmp_file"
  mv "$tmp_file" "$STATE_FILE"
}

recent_hash_seen() {
  local target_hash="$1"
  local hash_value
  for hash_value in "${STATE_RECENT_MESSAGE_HASHES[@]}"; do
    if [[ "$hash_value" == "$target_hash" ]]; then
      return 0
    fi
  done
  return 1
}

add_recent_hash() {
  local target_hash="$1"
  local -a next_hashes=()
  local hash_value

  [[ -n "$target_hash" ]] || return 0

  next_hashes+=("$target_hash")
  for hash_value in "${STATE_RECENT_MESSAGE_HASHES[@]}"; do
    [[ -n "$hash_value" ]] || continue
    [[ "$hash_value" == "$target_hash" ]] && continue
    next_hashes+=("$hash_value")
    if (( ${#next_hashes[@]} >= RECENT_HASH_LIMIT )); then
      break
    fi
  done

  STATE_RECENT_MESSAGE_HASHES=("${next_hashes[@]}")
}

set_last_metrics() {
  local input_tokens="$1"
  local cached_tokens="$2"

  STATE_LAST_INPUT_TOKENS="$input_tokens"
  STATE_LAST_CACHED_INPUT_TOKENS="$cached_tokens"
  STATE_LAST_CACHE_HIT_RATIO="$(cache_hit_ratio "$input_tokens" "$cached_tokens")"
}

clear_queued_message() {
  STATE_QUEUED_MESSAGE=""
  STATE_QUEUED_REASON=""
  STATE_QUEUED_HASH=""
}

queue_message() {
  local message="$1"
  local reason="$2"
  local message_hash="$3"

  STATE_QUEUED_MESSAGE="$message"
  STATE_QUEUED_REASON="$reason"
  STATE_QUEUED_HASH="$message_hash"
  add_recent_hash "$message_hash"
}

mark_delivered() {
  local message_hash="$1"

  STATE_LAST_DELIVERED_HASH="$message_hash"
  STATE_COOLDOWN_UNTIL="$(( $(date +%s) + COOLDOWN_SECONDS ))"
  add_recent_hash "$message_hash"
  clear_queued_message
}

driver_capture() {
  tmux capture-pane -t "$DRIVER_PANE" -p -S "-${PROMPT_WINDOW_LINES}" 2>/dev/null || true
}

driver_is_busy() {
  driver_capture | grep -Eq 'esc to interrupt|Working \([0-9]+s'
}

driver_accepting_injection() {
  local pane_text
  pane_text="$(driver_capture)"
  ! grep -Eq 'esc to interrupt|Working \([0-9]+s' <<<"$pane_text" &&
    grep -q 'Use /skills to list available skills' <<<"$pane_text"
}

start_driver() {
  local workdir_q driver_model_q

  if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    log "tmux session '$TMUX_SESSION' already exists"
    return 0
  fi

  workdir_q="$(shell_quote "$WORKDIR")"
  driver_model_q="$(shell_quote "$DRIVER_MODEL")"
  log "Starting Codex driver in tmux session '$TMUX_SESSION'"
  tmux new-session -d -s "$TMUX_SESSION" \
    "cd $workdir_q && codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox --model $driver_model_q"
  log "Started. Attach with: tmux attach -t $TMUX_SESSION"
}

session_file_for_id() {
  local target_id="$1"
  local file meta id

  while IFS= read -r -d '' file; do
    meta="$(head -n 1 "$file" 2>/dev/null || true)"
    id="$(jq -r 'select(.type=="session_meta") | .payload.id // ""' <<<"$meta" 2>/dev/null || true)"
    if [[ "$id" == "$target_id" ]]; then
      printf '%s\n' "$file"
      return 0
    fi
  done < <(find "$SESSIONS_ROOT" -type f -mtime -2 -name '*.jsonl' -print0 2>/dev/null)

  return 1
}

list_cli_sessions_for_cwd() {
  local file meta source cwd id

  while IFS= read -r -d '' file; do
    meta="$(head -n 1 "$file" 2>/dev/null || true)"
    source="$(jq -r 'select(.type=="session_meta") | .payload.source // ""' <<<"$meta" 2>/dev/null || true)"
    cwd="$(jq -r 'select(.type=="session_meta") | .payload.cwd // ""' <<<"$meta" 2>/dev/null || true)"
    id="$(jq -r 'select(.type=="session_meta") | .payload.id // ""' <<<"$meta" 2>/dev/null || true)"
    [[ "$source" == "cli" ]] || continue
    [[ "$cwd" == "$WORKDIR" ]] || continue
    [[ -n "$id" ]] || continue
    printf '%s\n' "$id"
  done < <(find "$SESSIONS_ROOT" -type f -mtime -2 -name '*.jsonl' -print0 2>/dev/null)
}

most_recent_driver_session_for_cwd() {
  local min_mtime="${1:-0}"
  local newest_root_id=""
  local newest_root_mtime=0
  local newest_any_id=""
  local newest_any_mtime=0
  local file meta source cwd id forked_from_id mtime

  while IFS= read -r -d '' file; do
    meta="$(head -n 1 "$file" 2>/dev/null || true)"
    source="$(jq -r 'select(.type=="session_meta") | .payload.source // ""' <<<"$meta" 2>/dev/null || true)"
    cwd="$(jq -r 'select(.type=="session_meta") | .payload.cwd // ""' <<<"$meta" 2>/dev/null || true)"
    id="$(jq -r 'select(.type=="session_meta") | .payload.id // ""' <<<"$meta" 2>/dev/null || true)"
    forked_from_id="$(jq -r 'select(.type=="session_meta") | .payload.forked_from_id // ""' <<<"$meta" 2>/dev/null || true)"
    [[ "$source" == "cli" ]] || continue
    [[ "$cwd" == "$WORKDIR" ]] || continue
    [[ -n "$id" ]] || continue
    mtime="$(stat -f %m "$file")"
    (( mtime >= min_mtime )) || continue
    if (( mtime > newest_any_mtime )); then
      newest_any_mtime="$mtime"
      newest_any_id="$id"
    fi
    if [[ -z "$forked_from_id" ]] && (( mtime > newest_root_mtime )); then
      newest_root_mtime="$mtime"
      newest_root_id="$id"
    fi
  done < <(find "$SESSIONS_ROOT" -type f -mtime -2 -name '*.jsonl' -print0 2>/dev/null)

  if [[ -n "$newest_root_id" ]]; then
    printf '%s\n' "$newest_root_id"
  else
    printf '%s\n' "$newest_any_id"
  fi
}

wait_for_driver_session_id() {
  local state_session_file state_session_mtime

  if [[ -n "$DRIVER_SESSION_ID" ]]; then
    printf '%s\n' "$DRIVER_SESSION_ID"
    return 0
  fi

  if [[ -n "$STATE_LAST_DRIVER_SESSION_ID" ]] && state_session_file="$(session_file_for_id "$STATE_LAST_DRIVER_SESSION_ID" 2>/dev/null)"; then
    state_session_mtime="$(stat -f %m "$state_session_file")"
    if (( state_session_mtime >= TMUX_SESSION_CREATED_AT )); then
      printf '%s\n' "$STATE_LAST_DRIVER_SESSION_ID"
      return 0
    fi
  fi

  log "Waiting for a Codex driver session file in $WORKDIR"
  local sid=""
  local tries=0

  while [[ -z "$sid" ]]; do
    sid="$(most_recent_driver_session_for_cwd "$TMUX_SESSION_CREATED_AT")"
    if [[ -z "$sid" ]]; then
      sid="$(most_recent_driver_session_for_cwd)"
    fi
    if [[ -n "$sid" ]]; then
      break
    fi
    sleep 2
    tries=$((tries + 1))
    if (( tries % 10 == 0 )); then
      log "Still waiting. Run at least one prompt in the driver so Codex persists a session."
    fi
  done

  printf '%s\n' "$sid"
}

find_new_cli_session_excluding() {
  local known_ids="$1"
  local exclude_id="${2:-}"
  local newest_id=""
  local newest_mtime=0
  local file meta source cwd id mtime

  while IFS= read -r -d '' file; do
    meta="$(head -n 1 "$file" 2>/dev/null || true)"
    source="$(jq -r 'select(.type=="session_meta") | .payload.source // ""' <<<"$meta" 2>/dev/null || true)"
    cwd="$(jq -r 'select(.type=="session_meta") | .payload.cwd // ""' <<<"$meta" 2>/dev/null || true)"
    id="$(jq -r 'select(.type=="session_meta") | .payload.id // ""' <<<"$meta" 2>/dev/null || true)"
    [[ "$source" == "cli" ]] || continue
    [[ "$cwd" == "$WORKDIR" ]] || continue
    [[ -n "$id" ]] || continue
    [[ "$id" != "$exclude_id" ]] || continue
    if grep -Fqx "$id" <<<"$known_ids"; then
      continue
    fi
    mtime="$(stat -f %m "$file")"
    if (( mtime > newest_mtime )); then
      newest_mtime="$mtime"
      newest_id="$id"
    fi
  done < <(find "$SESSIONS_ROOT" -type f -mtime -2 -name '*.jsonl' -print0 2>/dev/null)

  printf '%s\n' "$newest_id"
}

wait_for_tmux_settle() {
  local pane="$1"
  local max_wait="${2:-30}"
  local waited=0

  while (( waited < max_wait )); do
    if ! tmux has-session -t "${pane%%:*}" 2>/dev/null; then
      return 0
    fi
    if ! tmux capture-pane -t "$pane" -p -S -80 2>/dev/null | grep -Eq 'esc to interrupt|Working \([0-9]+s'; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

git_snapshot() {
  {
    echo "## git status"
    git status --short 2>/dev/null || true
    echo
    echo "## git diff --stat"
    git diff --stat --compact-summary 2>/dev/null || true
  }
}

build_review_prompt() {
  local driver_busy="$1"
  local queued_pending="$2"
  local pane_text="$3"
  local git_text="$4"

  cat <<EOF
${LENS_PROMPTS[$LENS]}

Do not use tools. Do not read files. Use only the driver state included below.

Return JSON only. No markdown fences. Use this exact shape:
{"action":"noop|queue|interrupt","reason":"short reason","message":"short message or empty"}

Rules:
- action=noop when nothing important changed.
- action=queue when feedback is useful but can wait.
- action=interrupt only for high-confidence interventions that should preempt the driver now.
- message must be empty for noop.
- message must be one short paragraph and under 240 characters.
- reason must stay under 120 characters.

Current driver state:
- driver_busy: ${driver_busy}
- queued_message_pending: ${queued_pending}

${git_text}

## driver terminal excerpt
${pane_text}
EOF
}

sanitize_json_message() {
  sed -e '1{/^```json$/d;}' -e '1{/^```$/d;}' -e '${/^```$/d;}'
}

extract_final_message() {
  local session_file="$1"

  jq -sr -r '
    [
      .[]
      | select(.type=="response_item" and .payload.type=="message" and .payload.role=="assistant" and (.payload.phase // "")=="final_answer")
      | .payload.content[]?
      | select(.type=="output_text")
      | .text
    ][-1]
    //
    [
      .[]
      | select(.type=="response_item" and .payload.type=="message" and .payload.role=="assistant")
      | .payload.content[]?
      | select(.type=="output_text")
      | .text
    ][-1]
    // ""
  ' "$session_file" 2>/dev/null
}

extract_usage_metrics() {
  local session_file="$1"
  local metrics_json input_tokens cached_tokens ratio

  metrics_json="$(
    jq -sr '
      [
        .[]
        | select(.type=="event_msg" and .payload.type=="token_count" and .payload.info.last_token_usage != null)
        | .payload.info.last_token_usage
      ][-1] // {}
    ' "$session_file" 2>/dev/null
  )"
  input_tokens="$(jq -r '.input_tokens // 0' <<<"$metrics_json" 2>/dev/null || printf '0')"
  cached_tokens="$(jq -r '.cached_input_tokens // 0' <<<"$metrics_json" 2>/dev/null || printf '0')"
  ratio="$(cache_hit_ratio "$input_tokens" "$cached_tokens")"
  printf '%s\t%s\t%s\n' "$input_tokens" "$cached_tokens" "$ratio"
}

run_observer_epoch() {
  local driver_sid="$1"
  local driver_busy="$2"
  local queued_pending="$3"
  local pane_text="$4"
  local git_text="$5"
  local fork_tmux known_ids observer_sid session_file prompt tries=0
  local result_text input_tokens cached_tokens ratio
  local workdir_q driver_sid_q prompt_q observer_model_q observer_effort_q

  known_ids="$(list_cli_sessions_for_cwd)"
  fork_tmux="companion-epoch-${TMUX_SESSION}-$$-$RANDOM"
  prompt="$(build_review_prompt "$driver_busy" "$queued_pending" "$pane_text" "$git_text")"
  workdir_q="$(shell_quote "$WORKDIR")"
  driver_sid_q="$(shell_quote "$driver_sid")"
  prompt_q="$(shell_quote "$prompt")"
  observer_model_q="$(shell_quote "$OBSERVER_MODEL")"
  observer_effort_q="$(shell_quote "$OBSERVER_EFFORT")"

  log "Forking fresh observer from driver $driver_sid"
  tmux new-session -d -s "$fork_tmux" \
    "cd $workdir_q && codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox -c model_reasoning_effort=$observer_effort_q --model $observer_model_q fork $driver_sid_q $prompt_q"

  observer_sid=""
  while [[ -z "$observer_sid" ]]; do
    observer_sid="$(find_new_cli_session_excluding "$known_ids" "$driver_sid")"
    [[ -n "$observer_sid" ]] && break
    sleep 1
    tries=$((tries + 1))
    if (( tries > 60 )); then
      log "Failed to detect observer fork session id"
      tmux kill-session -t "$fork_tmux" 2>/dev/null || true
      return 1
    fi
  done

  wait_for_tmux_settle "$fork_tmux:0.0" 45
  tmux kill-session -t "$fork_tmux" 2>/dev/null || true

  if ! session_file="$(session_file_for_id "$observer_sid")"; then
    log "Could not locate observer session file for $observer_sid"
    return 1
  fi

  result_text="$(extract_final_message "$session_file" | sanitize_json_message)"
  read -r input_tokens cached_tokens ratio < <(extract_usage_metrics "$session_file")
  set_last_metrics "$input_tokens" "$cached_tokens"
  save_state
  log "Epoch tokens: input=$input_tokens cached=$cached_tokens hit=${ratio}"

  printf '%s\n' "$result_text"
}

decision_field() {
  local text="$1"
  local field="$2"
  jq -r ".$field // empty" <<<"$text" 2>/dev/null || true
}

deliver_to_driver() {
  local message="$1"
  [[ -n "$message" ]] || return 0

  log "Injecting into driver"
  tmux send-keys -t "$DRIVER_PANE" -l "$message"
  sleep 0.20
  tmux send-keys -t "$DRIVER_PANE" Enter
  sleep 0.35
  tmux send-keys -t "$DRIVER_PANE" Enter
}

interrupt_and_deliver() {
  local message="$1"
  log "Experimental interrupt delivery"
  tmux send-keys -t "$DRIVER_PANE" Escape
  sleep 0.40
  deliver_to_driver "$message"
}

flush_queued_message_if_possible() {
  local now

  [[ -n "$STATE_QUEUED_MESSAGE" ]] || return 1

  now="$(date +%s)"
  if (( now < STATE_COOLDOWN_UNTIL )); then
    return 1
  fi
  if ! driver_accepting_injection; then
    return 1
  fi

  log "Flushing queued message (${STATE_QUEUED_REASON:-no reason})"
  deliver_to_driver "[${LENS}] $STATE_QUEUED_MESSAGE"
  mark_delivered "$STATE_QUEUED_HASH"
  save_state
  return 0
}

handle_observer_decision() {
  local action="$1"
  local reason="$2"
  local message="$3"
  local message_hash now

  case "$action" in
    noop|"")
      log "Observer: noop (${reason:-no reason})"
      return 0
      ;;
    queue|interrupt)
      ;;
    *)
      log "Observer returned unknown action '$action'"
      return 1
      ;;
  esac

  if [[ -z "$message" ]]; then
    log "Observer returned '$action' without a message"
    return 1
  fi

  if [[ "$DELIVERY_MODE" == "print" ]]; then
    printf '[%s %s] %s\n' "$LENS" "$action" "$message"
    return 0
  fi

  message_hash="$(hash_text "${action}|${message}")"
  if [[ "$message_hash" == "$STATE_QUEUED_HASH" ]] || [[ "$message_hash" == "$STATE_LAST_DELIVERED_HASH" ]] || recent_hash_seen "$message_hash"; then
    log "Suppressing duplicate ${action} message (${reason:-no reason})"
    return 0
  fi

  now="$(date +%s)"
  case "$action" in
    queue)
      log "Observer: queue (${reason:-no reason})"
      if (( now >= STATE_COOLDOWN_UNTIL )) && driver_accepting_injection; then
        deliver_to_driver "[${LENS}] $message"
        mark_delivered "$message_hash"
      else
        queue_message "$message" "$reason" "$message_hash"
      fi
      ;;
    interrupt)
      log "Observer: interrupt (${reason:-no reason})"
      if (( now >= STATE_COOLDOWN_UNTIL )); then
        if [[ "$DELIVERY_MODE" == "interrupt" ]]; then
          interrupt_and_deliver "[${LENS}] $message"
          mark_delivered "$message_hash"
        elif driver_accepting_injection; then
          deliver_to_driver "[${LENS}] $message"
          mark_delivered "$message_hash"
        else
          queue_message "$message" "$reason" "$message_hash"
        fi
      else
        queue_message "$message" "$reason" "$message_hash"
      fi
      ;;
  esac

  save_state
}

observe_loop() {
  require_tmux_session
  load_state

  TMUX_SESSION_CREATED_AT="$(tmux display-message -p -t "$TMUX_SESSION" '#{session_created}' 2>/dev/null || printf '0')"

  local driver_sid pane_text git_text busy pending snapshot_hash decision action reason message

  driver_sid="$(wait_for_driver_session_id)"
  STATE_LAST_DRIVER_SESSION_ID="$driver_sid"
  save_state

  log "Driver session: $driver_sid"
  log "State file: $STATE_FILE"

  while true; do
    if [[ "$DELIVERY_MODE" != "print" ]]; then
      flush_queued_message_if_possible || true
    fi

    pane_text="$(driver_capture)"
    git_text="$(git_snapshot)"
    busy=false
    pending=false
    driver_is_busy && busy=true
    [[ -n "$STATE_QUEUED_MESSAGE" ]] && pending=true

    snapshot_hash="$(
      {
        printf '%s\n' "$busy"
        printf '%s\n' "$pending"
        printf '%s\n' "$pane_text"
        printf '%s\n' "$git_text"
      } | shasum -a 256 | awk '{print $1}'
    )"

    if [[ "$snapshot_hash" == "$STATE_LAST_REVIEW_HASH" ]]; then
      if [[ "$CONTINUOUS" == true ]]; then
        sleep "$POLL_INTERVAL"
        continue
      fi
      log "No new state to review"
      break
    fi

    if ! decision="$(run_observer_epoch "$driver_sid" "$busy" "$pending" "$pane_text" "$git_text")"; then
      log "Fresh observer epoch failed"
      if [[ "$CONTINUOUS" == true ]]; then
        sleep "$POLL_INTERVAL"
        continue
      fi
      break
    fi

    if ! jq -e . >/dev/null 2>&1 <<<"$decision"; then
      log "Observer returned invalid JSON, skipping"
      if [[ "$CONTINUOUS" == true ]]; then
        sleep "$POLL_INTERVAL"
        continue
      fi
      break
    fi

    action="$(decision_field "$decision" action)"
    reason="$(decision_field "$decision" reason)"
    message="$(decision_field "$decision" message)"

    if ! handle_observer_decision "$action" "$reason" "$message"; then
      log "Decision handling failed"
      if [[ "$CONTINUOUS" == true ]]; then
        sleep "$POLL_INTERVAL"
        continue
      fi
      break
    fi

    STATE_LAST_REVIEW_HASH="$snapshot_hash"
    save_state

    if [[ "$CONTINUOUS" == false ]]; then
      break
    fi

    sleep "$POLL_INTERVAL"
  done
}

case "$COMMAND" in
  start)
    start_driver
    ;;
  observe)
    observe_loop
    ;;
  *)
    usage
    exit 1
    ;;
esac
