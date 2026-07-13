#!/usr/bin/env bash
#
# Automated setup for claude-multi-instance on macOS.
# Installs everything that can be automated (Homebrew, git, tmux, node, Claude Code),
# clones the repo, and leaves the dashboard ready to start.
# What must be done manually is listed in the final checklist.
#
# Usage (sources in order: raw GitHub, GitHub API, jsDelivr mirror):
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/icarloscornejo/claude-multi-instance/main/setup.sh || curl -fsSL -H 'Accept: application/vnd.github.raw' https://api.github.com/repos/icarloscornejo/claude-multi-instance/contents/setup.sh || curl -fsSL https://cdn.jsdelivr.net/gh/icarloscornejo/claude-multi-instance@main/setup.sh)"
#
set -euo pipefail

REPO_URL="https://github.com/icarloscornejo/claude-multi-instance.git"
INSTALL_DIR="${CLAUDE_DASHBOARD_DIR:-${HOME}/claude-multi-instance}"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[1;32m    ✓ %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m    ! %s\033[0m\n' "$1"; }

# Download with fallback: raw.githubusercontent may return 429 on corporate
# networks with a shared IP; jsDelivr serves the same file from a different CDN
fetch_remote_script() {
  curl -fsSL "$1" || curl -fsSL "$2"
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script is for macOS only." >&2
  exit 1
fi

# 1. Homebrew (also pulls in Xcode Command Line Tools, required for native modules)
step "Homebrew"
if command -v brew >/dev/null 2>&1; then
  ok "Homebrew already installed"
else
  # The Homebrew installer is interactive (asks for RETURN and the sudo password).
  # With "curl | bash" stdin is the pipe, not the keyboard: reconnect it to the real
  # terminal (/dev/tty). Without a terminal (e.g. CI), fall through to non-interactive mode.
  homebrew_installer="$(fetch_remote_script \
    https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh \
    https://cdn.jsdelivr.net/gh/Homebrew/install@master/install.sh)"
  if [[ -t 0 ]]; then
    /bin/bash -c "${homebrew_installer}"
  elif bash -c ': </dev/tty' 2>/dev/null; then
    /bin/bash -c "${homebrew_installer}" </dev/tty
  else
    NONINTERACTIVE=1 /bin/bash -c "${homebrew_installer}"
  fi
  ok "Homebrew installed"
fi
# Ensure brew is in PATH for this run (Apple Silicon uses /opt/homebrew, Intel /usr/local)
if [[ -x /opt/homebrew/bin/brew ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [[ -x /usr/local/bin/brew ]]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi

# 2. System dependencies
step "git, tmux y node"
version_of() {
  # tmux only understands -V; everything else uses --version
  { "$1" --version 2>/dev/null || "$1" -V 2>/dev/null; } | head -1
}

for formula in git tmux; do
  if command -v "$formula" >/dev/null 2>&1; then
    ok "$formula already installed ($(version_of "$formula"))"
  else
    brew install "$formula"
    ok "$formula installed"
  fi
done

# The server uses import.meta.dirname, available since node 20.11: if there is an old
# node floating around (nvm, prior installs), install a current one via brew
node_is_recent() {
  command -v node >/dev/null 2>&1 && node -e 'process.exit(parseInt(process.versions.node, 10) >= 20 ? 0 : 1)'
}
if node_is_recent; then
  ok "node already installed ($(node --version))"
else
  brew install node
  if ! node_is_recent; then
    warn "The active node in PATH is still old ($(node --version 2>/dev/null)). node 20.11+ is required."
  else
    ok "node installed ($(node --version))"
  fi
fi

# 3. Claude Code (official native installer). Authentication is NOT touched:
#    the dashboard inherits the shell environment exactly as it is configured.
step "Claude Code"
if command -v claude >/dev/null 2>&1; then
  ok "claude already installed ($(claude --version 2>/dev/null | head -1))"
else
  curl -fsSL https://claude.ai/install.sh | bash
  # The installer puts the binary in ~/.local/bin and updates the shell rc file,
  # but this script is already running: add it to PATH for this run
  export PATH="${HOME}/.local/bin:${PATH}"
  ok "claude installed ($(claude --version 2>/dev/null | head -1))"
fi

# 4. Dashboard repo + npm dependencies
step "Dashboard"
if [[ -d "${INSTALL_DIR}/.git" ]]; then
  git -C "${INSTALL_DIR}" fetch origin main
  # npm install regenerates package-lock metadata depending on the npm version;
  # discard that noise so it does not count as a local change
  git -C "${INSTALL_DIR}" checkout -- package-lock.json 2>/dev/null || true
  if git -C "${INSTALL_DIR}" merge --ff-only origin/main >/dev/null 2>&1; then
    ok "Repo updated at ${INSTALL_DIR}"
  elif [[ -z "$(git -C "${INSTALL_DIR}" status --porcelain)" ]]; then
    # Divergent history (e.g. the remote was rewritten with force push). With no
    # local changes, realigning the clone with the remote loses nothing.
    git -C "${INSTALL_DIR}" reset --hard origin/main
    ok "Divergent history: repo realigned with origin/main at ${INSTALL_DIR}"
  else
    warn "Local history diverges from remote and there are uncommitted local changes."
    echo   "      Check ${INSTALL_DIR} (git status) and then realign with:"
    echo   "        git -C ${INSTALL_DIR} reset --hard origin/main"
    exit 1
  fi
else
  git clone "${REPO_URL}" "${INSTALL_DIR}"
  ok "Repo cloned at ${INSTALL_DIR}"
fi
# All dependencies are public. On corporate machines, npm often points to a private
# registry with expired credentials (E401), either via ~/.npmrc or via npm_config_* /
# NPM_CONFIG_* environment variables that override even the project's .npmrc. The retry
# ignores all that configuration, only for this install, and uses the official public registry.
npm_install_with_clean_config() {
  (
    cd "${INSTALL_DIR}"
    for environmentVariable in $(compgen -e); do
      case "${environmentVariable}" in
        npm_config_*|NPM_CONFIG_*|NPM_TOKEN|NODE_AUTH_TOKEN) unset "${environmentVariable}" ;;
      esac
    done
    # npm requires userconfig and globalconfig to be different files
    emptyUserConfig="$(mktemp)"
    emptyGlobalConfig="$(mktemp)"
    installExitCode=0
    npm install --userconfig="${emptyUserConfig}" --globalconfig="${emptyGlobalConfig}" || installExitCode=$?
    rm -f "${emptyUserConfig}" "${emptyGlobalConfig}"
    exit "${installExitCode}"
  )
}

if (cd "${INSTALL_DIR}" && npm install); then
  ok "npm dependencies installed"
elif { warn "npm install failed with this machine's npm config. Retrying with a clean config..."; npm_install_with_clean_config; }; then
  ok "npm dependencies installed (corporate npm config ignored for this project only)"
else
  warn "npm install failed even with a clean config. Diagnostics:"
  echo   "      npm config ls -l | grep -iE 'registry|auth|proxy'"
  echo   "      If the corporate network blocks registry.npmjs.org, renew the credentials"
  echo   "      for the internal registry (npm login) and retry:"
  echo   "        cd ${INSTALL_DIR} && npm install"
  exit 1
fi

# 5. claude.local: hostname + reverse proxy, so the dashboard is reachable at
#    http://claude.local with no port suffix, while Vite keeps listening on its
#    normal unprivileged port 5173 (macOS refuses to bind :80 without root).
#    Caddy is installed as a brew service (a LaunchDaemon running as root, brew's
#    standard way to let a service bind privileged ports) and proxies 80 -> 5173
#    using the repo's Caddyfile.
step "claude.local"

# Needs a controlling terminal for sudo to prompt for the password (sudo talks to
# /dev/tty directly, not stdin, so this works even when stdin is itself a pipe).
# Without one (e.g. CI), skip with instructions instead of hanging.
have_sudo_tty() { bash -c ': </dev/tty' 2>/dev/null; }
run_as_root() { sudo "$@"; }

# Both an A and an AAAA record: hostname resolvers that try IPv6 first (curl,
# browsers) can otherwise stall for several seconds waiting on a network AAAA
# lookup before falling back to the A record from this file.
hosts_v4_line='127.0.0.1  claude.local'
hosts_v6_line='::1  claude.local'
hosts_v4_done=1
hosts_v6_done=1
grep -qE '^[[:space:]]*127\.0\.0\.1[[:space:]]+claude\.local([[:space:]]|$)' /etc/hosts 2>/dev/null || hosts_v4_done=0
grep -qE '^[[:space:]]*::1[[:space:]]+claude\.local([[:space:]]|$)' /etc/hosts 2>/dev/null || hosts_v6_done=0
missing_hosts_lines=()
[[ "${hosts_v4_done}" -eq 0 ]] && missing_hosts_lines+=("${hosts_v4_line}")
[[ "${hosts_v6_done}" -eq 0 ]] && missing_hosts_lines+=("${hosts_v6_line}")

if [[ "${#missing_hosts_lines[@]}" -eq 0 ]]; then
  ok "claude.local already in /etc/hosts"
elif ! have_sudo_tty; then
  warn "No terminal available to prompt for sudo. Add these lines to /etc/hosts manually:"
  for line in "${missing_hosts_lines[@]}"; do echo "        ${line}"; done
else
  printf '%s\n' "${missing_hosts_lines[@]}" | run_as_root tee -a /etc/hosts >/dev/null
  ok "claude.local added to /etc/hosts"
fi

if command -v caddy >/dev/null 2>&1; then
  ok "caddy already installed ($(caddy version 2>/dev/null | head -1))"
else
  brew install caddy
  ok "caddy installed"
fi

caddyfile_import="import ${INSTALL_DIR}/Caddyfile"
brew_caddyfile="$(brew --prefix)/etc/Caddyfile"
if [[ -f "${brew_caddyfile}" ]] && grep -qF "${caddyfile_import}" "${brew_caddyfile}"; then
  caddy_config_done=1
else
  caddy_config_done=0
fi

if [[ "${caddy_config_done}" -eq 1 ]]; then
  ok "Caddy already configured to proxy claude.local -> 5173"
elif ! have_sudo_tty; then
  warn "No terminal available to prompt for sudo. To finish claude.local setup manually:"
  echo   "        echo '${caddyfile_import}' >> $(brew --prefix)/etc/Caddyfile"
  echo   "        sudo brew services start caddy"
else
  echo "${caddyfile_import}" >> "${brew_caddyfile}"
  ok "Caddy configured to proxy claude.local -> 5173"
  # brew services runs Caddy as a root LaunchDaemon (sudo needed once here, not for
  # "npm run dev"), so it can bind port 80 and keeps running across reboots.
  if run_as_root brew services list 2>/dev/null | grep -qE '^caddy\s+started'; then
    run_as_root brew services restart caddy >/dev/null
  else
    run_as_root brew services start caddy >/dev/null
  fi
  ok "Caddy running as a system service (survives reboots)"
fi

# 6. Final checklist: what must be done manually by design
printf '\n\033[1;35m=== Done. Manual steps ===\033[0m\n'
if [[ -z "${CLAUDE_CODE_USE_VERTEX:-}" ]]; then
  warn "CLAUDE_CODE_USE_VERTEX is not set in this shell."
  echo   "      If this machine uses Vertex AI, configure the env vars in your ~/.zshrc"
  echo   "      (CLAUDE_CODE_USE_VERTEX and related). The dashboard inherits them as-is."
else
  ok "CLAUDE_CODE_USE_VERTEX detected: Vertex routing is inherited automatically"
fi
cat <<EOF

  1. Start the dashboard:
       cd ${INSTALL_DIR} && npm run dev
     then open http://claude.local

  2. On the initial screen, add the folder paths where terminals will open.
     You can open multiple instances in the same folder at once.

EOF
