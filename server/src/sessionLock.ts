// A real FIFO mutex, keyed by tmux session name - NOT the single-flight pattern used by
// terminal.ts's sessionInitInFlight (which DEDUPLICATES concurrent callers onto one shared
// execution) or store.ts's saveQueue (which only serializes the final disk write). Both of
// those intentionally skip re-running work for a caller that arrives while one is already in
// flight. This module is the opposite: every caller's callback MUST run, in arrival order,
// never skipped and never merged with another caller's - a DELETE and a concurrent attach are
// different operations on the same session, and the whole reason this exists is to stop one
// from silently winning over the other instead of both running in a defined order.
//
// Held across an operation's ENTIRE lifetime for a session (e.g. DELETE's kill-then-persist,
// or ensureSessionReady's presence-check-then-recreate), not just its tmux calls - that is
// what closes the DELETE-vs-attach race this exists for (see terminal.ts's ensureSessionReady
// and routes.ts's DELETE handler, both of which acquire this lock around their whole body).
//
// No reentrancy: code already holding a session's lock must never call back into
// withSessionLock for the SAME session - doing so would deadlock forever, since the second
// acquisition would wait on a tail that can only advance once the first (still-running)
// callback finishes.
const sessionLockTails = new Map<string, Promise<unknown>>();

export async function withSessionLock<T>(sessionName: string, run: () => Promise<T>): Promise<T> {
  const previousTail: Promise<unknown> = sessionLockTails.get(sessionName) ?? Promise.resolve();
  // Chained onto BOTH branches of the previous tail (fulfilled or rejected) so one caller's
  // failure never poisons the queue for whoever is waiting behind it - each caller's own
  // outcome is independent of every other caller's.
  const myRun: Promise<T> = previousTail.then(run, run);
  // A tail promise that never rejects, purely for bookkeeping in the map: the map only needs
  // to know WHEN the previous holder finished, not what it returned or threw (myRun above is
  // what actually carries this caller's result/error back to its own awaiter).
  const myTail: Promise<void> = myRun.then(
    () => undefined,
    () => undefined
  );
  // Synchronous from the map's read above to this write, no `await` in between - so two calls
  // arriving back-to-back (same synchronous turn of the event loop) can never both read the
  // same previousTail and race each other into the map; the second always sees the first's
  // tail already installed. Same pattern as sessionInitInFlight in terminal.ts.
  sessionLockTails.set(sessionName, myTail);
  myTail.finally(() => {
    // Identity-safe: only remove the entry if it's still mine. If another caller queued
    // behind me in the meantime, the map already points at THEIR tail, and it is theirs to
    // clean up when they finish - deleting here would drop a live waiter's bookkeeping.
    if (sessionLockTails.get(sessionName) === myTail) {
      sessionLockTails.delete(sessionName);
    }
  });
  return myRun;
}
