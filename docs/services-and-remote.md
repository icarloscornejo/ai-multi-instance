# Services and remote access

How the dashboard stays running, and how to reach it from outside the machine.
Back to the [README](../README.md).

## Installing on a clean machine

The setup script installs dashboard dependencies and detects supported AI CLIs.
It does not install or authenticate any provider; when Cursor Agent is present,
it adds a local statusline wrapper so its live session metrics can appear in
the dashboard.

The one-liner in the README tries sources in order: `raw.githubusercontent.com`,
the GitHub API (different host, always fresh), and the jsDelivr mirror (CDN,
may cache up to 12 hours). This survives the 429 rate-limit error typical on
corporate networks with a shared IP.

If the repo is already cloned, the one-liner is not needed:
`bash ~/claude-multi-instance/setup.sh` does the same thing and self-updates.

The script does not touch Claude Code authentication: the dashboard inherits
the shell environment as-is (Vertex AI included). At the end it prints a
checklist of what remains to be done manually.

## The dev service (`midev`)

On macOS, `setup.sh` installs the dashboard as a launchd service: it starts at
login, restarts itself, and runs the server plus the frontend build with hot
reload. `scripts/dev-service.sh` runs `npm run dev:all` (server with
`tsx watch` plus `vite build --watch`) as a launchd LaunchAgent that restarts
the whole thing when any part dies or hangs. `setup.sh` also adds a `midev`
function to your zsh config, so a new terminal has:

```bash
midev            # restart everything (also loads the job if it was stopped)
midev stop       # stop it (it comes back at the next login, or with midev)
midev log        # tail data/dev-service.log
midev status     # job state and whether :3001 / :5173 answer
midev uninstall  # remove it for good
midev setup      # (re)install it; safe to rerun, this is the retry command the warnings print
```

Things worth knowing:

- Opt out with `AI_MULTI_INSTANCE_SKIP_SERVICE=1 bash setup.sh` (pass it on
  every run, or `setup.sh` installs it again).
- On a machine with no dashboard password the service still installs, and the
  setup checklist warns that the dashboard runs without one (Caddy exposes it
  on your LAN). If a password is configured, the service refuses to stay
  installed unless it can confirm that the login still requires it.
- It also refuses to install if it would change the tmux socket dir (which
  kills live sessions) or run without a UTF-8 locale. If agent sessions work in
  `~/Desktop`, `~/Documents` or similar, macOS may block them under launchd
  until `/bin/bash` has Full Disk Access; `setup.sh` runs a probe and says so.
- On a clean machine `setup.sh` adds `brew shellenv` to your `~/.zprofile` if
  needed, because launchd's login shell would otherwise not find `npm`.

### Running it by hand

If you skipped the service, or want to run the dashboard in a terminal, stop
the service first because both use ports 3001 and 5173:

```bash
midev stop                    # only if the service is installed
cd ~/claude-multi-instance
npm run dev
```

If the server crashes, `data/server.log` (or `data/server-dev.log` under
`npm run dev`) has the stack trace.

### The older supervised service

`npm run service:install` is the older optional mode: a launchd service running
plain `npm start` (no hot reload, no frontend watcher). It cannot coexist with
the dev service (same ports, both start at login): `midev uninstall` first, and
`npm run service:uninstall` before going back.

```bash
npm run service:install    # sets it up as a per-user launchd service and starts it
npm run service:uninstall  # removes it
npm run service:status     # is it running, and what's its PID
npm run service:stop       # stop it (e.g. before npm run dev)
npm run service:restart    # restart it (e.g. after a server/src/ update, which the service doesn't hot-reload)
npm run service:start      # start it again
npm run service:log        # tail data/server.log
```

## Updates

The Update button in the tab bar fetches the latest version from GitHub and
applies it (fast-forward plus `npm install`) if there are no local changes in
the folder. Server and web changes hot-reload automatically (`tsx watch` and
Vite); other changes (dependencies, config) need a restart (`midev`, or
`npm run dev` again if you run it by hand). Sessions live in tmux, so
relaunching does not interrupt anything.

## Remote access (tunnel)

A way to reach the dashboard beyond `http://ai.local` on the same machine. Both
modes serve the same frontend Express publishes to `web/dist` (Caddy proxies
straight to the server, there is no Vite in this path), and both are only
useful with the password gate on: set a password first (stored hashed with
scrypt in `data/auth-password.json`, or via the `DASHBOARD_PASSWORD` env var)
so the public URL isn't wide open.

### Quick Tunnel (default, zero-config)

Start a `cloudflared tunnel --url` from the dashboard's Setup screen to get a
temporary public `*.trycloudflare.com` URL, no port forwarding, account, or
domain needed. The URL changes every time the tunnel restarts, and it rides a
single edge connection. It points at Caddy, requires Caddy to be running, and
fails with an actionable error if it isn't.

### Named Tunnel (opt-in, needs a Cloudflare-managed domain)

A stable hostname on a domain you own, up to four HA edge connections, and a
connector that runs as its own launchd service so it survives restarts of the
Node process and the machine. The hostname convention this project uses is
`<machine>-mi.<your-domain>` (one label under the apex, so free Universal SSL
covers it), e.g. `protom4-mi.example.com`. Setup is one command:

```bash
cloudflared login                                          # once per machine, if you haven't
bash scripts/setup-named-tunnel.sh protom4-mi.example.com  # tunnel + DNS + config + installs the connector
```

That creates the tunnel and DNS route, writes the config under
`data/named-tunnel/`, then installs and starts the connector service. The
dashboard switches to named mode with no restart, and its Setup screen shows
Start and Stop for the named tunnel (still ai.local only).

- `npm run tunnel:stop` keeps it down across reboot; `npm run tunnel:log` and
  `npm run tunnel:status` for diagnostics.
- To leave named mode, `npm run tunnel:uninstall` and delete
  `data/named-tunnel/tunnel.json`.
- Pass `--no-install` to `setup-named-tunnel.sh` to write the config only.
- The named tunnel points cloudflared straight at the server
  (`127.0.0.1:3001`), bypassing Caddy, and its config never lands at
  `~/.cloudflared/config.yml` (which would break the Quick Tunnel).
