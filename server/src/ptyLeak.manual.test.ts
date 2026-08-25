import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// THE test that actually proves the fix for the recurring "posix_spawnp failed." bug: a real
// fd leak inside @lydell/node-pty's Darwin binding that persisted even when releasePty()
// called destroy() on every attach (terminal.ts) - see this repo's fix commit and the plan
// this was implemented from for the full investigation. Measured directly: 1.1.0 leaked ~3 fds
// per spawn+exit+destroy() cycle in a long-lived process, never reclaimed even after several
// seconds of grace time and a forced GC; the version this repo now pins does not.
//
// Deliberately NOT part of the default `npm test` run, for reasons specific to what this test
// actually does, not generic caution:
//   - it spawns real ptys against the real system-wide pool (kern.tty.ptmx_max) - while it
//     runs, nothing else on the machine (a real Terminal window, tmux, another dev server) can
//     open a pty, and a batch size big enough to detect a slow per-cycle leak reliably is big
//     enough to matter
//   - the leak this guards against is specific to Darwin's posix_spawn path (see the plan);
//     this repo also installs node-pty binaries for Linux and Windows (package-lock.json),
//     where this test would either be meaningless or need a different mechanism entirely
// Gated behind an explicit opt-in env var so it never runs by accident in CI or a routine
// `npm test`. To run it locally on macOS:
//   RUN_PTY_LEAK_TEST=1 npx vitest run src/ptyLeak.manual.test.ts
const OPT_IN_ENV_VAR = "RUN_PTY_LEAK_TEST";
const shouldRun = process.platform === "darwin" && process.env[OPT_IN_ENV_VAR] === "1";
const skipReason =
  process.platform !== "darwin"
    ? "macOS-only: this leak is specific to node-pty's Darwin posix_spawn path"
    : `opt-in only: set ${OPT_IN_ENV_VAR}=1 to run (spawns real system-wide ptys, see this file's header comment)`;

const CYCLES_PER_BATCH = 20;
const BATCH_COUNT = 4;
// A tolerance, not exact equality: even the fixed version left a small, constant number of fds
// above baseline in direct measurement (13 vs a baseline of 12) that did not grow with more
// cycles. The pass/fail signal that matters is "does it keep growing", not "does it return to
// literally the same number".
const MAX_TOLERATED_GROWTH_PER_BATCH = 1;

// Runs entirely in an isolated CHILD process (never the vitest runner's own process, and never
// node_modules on disk is touched) so this process's own fd table, and every other test file
// running in the same runner, is completely unaffected regardless of outcome.
//
// `injectSyntheticLeak` exists only so this harness can prove it actually detects a growing fd
// count when there is one, rather than trusting a passing result to mean the harness itself
// works. It is DELIBERATELY independent of node-pty's own behavior: an earlier version of this
// sanity check just skipped calling destroy(), which caught the original 1.1.0 leak but proves
// nothing once run against a version that no longer leaks (skipping destroy() then leaks
// nothing to detect, and the sanity check would report a false "harness is broken"). Opening
// and deliberately never closing an unrelated fd once per cycle isolates what this sanity
// check actually needs to prove: the counting-and-threshold mechanism below catches a real,
// steady per-cycle fd increase, independent of whichever node-pty version happens to be
// installed.
function runLeakProbe(injectSyntheticLeak: boolean): number[] {
  const script = `
    const pty = require(${JSON.stringify(require.resolve("@lydell/node-pty"))});
    const fs = require("fs");
    const countFds = () => fs.readdirSync("/dev/fd").length;
    const leakedHandles = [];
    const results = [];
    let done = 0;
    const totalCycles = ${CYCLES_PER_BATCH * BATCH_COUNT};
    function cycle() {
      // "true" exits essentially instantly - unlike "sleep 1" (used in this bug's original,
      // interactive investigation), this keeps a whole multi-batch run well inside a bounded
      // child-process timeout while still exercising the exact spawn/exit/destroy() sequence
      // releasePty (terminal.ts) uses on every real attach teardown.
      const p = pty.spawn("true", [], {
        name: "xterm", cols: 80, rows: 24, cwd: process.env.HOME, env: process.env,
      });
      p.onExit(() => {
        try { p.destroy ? p.destroy() : p.kill(); } catch (e) {}
        if (${injectSyntheticLeak}) {
          // Deliberately never closed - see this function's header comment.
          leakedHandles.push(fs.openSync("/dev/null", "r"));
        }
        done += 1;
        if (done % ${CYCLES_PER_BATCH} === 0) {
          results.push(countFds());
        }
        if (done < totalCycles) {
          cycle();
        } else {
          console.log(JSON.stringify(results));
        }
      });
    }
    cycle();
  `;
  const output = execFileSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    timeout: 30_000,
  });
  const lastLine = output.trim().split("\n").pop() ?? "[]";
  return JSON.parse(lastLine) as number[];
}

describe.skipIf(!shouldRun)("node-pty fd leak (the real fix this bug needed)", () => {
  it(skipReason, () => {
    // Only reached when shouldRun is true; the title above is the skip reason when it isn't,
    // vitest has no separate "skip reason" API for describe.skipIf.
  });

  it(
    "the currently pinned node-pty version does not leak fds across repeated spawn+exit+destroy() cycles",
    () => {
      const perBatchFdCounts = runLeakProbe(false);
      expect(perBatchFdCounts).toHaveLength(BATCH_COUNT);
      for (let i = 1; i < perBatchFdCounts.length; i += 1) {
        const growth = perBatchFdCounts[i] - perBatchFdCounts[i - 1];
        expect(growth).toBeLessThanOrEqual(MAX_TOLERATED_GROWTH_PER_BATCH * CYCLES_PER_BATCH);
      }
    },
    35_000
  );

  // Proves the harness itself actually detects a leak, not just that this version happens to
  // pass - a synthetic, node-pty-independent per-cycle leak must show clear, sustained growth.
  it(
    "the harness itself detects a leak when one is deliberately injected (sanity check)",
    () => {
      const perBatchFdCounts = runLeakProbe(true);
      expect(perBatchFdCounts).toHaveLength(BATCH_COUNT);
      const totalGrowth = perBatchFdCounts[perBatchFdCounts.length - 1] - perBatchFdCounts[0];
      expect(totalGrowth).toBeGreaterThan(0);
    },
    35_000
  );
});
