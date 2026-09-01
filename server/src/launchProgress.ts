// Progress protocol for POST /api/instances once it commits to a streaming (NDJSON) response.
//
// Why this is its own module: the route hands each event to a sink it injects (a closure over
// `response.write`), never to the Response object directly, so the whole emitter is testable
// with a plain array sink and no express. And the emitter NEVER throws - a write to a socket
// the browser or Caddy already closed will reject, and if that propagated into the route's
// execution phase it could interrupt initializeInstanceSession's guarded tmux sequence (see
// terminal.ts's long header comment). So a failed write just marks the sink dead and every
// later event is a no-op; initialization keeps running exactly as if no progress were wired
// at all.

// One step per real awaited operation in the execution phase. Every await after the response
// commits must sit inside one of these, so a slow or failing operation always has exactly one
// "current" step to attribute the time and the failure to.
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
  // A step began. `label` is human-facing.
  | { type: "step"; id: LaunchStepId; label: string }
  // A step finished cleanly. `ms` is measured on the server around the real work.
  | { type: "step-done"; id: LaunchStepId; ms: number }
  // A step was applied but could not be confirmed (the faithful translation of today's
  // "persisted, but the provider launch did not confirm" case). NOT terminal: always
  // followed by `done`. The client paints the step amber and still adds the instance.
  | { type: "step-warning"; id: LaunchStepId; message: string }
  // Terminal, failure: nothing was persisted, the client adds no instance. Mirrors the
  // 409/500 the endpoint used to return.
  | { type: "error"; id?: LaunchStepId; message: string }
  // Terminal, success: `instance` is the authoritative persisted record.
  | { type: "done"; instance: unknown };

export type LaunchSink = (line: string) => void;

export class LaunchProgress {
  private readonly startedAt = new Map<LaunchStepId, number>();
  private sinkAlive = true;
  private terminalSent = false;

  constructor(private readonly sink: LaunchSink, private readonly now: () => number = Date.now) {}

  stepStart(id: LaunchStepId, label: string): void {
    this.startedAt.set(id, this.now());
    this.write({ type: "step", id, label });
  }

  stepDone(id: LaunchStepId): void {
    const started = this.startedAt.get(id);
    this.write({ type: "step-done", id, ms: started === undefined ? 0 : this.now() - started });
  }

  stepWarning(id: LaunchStepId, message: string): void {
    this.write({ type: "step-warning", id, message });
  }

  // Terminal. Safe to call more than once (only the first is emitted) so the route's
  // catch/finally can call it defensively.
  fail(message: string, id?: LaunchStepId): void {
    if (this.terminalSent) {
      return;
    }
    this.terminalSent = true;
    this.write({ type: "error", ...(id === undefined ? {} : { id }), message });
  }

  // Terminal.
  done(instance: unknown): void {
    if (this.terminalSent) {
      return;
    }
    this.terminalSent = true;
    this.write({ type: "done", instance });
  }

  get hasSentTerminal(): boolean {
    return this.terminalSent;
  }

  // The client stopped reading: stop writing, but never abort the work in flight.
  markSinkClosed(): void {
    this.sinkAlive = false;
  }

  private write(event: LaunchEvent): void {
    if (!this.sinkAlive) {
      return;
    }
    try {
      this.sink(`${JSON.stringify(event)}\n`);
    } catch {
      // Socket already closed by the browser or the reverse proxy. Not our problem to
      // recover from and definitely not something to throw over - the tmux session and the
      // agent must still finish coming up.
      this.sinkAlive = false;
    }
  }
}
