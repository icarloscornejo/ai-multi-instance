# AI Multi-Instance

**Version:** 1.9.0

Local dashboard for running Claude Code, Codex CLI, Cursor Agent, custom commands, and shell sessions in parallel. Every instance is a real tmux-backed terminal, so it survives browser and dashboard restarts. Installable as a mobile PWA too, with its own password-protected home, terminal, and settings screens.

## Installation (clean machine)

The setup script installs dashboard dependencies and detects supported AI CLIs. It does not install or authenticate any provider; when Cursor Agent is present, it adds a local statusline wrapper so its live session metrics can appear in the dashboard.

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/icarloscornejo/claude-multi-instance/main/setup.sh || curl -fsSL -H 'Accept: application/vnd.github.raw' https://api.github.com/repos/icarloscornejo/claude-multi-instance/contents/setup.sh || curl -fsSL https://cdn.jsdelivr.net/gh/icarloscornejo/claude-multi-instance@main/setup.sh)"
```

The command tries sources in order: `raw.githubusercontent.com`, the GitHub API (different host, always fresh), and the jsDelivr mirror (CDN, may cache up to 12 hours). This survives the 429 rate-limit error typical on corporate networks with a shared IP.

If the repo is already cloned, the one-liner is not needed: `bash ~/claude-multi-instance/setup.sh` does the same thing and self-updates.

The script does not touch Claude Code authentication: the dashboard inherits the shell environment as-is (Vertex AI included). At the end it prints a checklist of what remains to be done manually.

## Usage

```bash
cd ~/claude-multi-instance
npm run dev
```

Open <http://ai.local> (`http://localhost` also works). Existing installations may continue using <http://claude.local>.

1. **Initial setup** (once, or from the `Settings` button): add the folder paths where terminals will open. You can open multiple instances in the same folder at once; there is no per-folder limit.
2. **New instance** (the `+` button): pick a location, name the instance, and choose Claude Code, Codex CLI, Cursor Agent, a custom command, or shell only. Provider-specific model and effort fields are shown only when supported.
3. **Closing the browser does not kill anything**: sessions live in tmux. When you reopen the dashboard, each tab reconnects to its session with all output intact.
4. **Delete an instance** (from the instance sidebar): closes the tmux session. The folder and its contents are untouched on disk.
5. **Terminal zoom**: `A-` / `A+` buttons or `Cmd +` / `Cmd -` with focus inside the terminal. The size persists per instance.
6. **Update** (button in the tab bar): fetches the latest version from GitHub and applies it (fast-forward + npm install) if there are no local changes in the folder. If it updated, it shows a "relaunch dashboard" notice: stop `npm run dev` with Ctrl+C and run it again. Sessions live in tmux so relaunching does not interrupt anything.

## Mobile / PWA

On a phone or narrow viewport the dashboard switches to a dedicated mobile shell instead of the desktop split view:

- **Installable**: the site ships a web app manifest and a minimal network-only service worker, so it can be added to the home screen like a native app (no offline caching, it just needs the dashboard reachable).
- **Home screen**: instance cards instead of the desktop sidebar's status dots, tap a card to open its terminal full-screen.
- **Terminal navigation**: full-screen per instance, with the phone's back gesture/button popping back to the home screen via browser history instead of closing the app.
- **Sheets**: bottom sheets and action sheets replace desktop modals for instance settings and actions, plus a keyboard accessory bar with common terminal keys (Esc, Tab, Ctrl, arrows) above the on-screen keyboard.
- **Theme**: Light/Dark/System preference, applied live.
- **Password gate**: when a password is set (see Remote access below), a lock screen guards both the API and the WebSocket connection before any instance data loads.

## Remote access (HTTPS + tunnel)

Two independent ways to reach the dashboard beyond `http://ai.local` on the same machine:

- **Local HTTPS (mkcert)**: `setup.sh` generates a locally-trusted certificate covering `ai.local`, `claude.local`, `localhost`, and this machine's LAN IP, writing it to `certs/` and a generated `Caddyfile.https` (imported by the main `Caddyfile`) so Caddy serves HTTPS on `:443` alongside the existing `:80`. Useful for reaching the dashboard by LAN IP from a phone without certificate warnings.
- **Cloudflare tunnel**: start a `cloudflared tunnel --url` from the dashboard's Setup screen to get a temporary public `*.trycloudflare.com` URL, no port forwarding or account needed. The tunnel is only ever useful alongside the password gate: set a password first (stored hashed with scrypt in `data/auth-password.json`, or via the `DASHBOARD_PASSWORD` env var) so the public URL isn't wide open.

## How it works

- **Backend** (`server/`): Node + Express + ws. Each instance is a tmux session (`ccdash-<id>`) created in its location folder. The browser attaches via WebSocket: the server spawns a pty running `tmux attach-session` and bridges the two. Detach on tab close, session stays alive.
- **Frontend** (`web/`): React + Vite + xterm.js + Tailwind, dev server on port 5173. `setup.sh` adds `ai.local` to `/etc/hosts` and configures [Caddy](https://caddyserver.com) to proxy port 80 to Vite.
- **State** (`data/instances.json`): instance registry and config, persists across restarts.
- **Providers**: a small adapter layer builds valid launch and resume commands for each CLI. Custom commands are executed exactly as entered.
- **Resume**: Claude uses its session ID, Codex captures the UUID from local session metadata, and Cursor creates and stores a chat ID before launch.
- **Live data**: Claude exposes context, cost, and limits; Codex exposes context and rate limits from its local events; Cursor exposes its native statusline data (model, session, context percentage/window, input/output tokens, branch, and Git changes). Cursor account limits and billing data are not collected. Custom commands show only stable data they make available.
- **Cursor status line**: setup configures a small local wrapper in `~/.cursor/cli-config.json` so the dashboard can receive Cursor's live structured statusline payload. If you already configured a custom Cursor statusline, its command is preserved in `~/.cursor/ai-multi-instance-statusline.json` and continues to render normally.
- **Authentication**: none by default for the CLIs themselves, tmux starts your login shell so each one inherits its normal credentials and environment. The dashboard's own password gate (`server/src/auth.ts`) is opt-in: it activates once a password is set (UI or `DASHBOARD_PASSWORD`), and protects both the HTTP API and the WebSocket upgrade with a signed cookie.
- **Tunnel** (`server/src/tunnel.ts`): manages the `cloudflared` child process, parses the assigned `*.trycloudflare.com` URL from its stderr log, and exposes start/stop and status to the Setup screen.

## Requirements

macOS with tmux, jq, node 20.11+, and Caddy. At least one AI CLI is optional; shell-only and custom-command instances work without one. `mkcert` (for local HTTPS) and `cloudflared` (for the remote tunnel) are optional, install them only if you want those features.

Supported executable defaults:

- Claude Code: `claude`
- Codex CLI: `codex`
- Cursor Agent: `agent`

Install and authenticate those tools using their official instructions before selecting the corresponding provider.
