import type { Instance } from "./types";
import { ApiError } from "./apiError";

// Client half of the POST /api/instances progress protocol (server side: server/src/launchProgress.ts).
// Two concerns live here, both pure and unit-tested: reading the NDJSON stream into events,
// and folding those events into the step list the modal renders.

export type LaunchStepId =
  | "prepare-resume"
  | "fetch-base"
  | "update-base"
  | "checkout-branch"
  | "create-branch"
  | "create-session"
  | "persist"
  | "launch-agent";

export type LaunchEvent =
  | { type: "step"; id: LaunchStepId; label: string }
  | { type: "step-done"; id: LaunchStepId; ms: number }
  | { type: "step-warning"; id: LaunchStepId; message: string }
  | { type: "error"; id?: LaunchStepId; message: string }
  | { type: "done"; instance: Instance };

export type LaunchStepStatus = "running" | "done" | "warning" | "failed";

export interface LaunchStepView {
  id: LaunchStepId;
  label: string;
  status: LaunchStepStatus;
  ms?: number;
  message?: string;
}

const KNOWN_EVENT_TYPES = new Set(["step", "step-done", "step-warning", "error", "done"]);

function isTerminal(event: LaunchEvent): boolean {
  return event.type === "done" || event.type === "error";
}

// A single NDJSON line -> event, or an ApiError if it is not a recognisable event. Exported
// for the tests; consumeLaunchStream is the real entry point.
export function parseLaunchLine(line: string): LaunchEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new ApiError("The server sent a malformed progress update.", 502);
  }
  if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
    throw new ApiError("The server sent an unrecognised progress update.", 502);
  }
  const event = parsed as { type: unknown };
  if (typeof event.type !== "string" || !KNOWN_EVENT_TYPES.has(event.type)) {
    throw new ApiError("The server sent an unrecognised progress update.", 502);
  }
  return parsed as LaunchEvent;
}

// Reads the whole stream, forwarding every event to `onEvent`, and resolves with the
// authoritative instance from the single terminal `done`. Rejects (ApiError) on a malformed
// line, a second terminal event, or the stream ending without one - the cases that would
// otherwise leave a step spinning forever or quietly pass an aborted stream off as success.
export async function consumeLaunchStream(
  body: ReadableStream<Uint8Array>,
  onEvent?: (event: LaunchEvent) => void
): Promise<Instance> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal: LaunchEvent | null = null;

  const handleLine = (rawLine: string): void => {
    const line = rawLine.trim();
    if (line === "") {
      return;
    }
    const event = parseLaunchLine(line);
    if (terminal !== null) {
      throw new ApiError("The server sent data after the stream had already finished.", 502);
    }
    if (isTerminal(event)) {
      terminal = event;
    }
    onEvent?.(event);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const rawLine = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        handleLine(rawLine);
      }
    }
    buffer += decoder.decode();
    handleLine(buffer);
  } finally {
    reader.releaseLock();
  }

  if (terminal === null) {
    throw new ApiError("The server closed the connection before finishing.", 502);
  }
  // TS cannot see that handleLine narrowed this; assert against the tagged union.
  const terminalEvent = terminal as LaunchEvent;
  if (terminalEvent.type === "error") {
    throw new ApiError(terminalEvent.message, 500);
  }
  if (terminalEvent.type === "done") {
    return terminalEvent.instance;
  }
  throw new ApiError("The server finished without a result.", 502);
}

// Fold one event into the running step list. Pure: same inputs, same output, no mutation.
export function applyLaunchEvent(steps: LaunchStepView[], event: LaunchEvent): LaunchStepView[] {
  switch (event.type) {
    case "step":
      if (steps.some((step) => step.id === event.id)) {
        return steps.map((step) =>
          step.id === event.id ? { ...step, label: event.label, status: "running" } : step
        );
      }
      return [...steps, { id: event.id, label: event.label, status: "running" }];
    case "step-done":
      return steps.map((step) =>
        step.id === event.id ? { ...step, status: "done", ms: event.ms } : step
      );
    case "step-warning":
      return steps.map((step) =>
        step.id === event.id ? { ...step, status: "warning", message: event.message } : step
      );
    case "error": {
      // Mark the step it names, or else the one still running, as failed; leave the rest
      // untouched so the log still shows how far it got.
      const targetIndex =
        event.id !== undefined
          ? steps.findIndex((step) => step.id === event.id)
          : steps.findIndex((step) => step.status === "running");
      if (targetIndex === -1) {
        return steps;
      }
      return steps.map((step, index) =>
        index === targetIndex ? { ...step, status: "failed", message: event.message } : step
      );
    }
    case "done":
      return steps;
  }
}
