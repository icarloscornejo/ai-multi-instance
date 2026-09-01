import { describe, expect, it, vi } from "vitest";
import { LaunchProgress, type LaunchEvent } from "./launchProgress";

function collectingSink(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line) => lines.push(line) };
}

function events(lines: string[]): LaunchEvent[] {
  return lines.map((line) => JSON.parse(line) as LaunchEvent);
}

describe("LaunchProgress", () => {
  it("emits one NDJSON line per event, each newline-terminated", () => {
    const { lines, sink } = collectingSink();
    const progress = new LaunchProgress(sink);

    progress.stepStart("fetch-base", "Fetching main from origin");
    progress.stepDone("fetch-base");
    progress.done({ id: "abc" });

    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.endsWith("\n"))).toBe(true);
    expect(events(lines)).toEqual([
      { type: "step", id: "fetch-base", label: "Fetching main from origin" },
      { type: "step-done", id: "fetch-base", ms: expect.any(Number) },
      { type: "done", instance: { id: "abc" } },
    ]);
  });

  it("measures ms between stepStart and stepDone from the injected clock", () => {
    let clock = 1000;
    const { lines, sink } = collectingSink();
    const progress = new LaunchProgress(sink, () => clock);

    progress.stepStart("update-base", "Updating main");
    clock = 15803;
    progress.stepDone("update-base");

    expect(events(lines)[1]).toEqual({ type: "step-done", id: "update-base", ms: 14803 });
  });

  it("reports ms 0 for a stepDone with no matching stepStart", () => {
    const { lines, sink } = collectingSink();
    const progress = new LaunchProgress(sink);
    progress.stepDone("persist");
    expect(events(lines)[0]).toEqual({ type: "step-done", id: "persist", ms: 0 });
  });

  it("only emits the first terminal event", () => {
    const { lines, sink } = collectingSink();
    const progress = new LaunchProgress(sink);

    progress.done({ id: "abc" });
    progress.fail("too late");
    progress.done({ id: "def" });

    expect(lines).toHaveLength(1);
    expect(events(lines)[0]).toEqual({ type: "done", instance: { id: "abc" } });
    expect(progress.hasSentTerminal).toBe(true);
  });

  it("step-warning is not terminal: a later done still goes out", () => {
    const { lines, sink } = collectingSink();
    const progress = new LaunchProgress(sink);

    progress.stepWarning("launch-agent", "could not confirm");
    progress.done({ id: "abc" });

    expect(events(lines)).toEqual([
      { type: "step-warning", id: "launch-agent", message: "could not confirm" },
      { type: "done", instance: { id: "abc" } },
    ]);
  });

  it("fail carries the step id only when given one", () => {
    const withId = collectingSink();
    new LaunchProgress(withId.sink).fail("boom", "create-branch");
    expect(events(withId.lines)[0]).toEqual({ type: "error", id: "create-branch", message: "boom" });

    const withoutId = collectingSink();
    new LaunchProgress(withoutId.sink).fail("boom");
    expect(events(withoutId.lines)[0]).toEqual({ type: "error", message: "boom" });
  });

  it("a throwing sink never propagates, and every later write becomes a silent no-op", () => {
    const sink = vi.fn(() => {
      throw new Error("EPIPE: socket closed");
    });
    const progress = new LaunchProgress(sink);

    expect(() => progress.stepStart("create-session", "Starting tmux session")).not.toThrow();
    expect(() => progress.done({ id: "abc" })).not.toThrow();
    // First write attempted and threw; after that the sink is considered dead and not called again.
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("markSinkClosed stops all further writes without throwing", () => {
    const { lines, sink } = collectingSink();
    const progress = new LaunchProgress(sink);

    progress.stepStart("fetch-base", "Fetching");
    progress.markSinkClosed();
    progress.stepDone("fetch-base");
    progress.done({ id: "abc" });

    expect(lines).toHaveLength(1);
  });
});
