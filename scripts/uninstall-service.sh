#!/usr/bin/env bash
# Undoes install-service.sh: stops the dashboard's launchd service and removes its plist, so
# `npm run dev` goes back to being the only way the dashboard runs, with no port-3001 conflict.
set -euo pipefail

SERVICE_LABEL="com.ai-multi-instance.server"
SERVICE_PLIST_PATH="${HOME}/Library/LaunchAgents/${SERVICE_LABEL}.plist"

launchctl bootout "gui/$(id -u)/${SERVICE_LABEL}" >/dev/null 2>&1 || true
rm -f "${SERVICE_PLIST_PATH}"
echo "Dashboard service removed. Port 3001 is free; run npm run dev whenever you want it up."
