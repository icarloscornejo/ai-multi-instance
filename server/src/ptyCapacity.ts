// Purely informational context about macOS's SYSTEM-WIDE pty capacity (kern.tty.ptmx_max),
// used only to enrich the diagnostic detail attached to a spawn failure or a MAX_LIVE_PTYS
// rejection (see terminal.ts's header comment on MAX_LIVE_PTYS for why this can never be a
// second gate). Nothing exported here ever rejects an attach; every read degrades to null/a
// safe default rather than throwing, because a broken diagnostic must never become a broken
// feature.
//
// Root cause this exists to make visible, not to fix (the real fix is the node-pty version
// bump - see terminal.ts): kern.tty.ptmx_max is a limit on the WHOLE MACHINE, not this
// process. Every per-process metric (this server's own fd count, its own pty count) can be
// perfectly healthy while the system-wide pool is exhausted by every terminal, tmux session,
// and agent process on the box combined - which is exactly what made this bug so hard to
// diagnose from inside the server alone. See bsd/kern/tty_ptmx.c in Apple's open-source XNU
// for the two constants below.

import { execFileSync } from "node:child_process";
import fs from "node:fs";

// XNU's own default (PTMX_MAX_DEFAULT). Used only when the sysctl read itself fails (non-
// macOS, sysctl missing, a permission oddity) - a safe assumption here since it's the number
// macOS itself starts every machine at before anyone raises it.
const DEFAULT_PTMX_MAX = 511;

// XNU generates dynamic pty device nodes as "ttys%03d" - three DECIMAL digits (PTSD_TEMPLATE
// in tty_ptmx.c), not hex. An earlier draft of this module used a hex pattern and would have
// silently swallowed the legacy static nodes ttys0..ttysf (one hex digit each, 16 total, NOT
// part of this pool) into the dynamic count - caught only because it was checked against the
// kernel source rather than assumed from how the failure count looked at a glance.
const DYNAMIC_PTY_NAME_PATTERN = /^ttys[0-9]{3}$/;

export interface PtyCapacityDeps {
  readdirSync: (path: string) => string[];
  readPtmxMaxFromSysctl: () => number | null;
}

export const defaultPtyCapacityDeps: PtyCapacityDeps = {
  readdirSync: (path: string) => fs.readdirSync(path),
  readPtmxMaxFromSysctl: (): number | null => {
    try {
      const output = execFileSync("sysctl", ["-n", "kern.tty.ptmx_max"], { encoding: "utf8" }).trim();
      const parsed = Number(output);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    } catch {
      // Not macOS, sysctl missing, or some other read failure - never fatal, see header
      // comment. Note this spawns a process, which would normally be off-limits on the attach
      // path (diagnosing a spawn failure by spawning something else is exactly backwards under
      // resource pressure) - but this is only ever read once at module load, well before the
      // server accepts its first connection (see terminal.ts's MAX_LIVE_PTYS, computed at
      // import time), never during a live attach or its failure.
      return null;
    }
  },
};

// ptmx_max never changes on its own once the process is running, but an operator might run
// `sysctl -w kern.tty.ptmx_max=...` (see this bug's mitigation step) while the server is
// already up, so this is a lazily-refreshable cache rather than a value fixed forever at
// import time - refreshPtmxMax exists for exactly that. Refresh is opt-in, not polled on a
// timer: this value is informational, not correctness-critical, so there is no reason to keep
// spawning sysctl in the background.
let cachedPtmxMax: number | null = null;

export function getPtmxMax(deps: PtyCapacityDeps = defaultPtyCapacityDeps): number {
  if (cachedPtmxMax === null) {
    cachedPtmxMax = deps.readPtmxMaxFromSysctl() ?? DEFAULT_PTMX_MAX;
  }
  return cachedPtmxMax;
}

export function refreshPtmxMax(deps: PtyCapacityDeps = defaultPtyCapacityDeps): number {
  cachedPtmxMax = deps.readPtmxMaxFromSysctl() ?? DEFAULT_PTMX_MAX;
  return cachedPtmxMax;
}

export function _resetPtyCapacityCacheForTests(): void {
  cachedPtmxMax = null;
}

// Counts the system-wide dynamic ptys currently allocated. Fail-open by design (see header
// comment): a readdir failure returns null, never throws, and every caller must treat null as
// "no data available" rather than zero - reporting zero when the read itself failed would be
// actively misleading in a diagnostic line, worse than reporting nothing.
//
// Known limitation, documented rather than hidden: this can transiently OVERCOUNT, because a
// dynamic pty's /dev node is reclaimed when the OWNING PROCESS exits, not when the pty itself
// is destroyed - measured directly while investigating this bug (destroying 80 ptys in a live
// process left the node count elevated for as long as that process kept running). This is
// exactly why this count is advisory/informational only and never gates an attach - see this
// module's header comment.
export function countSystemDynamicPtys(deps: PtyCapacityDeps = defaultPtyCapacityDeps): number | null {
  try {
    const entries = deps.readdirSync("/dev");
    let count = 0;
    for (const entry of entries) {
      if (DYNAMIC_PTY_NAME_PATTERN.test(entry)) {
        count += 1;
      }
    }
    return count;
  } catch {
    return null;
  }
}

// Derives the per-process pty admission gate (MAX_LIVE_PTYS in terminal.ts) from the SYSTEM's
// actual ptmx_max instead of a fixed constant. A fixed constant had two failure modes: left
// too low, it wastes headroom once an operator raises ptmx_max (see this bug's mitigation
// step, sysctl -w kern.tty.ptmx_max=999); left too high relative to the default (the previous
// 480 against a default of 511 - only 31 ptys of margin for every OTHER terminal app on the
// machine combined), it leaves almost no room for anything else, which is exactly the
// condition that emptied the system-wide pool in the first place. MARGIN_FOR_OTHER_PROCESSES
// is reserved for the rest of the machine; the floor and ceiling keep this sane at both a very
// low and a very high ptmx_max.
const MARGIN_FOR_OTHER_PROCESSES = 100;
const MIN_MAX_LIVE_PTYS = 200;
const MAX_MAX_LIVE_PTYS = 900;

export function computeMaxLivePtys(ptmxMax: number): number {
  const withMargin = ptmxMax - MARGIN_FOR_OTHER_PROCESSES;
  return Math.max(MIN_MAX_LIVE_PTYS, Math.min(MAX_MAX_LIVE_PTYS, withMargin));
}
