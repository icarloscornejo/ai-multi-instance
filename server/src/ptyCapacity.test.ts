import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetPtyCapacityCacheForTests,
  computeMaxLivePtys,
  countSystemDynamicPtys,
  getPtmxMax,
  refreshPtmxMax,
  type PtyCapacityDeps,
} from "./ptyCapacity";

beforeEach(() => {
  _resetPtyCapacityCacheForTests();
});

describe("countSystemDynamicPtys", () => {
  // The exact bug this regex used to have: an earlier draft used a hex pattern
  // (^ttys[0-9a-f]{3}$), which would have folded the 16 legacy static nodes ttys0..ttysf into
  // the dynamic count. XNU generates dynamic nodes as "ttys%03d" - three DECIMAL digits
  // (bsd/kern/tty_ptmx.c, PTSD_TEMPLATE) - confirmed against the kernel source, not assumed.
  it("counts only three-decimal-digit ttysNNN nodes, excluding static and malformed lookalikes", () => {
    const deps: PtyCapacityDeps = {
      readdirSync: () => [
        "ttys000",
        "ttys511",
        "ttys999",
        "ttys0", // static legacy node (one hex digit), not a dynamic pty
        "ttysf", // static legacy node (one hex digit), not a dynamic pty
        "ttysabc", // hex-looking, not the decimal pattern this kernel actually uses
        "ttys1000", // four digits, wrong length
        "console",
        "null",
      ],
      readPtmxMaxFromSysctl: () => null,
    };
    expect(countSystemDynamicPtys(deps)).toBe(3);
  });

  it("returns null (fail-open, never zero) when the directory read itself fails", () => {
    const deps: PtyCapacityDeps = {
      readdirSync: () => {
        throw new Error("EACCES");
      },
      readPtmxMaxFromSysctl: () => null,
    };
    expect(countSystemDynamicPtys(deps)).toBeNull();
  });

  it("returns 0 for an empty /dev listing (a real zero, distinct from a failed read returning null)", () => {
    const deps: PtyCapacityDeps = {
      readdirSync: () => [],
      readPtmxMaxFromSysctl: () => null,
    };
    expect(countSystemDynamicPtys(deps)).toBe(0);
  });
});

describe("getPtmxMax / refreshPtmxMax", () => {
  it("caches the sysctl read: a second call does not read again", () => {
    let reads = 0;
    const deps: PtyCapacityDeps = {
      readdirSync: () => [],
      readPtmxMaxFromSysctl: () => {
        reads += 1;
        return 511;
      },
    };
    expect(getPtmxMax(deps)).toBe(511);
    expect(getPtmxMax(deps)).toBe(511);
    expect(reads).toBe(1);
  });

  it("falls back to the documented macOS default (511) when the sysctl read fails", () => {
    const deps: PtyCapacityDeps = {
      readdirSync: () => [],
      readPtmxMaxFromSysctl: () => null,
    };
    expect(getPtmxMax(deps)).toBe(511);
  });

  // Models an operator running `sysctl -w kern.tty.ptmx_max=999` (this bug's mitigation step)
  // while the server is already up: the cache must not stay pinned to whatever was read at
  // startup forever.
  it("refreshPtmxMax re-reads and updates the cache, reflecting a value raised after startup", () => {
    let currentValue = 511;
    const deps: PtyCapacityDeps = {
      readdirSync: () => [],
      readPtmxMaxFromSysctl: () => currentValue,
    };
    expect(getPtmxMax(deps)).toBe(511);
    currentValue = 999;
    expect(getPtmxMax(deps)).toBe(511); // still cached, refresh not called yet
    expect(refreshPtmxMax(deps)).toBe(999);
    expect(getPtmxMax(deps)).toBe(999);
  });
});

describe("computeMaxLivePtys", () => {
  it("leaves a margin below ptmx_max for every other process on the machine", () => {
    // The previous fixed constant (480) left only 31 ptys of margin below the 511 default -
    // exactly the kind of razor-thin headroom that starves every other terminal app on the
    // machine. This must leave meaningfully more.
    const result = computeMaxLivePtys(511);
    expect(result).toBeLessThan(511);
    expect(511 - result).toBeGreaterThanOrEqual(100);
  });

  it("scales up when ptmx_max is raised (the mitigation step), instead of wasting the new headroom", () => {
    expect(computeMaxLivePtys(999)).toBeGreaterThan(computeMaxLivePtys(511));
  });

  it("never drops below a sane floor even for a very low ptmx_max", () => {
    expect(computeMaxLivePtys(50)).toBeGreaterThanOrEqual(200);
  });

  it("never exceeds a sane ceiling even for a very high ptmx_max", () => {
    expect(computeMaxLivePtys(999_999)).toBeLessThanOrEqual(900);
  });
});
