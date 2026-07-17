# claude-multi-instance

**Version:** 1.1.0

Local dashboard to run N Claude Code sessions in parallel, each one in its own folder. A real terminal per instance (tmux underneath, so sessions survive browser restarts), tabs to switch between instances, and a config sidebar per instance (command, model, effort).

## Installation (clean machine)

In Terminal (if you don't have Homebrew, git, tmux, node, or Claude Code, the script installs them automatically):

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

Open <http://claude.local> (`http://localhost` also works).

1. **Initial setup** (once, or from the `Settings` button): add the folder paths where terminals will open. You can open multiple instances in the same folder at once; there is no per-folder limit.
2. **New instance** (the `+` button): pick a location, give it a name, and optionally choose the Claude binary, model, and effort level. The dashboard opens a tmux session in that folder and launches the command. All fields are just a starting point — inside the terminal you can use `/model`, `/effort`, or any command as you normally would.
3. **Closing the browser does not kill anything**: sessions live in tmux. When you reopen the dashboard, each tab reconnects to its session with all output intact.
4. **Delete an instance** (from the instance sidebar): closes the tmux session. The folder and its contents are untouched on disk.
5. **Terminal zoom**: `A-` / `A+` buttons or `Cmd +` / `Cmd -` with focus inside the terminal. The size persists per instance.
6. **Update** (button in the tab bar): fetches the latest version from GitHub and applies it (fast-forward + npm install) if there are no local changes in the folder. If it updated, it shows a "relaunch dashboard" notice: stop `npm run dev` with Ctrl+C and run it again. Sessions live in tmux so relaunching does not interrupt anything.

## How it works

- **Backend** (`server/`): Node + Express + ws. Each instance is a tmux session (`ccdash-<id>`) created in its location folder. The browser attaches via WebSocket: the server spawns a pty running `tmux attach-session` and bridges the two. Detach on tab close, session stays alive.
- **Frontend** (`web/`): React + Vite + xterm.js + Tailwind, dev server on port 5173. `setup.sh` adds the `claude.local` entry to `/etc/hosts` and installs [Caddy](https://caddyserver.com) as a system service (`Caddyfile`) that proxies `http://claude.local` (port 80) to Vite, so the dashboard is reachable without a port suffix.
- **State** (`data/instances.json`): instance registry and config, persists across restarts.
- **Authentication**: none of its own. tmux starts your login shell, so environment variables (Vertex AI and others) arrive just as they do in any terminal.

## Requirements

macOS with tmux, node 20.11+, Caddy, and the `claude` CLI (all installed by `setup.sh`).
