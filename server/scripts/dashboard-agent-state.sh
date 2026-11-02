#!/bin/bash
# Claude Code hook injected through the per-launch --settings (see server/src/providers.ts and
# shims/claude). Records whether the agent is waiting, working or idle in a small state file
# keyed by the dashboard instance id, which the server reads to badge the instance.
#
# stdout is closed first: for some events it becomes agent context and for PermissionRequest
# it is read as a decision. The script always exits 0 so it can never block or break the agent.
exec 1>/dev/null 2>/dev/null
set -f
umask 077

cache_dir="$HOME/Library/Application Support/ai-multi-instance"
log_file="$cache_dir/agent-state.log"
tmp_file=""
trap '[ -n "$tmp_file" ] && rm -f "$tmp_file"' EXIT

# Never records payload text: only a timestamp, the event name and the reason.
log_failure() {
  [ -d "$cache_dir" ] && printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" >> "$log_file"
}

input=$(cat)
[ -z "$input" ] && exit 0

if ! command -v jq >/dev/null 2>&1; then
  log_failure "unknown" "jq not found"
  exit 0
fi

# The mapping lives in jq so the event name is only ever echoed back from the known list.
decision=$(printf '%s' "$input" | jq -r '
  if type != "object" then "skip"
  else
    (.hook_event_name // "") as $event
    | (.notification_type // "") as $notification
    | (if $event == "PermissionRequest" then "waiting"
       elif $event == "Notification" then
         (if ($notification == "permission_prompt" or $notification == "elicitation_dialog" or $notification == "agent_needs_input") then "waiting"
          elif $notification == "idle_prompt" then "idle" else "skip" end)
       elif $event == "PreToolUse" then (if .tool_name == "AskUserQuestion" then "waiting" else "skip" end)
       elif ($event == "UserPromptSubmit" or $event == "PostToolUse" or $event == "PostToolUseFailure") then "working"
       elif ($event == "Stop" or $event == "StopFailure") then "idle"
       elif $event == "SessionStart" then (if (.source == "startup" or .source == "resume" or .source == "clear") then "idle" else "skip" end)
       elif $event == "SessionEnd" then "remove"
       else "skip" end) as $action
    | if $action == "skip" then "skip" else "\($action) \($event)" end
  end' 2>/dev/null)
action="${decision%% *}"
event_name="${decision#* }"
if [ -z "$decision" ] || [ "$action" = "skip" ]; then
  exit 0
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/lib/pane-identity.sh"
ai_resolve_pane_identity || exit 0

instance_id="$AI_INSTANCE_ID"
if [[ ! "$instance_id" =~ ^[0-9a-f]{8}$ ]]; then
  log_failure "$event_name" "invalid instance id"
  exit 0
fi

# chmod even when the directory already existed: older versions created it with the default mode.
if ! mkdir -p "$cache_dir" || ! chmod 700 "$cache_dir"; then
  exit 0
fi
state_file="$cache_dir/${instance_id}.state.json"

if [ "$action" = "remove" ]; then
  rm -f "$state_file"
  exit 0
fi

session_id=$(printf '%s' "$input" | jq -r '(.session_id // "") | if type == "string" then . else "" end' 2>/dev/null)
tmp_file=$(mktemp "$cache_dir/.state.XXXXXX") || { log_failure "$event_name" "mktemp failed"; tmp_file=""; exit 0; }

if jq -n \
  --arg state "$action" \
  --arg sessionId "$session_id" \
  --arg paneJobPid "$AI_PANE_JOB_PID" \
  --arg event "$event_name" \
  --arg updatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{state: $state, sessionId: $sessionId, paneJobPid: ($paneJobPid | tonumber? // null), event: $event, updatedAt: $updatedAt}' > "$tmp_file" \
  && mv "$tmp_file" "$state_file"; then
  tmp_file=""
else
  log_failure "$event_name" "write failed"
fi
exit 0
