# How it works

The architecture behind the [README](../README.md).

- **Backend** (`server/`): Node + Express + ws. Each instance is a tmux session
  (`ccdash-<id>`) created in its location folder. The browser attaches via
  WebSocket: the server spawns a pty running `tmux attach-session` and bridges
  the two. Detach on tab close, session stays alive.
- **Frontend** (`web/`): React + Vite + xterm.js + Tailwind, dev server on port
  5173. `setup.sh` adds `ai.local` to `/etc/hosts` and configures
  [Caddy](https://caddyserver.com) to proxy port 80 to the dashboard server
  (port 3001), which serves the built frontend from `web/dist`.
- **State** (`data/instances.json`): instance registry and config, persists
  across restarts.
- **Providers**: a small adapter layer builds valid launch and resume commands
  for each CLI. Custom commands are executed exactly as entered.
- **Resume**: Claude uses its session ID, Codex captures the UUID from local
  session metadata, and Cursor creates and stores a chat ID before launch.
- **Live data**: Claude exposes context, cost, and limits; Codex exposes
  context and rate limits from its local events; Cursor exposes its native
  statusline data (model, session, context percentage and window, input and
  output tokens, branch, and Git changes). Cursor account limits and billing
  data are not collected. Custom commands show only stable data they make
  available.
- **Following the session in the pane**: the sidebar shows whatever agent runs
  in the instance's pane right now, not only the one the dashboard launched.
  Every pane gets `server/scripts/shims` first on `PATH`, so a `claude`,
  `claude-me` or `codex` you start by hand reports to the dashboard like a
  dashboard launch does. The server tells which agent is in the foreground from
  the pane's process tree (`server/src/paneAgent.ts`) and only trusts a
  snapshot written by that same process. If an agent never reported (started
  around the shims, or by an instance that was already open before this
  existed), the sidebar reads its model and context from its own transcript or
  rollout, and labels it as such. With nothing running it says so instead of
  showing the last session. Rate limits are the account's, so instances of the
  same Claude profile share the freshest reading; stale values are dimmed and a
  window that already reset is hidden. Instances opened before this was
  deployed pick up the shims the next time they are relaunched.
- **Cursor status line**: setup configures a small local wrapper in
  `~/.cursor/cli-config.json` so the dashboard can receive Cursor's live
  structured statusline payload. If you already configured a custom Cursor
  statusline, its command is preserved in
  `~/.cursor/ai-multi-instance-statusline.json` and continues to render
  normally.
- **Authentication**: none by default for the CLIs themselves, tmux starts your
  login shell so each one inherits its normal credentials and environment. The
  dashboard's own password gate (`server/src/auth.ts`) is opt-in: it activates
  once a password is set (UI or `DASHBOARD_PASSWORD`), and protects both the
  HTTP API and the WebSocket upgrade with a signed cookie.
- **Quick Tunnel** (`server/src/tunnel.ts`): manages the `cloudflared` child
  process, parses the assigned `*.trycloudflare.com` URL from its stderr log,
  and exposes start, stop and status to the Setup screen. It points cloudflared
  at Caddy (`http://localhost:80` with an `ai.local` host header), the same
  upstream `ai.local` uses.
- **Named Tunnel** (`server/src/namedTunnel.ts`): active when
  `data/named-tunnel/tunnel.json` exists. cloudflared runs as a launchd
  LaunchAgent (`com.ai-multi-instance.tunnel`), not a child of the server; a
  sentinel file (`data/named-tunnel/enabled`) watched by the plist's
  `KeepAlive.PathState` expresses start and stop intent, and status is read
  from cloudflared's local `/ready` endpoint plus an end-to-end check of the
  public URL. Because the connector outlives the server, the named-tunnel path
  also fails closed: if the password ever disappears while the connector is up,
  requests to the public hostname are refused (`server/src/requestHost.ts`),
  the auth cookie is issued `Secure` on that host, and the tunnel controls
  themselves are locked to local and LAN callers server-side.
