#!/usr/bin/env bash
#
# OPTIONAL. Installs the dashboard server as a per-user launchd LaunchAgent
# (com.ai-multi-instance.server): it restarts automatically on crash and comes back at login,
# so you don't have to keep a terminal open running `npm run dev`.
#
# This is NOT run automatically by setup.sh, and NOT required: the default, always-supported way
# to run the dashboard is still `npm run dev` in a terminal you start and stop yourself. Only run
# this script if you specifically want the always-on behavior. `npm run dev` and this service both
# want port 3001 - see README.md's Usage section for how the two coexist.
#
# Usage:
#   bash scripts/install-service.sh            # install/update and start the service
#   npm run service:uninstall                  # remove it, back to npm run dev only
#
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script is for macOS only (launchd)." >&2
  exit 1
fi

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[1;32m    ✓ %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m    ! %s\033[0m\n' "$1"; }

step "Dashboard service (launchd, optional)"

SERVICE_LABEL="com.ai-multi-instance.server"
SERVICE_PLIST_PATH="${HOME}/Library/LaunchAgents/${SERVICE_LABEL}.plist"
SERVICE_DOMAIN_TARGET="gui/$(id -u)/${SERVICE_LABEL}"
SERVICE_BOOTSTRAP_TARGET="gui/$(id -u)"
LAUNCHD_STDERR_LOG="${INSTALL_DIR}/data/launchd-stderr.log"

# launchd opens StandardErrorPath BEFORE running the program, and only creates the FILE, never the
# directory. data/ is entirely gitignored (no files are ever committed there), so on a clean clone
# it doesn't exist yet - without this, the very first bootstrap would fail before npm start ever runs.
mkdir -p "${INSTALL_DIR}/data"
chmod 0700 "${INSTALL_DIR}/data"
if ! ( : > "${LAUNCHD_STDERR_LOG}" ) 2>/dev/null; then
  warn "Could not create ${LAUNCHD_STDERR_LOG} for writing. Check permissions on ${INSTALL_DIR}/data."
  exit 1
fi
chmod 0600 "${LAUNCHD_STDERR_LOG}"
ok "data/ ready (0700, no sudo needed)"

# Rotate by RENAME, never truncate/rewrite in place: launchd itself may be holding an fd open on
# this exact inode from a still-running job (see server/src/serverLog.ts for why server.log, which
# only the Node process itself ever writes, can safely trim itself in place instead - this file is
# different, launchd is the sole writer here).
LAUNCHD_STDERR_LOG_MAX_BYTES=$((5 * 1024 * 1024))
if [[ -f "${LAUNCHD_STDERR_LOG}" ]]; then
  current_log_size="$(stat -f%z "${LAUNCHD_STDERR_LOG}" 2>/dev/null || echo 0)"
  if [[ "${current_log_size}" -gt "${LAUNCHD_STDERR_LOG_MAX_BYTES}" ]]; then
    mv -f "${LAUNCHD_STDERR_LOG}" "${LAUNCHD_STDERR_LOG}.1"
    : > "${LAUNCHD_STDERR_LOG}"
    chmod 0600 "${LAUNCHD_STDERR_LOG}"
    ok "Rotated an oversized data/launchd-stderr.log"
  fi
fi

# Render the plist with explicit XML escaping of INSTALL_DIR: a raw &, <, or > in the path would
# otherwise produce invalid XML - combined with the bootout further down, that could leave the
# dashboard stopped with no service to fall back on.
plist_candidate="$(mktemp)"
INSTALL_DIR="${INSTALL_DIR}" SERVICE_LABEL="${SERVICE_LABEL}" PLIST_OUTPUT_PATH="${plist_candidate}" python3 - <<'PY'
import os
import xml.sax.saxutils as saxutils

install_dir = os.environ["INSTALL_DIR"]
label = os.environ["SERVICE_LABEL"]
output_path = os.environ["PLIST_OUTPUT_PATH"]

working_directory = saxutils.escape(install_dir)
stderr_log_path = saxutils.escape(f"{install_dir}/data/launchd-stderr.log")

plist = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{saxutils.escape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>exec npm start</string>
  </array>
  <key>WorkingDirectory</key><string>{working_directory}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AI_MULTI_INSTANCE_SUPERVISED</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>{stderr_log_path}</string>
</dict>
</plist>
"""

with open(output_path, "w") as handle:
    handle.write(plist)
PY

if ! plutil -lint "${plist_candidate}" >/dev/null; then
  warn "Generated an invalid dashboard service plist - not installing it."
  rm -f "${plist_candidate}"
  exit 1
fi

health_check_service() {
  local attempt
  for attempt in $(seq 1 10); do
    if curl -sf -o /dev/null "http://127.0.0.1:3001/"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

if lsof -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1 && ! launchctl print "${SERVICE_DOMAIN_TARGET}" >/dev/null 2>&1; then
  warn "Something is already listening on port 3001 that isn't this service (probably npm run dev)."
  echo   "      Stop it first, then rerun this script."
  exit 1
fi

service_was_loaded=0
launchctl print "${SERVICE_DOMAIN_TARGET}" >/dev/null 2>&1 && service_was_loaded=1

plist_unchanged=0
[[ -f "${SERVICE_PLIST_PATH}" ]] && cmp -s "${SERVICE_PLIST_PATH}" "${plist_candidate}" && plist_unchanged=1

if [[ "${plist_unchanged}" -eq 1 && "${service_was_loaded}" -eq 1 ]]; then
  rm -f "${plist_candidate}"
  if launchctl kickstart -k "${SERVICE_DOMAIN_TARGET}" && health_check_service; then
    ok "Dashboard service restarted"
  else
    warn "Dashboard service did not come back healthy after a restart. Check: npm run service:log"
  fi
else
  # Either a fresh install or the plist changed: install with rollback. set -e (top of this script)
  # means an unconditional bootout followed by a failed bootstrap would otherwise abort THIS script
  # with the old, working service already torn down. Keep a backup and restore it on any failure.
  plist_backup=""
  if [[ -f "${SERVICE_PLIST_PATH}" ]]; then
    plist_backup="$(mktemp)"
    cp "${SERVICE_PLIST_PATH}" "${plist_backup}"
  fi

  install_ok=1
  mkdir -p "${HOME}/Library/LaunchAgents"
  cp "${plist_candidate}" "${SERVICE_PLIST_PATH}"
  launchctl bootout "${SERVICE_DOMAIN_TARGET}" >/dev/null 2>&1 || true
  if ! launchctl bootstrap "${SERVICE_BOOTSTRAP_TARGET}" "${SERVICE_PLIST_PATH}" || ! health_check_service; then
    install_ok=0
  fi

  if [[ "${install_ok}" -eq 1 ]]; then
    ok "Dashboard service installed and running (restarts on crash and at login, no sudo needed)"
  else
    warn "Dashboard service failed to come up - rolling back the launchd configuration."
    launchctl bootout "${SERVICE_DOMAIN_TARGET}" >/dev/null 2>&1 || true
    if [[ -n "${plist_backup}" ]]; then
      cp "${plist_backup}" "${SERVICE_PLIST_PATH}"
      if launchctl bootstrap "${SERVICE_BOOTSTRAP_TARGET}" "${SERVICE_PLIST_PATH}" && health_check_service; then
        warn "Rolled back to the previous dashboard service configuration; it is running again."
      else
        warn "Rollback of the dashboard service also failed. Check manually: npm run service:status"
      fi
    else
      warn "No previous dashboard service configuration to roll back to (this was a fresh install)."
    fi
    echo   "      Note: this rollback only restores the launchd CONFIGURATION (the plist)."
    echo   "      If the new code itself fails to start - not the plist - the restored plist will"
    echo   "      relaunch that SAME new code. That case needs a manual code fix, not this script."
    [[ -n "${plist_backup}" ]] && rm -f "${plist_backup}"
    rm -f "${plist_candidate}"
    exit 1
  fi
  [[ -n "${plist_backup}" ]] && rm -f "${plist_backup}"
  rm -f "${plist_candidate}"
fi

# A plain `zsh -lc` here would inherit whatever THIS shell already has exported, even if it's
# absent from every init file - a false "it's fine" that says nothing about what launchd's own
# environment (which does NOT come from this shell) will actually have. env -i with a minimal
# environment forces the check through the same login-shell init files (~/.zshenv, ~/.zprofile -
# NOT ~/.zshrc: a non-interactive `zsh -l` never sources that) launchd's own "/bin/zsh -lc" goes
# through, so this can't give a false all-clear the way checking the current shell would.
warn_if_env_var_unreachable_from_service() {
  local var_name="$1"
  local current_value="${!var_name:-}"
  if [[ -z "${current_value}" ]]; then
    return 0
  fi
  local reachable
  reachable="$(env -i HOME="${HOME}" USER="${USER}" /bin/zsh -lc "echo -n \"\${${var_name}:+set}\"" 2>/dev/null || true)"
  if [[ -z "${reachable}" ]]; then
    warn "${var_name} is set in this shell but not reachable from a login shell."
    echo   "      The dashboard service won't see it. Move it from ~/.zshrc into ~/.zshenv or ~/.zprofile."
  fi
}
warn_if_env_var_unreachable_from_service "CLAUDE_CODE_USE_VERTEX"
warn_if_env_var_unreachable_from_service "DASHBOARD_PASSWORD"

cat <<EOF

  The dashboard service is running: open http://ai.local
  It now owns port 3001, so a plain "npm run dev" will fail with EADDRINUSE until you either
  stop the service (npm run service:stop) or remove it for good (npm run service:uninstall).
EOF
