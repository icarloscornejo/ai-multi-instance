// Node twin of pane-identity.sh, for the Cursor writers. Same rule as classifyPane in
// server/src/paneAgent.ts, so writer and server always agree on the pane job pid.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function run(command, args) {
  try {
    return (await execFileAsync(command, args, { timeout: 3000 })).stdout.trim();
  } catch {
    return "";
  }
}

// Returns { instanceId, idSource, paneJobPid } or null when the caller must write nothing: not a
// dashboard pane at all, or a pane that is not the instance's own (a user split, a teammate).
export async function resolvePaneIdentity(env = process.env) {
  const tmuxPane = env.TMUX_PANE;
  if (!tmuxPane) {
    // Outside tmux there is no pid to compare; an id handed in explicitly is still honoured.
    return env.AI_MULTI_INSTANCE_ID
      ? { instanceId: env.AI_MULTI_INSTANCE_ID, idSource: "env", paneJobPid: null }
      : null;
  }

  const session = await run("tmux", ["display", "-p", "-t", tmuxPane, "#S"]);
  let instanceId;
  let idSource;
  if (env.AI_MULTI_INSTANCE_ID) {
    instanceId = env.AI_MULTI_INSTANCE_ID;
    idSource = "env";
  } else {
    const match = /^ccdash-([0-9a-f]{8})$/.exec(session);
    if (match === null) return null;
    instanceId = match[1];
    idSource = "tmux";
  }

  // The instance is its original pane: the lowest pane id in the session.
  let original = null;
  for (const line of (await run("tmux", ["list-panes", "-s", "-t", session, "-F", "#{pane_id} #{pane_pid}"])).split("\n")) {
    const match = /^%(\d+) (\d+)$/.exec(line.trim());
    if (match !== null && (original === null || Number(match[1]) < original.order)) {
      original = { order: Number(match[1]), panePid: Number(match[2]) };
    }
  }
  if (original === null || `%${original.order}` !== tmuxPane) return null;

  const paneGroup = await run("ps", ["-o", "pgid=", "-p", String(original.panePid)]);
  const foregroundGroup = await run("ps", ["-o", "tpgid=", "-p", String(process.pid)]);
  if (paneGroup !== "" && paneGroup === foregroundGroup) {
    return { instanceId, idSource, paneJobPid: original.panePid };
  }

  // Walk up to the pane shell's direct child: that is the foreground job.
  let currentPid = process.pid;
  for (let depth = 0; depth < 12; depth += 1) {
    const parentPid = Number(await run("ps", ["-o", "ppid=", "-p", String(currentPid)]));
    if (!(parentPid > 1)) break;
    if (parentPid === original.panePid) return { instanceId, idSource, paneJobPid: currentPid };
    currentPid = parentPid;
  }
  return { instanceId, idSource, paneJobPid: null };
}
