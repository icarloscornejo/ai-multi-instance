#!/usr/bin/env bash
#
# OPTIONAL. Installs the Cloudflare Named Tunnel connector as a per-user launchd LaunchAgent
# (com.ai-multi-instance.tunnel). Unlike the dashboard server, the connector is meant to be a
# long-lived background service that survives restarts of the Node process and of the machine.
#
# Requires scripts/setup-named-tunnel.sh to have been run first (it writes data/named-tunnel/).
#
# The LaunchAgent's KeepAlive is driven by a sentinel file, data/named-tunnel/enabled:
#   - while it exists, launchd keeps the connector running and restarts it on crash
#   - remove it (npm run tunnel:stop, or the dashboard's Stop button) and the connector stays
#     down, including across reboot
# So "installed" and "running" are separate states: this script never starts a tunnel the user
# has deliberately stopped.
#
# Usage:
#   bash scripts/install-tunnel-service.sh      # install/update; starts it only on a FRESH install
#   npm run tunnel:uninstall                    # remove the service
#
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script is for macOS only (launchd)." >&2
  exit 1
fi

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAMED_DIR="${INSTALL_DIR}/data/named-tunnel"
TUNNEL_JSON="${NAMED_DIR}/tunnel.json"
CONFIG_YML="${NAMED_DIR}/config.yml"
SENTINEL="${NAMED_DIR}/enabled"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[1;32m    ✓ %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m    ! %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31m    ✗ %s\033[0m\n' "$1" >&2; exit 1; }

step "Named tunnel connector service (launchd)"

[[ -f "${TUNNEL_JSON}" && -f "${CONFIG_YML}" ]] || die "data/named-tunnel/ is not set up. Run: bash scripts/setup-named-tunnel.sh <hostname>"
command -v jq >/dev/null 2>&1 || die "jq is not installed. Run: brew install jq"
CLOUDFLARED_BIN="$(command -v cloudflared || true)"
[[ -n "${CLOUDFLARED_BIN}" ]] || die "cloudflared is not installed. Run: brew install cloudflared"

METRICS_PORT="$(jq -r '.metricsPort' "${TUNNEL_JSON}")"
[[ "${METRICS_PORT}" =~ ^[0-9]+$ ]] || die "metricsPort in tunnel.json is not a number."

LABEL="com.ai-multi-instance.tunnel"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
DOMAIN_TARGET="gui/$(id -u)/${LABEL}"
BOOTSTRAP_TARGET="gui/$(id -u)"
LAUNCHD_STDERR_LOG="${INSTALL_DIR}/data/cloudflared-launchd.log"

# launchd opens StandardErrorPath before exec and only creates the file, not the directory.
mkdir -p "${NAMED_DIR}"
chmod 0700 "${INSTALL_DIR}/data" "${NAMED_DIR}"
: > "${LAUNCHD_STDERR_LOG}" || die "Could not create ${LAUNCHD_STDERR_LOG}"
chmod 0600 "${LAUNCHD_STDERR_LOG}"

# Rotate cloudflared's own log by RENAME (never truncate in place): a running connector, or
# launchd, may hold an fd on that inode. Same reasoning as scripts/install-service.sh.
CLOUDFLARED_LOG="${INSTALL_DIR}/data/cloudflared.log"
LOG_MAX_BYTES=$((5 * 1024 * 1024))
if [[ -f "${CLOUDFLARED_LOG}" ]]; then
  size="$(stat -f%z "${CLOUDFLARED_LOG}" 2>/dev/null || echo 0)"
  if [[ "${size}" -gt "${LOG_MAX_BYTES}" ]]; then
    mv -f "${CLOUDFLARED_LOG}" "${CLOUDFLARED_LOG}.1"
    ok "Rotated an oversized data/cloudflared.log"
  fi
fi

# Was the service already installed, and is the tunnel currently meant to be up? These decide
# whether this run is allowed to start anything.
SERVICE_WAS_LOADED=0
launchctl print "${DOMAIN_TARGET}" >/dev/null 2>&1 && SERVICE_WAS_LOADED=1
SENTINEL_PRESENT=0
[[ -f "${SENTINEL}" ]] && SENTINEL_PRESENT=1

step "Rendering ${PLIST_PATH}"

plist_candidate="$(mktemp)"
INSTALL_DIR="${INSTALL_DIR}" LABEL="${LABEL}" CLOUDFLARED_BIN="${CLOUDFLARED_BIN}" \
  CONFIG_YML="${CONFIG_YML}" SENTINEL="${SENTINEL}" STDERR_LOG="${LAUNCHD_STDERR_LOG}" \
  PLIST_OUTPUT_PATH="${plist_candidate}" python3 - <<'PY'
import os
import xml.sax.saxutils as x

e = x.escape
label = os.environ["LABEL"]
cloudflared = os.environ["CLOUDFLARED_BIN"]
config = os.environ["CONFIG_YML"]
sentinel = os.environ["SENTINEL"]
stderr_log = os.environ["STDERR_LOG"]
workdir = os.environ["INSTALL_DIR"]
out = os.environ["PLIST_OUTPUT_PATH"]

plist = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{e(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{e(cloudflared)}</string>
    <string>tunnel</string>
    <string>--config</string>
    <string>{e(config)}</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key><string>{e(workdir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NO_AUTOUPDATE</key><string>1</string>
    <key>TUNNEL_ORIGIN_CERT</key><string>{e(os.path.expanduser("~/.cloudflared/cert.pem"))}</string>
  </dict>
  <key>RunAtLoad</key><false/>
  <key>KeepAlive</key>
  <dict>
    <key>PathState</key>
    <dict>
      <key>{e(sentinel)}</key><true/>
    </dict>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>{e(stderr_log)}</string>
</dict>
</plist>
"""
with open(out, "w") as f:
    f.write(plist)
PY

plutil -lint "${plist_candidate}" >/dev/null || { rm -f "${plist_candidate}"; die "Generated an invalid plist."; }

# Health check: only meaningful when the tunnel is supposed to be running.
health_check_ready() {
  local attempt
  for attempt in $(seq 1 15); do
    if curl -sf "http://127.0.0.1:${METRICS_PORT}/ready" 2>/dev/null | grep -q '"readyConnections":[1-9]'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

step "Installing"

plist_backup=""
if [[ -f "${PLIST_PATH}" ]]; then
  plist_backup="$(mktemp)"
  cp "${PLIST_PATH}" "${plist_backup}"
fi

mkdir -p "${HOME}/Library/LaunchAgents"
cp "${plist_candidate}" "${PLIST_PATH}"
rm -f "${plist_candidate}"

launchctl bootout "${DOMAIN_TARGET}" >/dev/null 2>&1 || true
if ! launchctl bootstrap "${BOOTSTRAP_TARGET}" "${PLIST_PATH}"; then
  warn "bootstrap failed, rolling back"
  launchctl bootout "${DOMAIN_TARGET}" >/dev/null 2>&1 || true
  if [[ -n "${plist_backup}" ]]; then
    cp "${plist_backup}" "${PLIST_PATH}"
    launchctl bootstrap "${BOOTSTRAP_TARGET}" "${PLIST_PATH}" >/dev/null 2>&1 || true
    rm -f "${plist_backup}"
    die "Rolled back to the previous connector service."
  fi
  rm -f "${PLIST_PATH}"
  die "Fresh install failed; no service is left behind."
fi
[[ -n "${plist_backup}" ]] && rm -f "${plist_backup}"

if [[ "${SERVICE_WAS_LOADED}" -eq 1 ]]; then
  # Reinstall: preserve whatever run state the user had. Never implicitly start a stopped tunnel.
  if [[ "${SENTINEL_PRESENT}" -eq 1 ]]; then
    launchctl kickstart "${DOMAIN_TARGET}" >/dev/null 2>&1 || true
    if health_check_ready; then
      ok "Connector service updated and running"
    else
      warn "Service updated but /ready did not report a connection. Check: npm run tunnel:log"
    fi
  else
    launchctl print "${DOMAIN_TARGET}" >/dev/null 2>&1 && ok "Connector service updated (tunnel stays stopped, as it was)"
  fi
else
  # Fresh install: bring the tunnel up once, with rollback if it never becomes ready.
  step "Starting the tunnel"
  mkdir -p "${NAMED_DIR}"
  : > "${SENTINEL}"
  launchctl kickstart "${DOMAIN_TARGET}" >/dev/null 2>&1 || true
  if health_check_ready; then
    ok "Connector installed and running ($(curl -sf "http://127.0.0.1:${METRICS_PORT}/ready" | jq -r '.readyConnections') edge connections)"
  else
    warn "Connector did not become ready. Rolling back."
    rm -f "${SENTINEL}"
    launchctl bootout "${DOMAIN_TARGET}" >/dev/null 2>&1 || true
    rm -f "${PLIST_PATH}"
    die "Check ${LAUNCHD_STDERR_LOG} and data/cloudflared.log, fix the config, and rerun."
  fi
fi

cat <<EOF

  Manage it with:
    npm run tunnel:status     # launchctl print
    npm run tunnel:log        # tail data/cloudflared.log
    npm run tunnel:stop       # stop, and keep it stopped across reboot
    npm run tunnel:start      # start again
  Or use the Start/Stop buttons on the dashboard's Setup screen (ai.local only).
EOF
