# AI Multi-Instance

**Version:** 1.13.3

Local dashboard for running Claude Code, Codex CLI, Cursor Agent, custom commands, and shell sessions in parallel. Every instance is a real tmux-backed terminal, so it survives browser and dashboard restarts. Works well from a phone browser too, with its own password-protected home, terminal, and settings screens.

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
6. **Update** (button in the tab bar): fetches the latest version from GitHub and applies it (fast-forward + npm install) if there are no local changes in the folder. Server/web code changes hot-reload automatically (`tsx watch` and Vite); other changes (dependencies, config) need `npm run dev` restarted manually. Sessions live in tmux so relaunching does not interrupt anything.

If the server crashes, `data/server.log` (or `data/server-dev.log` under `npm run dev`) has a stack trace - it didn't before, and figuring out *why* the dashboard went down used to mean nothing to go on.

### Optional: keep it running without a terminal open

By default the dashboard only runs while you have `npm run dev` open, same as always - nothing below is enabled unless you ask for it. If you'd rather it start at login and restart itself after a crash instead of needing a terminal:

```bash
npm run service:install    # sets it up as a per-user launchd service and starts it
npm run service:uninstall  # removes it, back to npm run dev only
```

Once installed, the service owns port 3001, so a plain `npm run dev` will fail fast with `EADDRINUSE` until you stop the service first:

```bash
npm run service:status    # is it running, and what's its PID
npm run service:stop      # stop it (e.g. before npm run dev)
npm run service:restart   # restart it (e.g. after a server/src/ update, which the service doesn't hot-reload)
npm run service:start     # start it again
npm run service:log       # tail data/server.log
```

## Mobile

On a phone or narrow viewport the dashboard switches to a dedicated mobile shell instead of the desktop split view:

- **Home screen**: instance cards instead of the desktop sidebar's status dots, tap a card to open its terminal full-screen.
- **Terminal navigation**: full-screen per instance, with the phone's back gesture/button popping back to the home screen via browser history instead of closing the app.
- **Sheets**: bottom sheets and action sheets replace desktop modals for instance settings and actions, plus a keyboard accessory bar with common terminal keys above the on-screen keyboard. Which keys show and their order are configurable per device from Settings > Helper keys (drag to reorder, toggle to show/hide, at least one stays enabled).
- **Theme**: Light/Dark/System preference, applied live.
- **Password gate**: when a password is set (see Remote access below), a lock screen guards both the API and the WebSocket connection before any instance data loads.

## Remote access (tunnel)

A way to reach the dashboard beyond `http://ai.local` on the same machine. Both modes serve the same frontend Express publishes to `web/dist` (Caddy proxies straight to the server, there is no Vite in this path), and both are only useful with the password gate on: set a password first (stored hashed with scrypt in `data/auth-password.json`, or via the `DASHBOARD_PASSWORD` env var) so the public URL isn't wide open.

- **Quick Tunnel** (default, zero-config): start a `cloudflared tunnel --url` from the dashboard's Setup screen to get a temporary public `*.trycloudflare.com` URL, no port forwarding, account, or domain needed. The URL changes every time the tunnel restarts, and it rides a single edge connection. It points at Caddy, requires Caddy to be running, and fails with an actionable error if it isn't.
- **Named Tunnel** (opt-in, needs a Cloudflare-managed domain): a stable hostname on a domain you own, up to four HA edge connections, and a connector that runs as its own launchd service so it survives restarts of the Node process and the machine. The hostname convention this project uses is `<machine>-mi.<your-domain>` (one label under the apex, so free Universal SSL covers it), e.g. `protom4-mi.example.com`. Setup is one command:

  ```
  cloudflared login                                          # once per machine, if you haven't
  bash scripts/setup-named-tunnel.sh protom4-mi.example.com  # tunnel + DNS + config + installs the connector
  ```

  That creates the tunnel and DNS route, writes the config under `data/named-tunnel/`, then installs and starts the connector service. The dashboard switches to named mode with no restart, and its Setup screen shows Start/Stop for the named tunnel (still ai.local only). `npm run tunnel:stop` keeps it down across reboot; `npm run tunnel:log` / `tunnel:status` for diagnostics. To leave named mode, `npm run tunnel:uninstall` and delete `data/named-tunnel/tunnel.json`. Pass `--no-install` to `setup-named-tunnel.sh` to write the config only. The named tunnel points cloudflared straight at the server (`127.0.0.1:3001`), bypassing Caddy, and its config never lands at `~/.cloudflared/config.yml` (which would break the Quick Tunnel).

## How it works

- **Backend** (`server/`): Node + Express + ws. Each instance is a tmux session (`ccdash-<id>`) created in its location folder. The browser attaches via WebSocket: the server spawns a pty running `tmux attach-session` and bridges the two. Detach on tab close, session stays alive.
- **Frontend** (`web/`): React + Vite + xterm.js + Tailwind, dev server on port 5173. `setup.sh` adds `ai.local` to `/etc/hosts` and configures [Caddy](https://caddyserver.com) to proxy port 80 to Vite.
- **State** (`data/instances.json`): instance registry and config, persists across restarts.
- **Providers**: a small adapter layer builds valid launch and resume commands for each CLI. Custom commands are executed exactly as entered.
- **Resume**: Claude uses its session ID, Codex captures the UUID from local session metadata, and Cursor creates and stores a chat ID before launch.
- **Live data**: Claude exposes context, cost, and limits; Codex exposes context and rate limits from its local events; Cursor exposes its native statusline data (model, session, context percentage/window, input/output tokens, branch, and Git changes). Cursor account limits and billing data are not collected. Custom commands show only stable data they make available.
- **Cursor status line**: setup configures a small local wrapper in `~/.cursor/cli-config.json` so the dashboard can receive Cursor's live structured statusline payload. If you already configured a custom Cursor statusline, its command is preserved in `~/.cursor/ai-multi-instance-statusline.json` and continues to render normally.
- **Authentication**: none by default for the CLIs themselves, tmux starts your login shell so each one inherits its normal credentials and environment. The dashboard's own password gate (`server/src/auth.ts`) is opt-in: it activates once a password is set (UI or `DASHBOARD_PASSWORD`), and protects both the HTTP API and the WebSocket upgrade with a signed cookie.
- **Quick Tunnel** (`server/src/tunnel.ts`): manages the `cloudflared` child process, parses the assigned `*.trycloudflare.com` URL from its stderr log, and exposes start/stop and status to the Setup screen. It points cloudflared at Caddy (`http://localhost:80` with an `ai.local` host header), the same upstream `ai.local` uses.
- **Named Tunnel** (`server/src/namedTunnel.ts`): active when `data/named-tunnel/tunnel.json` exists. cloudflared runs as a launchd LaunchAgent (`com.ai-multi-instance.tunnel`), not a child of the server; a sentinel file (`data/named-tunnel/enabled`) watched by the plist's `KeepAlive.PathState` expresses start/stop intent, and status is read from cloudflared's local `/ready` endpoint plus an end-to-end check of the public URL. Because the connector outlives the server, the named-tunnel path also fails closed: if the password ever disappears while the connector is up, requests to the public hostname are refused (`server/src/requestHost.ts`), the auth cookie is issued `Secure` on that host, and the tunnel controls themselves are locked to local/LAN callers server-side.

## Requirements

macOS with tmux, jq, node 20.11+, and Caddy. At least one AI CLI is optional; shell-only and custom-command instances work without one. `cloudflared` (for the remote tunnel) is optional, install it only if you want that feature.

Supported executable defaults:

- Claude Code: `claude`
- Codex CLI: `codex`
- Cursor Agent: `agent`

Install and authenticate those tools using their official instructions before selecting the corresponding provider.
