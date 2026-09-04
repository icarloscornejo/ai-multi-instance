#!/usr/bin/env bash
#
# OPTIONAL, one-time. Provisions a Cloudflare *Named* Tunnel for this machine so the dashboard
# is reachable at a stable hostname on a domain you own, instead of the random *.trycloudflare.com
# URL the built-in Quick Tunnel gives you. This is opt-in: without it, remote access stays on the
# Quick Tunnel and needs no account or domain.
#
# Prerequisites:
#   - `cloudflared` installed (brew install cloudflared)
#   - You have run `cloudflared login` once, so ~/.cloudflared/cert.pem exists and is scoped to
#     the Cloudflare zone that owns your domain
#   - `jq` installed (already a dependency of this project)
#
# Usage:
#   bash scripts/setup-named-tunnel.sh <public-hostname> [tunnel-name] [--no-install]
#   e.g. bash scripts/setup-named-tunnel.sh protom4-mi.example.com
#
# The convention this project uses for the hostname is <machine>-mi.<your-domain> (one label
# under the apex, so Cloudflare's free Universal SSL covers it). tunnel-name defaults to the
# first DNS label of the hostname.
#
# By default this runs end to end: provisions the tunnel + DNS + config, then installs and
# starts the connector service (scripts/install-tunnel-service.sh). Pass --no-install to stop
# after writing the config. The dashboard picks up named mode with no restart.
#
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script is for macOS only." >&2
  exit 1
fi

PUBLIC_HOSTNAME=""
TUNNEL_NAME=""
RUN_INSTALL=1
for arg in "$@"; do
  case "${arg}" in
    --no-install) RUN_INSTALL=0 ;;
    *)
      if [[ -z "${PUBLIC_HOSTNAME}" ]]; then PUBLIC_HOSTNAME="${arg}"
      elif [[ -z "${TUNNEL_NAME}" ]]; then TUNNEL_NAME="${arg}"
      fi
      ;;
  esac
done
if [[ -z "${PUBLIC_HOSTNAME}" ]]; then
  echo "Usage: bash scripts/setup-named-tunnel.sh <public-hostname> [tunnel-name] [--no-install]" >&2
  exit 1
fi
TUNNEL_NAME="${TUNNEL_NAME:-${PUBLIC_HOSTNAME%%.*}}"

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAMED_DIR="${INSTALL_DIR}/data/named-tunnel"
CLOUDFLARED_HOME="${HOME}/.cloudflared"
CERT_PEM="${CLOUDFLARED_HOME}/cert.pem"
QUICK_TUNNEL_CONFIG="${CLOUDFLARED_HOME}/config.yml"
METRICS_PORT="20241"
PROTOCOL="auto"
ORIGIN_SERVICE="http://127.0.0.1:3001"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[1;32m    ✓ %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m    ! %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31m    ✗ %s\033[0m\n' "$1" >&2; exit 1; }

step "Preconditions"

command -v cloudflared >/dev/null 2>&1 || die "cloudflared is not installed. Run: brew install cloudflared"
command -v jq >/dev/null 2>&1 || die "jq is not installed. Run: brew install jq"
[[ -f "${CERT_PEM}" ]] || die "${CERT_PEM} not found. Run: cloudflared login"

# The named tunnel exposes the dashboard publicly. The password gate must be on first, otherwise
# the server fails every request to the public hostname closed (server/src/requestHost.ts) and
# the tunnel is useless anyway. Warn loudly but don't block provisioning (which exposes nothing
# on its own - the connector isn't running yet).
if [[ -z "${DASHBOARD_PASSWORD:-}" && ! -f "${INSTALL_DIR}/data/auth-password.json" ]]; then
  warn "No dashboard password is set (no DASHBOARD_PASSWORD env var, no data/auth-password.json)."
  echo   "      Set one on http://ai.local (Setup screen) or export DASHBOARD_PASSWORD before the"
  echo   "      connector will serve anything on the public hostname."
fi

# A config file at cloudflared's default path makes `cloudflared tunnel --url` (the Quick Tunnel
# this project still uses by default) refuse to run. This project keeps the Named Tunnel's config
# under data/ specifically to avoid that, so if the default path is occupied something else put
# it there and we must not silently coexist with it.
if [[ -e "${QUICK_TUNNEL_CONFIG}" ]]; then
  die "${QUICK_TUNNEL_CONFIG} exists. This project keeps its tunnel config under data/named-tunnel/ so the built-in Quick Tunnel keeps working. Move or remove that file, then rerun."
fi
ok "cloudflared, jq, cert.pem present; no conflicting ~/.cloudflared/config.yml"

step "Tunnel '${TUNNEL_NAME}'"

# `cloudflared tunnel list --output json` returns [{ id, name, ... }]. Match by exact name.
EXISTING_ID="$(cloudflared tunnel list --output json 2>/dev/null | jq -r --arg n "${TUNNEL_NAME}" '[.[] | select(.name == $n)] | .[0].id // empty')"

if [[ -n "${EXISTING_ID}" ]]; then
  TUNNEL_ID="${EXISTING_ID}"
  CREDENTIALS_FILE="${CLOUDFLARED_HOME}/${TUNNEL_ID}.json"
  # A tunnel can exist on the account while its credentials file lives only on the machine that
  # ran `tunnel create`. Running the connector needs that file; without it this whole setup would
  # produce a config pointing at nothing.
  [[ -f "${CREDENTIALS_FILE}" ]] || die "Tunnel '${TUNNEL_NAME}' (${TUNNEL_ID}) already exists but ${CREDENTIALS_FILE} is not on this machine. Delete the tunnel in the Cloudflare dashboard and rerun to create a fresh one, or copy its credentials JSON here."
  ok "Reusing existing tunnel ${TUNNEL_ID} (credentials present)"
else
  cloudflared tunnel create "${TUNNEL_NAME}" >/dev/null
  TUNNEL_ID="$(cloudflared tunnel list --output json | jq -r --arg n "${TUNNEL_NAME}" '[.[] | select(.name == $n)] | .[0].id // empty')"
  [[ -n "${TUNNEL_ID}" ]] || die "Created tunnel '${TUNNEL_NAME}' but could not read its id back."
  CREDENTIALS_FILE="${CLOUDFLARED_HOME}/${TUNNEL_ID}.json"
  [[ -f "${CREDENTIALS_FILE}" ]] || die "Created tunnel ${TUNNEL_ID} but ${CREDENTIALS_FILE} was not written."
  ok "Created tunnel ${TUNNEL_ID}"
fi

step "DNS route ${PUBLIC_HOSTNAME}"

# `cloudflared tunnel route dns <tunnel> <hostname>` creates a proxied CNAME. It fails (non-zero)
# rather than clobbering if a record for that hostname already exists and points somewhere else.
# We deliberately do NOT pass --overwrite-dns: a pre-existing record is something the user has to
# look at, not something this script should silently take over.
if cloudflared tunnel route dns "${TUNNEL_NAME}" "${PUBLIC_HOSTNAME}" 2>/tmp/cf-route-dns.err; then
  ok "DNS record for ${PUBLIC_HOSTNAME} points at this tunnel"
else
  if grep -qi "already exists\|record with that host" /tmp/cf-route-dns.err; then
    warn "A DNS record for ${PUBLIC_HOSTNAME} already exists."
    echo   "      If it already points at THIS tunnel (${TUNNEL_ID}), you're fine, continuing."
    echo   "      If it points at something else, fix it in the Cloudflare dashboard before installing the service."
  else
    cat /tmp/cf-route-dns.err >&2
    die "cloudflared tunnel route dns failed (see above)."
  fi
fi

step "Writing config under data/named-tunnel/"

mkdir -p "${NAMED_DIR}"
chmod 0700 "${INSTALL_DIR}/data" "${NAMED_DIR}"

CONFIG_YML="${NAMED_DIR}/config.yml"
TUNNEL_JSON="${NAMED_DIR}/tunnel.json"

cat > "${CONFIG_YML}" <<YAML
# Generated by scripts/setup-named-tunnel.sh - do not edit by hand, rerun the script instead.
# Passed to cloudflared with an explicit --config so it never touches ~/.cloudflared/config.yml
# (which would break the built-in Quick Tunnel).
tunnel: ${TUNNEL_ID}
credentials-file: ${CREDENTIALS_FILE}
protocol: ${PROTOCOL}
metrics: 127.0.0.1:${METRICS_PORT}
logfile: ${INSTALL_DIR}/data/cloudflared.log
no-autoupdate: true
ingress:
  - hostname: ${PUBLIC_HOSTNAME}
    service: ${ORIGIN_SERVICE}
  - service: http_status:404
YAML
chmod 0600 "${CONFIG_YML}"

cat > "${TUNNEL_JSON}" <<JSON
{
  "hostname": "${PUBLIC_HOSTNAME}",
  "tunnelName": "${TUNNEL_NAME}",
  "tunnelId": "${TUNNEL_ID}",
  "credentialsFile": "${CREDENTIALS_FILE}",
  "metricsPort": ${METRICS_PORT},
  "protocol": "${PROTOCOL}"
}
JSON
chmod 0600 "${TUNNEL_JSON}"

# Validate the ingress before declaring success: a typo here surfaces now, not at first connect.
# --config must come before the `ingress validate` subcommand, not after it.
cloudflared tunnel --config "${CONFIG_YML}" ingress validate >/dev/null || die "Generated ingress config failed validation."
ok "data/named-tunnel/config.yml and tunnel.json written (0600)"
ok "The dashboard is now in NAMED tunnel mode (no server restart needed)"

if [[ "${RUN_INSTALL}" -eq 1 ]]; then
  step "Installing the connector service"
  bash "${INSTALL_DIR}/scripts/install-tunnel-service.sh"
  cat <<EOF

  Done end to end. Manage the tunnel from the dashboard's Setup screen (ai.local), or with
  npm run tunnel:stop / tunnel:start / tunnel:log / tunnel:status.
  To go back to the Quick Tunnel: npm run tunnel:uninstall && rm data/named-tunnel/tunnel.json
EOF
else
  step "Done (config only)"
  cat <<EOF

  Skipped the connector install (--no-install). To bring it up:  npm run tunnel:install
  To go back to the Quick Tunnel: rm data/named-tunnel/tunnel.json
EOF
fi
