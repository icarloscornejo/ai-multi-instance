# Sourced by dashboard-statusline.sh and shims/codex. Works out which dashboard instance the
# calling process belongs to and which process is the pane's foreground job, using the same
# rule as classifyPane in server/src/paneAgent.ts so writer and server always agree on the pid.
#
# Sets AI_INSTANCE_ID, AI_ID_SOURCE ("env" when the dashboard's own launch command put
# AI_MULTI_INSTANCE_ID in the environment, "tmux" when it was derived from the session name,
# i.e. the agent was started by hand) and AI_PANE_JOB_PID.
#
# Returns 0 when the caller should write for that instance, 1 when it is not a dashboard pane
# at all, 2 when it is a dashboard pane but not the instance's own (a user split or an agent
# teammate pane): both non-zero cases mean "write nothing".

ai_process_field() {
  # $1 = ps keyword, $2 = pid. Trimmed value, empty when the process is gone.
  ps -o "$1=" -p "$2" 2>/dev/null | tr -d ' '
}

ai_resolve_pane_identity() {
  AI_INSTANCE_ID=""
  AI_ID_SOURCE=""
  AI_PANE_JOB_PID=""

  if [ -z "$TMUX_PANE" ]; then
    # Not inside tmux: keep the old behaviour for an explicitly-provided id (no pid to compare).
    [ -n "$AI_MULTI_INSTANCE_ID" ] || return 1
    AI_INSTANCE_ID="$AI_MULTI_INSTANCE_ID"
    AI_ID_SOURCE="env"
    return 0
  fi

  local session
  session=$(tmux display -p -t "$TMUX_PANE" '#S' 2>/dev/null)
  if [ -n "$AI_MULTI_INSTANCE_ID" ]; then
    AI_INSTANCE_ID="$AI_MULTI_INSTANCE_ID"
    AI_ID_SOURCE="env"
  elif [[ "$session" =~ ^ccdash-([0-9a-f]{8})$ ]]; then
    AI_INSTANCE_ID="${BASH_REMATCH[1]}"
    AI_ID_SOURCE="tmux"
  else
    return 1
  fi

  # The instance is its original pane: the lowest pane id in the session (see pickOriginalPane).
  local original_pane_id original_pane_pid
  read -r original_pane_id original_pane_pid <<< "$(tmux list-panes -s -t "$session" -F '#{pane_id} #{pane_pid}' 2>/dev/null \
    | sed 's/^%//' | sort -n | head -1)"
  [ -n "$original_pane_id" ] || return 1
  [ "%$original_pane_id" = "$TMUX_PANE" ] || return 2

  local pane_pgid foreground_pgid
  pane_pgid=$(ai_process_field pgid "$original_pane_pid")
  foreground_pgid=$(ai_process_field tpgid "$$")
  if [ -n "$pane_pgid" ] && [ "$pane_pgid" = "$foreground_pgid" ]; then
    AI_PANE_JOB_PID="$original_pane_pid"
    return 0
  fi

  # Walk up from this process to the pane shell's direct child: that is the foreground job.
  local current_pid="$$" parent_pid depth=0
  while [ "$depth" -lt 12 ]; do
    parent_pid=$(ai_process_field ppid "$current_pid")
    [ -n "$parent_pid" ] && [ "$parent_pid" -gt 1 ] 2>/dev/null || return 0
    if [ "$parent_pid" = "$original_pane_pid" ]; then
      AI_PANE_JOB_PID="$current_pid"
      return 0
    fi
    current_pid="$parent_pid"
    depth=$((depth + 1))
  done
  return 0
}
