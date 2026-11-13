<h1 align="center">AI Multi-Instance</h1>

<p align="center"><b>All your agents. One tab.</b></p>

<p align="center">
  Run Claude Code, Codex, Cursor and plain shells side by side, from your desk or your phone.
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-2.0.1-0071e3">
  <img alt="macOS" src="https://img.shields.io/badge/macOS-tmux-1d1d1f?logo=apple&logoColor=white">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-20.11%2B-5FA04E?logo=nodedotjs&logoColor=white">
  <img alt="Agents" src="https://img.shields.io/badge/agents-Claude%20%7C%20Codex%20%7C%20Cursor-D97757">
  <img alt="Local-first" src="https://img.shields.io/badge/local--first-runs%20on%20your%20Mac-1d1d1f">
</p>

AI Multi-Instance is a local dashboard for running many AI coding agents at
once. Every instance is a real terminal backed by tmux, so closing the browser,
or even restarting the dashboard, never kills a session. Open it at
`http://ai.local`, or from your phone, and pick up right where you left off.

## Many agents, zero juggling.

**Any agent, any folder.** Claude Code, Codex CLI, Cursor Agent, a custom
command, or just a shell. Open as many instances as you want, even several in
the same folder.

**Sessions that don't die.** Every instance lives in tmux. Close the tab, close
the browser, restart the dashboard: when you come back, each terminal
reconnects with all its output intact.

**See what each one is doing.** The sidebar shows the model, context, cost and
rate limits of whatever agent is running in each pane right now, even one you
started by hand.

**Restart and resume.** Restart an instance and its agent picks up the same
conversation: Claude by session ID, Codex by its session UUID, Cursor by chat
ID.

**From your phone, too.** On a phone the dashboard becomes its own app: instance
cards, full-screen terminals, bottom sheets, and a row of helper keys above
the keyboard that you can reorder.

**Reach it from anywhere.** A Cloudflare tunnel gives you a public URL, behind
a password, with no port forwarding. Quick and temporary, or on your own
domain.

## Get started

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/icarloscornejo/claude-multi-instance/main/setup.sh || curl -fsSL -H 'Accept: application/vnd.github.raw' https://api.github.com/repos/icarloscornejo/claude-multi-instance/contents/setup.sh || curl -fsSL https://cdn.jsdelivr.net/gh/icarloscornejo/claude-multi-instance@main/setup.sh)"
```

The script installs everything, sets the dashboard up as a service that starts
at login, and ends with a checklist of anything left to do by hand. Then open
<http://ai.local>.

1. **Add your folders** in Settings: the places where terminals will open.
2. **Press `+`** to create an instance: pick a folder, a name and an agent.
3. **That's it.** Close the browser whenever you want; nothing stops.

To restart it, type `midev`. To update, press Update in the tab bar.

## Requirements

macOS with tmux, jq, Node 20.11+ and Caddy. AI CLIs are optional: shell and
custom-command instances work without one. Install and sign in to each agent
you want to use with its own instructions first:

| Agent | Command |
|---|---|
| Claude Code | `claude` |
| Codex CLI | `codex` |
| Cursor Agent | `agent` |

`cloudflared` is only needed for remote access.

## Your machine, your sessions.

Everything runs on your Mac. Each agent uses its own login, unchanged. The
dashboard password is optional on your desk; set one before you turn on
remote access. It is stored hashed, it guards both the page and the live
terminal connection, and the named tunnel refuses public requests if the
password ever goes away.

## Learn more

- [Services and remote access](docs/services-and-remote.md): the `midev`
  service, running it by hand, updates, Quick and Named tunnels.
- [How it works](docs/how-it-works.md): tmux bridge, providers, resume, live
  data, the password gate and the tunnels inside.
