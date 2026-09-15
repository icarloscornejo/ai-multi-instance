import { describe, expect, it } from "vitest";
import {
  clearAgentReadiness,
  getReadyChannel,
  isAgentReady,
  markAgentBooting,
  markAgentReady,
  onAgentReady,
} from "./agentReadiness";

describe("agentReadiness", () => {
  it("is ready by default for an id it never tracked", () => {
    expect(isAgentReady("unknown-instance")).toBe(true);
  });

  it("is not ready once booting starts, then ready once marked with the matching channel", () => {
    markAgentBooting("instance-1", "channel-a");
    expect(isAgentReady("instance-1")).toBe(false);

    markAgentReady("instance-1", "channel-a");
    expect(isAgentReady("instance-1")).toBe(true);
  });

  it("ignores a ready signal whose channel does not match the instance's current one", () => {
    markAgentBooting("instance-2", "channel-old");
    // Simulates a relaunch of the same instance id before the old watcher resolved.
    markAgentBooting("instance-2", "channel-new");

    markAgentReady("instance-2", "channel-old");
    expect(isAgentReady("instance-2")).toBe(false);

    markAgentReady("instance-2", "channel-new");
    expect(isAgentReady("instance-2")).toBe(true);
  });

  it("ignores a ready signal for an instance whose entry was already cleared", () => {
    markAgentBooting("instance-3", "channel-a");
    clearAgentReadiness("instance-3");

    markAgentReady("instance-3", "channel-a");
    expect(isAgentReady("instance-3")).toBe(true); // untracked -> the safe default
    expect(getReadyChannel("instance-3")).toBeNull();
  });

  it("notifies every registered waiter when the matching channel resolves, then forgets them", () => {
    markAgentBooting("instance-4", "channel-a");
    const calls: string[] = [];
    onAgentReady("instance-4", () => calls.push("first"));
    onAgentReady("instance-4", () => calls.push("second"));

    markAgentReady("instance-4", "channel-a");
    expect(calls).toEqual(["first", "second"]);

    // A late resolution (already ready) must not notify anyone again.
    markAgentReady("instance-4", "channel-a");
    expect(calls).toEqual(["first", "second"]);
  });

  it("fires the listener synchronously when the instance is already ready", () => {
    const calls: string[] = [];
    onAgentReady("some-other-untracked-instance", () => calls.push("fired"));
    expect(calls).toEqual(["fired"]);
  });

  it("unsubscribe stops a listener from being called", () => {
    markAgentBooting("instance-5", "channel-a");
    const calls: string[] = [];
    const unsubscribe = onAgentReady("instance-5", () => calls.push("fired"));
    unsubscribe();

    markAgentReady("instance-5", "channel-a");
    expect(calls).toEqual([]);
  });

  it("getReadyChannel returns the current channel while booting, and null once cleared", () => {
    markAgentBooting("instance-6", "channel-a");
    expect(getReadyChannel("instance-6")).toBe("channel-a");

    clearAgentReadiness("instance-6");
    expect(getReadyChannel("instance-6")).toBeNull();
  });
});
