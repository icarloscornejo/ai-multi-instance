# AI Multi-Instance

**Version:** 1.3.0

Local dashboard for running Claude Code, Codex CLI, Cursor Agent, custom commands, and shell sessions in parallel. Every instance is a real tmux-backed terminal, so it survives browser and dashboard restarts.

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

## How it works

- **Backend** (`server/`): Node + Express + ws. Each instance is a tmux session (`ccdash-<id>`) created in its location folder. The browser attaches via WebSocket: the server spawns a pty running `tmux attach-session` and bridges the two. Detach on tab close, session stays alive.
- **Frontend** (`web/`): React + Vite + xterm.js + Tailwind, dev server on port 5173. `setup.sh` adds `ai.local` to `/etc/hosts` and configures [Caddy](https://caddyserver.com) to proxy port 80 to Vite.
- **State** (`data/instances.json`): instance registry and config, persists across restarts.
- **Providers**: a small adapter layer builds valid launch and resume commands for each CLI. Custom commands are executed exactly as entered.
- **Resume**: Claude uses its session ID, Codex captures the UUID from local session metadata, and Cursor creates and stores a chat ID before launch.
- **Live data**: Claude exposes context, cost, and limits; Codex exposes context and rate limits from its local events; Cursor exposes its native statusline data (model, session, context percentage/window, input/output tokens, branch, and Git changes). Cursor account limits and billing data are not collected. Custom commands show only stable data they make available.
- **Cursor status line**: setup configures a small local wrapper in `~/.cursor/cli-config.json` so the dashboard can receive Cursor's live structured statusline payload. If you already configured a custom Cursor statusline, its command is preserved in `~/.cursor/ai-multi-instance-statusline.json` and continues to render normally.
- **Authentication**: none of its own. tmux starts your login shell, so each CLI inherits its normal credentials and environment.

## Requirements

macOS with tmux, jq, node 20.11+, and Caddy. At least one AI CLI is optional; shell-only and custom-command instances work without one.

Supported executable defaults:

- Claude Code: `claude`
- Codex CLI: `codex`
- Cursor Agent: `agent`

Install and authenticate those tools using their official instructions before selecting the corresponding provider.
