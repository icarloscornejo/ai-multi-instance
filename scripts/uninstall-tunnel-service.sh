#!/usr/bin/env bash
# Undoes install-tunnel-service.sh: stops the Cloudflare Named Tunnel connector, removes its
# launchd plist, and clears the run sentinel. The dashboard falls back to the built-in Quick
# Tunnel as long as data/named-tunnel/tunnel.json still exists; delete that too to fully leave
# named mode.
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.ai-multi-instance.tunnel"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
SENTINEL="${INSTALL_DIR}/data/named-tunnel/enabled"

rm -f "${SENTINEL}"
launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
rm -f "${PLIST_PATH}"

echo "Named tunnel connector service removed."
echo "data/named-tunnel/tunnel.json is untouched; remove it to return to the Quick Tunnel."
