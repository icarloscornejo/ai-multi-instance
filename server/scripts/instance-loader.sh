# Sourced (not executed) inside the tmux pane's own interactive shell right before an agent
# launches - see server/src/terminal.ts (initializeInstanceSession) and server/src/launch.ts
# (buildLoaderInvocation). Its whole reason to exist: the real launch command (with
# AI_MULTI_INSTANCE_ID=..., --resume, --settings '<json>', the resume-fallback snippet, ...)
# used to be typed literally into the pane via tmux send-keys, so the user saw that entire
# one-liner sitting on screen until the agent painted its own UI. Now that command travels
# through the tmux session's own environment instead (see setSessionEnvironment in tmux.ts),
# and all that gets typed into the pane is a short `source '<this file>'` line - this script
# reads the real command back out and evaluates it in place.
#
# Also reads a tmux "wait-for" channel name from the same session environment and signals it
# (tmux wait-for -S) right before the eval - a named, server-side semaphore, not any kind of
# visible output. The dashboard's web UI covers the terminal with its own HTML loading overlay
# until it observes that signal (see agentReadiness.ts/terminal.ts), so this script never
# prints anything about its own progress: there is nothing left to hide from the pane, and
# nothing that could end up in the terminal's scrollback if something goes wrong.
#
# Sourced, not `bash <file>` or `exec`: the real command keeps running in the SAME
# interactive shell the pane already had (same aliases, same Vertex env vars from
# .zprofile/.zshrc, same shell the user lands back on when the agent exits). That also means
# `return` (not `exit`) on error paths below - `exit` would kill the pane's shell entirely.

_ail_raw="$(tmux show-environment AI_LAUNCH_COMMAND 2>/dev/null)"
_ail_channel_raw="$(tmux show-environment AI_LAUNCH_READY_CHANNEL 2>/dev/null)"
tmux set-environment -u AI_LAUNCH_COMMAND 2>/dev/null
tmux set-environment -u AI_LAUNCH_READY_CHANNEL 2>/dev/null

case "$_ail_raw" in
  AI_LAUNCH_COMMAND=*)
    _ail_launch_command="${_ail_raw#AI_LAUNCH_COMMAND=}"
    ;;
  *)
    _ail_launch_command=""
    ;;
esac

case "$_ail_channel_raw" in
  AI_LAUNCH_READY_CHANNEL=*)
    _ail_ready_channel="${_ail_channel_raw#AI_LAUNCH_READY_CHANNEL=}"
    ;;
  *)
    _ail_ready_channel=""
    ;;
esac

# TEMP debug instrumentation for the Mac Sephora blank-prompt-flash edge case - writes to a
# FILE, never to the pane, so it does not violate the "nothing printed" contract above. Keyed
# by the ready channel name (unique per launch, see buildReadyChannelName) so it lines up with
# the matching [agent-boot] lines in the server's own log. Remove once that edge case is understood.
zmodload zsh/datetime 2>/dev/null
_ail_debug() {
  printf '%s %s %s\n' "${EPOCHREALTIME:-$(date +%s)}" "${_ail_ready_channel:-no-channel}" "$1" \
    >> /tmp/ccdash-boot-debug.log 2>/dev/null
}
_ail_debug loader-start

if [ -z "$_ail_launch_command" ]; then
  printf '\033[31mNo se encontro el comando de lanzamiento (AI_LAUNCH_COMMAND vacio o no seteado).\033[0m\n'
  unset -f _ail_debug
  unset _ail_raw _ail_channel_raw _ail_launch_command _ail_ready_channel
  return 1
fi

clear

# Defensive: an old/relaunched instance with no channel set must still boot normally instead
# of failing here - the dashboard's overlay just falls back to its own timeout in that case.
if [ -n "$_ail_ready_channel" ]; then
  tmux wait-for -S "$_ail_ready_channel" 2>/dev/null
  _ail_debug signal-sent
fi

_ail_debug eval-start
eval "$_ail_launch_command"
_ail_debug eval-exit

unset -f _ail_debug
unset _ail_raw _ail_channel_raw _ail_launch_command _ail_ready_channel
