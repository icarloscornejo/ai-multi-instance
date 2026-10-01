#!/usr/bin/env bash
#
# Runs the same thing as `npm run dev:all` (server with tsx watch + vite build --watch) as a
# per-user launchd LaunchAgent (com.ai-multi-instance.dev): it starts at login and is restarted as a
# whole when anything dies or hangs. Meant to be used through the `midev` shell alias.
#
#   midev                  restart everything (also loads the job if it was stopped)
#   midev install [--no-live-check]
#   midev stop | log | status
#
# Separate from install-service.sh (com.ai-multi-instance.server, supervised `npm start`): both
# want ports 3001/5173, so only one of the two can be loaded at a time.
#
# Internal subcommands: run (what launchd executes), probejob/tccprobe/tmuxprobe (deploy gates).
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${REPO_ROOT}/data"
LABEL="com.ai-multi-instance.dev"
PROBE_LABEL="com.ai-multi-instance.probe"
OTHER_SERVICE_LABEL="com.ai-multi-instance.server"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
PROBE_PLIST_PATH="${DATA_DIR}/probe.plist"
PROBE_OUT_PATH="${DATA_DIR}/probe.out"
SERVICE_LOG="${DATA_DIR}/dev-service.log"
DEV_LOG="${DATA_DIR}/server-dev.log"
AUTHGATE_PATH="${DATA_DIR}/dev-service-authgate"
SERVER_PORT=3001
VITE_PORT=5173
LOG_MAX_BYTES=$((10 * 1024 * 1024))
USER_DOMAIN="gui/$(id -u)"
UPDATE_TRANSACTION_MARKER="updateTransaction.ts --run"
SCRIPT_PATH="${REPO_ROOT}/scripts/dev-service.sh"
OTHER_SERVICE_PLIST_PATH="${HOME}/Library/LaunchAgents/${OTHER_SERVICE_LABEL}.plist"

log_line() { printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*"; }
die() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }
note() { printf '\033[1;33m    ! %s\033[0m\n' "$*"; }
ok() { printf '\033[1;32m    ✓ %s\033[0m\n' "$*"; }

# Any HTTP status other than 000 means something answered: a 404 while web/dist is being rebuilt
# is not an outage.
probe_port() { curl -s -o /dev/null --max-time 2 -w '%{http_code}' "http://127.0.0.1:$1/" 2>/dev/null || true; }
listeners_on() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true; }
is_loaded() { launchctl print "${USER_DOMAIN}/$1" >/dev/null 2>&1; }
runner_pid() { launchctl print "${USER_DOMAIN}/${LABEL}" 2>/dev/null | awk '$1=="pid" && $2=="=" {print $3; exit}'; }

# Recovery commands carry absolute, shell-escaped paths: the remote installer runs from $HOME or from
# another checkout, and AI_MULTI_INSTANCE_DIR may contain spaces, quotes or a literal $.
retry_command() { printf 'bash %q setup' "${SCRIPT_PATH}"; }
accept_no_password_command() { printf 'rm %q && %s' "${AUTHGATE_PATH}" "$(retry_command)"; }
uninstall_other_command() { printf 'bash %q' "${REPO_ROOT}/scripts/uninstall-service.sh"; }

wait_healthy() {
  local deadline=$((SECONDS + $1))
  while (( SECONDS < deadline )); do
    if [[ "$(probe_port "${SERVER_PORT}")" != "000" && "$(probe_port "${VITE_PORT}")" != "000" ]]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# bootout can return while the job is still tearing down (the runner needs ~5s), so bootstrap or
# preflight right after it would race the old processes still holding the ports.
wait_gone() {
  local label="$1" check_ports="${2:-yes}" deadline=$((SECONDS + 40))
  while (( SECONDS < deadline )); do
    if ! is_loaded "${label}"; then
      if [[ "${check_ports}" != "yes" ]] || [[ -z "$(listeners_on "${SERVER_PORT}")$(listeners_on "${VITE_PORT}")" ]]; then
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}

# ---------------------------------------------------------------------------------------------
# run: what launchd executes. Supervises `npm run dev:all` itself because neither tsx watch nor
# concurrently reliably exits when the server dies or hangs, which would leave launchd blind.
# ---------------------------------------------------------------------------------------------

# All live descendants of a pid, skipping the subtree of a running update transaction: it is
# spawned detached on purpose so it survives restarts, and killing it mid git merge/npm install
# would leave a half-installed checkout.
descendants_of() {
  local parent_pid="$1" child_pid child_command
  for child_pid in $(pgrep -P "${parent_pid}" 2>/dev/null); do
    child_command="$(ps -o command= -p "${child_pid}" 2>/dev/null || true)"
    if [[ "${child_command}" == *"${UPDATE_TRANSACTION_MARKER}"* ]]; then
      continue
    fi
    echo "${child_pid}"
    descendants_of "${child_pid}"
  done
}

# Both logs are only ever written with open-append-close (launchd for the first, appendFileSync for
# the second), so emptying them in place is safe.
# ponytail: empties instead of keeping the tail, keep the tail if post-mortems need older context.
cap_logs() {
  local log_path size
  for log_path in "${SERVICE_LOG}" "${DEV_LOG}"; do
    size="$(stat -f%z "${log_path}" 2>/dev/null || echo 0)"
    if (( size > LOG_MAX_BYTES )); then
      : > "${log_path}"
      log_line "truncated ${log_path} (was ${size} bytes)"
    fi
  done
}

RUN_CHILD_PID=""
RUN_SNAPSHOT=""

# Unions the last snapshot (taken while the tree was alive, so it still names descendants that got
# orphaned when their parent died) with a fresh one, then TERM, grace, KILL on exactly those pids.
# A listener on the ports that is not in that set is never touched.
teardown() {
  local all_pids pid
  all_pids="$({ echo "${RUN_SNAPSHOT}"; [[ -n "${RUN_CHILD_PID}" ]] && { echo "${RUN_CHILD_PID}"; descendants_of "${RUN_CHILD_PID}"; }; } | grep -E '^[0-9]+$' | sort -un)"
  [[ -z "${all_pids}" ]] && return 0
  log_line "teardown: stopping $(echo "${all_pids}" | wc -l | tr -d ' ') process(es)"
  for pid in ${all_pids}; do kill -TERM "${pid}" 2>/dev/null || true; done
  sleep 5
  for pid in ${all_pids}; do kill -KILL "${pid}" 2>/dev/null || true; done
}

on_signal() {
  teardown
  exit 0
}

run_service() {
  # Must look like a manual `npm run dev` to server/src/updater.ts and serverLog.ts.
  unset AI_MULTI_INSTANCE_SUPERVISED
  mkdir -p "${DATA_DIR}"
  cap_logs

  local port
  for port in "${SERVER_PORT}" "${VITE_PORT}"; do
    if [[ -n "$(listeners_on "${port}")" ]]; then
      log_line "port ${port} is held by a process that is not this service, not starting (will retry)"
      sleep 10
      exit 1
    fi
  done

  trap on_signal TERM INT HUP
  cd "${REPO_ROOT}" || exit 1
  # Login + interactive so nvm and the env vars from ~/.zshrc are the same as in a terminal.
  /bin/zsh -lic 'npm run dev:all' </dev/null &
  RUN_CHILD_PID=$!
  log_line "started dev:all pid=${RUN_CHILD_PID}"

  local started_at=$SECONDS consecutive_failures=0 sleeper_pid
  while true; do
    sleep 10 &
    sleeper_pid=$!
    wait "${sleeper_pid}"
    cap_logs

    if ! kill -0 "${RUN_CHILD_PID}" 2>/dev/null; then
      log_line "dev:all exited, restarting everything"
      teardown
      exit 1
    fi
    RUN_SNAPSHOT="$(descendants_of "${RUN_CHILD_PID}")"

    if (( SECONDS - started_at < 60 )); then
      continue
    fi
    if [[ "$(probe_port "${SERVER_PORT}")" == "000" || "$(probe_port "${VITE_PORT}")" == "000" ]]; then
      consecutive_failures=$((consecutive_failures + 1))
      log_line "health probe failed (${consecutive_failures}/3)"
    else
      consecutive_failures=0
    fi
    if (( consecutive_failures >= 3 )); then
      log_line "service unhealthy, restarting everything"
      teardown
      exit 1
    fi
  done
}

# ---------------------------------------------------------------------------------------------
# install and its checks
# ---------------------------------------------------------------------------------------------

preflight() {
  if is_loaded "${OTHER_SERVICE_LABEL}"; then
    die "${OTHER_SERVICE_LABEL} is loaded and owns the same ports. Run: npm run service:uninstall"
  fi
  local port
  for port in "${SERVER_PORT}" "${VITE_PORT}"; do
    if [[ -n "$(listeners_on "${port}")" ]]; then
      die "Something is already listening on port ${port} (a manual npm run dev?). Stop it first."
    fi
  done
}

SERVICE_LANG=""

detect_service_lang() {
  local detected
  detected="$(env -i HOME="${HOME}" USER="${USER}" /bin/zsh -lic 'echo "__DS__${LANG:-}"' </dev/null 2>/dev/null | grep '^__DS__' | tail -1 | sed 's/^__DS__//')"
  if echo "${detected}" | grep -qiE 'utf-?8'; then
    echo "${detected}"
  else
    echo "en_US.UTF-8"
  fi
}

# Runs a zsh command the way launchd will (login + interactive, no terminal, minimal env) and
# returns the last line it printed after a __DS__ marker, because ~/.zshrc may print noise.
# Extra args are NAME=value pairs added to the environment.
service_eval() {
  local zsh_command="$1"
  shift
  env -i HOME="${HOME}" USER="${USER}" LANG="${SERVICE_LANG}" "$@" /bin/zsh -lic "${zsh_command}" </dev/null 2>/dev/null \
    | grep '^__DS__' | tail -1 | sed 's/^__DS__//'
}

service_node() {
  service_eval 'cd "$DS_REPO" && node -e "$DS_JS"' DS_REPO="${REPO_ROOT}" DS_JS="$1"
}

random_login_code() {
  curl -s -o /dev/null --max-time 3 -w '%{http_code}' -X POST -H 'content-type: application/json' \
    -d "{\"password\":\"$(openssl rand -hex 12)\"}" "http://127.0.0.1:${SERVER_PORT}/api/auth/login" 2>/dev/null || true
}

AUTH_EXPECTED=""
AUTH_REASON=""

# Without a live dashboard to compare against, the expectation comes from configuration. Durable
# signals (a stored "on", data/auth-password.json, DASHBOARD_PASSWORD in the env the service will
# really get) are persisted; a password that only exists in the invoking terminal counts for this
# run only, so it cannot leave a sticky "on" behind. Presence only: values are never printed.
derive_auth_expected() {
  local stored="" zsh_has_password=""
  stored="$(cat "${AUTHGATE_PATH}" 2>/dev/null || true)"
  zsh_has_password="$(service_eval 'echo "__DS__${DASHBOARD_PASSWORD:+set}"')"
  mkdir -p "${DATA_DIR}"
  if [[ -n "${zsh_has_password}" || -f "${DATA_DIR}/auth-password.json" ]]; then
    AUTH_EXPECTED="on"; AUTH_REASON="durable"
    echo "on" > "${AUTHGATE_PATH}"
  elif [[ "${stored}" == "on" ]]; then
    AUTH_EXPECTED="on"; AUTH_REASON="stored_on_only"
  elif [[ -n "${DASHBOARD_PASSWORD:-}" ]]; then
    AUTH_EXPECTED="on"; AUTH_REASON="caller_only"
  else
    AUTH_EXPECTED="off"; AUTH_REASON="none"
    echo "off" > "${AUTHGATE_PATH}"
    note "no dashboard password is configured: it will run from login without one and Caddy exposes it on the LAN."
    echo "      Set one from the dashboard UI, or export DASHBOARD_PASSWORD in ~/.zprofile and run: midev"
  fi
  note "auth expectation without a live dashboard: ${AUTH_EXPECTED} (${AUTH_REASON})"
}

envcheck() {
  local skip_live_auth="$1"
  SERVICE_LANG="$(detect_service_lang)"

  local npm_path
  npm_path="$(service_eval 'echo "__DS__$(command -v npm)"')"
  [[ -n "${npm_path}" ]] || die "npm does not resolve in a login shell without a terminal (what launchd will run)."
  ok "npm resolves: ${npm_path}"

  local effective_locale
  effective_locale="$(service_eval 'echo "__DS__${LC_ALL:-${LC_CTYPE:-$LANG}}"')"
  echo "${effective_locale}" | grep -qiE 'utf-?8' \
    || die "The service would run with locale '${effective_locale}', not UTF-8: tmux panes would draw '_' for non-ASCII."
  ok "locale: ${effective_locale}"

  local resolved_tmux_dir recorded_tmux_dir
  resolved_tmux_dir="$(service_node 'import("./scripts/with-writable-tmpdir.mjs").then(m=>console.log("__DS__"+(m.resolveTmuxTmpdir()??"")))')"
  recorded_tmux_dir="$(tr -d '\n' < "${DATA_DIR}/tmux-tmpdir.txt" 2>/dev/null || true)"
  if [[ -n "${recorded_tmux_dir}" && "${resolved_tmux_dir}" != "${recorded_tmux_dir%/}" ]]; then
    die "The service would use tmux dir '${resolved_tmux_dir}' but the dashboard last used '${recorded_tmux_dir}': starting it would kill the live sessions."
  fi
  ok "tmux socket dir matches the one in use"

  # Auth is checked by behavior against the live dashboard, never by reading its environment.
  local live_code live_auth
  live_code="$(random_login_code)"
  case "${live_code}" in
    401) live_auth="on" ;;
    200) live_auth="off" ;;
    *) live_auth="" ;;
  esac
  if [[ "${skip_live_auth}" == "yes" ]]; then
    derive_auth_expected
    return 0
  fi
  [[ -n "${live_auth}" ]] || die "No dashboard answering on ${SERVER_PORT} (login probe gave '${live_code}'). Start it, or use: $(retry_command)"
  AUTH_EXPECTED="${live_auth}"
  AUTH_REASON="live"
  mkdir -p "${DATA_DIR}"
  echo "${live_auth}" > "${AUTHGATE_PATH}"

  if [[ "${live_auth}" == "on" ]]; then
    local new_env_result
    new_env_result="$(service_node 'const pw=process.env.DASHBOARD_PASSWORD;if(!pw){console.log("__DS__nopw")}else{fetch("http://127.0.0.1:'"${SERVER_PORT}"'/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:pw})}).then(r=>console.log("__DS__"+r.status)).catch(()=>console.log("__DS__000"))}')"
    case "${new_env_result}" in
      200) ok "auth: the service's DASHBOARD_PASSWORD is accepted by the live dashboard" ;;
      nopw)
        [[ -f "${DATA_DIR}/auth-password.json" ]] \
          || die "Live auth is on but the service environment has no DASHBOARD_PASSWORD and there is no stored password: it would start without auth."
        note "auth: no DASHBOARD_PASSWORD in the service environment, the stored password (data/auth-password.json) stays in effect"
        ;;
      401) die "The DASHBOARD_PASSWORD the service would use differs from the live dashboard's." ;;
      *) die "Could not verify the service password against the live dashboard (got '${new_env_result}')." ;;
    esac
  else
    ok "auth: live dashboard has none"
  fi
}

xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

# render_plist <label> <subcommand> <stdout path> <service|probe>
render_plist() {
  local label="$1" subcommand="$2" output_path="$3" kind="$4"
  local script_path escaped_repo escaped_output
  script_path="$(printf '%s' "${REPO_ROOT}/scripts/dev-service.sh" | xml_escape)"
  escaped_repo="$(printf '%s' "${REPO_ROOT}" | xml_escape)"
  escaped_output="$(printf '%s' "${output_path}" | xml_escape)"
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${script_path}</string>
    <string>${subcommand}</string>
  </array>
  <key>WorkingDirectory</key><string>${escaped_repo}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LANG</key><string>${SERVICE_LANG}</string>
  </dict>
  <key>RunAtLoad</key><true/>
$([[ "${kind}" == "service" ]] && cat <<SERVICE_KEYS
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ExitTimeOut</key><integer>30</integer>
  <key>ProcessType</key><string>Interactive</string>
SERVICE_KEYS
)
  <key>StandardOutPath</key><string>${escaped_output}</string>
  <key>StandardErrorPath</key><string>${escaped_output}</string>
</dict>
</plist>
PLIST
}

wait_new_runner() {
  local previous_pid="$1" deadline=$((SECONDS + 60)) current_pid
  while (( SECONDS < deadline )); do
    current_pid="$(runner_pid)"
    [[ -n "${current_pid}" && "${current_pid}" != "${previous_pid}" ]] && return 0
    sleep 1
  done
  return 1
}

# Fail closed: with an expected password, anything but a 401 on the login route (a confirmed 200,
# or no confirmation within the window) means the service must not stay installed, because it
# could start answering without a password later or at the next login. 90s covers a cold start
# (login shell, nvm, tmux cleanup before the server listens).
confirm_auth_protected() {
  [[ "${AUTH_EXPECTED}" == "on" ]] || return 0
  local deadline=$((SECONDS + 90)) code
  while (( SECONDS < deadline )); do
    code="$(random_login_code)"
    [[ "${code}" == "401" ]] && return 0
    [[ "${code}" == "200" ]] && return 1
    sleep 3
  done
  return 1
}

remove_unprotected_service() {
  launchctl bootout "${USER_DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
  wait_gone "${LABEL}" || true
  rm -f "${PLIST_PATH}"
  echo "The service was removed (plist deleted) because it could not be confirmed to require a password." >&2
  case "${AUTH_REASON}" in
    caller_only)
      echo "Your DASHBOARD_PASSWORD only exists in this terminal and the service cannot see it." >&2
      echo "Export it in ~/.zprofile or ~/.zshenv, or rerun without that variable to install without a password." >&2
      ;;
    stored_on_only)
      echo "A password was configured before and no longer is (no data/auth-password.json, no DASHBOARD_PASSWORD for the service)." >&2
      echo "To accept running without a password: $(accept_no_password_command)" >&2
      ;;
    *)
      echo "Check that DASHBOARD_PASSWORD is exported in ~/.zprofile or ~/.zshenv (not only in an open terminal) and that data/auth-password.json is valid." >&2
      ;;
  esac
  echo "Then retry: $(retry_command)" >&2
  exit 1
}

install_service() {
  local skip_live_auth="no"
  [[ "${1:-}" == "--no-live-check" ]] && skip_live_auth="yes"

  [[ "$(uname -s)" == "Darwin" ]] || die "macOS only (launchd)."
  mkdir -p "${DATA_DIR}" "${HOME}/Library/LaunchAgents"
  chmod 0700 "${DATA_DIR}"
  envcheck "${skip_live_auth}"

  local candidate_plist previous_pid
  candidate_plist="$(mktemp)"
  render_plist "${LABEL}" "run" "${SERVICE_LOG}" "service" > "${candidate_plist}"
  plutil -lint "${candidate_plist}" >/dev/null || { rm -f "${candidate_plist}"; die "Generated an invalid plist, not installing."; }

  if is_loaded "${LABEL}"; then
    if cmp -s "${candidate_plist}" "${PLIST_PATH}"; then
      rm -f "${candidate_plist}"
      previous_pid="$(runner_pid)"
      launchctl kickstart -k "${USER_DOMAIN}/${LABEL}" || die "kickstart failed"
      wait_new_runner "${previous_pid}" || true
      confirm_auth_protected || remove_unprotected_service
      wait_healthy 60 || die "Service did not come back healthy. Check: midev log"
      ok "Service restarted"
      return 0
    fi
    local plist_backup
    plist_backup="$(mktemp)"
    cp "${PLIST_PATH}" "${plist_backup}"
    launchctl bootout "${USER_DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
    wait_gone "${LABEL}" || note "old job still tearing down after 40s"
    cp "${candidate_plist}" "${PLIST_PATH}"
    rm -f "${candidate_plist}"
    launchctl bootstrap "${USER_DOMAIN}" "${PLIST_PATH}" || true
    wait_new_runner "" || true
    # Not restoring the previous plist on an auth failure: it has the same environment.
    confirm_auth_protected || { rm -f "${plist_backup}"; remove_unprotected_service; }
    if wait_healthy 60; then
      rm -f "${plist_backup}"
      ok "Service updated and running"
      return 0
    fi
    note "New configuration failed, restoring the previous one"
    launchctl bootout "${USER_DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
    wait_gone "${LABEL}" || true
    cp "${plist_backup}" "${PLIST_PATH}"
    launchctl bootstrap "${USER_DOMAIN}" "${PLIST_PATH}" || true
    rm -f "${plist_backup}"
    die "Install failed; the previous configuration was restored. Check: midev log"
  fi

  preflight
  cp "${candidate_plist}" "${PLIST_PATH}"
  rm -f "${candidate_plist}"
  if ! launchctl bootstrap "${USER_DOMAIN}" "${PLIST_PATH}"; then
    rm -f "${PLIST_PATH}"
    die "launchctl bootstrap failed; nothing was installed."
  fi
  wait_new_runner "" || true
  confirm_auth_protected || remove_unprotected_service
  if wait_healthy 60; then
    ok "Service installed and running (starts at login, restarts as a whole on failure)"
    return 0
  fi
  launchctl bootout "${USER_DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
  wait_gone "${LABEL}" || true
  rm -f "${PLIST_PATH}"
  echo "--- tail of ${SERVICE_LOG} ---" >&2
  tail -n 30 "${SERVICE_LOG}" >&2 || true
  die "Fresh install did not become healthy; job removed, ports are free. Retry: $(retry_command)"
}

uninstall_service() {
  launchctl bootout "${USER_DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
  wait_gone "${LABEL}" || note "something still holds ${SERVER_PORT}/${VITE_PORT}"
  rm -f "${PLIST_PATH}"
  ok "Service removed (nothing starts at login any more). Reinstall with: $(retry_command)"
}

# ---------------------------------------------------------------------------------------------
# deploy gates: run as a throwaway launchd job in the same domain and shape as the real service
# ---------------------------------------------------------------------------------------------

tccprobe() {
  local output_file shell_pid deadline
  output_file="$(mktemp)"
  /bin/zsh -lic 'node -e "require(\"fs\").readdirSync(process.env.HOME + \"/Desktop\")"; echo "__DS_RC__$?"' </dev/null >"${output_file}" 2>&1 &
  shell_pid=$!
  # Detached from job control so killing it on timeout does not print a "Killed: 9" notice into
  # the probe output.
  disown "${shell_pid}"
  deadline=$((SECONDS + 20))
  while kill -0 "${shell_pid}" 2>/dev/null && (( SECONDS < deadline )); do sleep 1; done
  if kill -0 "${shell_pid}" 2>/dev/null; then
    pkill -9 -P "${shell_pid}" 2>/dev/null || true
    kill -9 "${shell_pid}" 2>/dev/null || true
    echo "timeout"
  elif grep -qx '__DS_RC__0' "${output_file}"; then
    echo "ok"
  elif grep -qiE 'EPERM|not permitted' "${output_file}"; then
    echo "EPERM"
  else
    echo "error"
  fi
  rm -f "${output_file}"
}

# Stays alive after printing so that the bootout from probejob is a real teardown of a job that
# owns a tmux server.
tmuxprobe() {
  /bin/zsh -lic "tmux -L ccdash-probe new-session -d 'sleep 3600'" </dev/null >/dev/null 2>&1 && echo "ok" || echo "error"
  sleep 600
}

probejob() {
  local subcommand="${1:-}" result
  [[ "${subcommand}" == "tccprobe" || "${subcommand}" == "tmuxprobe" ]] || die "usage: probejob tccprobe|tmuxprobe"
  mkdir -p "${DATA_DIR}"
  SERVICE_LANG="$(detect_service_lang)"
  : > "${PROBE_OUT_PATH}"
  render_plist "${PROBE_LABEL}" "${subcommand}" "${PROBE_OUT_PATH}" "probe" > "${PROBE_PLIST_PATH}"
  launchctl bootstrap "${USER_DOMAIN}" "${PROBE_PLIST_PATH}" || { rm -f "${PROBE_PLIST_PATH}"; die "probe bootstrap failed"; }
  local deadline=$((SECONDS + 30))
  while ! grep -qxE 'ok|EPERM|timeout|error' "${PROBE_OUT_PATH}" 2>/dev/null && (( SECONDS < deadline )); do sleep 1; done
  result="$(grep -xE 'ok|EPERM|timeout|error' "${PROBE_OUT_PATH}" 2>/dev/null | tail -n 1)"
  [[ -n "${result}" ]] || result="timeout"
  launchctl bootout "${USER_DOMAIN}/${PROBE_LABEL}" >/dev/null 2>&1 || true
  wait_gone "${PROBE_LABEL}" no || true
  rm -f "${PROBE_PLIST_PATH}"
  echo "${subcommand}: ${result}"
  [[ "${result}" == "ok" ]]
}

# ---------------------------------------------------------------------------------------------
# setup: what setup.sh calls. Never fails; every problem becomes a warning with a retry command.
# ---------------------------------------------------------------------------------------------

# The directory the service's own login shell reads its dotfiles from: ~/.zshenv is read under
# env -i, a ZDOTDIR exported only in the invoking terminal is not. Both dotfile writers use it.
zsh_config_dir() {
  local config_dir
  config_dir="$(env -i HOME="${HOME}" USER="${USER}" /bin/zsh -c 'echo "${ZDOTDIR:-$HOME}"' 2>/dev/null)"
  echo "${config_dir:-${HOME}}"
}

# Starts on a fresh line so a file without a trailing newline does not get its last line fused.
append_block() {
  local file_path="$1" block="$2"
  mkdir -p "$(dirname "${file_path}")"
  touch "${file_path}"
  if [[ -s "${file_path}" && -n "$(tail -c 1 "${file_path}")" ]]; then
    printf '\n' >> "${file_path}"
  fi
  printf '%s\n' "${block}" >> "${file_path}"
}

# A function and not an alias, so the path is never re-parsed; the "function" form also avoids
# "defining function based on alias" when an alias named midev comes from another file.
add_alias() {
  local rc_path block
  rc_path="$(zsh_config_dir)/.zshrc"
  if grep -qE '^[[:space:]]*(alias midev=|function[[:space:]]+midev|midev[[:space:]]*\(\))' "${rc_path}" 2>/dev/null; then
    ok "midev is already defined in ${rc_path}"
    return 0
  fi
  block="$(printf '# dev + dist launchd service (scripts/dev-service.sh)\nfunction midev { bash %q "$@"; }' "${SCRIPT_PATH}")"
  append_block "${rc_path}" "${block}"
  ok "midev added to ${rc_path} (open a new terminal or: source ${rc_path})"
}

npm_resolves_for_service() {
  [[ -n "$(service_eval 'echo "__DS__$(command -v npm)"')" ]]
}

# On a clean machine Homebrew is only on PATH for the setup run; launchd's login shell needs
# brew shellenv in a dotfile it reads.
ensure_brew_in_login_shell() {
  npm_resolves_for_service && return 0
  local brew_bin="" candidate
  for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [[ -x "${candidate}" ]] && { brew_bin="${candidate}"; break; }
  done
  [[ -n "${brew_bin}" ]] || return 1
  local profile_path
  profile_path="$(zsh_config_dir)/.zprofile"
  if ! grep -q 'brew shellenv' "${profile_path}" 2>/dev/null; then
    append_block "${profile_path}" "eval \"\$(${brew_bin} shellenv)\""
    ok "Homebrew added to ${profile_path} so the service can find npm"
  fi
  npm_resolves_for_service
}

setup_service() {
  if [[ "${AI_MULTI_INSTANCE_SKIP_SERVICE:-}" == "1" ]]; then
    note "AI_MULTI_INSTANCE_SKIP_SERVICE=1: not installing the dev service (pass it on every setup.sh run to keep it off)."
    return 0
  fi
  SERVICE_LANG="$(detect_service_lang)"
  add_alias || note "could not add the midev function to your zsh config"

  if [[ -f "${OTHER_SERVICE_PLIST_PATH}" ]]; then
    note "${OTHER_SERVICE_LABEL} is installed and uses the same ports, so the dev service was not installed."
    echo "      Remove it with: $(uninstall_other_command)"
    echo "      Then run: $(retry_command)"
    return 0
  fi
  if ! is_loaded "${LABEL}"; then
    local port
    for port in "${SERVER_PORT}" "${VITE_PORT}"; do
      if [[ -n "$(listeners_on "${port}")" ]]; then
        note "Something else is listening on port ${port} (a manual npm run dev?), so the dev service was not installed."
        echo "      Close it and run: $(retry_command)"
        return 0
      fi
    done
  fi
  if ! ensure_brew_in_login_shell; then
    note "npm does not resolve in a login shell without a terminal (what launchd runs), so the dev service was not installed."
    echo "      Make sure node/npm is on the PATH set by ~/.zprofile or ~/.zshenv, then run: $(retry_command)"
    return 0
  fi

  local probe_output probe_result
  probe_output="$(bash "${SCRIPT_PATH}" probejob tccprobe 2>&1 || true)"
  probe_result="$(echo "${probe_output}" | grep -E '^tccprobe: ' | tail -n 1 | sed 's/^tccprobe: //')"
  case "${probe_result}" in
    ok) ok "launchd jobs can read ~/Desktop" ;;
    EPERM)
      note "launchd jobs cannot read ~/Desktop (macOS privacy). Agent sessions in Desktop/Documents will fail until /bin/bash has Full Disk Access"
      echo "      (System Settings > Privacy & Security > Full Disk Access). This is a broad permission: your call."
      ;;
    timeout) note "the permission probe timed out (an unanswered macOS permission dialog, or a slow ~/.zshrc). Continuing." ;;
    *) note "could not run the permission probe: $(echo "${probe_output}" | tail -n 1). Continuing." ;;
  esac

  if ! bash "${SCRIPT_PATH}" install --no-live-check; then
    note "the dev service did not come up. Check: bash $(printf '%q' "${SCRIPT_PATH}") log"
    echo "      Retry: $(retry_command)"
    echo "      Or run the dashboard by hand: npm run dev"
  fi
  return 0
}

# ---------------------------------------------------------------------------------------------
# user-facing commands
# ---------------------------------------------------------------------------------------------

restart_service() {
  local deadline=$((SECONDS + 60)) previous_pid current_pid
  if is_loaded "${LABEL}"; then
    previous_pid="$(runner_pid)"
    launchctl kickstart -k "${USER_DOMAIN}/${LABEL}" || die "kickstart failed"
    # The old tree can still answer for a few seconds, so wait for the new runner before probing.
    while (( SECONDS < deadline )); do
      current_pid="$(runner_pid)"
      [[ -n "${current_pid}" && "${current_pid}" != "${previous_pid}" ]] && break
      sleep 1
    done
  else
    [[ -f "${PLIST_PATH}" ]] || die "Not installed. Run: $(retry_command)"
    preflight
    launchctl bootstrap "${USER_DOMAIN}" "${PLIST_PATH}" || die "bootstrap failed"
  fi
  if wait_healthy $(( deadline - SECONDS > 10 ? deadline - SECONDS : 10 )); then
    ok "dev + dist are up (server :${SERVER_PORT}, vite :${VITE_PORT})"
  else
    die "Did not become healthy in time. Check: midev log"
  fi
}

case "${1:-restart}" in
  run) run_service ;;
  install) install_service "${2:-}" ;;
  probejob) probejob "${2:-}" ;;
  tccprobe) tccprobe ;;
  tmuxprobe) tmuxprobe ;;
  setup) setup_service ;;
  uninstall) uninstall_service ;;
  healthy) is_loaded "${LABEL}" && [[ "$(probe_port "${SERVER_PORT}")" != "000" && "$(probe_port "${VITE_PORT}")" != "000" ]] ;;
  stop)
    launchctl bootout "${USER_DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
    wait_gone "${LABEL}" && ok "Stopped (comes back at next login, or run: midev)" || note "Stopped, but something still holds ${SERVER_PORT}/${VITE_PORT}"
    ;;
  log) exec tail -f "${SERVICE_LOG}" ;;
  status)
    launchctl print "${USER_DOMAIN}/${LABEL}" 2>&1 | grep -E 'state =|pid =|last exit|runs =|Could not find' || true
    echo "server :${SERVER_PORT} -> $(probe_port "${SERVER_PORT}")   vite :${VITE_PORT} -> $(probe_port "${VITE_PORT}")"
    ;;
  restart) restart_service ;;
  *) die "usage: midev [setup | install [--no-live-check] | uninstall | stop | log | status]" ;;
esac
