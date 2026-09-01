import { describe, expect, it } from "vitest";
import { ApiError } from "./apiError";
import {
  applyLaunchEvent,
  consumeLaunchStream,
  parseLaunchLine,
  type LaunchEvent,
  type LaunchStepView,
} from "./launchSteps";

// Builds a ReadableStream that yields `text` encoded to UTF-8, cut at the given byte offsets.
// Splitting mid-line and mid-multibyte-character is exactly the case the incremental decoder
// and line buffer have to survive.
function streamOf(text: string, cutAt: number[] = []): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const bounds = [0, ...cutAt, bytes.length].filter((value, index, all) => all.indexOf(value) === index);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    chunks.push(bytes.slice(bounds[i], bounds[i + 1]));
  }
  let cursor = 0;
  return new ReadableStream({
    pull(controller) {
      if (cursor >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[cursor]);
      cursor += 1;
    },
  });
}

const DONE_LINE = (id: string) => JSON.stringify({ type: "done", instance: { id } });

describe("parseLaunchLine", () => {
  it("accepts every known event type", () => {
    expect(parseLaunchLine('{"type":"step","id":"fetch-base","label":"x"}').type).toBe("step");
    expect(parseLaunchLine('{"type":"done","instance":{"id":"a"}}').type).toBe("done");
  });

  it("rejects malformed JSON and unknown types with an ApiError", () => {
    expect(() => parseLaunchLine("{not json")).toThrow(ApiError);
    expect(() => parseLaunchLine('{"type":"bogus"}')).toThrow(ApiError);
    expect(() => parseLaunchLine("42")).toThrow(ApiError);
  });
});

describe("consumeLaunchStream", () => {
  const goodStream = [
    JSON.stringify({ type: "step", id: "fetch-base", label: "Fetching main" }),
    JSON.stringify({ type: "step-done", id: "fetch-base", ms: 14803 }),
    JSON.stringify({ type: "step", id: "create-session", label: "Starting tmux session" }),
    JSON.stringify({ type: "step-done", id: "create-session", ms: 120 }),
    DONE_LINE("abc123"),
  ].join("\n") + "\n";

  it("forwards every event and resolves with the instance from `done`", async () => {
    const seen: LaunchEvent[] = [];
    const instance = await consumeLaunchStream(streamOf(goodStream), (event) => seen.push(event));

    expect(instance).toEqual({ id: "abc123" });
    expect(seen.map((event) => event.type)).toEqual(["step", "step-done", "step", "step-done", "done"]);
  });

  it("survives the payload being cut at every single byte boundary", async () => {
    const bytes = new TextEncoder().encode(goodStream);
    for (let cut = 1; cut < bytes.length; cut += 1) {
      const instance = await consumeLaunchStream(streamOf(goodStream, [cut]));
      expect(instance).toEqual({ id: "abc123" });
    }
  });

  it("decodes a multibyte character split across chunks", async () => {
    const line = JSON.stringify({ type: "step", id: "create-branch", label: "Creating jira/RÑ-8514 ✓" });
    const stream = line + "\n" + DONE_LINE("z") + "\n";
    const encoded = new TextEncoder().encode(stream);
    // Cut somewhere inside the "Ñ" (2 bytes) and inside the "✓" (3 bytes).
    const seen: LaunchEvent[] = [];
    await consumeLaunchStream(streamOf(stream, [line.indexOf("R") + 6, encoded.length - 5]), (event) =>
      seen.push(event)
    );
    expect((seen[0] as { label: string }).label).toContain("RÑ-8514 ✓");
  });

  it("rejects when the stream ends without a terminal event", async () => {
    const partial = JSON.stringify({ type: "step", id: "fetch-base", label: "Fetching" }) + "\n";
    await expect(consumeLaunchStream(streamOf(partial))).rejects.toMatchObject({
      name: "ApiError",
      message: expect.stringContaining("closed the connection"),
    });
  });

  it("turns a terminal `error` event into a thrown ApiError with its message", async () => {
    const stream =
      JSON.stringify({ type: "step", id: "fetch-base", label: "Fetching" }) +
      "\n" +
      JSON.stringify({ type: "error", id: "fetch-base", message: "check the VPN" }) +
      "\n";
    await expect(consumeLaunchStream(streamOf(stream))).rejects.toMatchObject({
      name: "ApiError",
      message: "check the VPN",
    });
  });

  it("rejects on a second terminal event", async () => {
    const stream = DONE_LINE("a") + "\n" + DONE_LINE("b") + "\n";
    await expect(consumeLaunchStream(streamOf(stream))).rejects.toThrow(ApiError);
  });

  it("rejects on a malformed line", async () => {
    const stream = "{ this is not json }\n" + DONE_LINE("a") + "\n";
    await expect(consumeLaunchStream(streamOf(stream))).rejects.toThrow(ApiError);
  });

  it("ignores blank lines", async () => {
    const stream = "\n\n" + DONE_LINE("ok") + "\n\n";
    expect(await consumeLaunchStream(streamOf(stream))).toEqual({ id: "ok" });
  });
});

describe("applyLaunchEvent", () => {
  const run = (events: LaunchEvent[]): LaunchStepView[] =>
    events.reduce<LaunchStepView[]>((steps, event) => applyLaunchEvent(steps, event), []);

  it("builds a step list: running then done with its duration", () => {
    const steps = run([
      { type: "step", id: "fetch-base", label: "Fetching main from origin" },
      { type: "step-done", id: "fetch-base", ms: 14803 },
      { type: "step", id: "create-session", label: "Starting tmux session" },
    ]);
    expect(steps).toEqual([
      { id: "fetch-base", label: "Fetching main from origin", status: "done", ms: 14803 },
      { id: "create-session", label: "Starting tmux session", status: "running" },
    ]);
  });

  it("marks a step amber on step-warning and keeps its message", () => {
    const steps = run([
      { type: "step", id: "launch-agent", label: "Launching claude" },
      { type: "step-warning", id: "launch-agent", message: "could not confirm" },
    ]);
    expect(steps[0]).toMatchObject({ status: "warning", message: "could not confirm" });
  });

  it("on error, fails the step it names and leaves finished steps intact", () => {
    const steps = run([
      { type: "step", id: "fetch-base", label: "Fetching" },
      { type: "step-done", id: "fetch-base", ms: 10 },
      { type: "step", id: "create-branch", label: "Creating branch" },
      { type: "error", id: "create-branch", message: "already exists" },
    ]);
    expect(steps[0].status).toBe("done");
    expect(steps[1]).toMatchObject({ status: "failed", message: "already exists" });
  });

  it("on error without an id, fails whichever step is still running", () => {
    const steps = run([
      { type: "step", id: "fetch-base", label: "Fetching" },
      { type: "error", message: "check the VPN" },
    ]);
    expect(steps[0]).toMatchObject({ status: "failed", message: "check the VPN" });
  });

  it("done does not mutate the step list", () => {
    const before = run([{ type: "step", id: "create-session", label: "Starting" }]);
    const after = applyLaunchEvent(before, { type: "done", instance: { id: "x" } as never });
    expect(after).toEqual(before);
  });
});
