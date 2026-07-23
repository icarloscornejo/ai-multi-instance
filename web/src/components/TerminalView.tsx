import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITheme } from "@xterm/xterm";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useIsMobile } from "../hooks/useIsMobile";
import { getHostFontSize, setHostFontSize } from "../hostPrefs";
import { btnGhost } from "../ui";
import type { Instance } from "../types";
import type { Theme } from "../theme";

export interface TerminalViewHandle {
  sendInput: (data: string) => void;
  scrollToBottom: () => void;
}

const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 18;

// ANSI palette aligned to the design tokens (xterm's defaults are too saturated)
const terminalThemeDark: ITheme = {
  background: "#17181a",
  foreground: "#c8cace",
  cursor: "#e2665e",
  cursorAccent: "#17181a",
  selectionBackground: "rgba(255,255,255,0.18)",
  // Original #1e2023 was nearly invisible on the #17181a background (contrast ~1.1:1);
  // Claude Code menus use ANSI black as text and were unreadable
  black: "#4d5058",
  red: "#c1615c",
  green: "#7ec699",
  yellow: "#d7ba7d",
  blue: "#7d9fc4",
  magenta: "#b491c8",
  cyan: "#7dcfb6",
  white: "#c8cace",
  brightBlack: "#6b6d70",
  brightRed: "#d3766f",
  brightGreen: "#93d4ab",
  brightYellow: "#e3c78f",
  brightBlue: "#94b4d4",
  brightMagenta: "#c6a6d8",
  brightCyan: "#94dcc6",
  brightWhite: "#f2f2f0",
};

const terminalThemeLight: ITheme = {
  background: "#ffffff",
  foreground: "#26282c",
  cursor: "#cf5147",
  cursorAccent: "#ffffff",
  selectionBackground: "rgba(0,0,0,0.14)",
  black: "#2b2c2f",
  red: "#b3413a",
  green: "#2f8f5b",
  yellow: "#a67c1e",
  blue: "#3f6fa8",
  magenta: "#8a5aa8",
  cyan: "#1f8f7d",
  white: "#5b5d62",
  brightBlack: "#75777c",
  brightRed: "#c1544a",
  brightGreen: "#3aa76a",
  brightYellow: "#b98f2c",
  brightBlue: "#4c7fb8",
  brightMagenta: "#9c6cb8",
  brightCyan: "#2a9f8c",
  brightWhite: "#101113",
};

const terminalThemesByMode: Record<Theme, ITheme> = {
  dark: terminalThemeDark,
  light: terminalThemeLight,
};

interface TerminalViewProps {
  instance: Instance;
  visible: boolean;
  theme: Theme;
  // Mobile navigates into the terminal screen without the user having tapped inside
  // the terminal itself; auto-focusing there would pop the native keyboard unprompted
  focusOnVisible?: boolean;
  onAtBottomChange?: (atBottom: boolean) => void;
}

const RECONNECT_DELAY_MS = 3_000;
const RECONNECT_RING_RADIUS = 16;
const RECONNECT_RING_CIRCUMFERENCE = 2 * Math.PI * RECONNECT_RING_RADIUS;

// tmux's mouse mode puts xterm's own touch-scroll to sleep (it only runs when
// no mouse tracking is active) and attach runs tmux in the alt screen anyway, so
// xterm's normal scrollback is empty regardless. Instead we translate swipes into
// synthetic wheel events on xterm's element: its existing wheel handler already
// encodes them with whatever mouse protocol tmux requested, and tmux's WheelPane
// binding (see reduceScrollStep in server/src/tmux.ts) enters copy-mode and scrolls
// 3 lines per tick, so we accumulate drag distance in 3-line steps to track the finger.
const SYNTHETIC_WHEEL_TICK_LINES = 3;

// Ticks are paced by ack instead of a fixed timer: the next tick is only dispatched once
// the previous one's redraw has actually landed (see the ack machinery above the touch
// listeners in TerminalView), so the client never queues up more redraws than the real
// round trip can clear regardless of link latency (localhost, LAN, or the Cloudflare
// tunnel all self-adjust). If an ack never arrives (e.g. the tick didn't change anything
// because scrollback is already at an edge), this timeout unblocks the next tick instead
// of stalling the gesture forever.
const ACK_TIMEOUT_MS = 90;
// Floor for momentum's own re-check cadence while coasting after the finger lifts (there
// is no touchmove to drive it, so it must re-arm itself); NOT a wire-pacing interval.
const MOMENTUM_TICK_INTERVAL_MS = 20;
// Per-momentum-tick decay applied to the release velocity while coasting; ~50 ticks/sec
// (1000 / MOMENTUM_TICK_INTERVAL_MS) at 0.95 decays to a stop in a bit over a second, so
// the coast reads as a gradual ease-out instead of stopping short right after the finger
// lifts.
const MOMENTUM_DECAY_PER_TICK = 0.95;
const MOMENTUM_MIN_VELOCITY_PX_PER_MS = 0.02;

// A landed tick has already jumped the content by a full 3-line step; instead of showing
// that step as a snap, we offset the container back by that same amount right as it lands
// and animate the offset to 0, so the eye reads a slide instead of a jump. The duration is
// a running average of the real interval between acks (see slideIntervalEmaMs below) so
// each slide finishes roughly when the next step's data is expected, clamped so a single
// slow or fast outlier reading can't produce a slide that's imperceptibly short or drags
// on well past the next step.
const SLIDE_MIN_DURATION_MS = 60;
const SLIDE_MAX_DURATION_MS = ACK_TIMEOUT_MS + 40;
const SLIDE_INTERVAL_EMA_ALPHA = 0.3;
// 1-line fine ticks (see FINE_SCROLL_VELOCITY_PX_PER_MS below) cost the same full-pane
// round trip as a 3-line tick, so covering the same distance takes 3x as many round trips.
// Clamping their slide to the same ceiling as a 3-line tick means the animation finishes
// before the real redraw lands whenever a round trip runs long, leaving a frozen frame
// until the next one arrives, which reads as the swipe losing and regaining momentum. A
// wider ceiling here lets the slide track the real round trip instead of stopping short.
const FINE_SLIDE_MAX_DURATION_MS = ACK_TIMEOUT_MS + 160;

// Below this velocity the coast is in its slow tail, where a 3-line jump is most visible
// and message frequency is naturally low, so the traffic cost this app avoided by keeping
// the server-side wheel bind at 3 lines (see reduceScrollStep in server/src/tmux.ts)
// doesn't apply here. Only reachable during momentum (after the finger has lifted), never
// during an active drag.
const FINE_SCROLL_VELOCITY_PX_PER_MS = 0.15;
// tmux's copy-mode-vi key table binds C-y/C-e to a 1-line scroll-up/scroll-down; that
// table (reduceScrollStep only rebinds the 3-line WheelPane entries, these are untouched)
// is only active while mode-keys is "vi", which this app never sets itself, it's whatever
// the host's tmux config has. If mode-keys were ever "emacs" here, C-e resolves to
// end-of-line in that table instead of scroll. To stay safe without reading tmux options
// from the client, this is only sent once a wheel tick has already landed a real ack this
// gesture (hasAckedThisGesture below), which is only possible from inside copy-mode,
// never speculatively.
const FINE_SCROLL_UP_BYTES = "\u0019"; // C-y
const FINE_SCROLL_DOWN_BYTES = "\u0005"; // C-e

function DisconnectedOverlay({
  msRemaining,
  totalMs,
  onReconnect,
}: {
  msRemaining: number;
  totalMs: number;
  onReconnect: () => void;
}) {
  const progress: number = 1 - msRemaining / totalMs;
  const secondsRemaining: number = Math.max(1, Math.ceil(msRemaining / 1000));

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-app/80">
      <div className="flex w-[280px] flex-col items-center gap-[14px] rounded-lg border border-border bg-surface p-[26px] shadow-modal">
        <div className="relative flex h-[38px] w-[38px] items-center justify-center">
          <svg viewBox="0 0 38 38" className="h-[38px] w-[38px] -rotate-90">
            <circle
              cx="19"
              cy="19"
              r={RECONNECT_RING_RADIUS}
              fill="none"
              stroke="var(--color-border-strong)"
              strokeWidth="3"
            />
            <circle
              cx="19"
              cy="19"
              r={RECONNECT_RING_RADIUS}
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={RECONNECT_RING_CIRCUMFERENCE}
              strokeDashoffset={RECONNECT_RING_CIRCUMFERENCE * (1 - progress)}
            />
          </svg>
          <span className="absolute flex items-center justify-center text-accent">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-[15px] w-[15px]"
            >
              <path d="M1 9a16 16 0 0 1 22 0M5 13a10.5 10.5 0 0 1 14 0M8.5 17a5.5 5.5 0 0 1 7 0" />
              <line x1="12" y1="21" x2="12.01" y2="21" />
            </svg>
          </span>
        </div>
        <div className="flex flex-col items-center gap-[3px] text-center">
          <span className="text-[13px] font-semibold text-txt-bright">Session disconnected</span>
          <span className="text-[11.5px] tabular-nums text-txt-dim">
            Retrying in <span className="font-semibold text-txt-secondary">{secondsRemaining}</span> seconds...
          </span>
        </div>
        <button type="button" onClick={onReconnect} className={`${btnGhost} px-[14px] py-[6px] text-[11.5px]`}>
          Reconnect now
        </button>
      </div>
    </div>
  );
}

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(function TerminalView(
  { instance, visible, theme, focusOnVisible = true, onAtBottomChange },
  forwardedRef
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const persistTimerRef = useRef<number | null>(null);
  const isMobile = useIsMobile();
  // Mobile screens are small enough that the server's default (tuned for desktop) reads
  // cramped-in-a-good-way but wastes space here; default to the smallest zoom on mobile
  // until the user picks their own (still persisted separately per-device via hostPrefs).
  const [fontSize, setFontSize] = useState<number>(() =>
    getHostFontSize(instance.id, isMobile ? MIN_FONT_SIZE : instance.fontSize)
  );
  const [disconnected, setDisconnected] = useState<boolean>(false);
  const [reconnectMsRemaining, setReconnectMsRemaining] = useState<number>(RECONNECT_DELAY_MS);
  const [connectionEpoch, setConnectionEpoch] = useState<number>(0);
  // On mobile every instance mounts hidden (display: none) in the always-rendered pool, so
  // fit() measures a zero-width container and the socket would open with xterm's 80x24
  // fallback baked into the initial pty size. Deferring the connection until this instance
  // has actually been shown once means the first fit is real, so the pty (and tmux's first
  // redraw) is sized correctly from the start instead of needing a later resize that
  // reflows a buffer already full of 80-column content and leaves the viewport unanchored
  // from the tail.
  const [hasBeenVisible, setHasBeenVisible] = useState<boolean>(visible);
  // xterm measures its cell size once when the terminal is created (and again only if
  // fontFamily/fontSize change later), never in reaction to the font finishing its network
  // load. Creating the terminal before JetBrains Mono is ready bakes in the fallback font's
  // (shorter) cell height, so fit() overcounts rows and the bottom ones render past the
  // container's clipped edge. Gating terminal creation on the font being ready means the
  // only measurement that matters always uses the real font.
  const [fontReady, setFontReady] = useState<boolean>(false);
  useEffect(() => {
    let cancelled = false;
    document.fonts
      .load(`${fontSize}px "JetBrains Mono"`)
      .catch(() => {
        // Fall through to fallback-font metrics rather than never creating the terminal
      })
      .then(() => {
        if (!cancelled) {
          setFontReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onAtBottomChangeRef = useRef(onAtBottomChange);
  onAtBottomChangeRef.current = onAtBottomChange;
  const touchScrollRef = useRef<{ lastClientY: number; accumulatedPx: number; released: boolean } | null>(null);
  // Set by the WS message handler's terminal.write() callback once a write has actually
  // been parsed; read by the touch-scroll ack gate in the terminal-creation effect below.
  const writeCommittedForAckRef = useRef<boolean>(false);

  useImperativeHandle(
    forwardedRef,
    () => ({
      sendInput: (data: string) => {
        const socket = socketRef.current;
        if (socket !== null && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "input", data }));
        }
      },
      scrollToBottom: () => terminalRef.current?.scrollToBottom(),
    }),
    []
  );

  const safeFit = useCallback((): void => {
    const container = containerRef.current;
    const fitAddon = fitAddonRef.current;
    // fit() on a hidden container (display: none) computes garbage dimensions
    if (container === null || fitAddon === null || container.clientWidth === 0) {
      return;
    }
    fitAddon.fit();
  }, []);

  const applyZoom = useCallback(
    (delta: number): void => {
      setFontSize((previousSize) => {
        const nextSize: number = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, previousSize + delta));
        if (nextSize !== previousSize && terminalRef.current !== null) {
          terminalRef.current.options.fontSize = nextSize;
          requestAnimationFrame(() => safeFit());
          if (persistTimerRef.current !== null) {
            window.clearTimeout(persistTimerRef.current);
          }
          persistTimerRef.current = window.setTimeout(() => {
            setHostFontSize(instance.id, nextSize);
          }, 600);
        }
        return nextSize;
      });
    },
    [instance.id, safeFit]
  );

  // Create the xterm terminal, once per instance, deferred until fontReady (see its
  // declaration above): creating it earlier would measure cell size with the fallback font.
  useEffect(() => {
    if (!fontReady) {
      return;
    }
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    const terminal = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize,
      theme: terminalThemesByMode[theme],
      cursorBlink: true,
      scrollback: 5000,
      smoothScrollDuration: 120,
      allowProposedApi: true,
      // Some TUIs send truecolor values (e.g. pure black) that bypass the theme palette;
      // this rewrites them on the fly so they are always readable on the background
      minimumContrastRatio: 4.5,
      // With tmux mouse mode active, normal click-drag is captured by tmux;
      // holding Option forces xterm's native selection for copying
      macOptionClickForcesSelection: true,
      // Option+click by default "moves the cursor" by sending arrow keys to the pty;
      // Claude Code interprets up-arrows as history and fills the input with
      // the previous prompt
      altClickMovesCursor: false,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // DOM renderer repaints the whole pane's DOM nodes on every redraw; on mobile that's
    // the single most expensive step in the touch-scroll round trip. WebGL renders to a
    // canvas instead, which is cheap enough that it stops being the bottleneck. Falls back
    // to the DOM renderer (xterm's default) if WebGL is unavailable or the context is lost,
    // since it's the addon crashing/degrading, not something the terminal can't run without.
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon.dispose();
        // Mobile browsers reclaim the WebGL context when the app is backgrounded; falling
        // back to the DOM renderer leaves whatever was on the canvas stale until new data
        // writes a row. If nothing is being written (e.g. a prompt already sitting idle),
        // the screen stays blank until this forces every row to repaint immediately.
        terminal.refresh(0, terminal.rows - 1);
      });
      terminal.loadAddon(webglAddon);
    } catch {
      // no WebGL support; xterm keeps using its default DOM renderer
    }

    terminal.onData((typedData: string) => {
      const socket = socketRef.current;
      if (socket !== null && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data: typedData }));
      }
    });

    terminal.onResize(({ cols, rows }: { cols: number; rows: number }) => {
      const socket = socketRef.current;
      if (socket !== null && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });

    // Cmd/Ctrl +/- adjust zoom only when focus is inside the terminal
    terminal.attachCustomKeyEventHandler((event: KeyboardEvent): boolean => {
      if (event.type !== "keydown" || !(event.metaKey || event.ctrlKey)) {
        return true;
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        applyZoom(1);
        return false;
      }
      if (event.key === "-") {
        event.preventDefault();
        applyZoom(-1);
        return false;
      }
      return true;
    });

    terminal.onScroll(() => {
      const buffer = terminal.buffer.active;
      onAtBottomChangeRef.current?.(buffer.viewportY >= buffer.baseY);
    });

    // xterm's built-in touch-scroll only runs when no mouse tracking is active, so with
    // tmux's mouse mode on (see SYNTHETIC_WHEEL_TICK_LINES above) it never fires; we
    // synthesize the wheel events ourselves from the raw swipe instead.
    //
    // Ticks are paced by ack rather than fired synchronously inside touchmove: each tick
    // makes tmux redraw the whole pane over the WebSocket, and a fast swipe can accumulate
    // many lines' worth in a single touchmove callback. Firing them all at once queues up
    // more redraws than the round trip can clear, so the screen visibly falls behind and
    // then catches up in a stutter, which is what reads as not smooth, more than the
    // line-jump size itself. Keeping exactly one redraw in flight, waiting for this tick's
    // ack before sending the next, self-adjusts to the real round trip instead of guessing
    // a fixed interval, and lets the tail continue to coast after the finger lifts
    // (momentum), instead of stopping dead.
    //
    // "Ack" means the render that resulted from this tick's data actually landing. Two
    // gates, both required: (1) writeCommittedForAckRef flips true only once
    // terminal.write() has parsed the bytes from a socket message following this tick
    // (armed fresh per tick), and (2) the onRender range below has to cover more than just
    // the cursor's row, since cursorBlink also fires onRender and would otherwise ack
    // instantly for the wrong reason. A safety timeout unblocks the gesture if a tick
    // doesn't change anything (e.g. scrollback is already at an edge) and so never
    // triggers a real redraw.
    let dragVelocityPxPerMs = 0;
    let lastMoveTimestamp = 0;
    let lastMomentumTimestamp = 0;
    let awaitingAck = false;
    let ackTimeoutId: number | null = null;
    let momentumTimeoutId: number | null = null;
    // Two ack timeouts in a row during coast mean the scrollback is pinned at an edge
    // (tmux has nothing left to redraw), not that a tick was merely slow; without this the
    // coast keeps retrying every ACK_TIMEOUT_MS until velocity decays to zero, which at the
    // ~90ms-per-attempt pace near an edge takes several seconds of an invisible "stuck" loop.
    let consecutiveAckTimeouts = 0;
    // Signed px of the tick currently in flight (direction * tickPx), consumed once its
    // ack lands to know which way and how far to slide the visual compensation from.
    let pendingSlideOffsetPx = 0;
    let pendingSlideWasFine = false;
    let lastAckLandTimestamp = 0;
    let slideIntervalEmaMs = SLIDE_MIN_DURATION_MS;
    // Flips true the first time a real ack (not a timeout) lands for this gesture, which
    // is only possible from inside copy-mode; gates the 1-line C-y/C-e fine-scroll path.
    let hasAckedThisGesture = false;

    const clearTimers = (): void => {
      if (ackTimeoutId !== null) {
        window.clearTimeout(ackTimeoutId);
        ackTimeoutId = null;
      }
      if (momentumTimeoutId !== null) {
        window.clearTimeout(momentumTimeoutId);
        momentumTimeoutId = null;
      }
    };

    const resetSlideTransform = (): void => {
      container.style.transition = "none";
      container.style.transform = "";
      lastAckLandTimestamp = 0;
      slideIntervalEmaMs = SLIDE_MIN_DURATION_MS;
    };

    const playSlideCompensation = (): void => {
      const now: number = performance.now();
      if (lastAckLandTimestamp !== 0) {
        const observedIntervalMs: number = now - lastAckLandTimestamp;
        slideIntervalEmaMs =
          slideIntervalEmaMs * (1 - SLIDE_INTERVAL_EMA_ALPHA) + observedIntervalMs * SLIDE_INTERVAL_EMA_ALPHA;
      }
      lastAckLandTimestamp = now;

      if (pendingSlideOffsetPx === 0) {
        return;
      }
      const maxDurationMs: number = pendingSlideWasFine ? FINE_SLIDE_MAX_DURATION_MS : SLIDE_MAX_DURATION_MS;
      const durationMs: number = Math.min(maxDurationMs, Math.max(SLIDE_MIN_DURATION_MS, slideIntervalEmaMs));
      container.style.transition = "none";
      container.style.transform = `translateY(${pendingSlideOffsetPx}px)`;
      // Force a layout flush so the jump above is committed before the transition below
      // is applied; otherwise the browser may coalesce both style writes into one frame
      // and skip straight to the animated end state.
      void container.offsetHeight;
      container.style.transition = `transform ${durationMs}ms linear`;
      container.style.transform = "translateY(0px)";
      pendingSlideOffsetPx = 0;
    };

    const stopDraining = (): void => {
      clearTimers();
      awaitingAck = false;
      touchScrollRef.current = null;
      resetSlideTransform();
    };

    const attemptDispatch = (): void => {
      if (awaitingAck) {
        return;
      }
      const activeTerminal = terminalRef.current;
      const touchState = touchScrollRef.current;
      if (activeTerminal === null || touchState === null) {
        stopDraining();
        return;
      }

      if (touchState.released) {
        const now: number = performance.now();
        const elapsedMs: number = lastMomentumTimestamp === 0 ? 0 : now - lastMomentumTimestamp;
        lastMomentumTimestamp = now;
        if (Math.abs(dragVelocityPxPerMs) < MOMENTUM_MIN_VELOCITY_PX_PER_MS) {
          stopDraining();
          return;
        }
        touchState.accumulatedPx += dragVelocityPxPerMs * elapsedMs;
        dragVelocityPxPerMs *= MOMENTUM_DECAY_PER_TICK;
      }

      const lineHeightPx: number = container.clientHeight / Math.max(1, activeTerminal.rows);
      // Once this gesture has already proven copy-mode is active (a prior tick landed a
      // real ack) and the coast has slowed into its tail, switch to 1-line raw key sends
      // instead of 3-line synthetic wheel ticks (see FINE_SCROLL_VELOCITY_PX_PER_MS above).
      const useFineScroll: boolean =
        touchState.released && hasAckedThisGesture && Math.abs(dragVelocityPxPerMs) < FINE_SCROLL_VELOCITY_PX_PER_MS;
      const tickLines: number = useFineScroll ? 1 : SYNTHETIC_WHEEL_TICK_LINES;
      const tickPx: number = tickLines * lineHeightPx;
      if (Math.abs(touchState.accumulatedPx) < tickPx) {
        // Nothing to send yet. While coasting there is no touchmove to drive the next
        // attempt, so re-arm ourselves; an active finger drag calls back in via
        // handleTouchMove instead.
        if (touchState.released) {
          momentumTimeoutId = window.setTimeout(attemptDispatch, MOMENTUM_TICK_INTERVAL_MS);
        }
        return;
      }

      const direction: number = Math.sign(touchState.accumulatedPx);
      touchState.accumulatedPx -= direction * tickPx;
      pendingSlideOffsetPx = direction * tickPx;
      pendingSlideWasFine = useFineScroll;
      writeCommittedForAckRef.current = false;
      if (useFineScroll) {
        const socket = socketRef.current;
        if (socket !== null && socket.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify({ type: "input", data: direction > 0 ? FINE_SCROLL_DOWN_BYTES : FINE_SCROLL_UP_BYTES })
          );
        }
      } else {
        activeTerminal.element?.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: direction * tickPx,
            deltaMode: WheelEvent.DOM_DELTA_PIXEL,
            bubbles: true,
            cancelable: true,
          })
        );
      }
      awaitingAck = true;
      ackTimeoutId = window.setTimeout(() => {
        ackTimeoutId = null;
        awaitingAck = false;
        // No real redraw landed for this tick (e.g. scrollback was already at an edge),
        // so there is nothing to visually compensate for; drop it rather than letting the
        // next real ack apply a jump-and-slide offset for a step that never happened.
        pendingSlideOffsetPx = 0;
        const touchState = touchScrollRef.current;
        if (touchState !== null && touchState.released) {
          consecutiveAckTimeouts += 1;
          // A single missed ack can just be a slow tick; two in a row while coasting
          // means the scrollback is pinned at an edge and further ticks are pointless.
          if (consecutiveAckTimeouts >= 2) {
            stopDraining();
            return;
          }
        }
        attemptDispatch();
      }, ACK_TIMEOUT_MS);
    };

    terminal.onRender(({ start, end }: { start: number; end: number }) => {
      if (!awaitingAck || !writeCommittedForAckRef.current) {
        return;
      }
      const cursorRow: number = terminal.buffer.active.cursorY;
      const isCursorBlinkOnly: boolean = start === end && start === cursorRow;
      if (isCursorBlinkOnly) {
        return;
      }
      if (ackTimeoutId !== null) {
        window.clearTimeout(ackTimeoutId);
        ackTimeoutId = null;
      }
      awaitingAck = false;
      hasAckedThisGesture = true;
      consecutiveAckTimeouts = 0;
      playSlideCompensation();
      attemptDispatch();
    });

    const handleTouchStart = (event: TouchEvent): void => {
      if (event.touches.length !== 1) {
        stopDraining();
        return;
      }
      clearTimers();
      awaitingAck = false;
      hasAckedThisGesture = false;
      consecutiveAckTimeouts = 0;
      pendingSlideOffsetPx = 0;
      resetSlideTransform();
      touchScrollRef.current = { lastClientY: event.touches[0].clientY, accumulatedPx: 0, released: false };
      dragVelocityPxPerMs = 0;
      lastMoveTimestamp = event.timeStamp;
      lastMomentumTimestamp = 0;
    };

    const handleTouchMove = (event: TouchEvent): void => {
      const activeTerminal = terminalRef.current;
      const touchState = touchScrollRef.current;
      if (
        activeTerminal === null ||
        touchState === null ||
        activeTerminal.modes.mouseTrackingMode === "none" ||
        event.touches.length !== 1
      ) {
        return;
      }
      // Without this the browser treats the gesture as unhandled and falls back to
      // native pull-to-refresh/rubber-banding once it reaches the top.
      event.preventDefault();
      const currentClientY: number = event.touches[0].clientY;
      const movedPx: number = touchState.lastClientY - currentClientY;
      const elapsedMs: number = Math.max(1, event.timeStamp - lastMoveTimestamp);
      dragVelocityPxPerMs = movedPx / elapsedMs;
      lastMoveTimestamp = event.timeStamp;
      touchState.lastClientY = currentClientY;
      touchState.accumulatedPx += movedPx;

      attemptDispatch();
    };

    const handleTouchRelease = (event: TouchEvent): void => {
      if (event.touches.length > 0) {
        return;
      }
      const touchState = touchScrollRef.current;
      if (touchState === null) {
        return;
      }
      touchState.released = true;
      if (Math.abs(dragVelocityPxPerMs) < MOMENTUM_MIN_VELOCITY_PX_PER_MS) {
        stopDraining();
        return;
      }
      lastMomentumTimestamp = performance.now();
      attemptDispatch();
    };

    container.addEventListener("touchstart", handleTouchStart, { passive: true });
    container.addEventListener("touchmove", handleTouchMove, { passive: false });
    container.addEventListener("touchend", handleTouchRelease, { passive: true });
    container.addEventListener("touchcancel", handleTouchRelease, { passive: true });

    // The container can resize outside any of the other repaint triggers below, e.g. a
    // mobile browser's address bar collapsing mid-session (100dvh grows the layout when
    // that happens). fit() alone only sends the new size to the pty; it does not repaint
    // the newly revealed rows, so without a forced refresh here they stay blank until some
    // unrelated event (reopening the screen, toggling the keyboard) happens to trigger one.
    const resizeObserver = new ResizeObserver(() => {
      safeFit();
      const terminal = terminalRef.current;
      if (terminal !== null) {
        terminal.refresh(0, terminal.rows - 1);
      }
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
      container.removeEventListener("touchend", handleTouchRelease);
      container.removeEventListener("touchcancel", handleTouchRelease);
      stopDraining();
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
      }
      socketRef.current?.close();
      try {
        terminal.dispose();
      } catch {
        // xterm-addon-webgl can throw from its own internal teardown if the WebGL
        // context was already lost/disposed by the time terminal.dispose() reaches it
        // (see onContextLoss above). The terminal is being torn down either way, and
        // with no error boundary in this app an uncaught throw here crashes the whole
        // React tree instead of just this component.
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontReady]);

  // WebSocket connection to the tmux bridge; connectionEpoch allows manual reconnect.
  // Deferred until hasBeenVisible so the first fit (right below) measures a real,
  // on-screen container instead of a hidden one (see hasBeenVisible's declaration above),
  // and until fontReady so that fit exists at all (the terminal itself isn't created
  // before then, see fontReady's declaration above) and measures with the real font.
  useEffect(() => {
    if (!hasBeenVisible || !fontReady) {
      return;
    }
    // fit() is synchronous and the layout is settled when this effect runs (it runs
    // after the commit); we measure real cols/rows BEFORE opening the socket so we
    // can send them in the URL. The server uses this as the pty's initial size instead
    // of a hardcoded value, so tmux never draws for a different size than the client
    // on the first frame (see bridgeTerminal in server/src/terminal.ts).
    safeFit();
    const terminalBeforeConnect = terminalRef.current;
    const sizeQuery: string =
      terminalBeforeConnect !== null
        ? `?cols=${terminalBeforeConnect.cols}&rows=${terminalBeforeConnect.rows}`
        : "";
    const wsProtocol: string = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${wsProtocol}://${window.location.host}/ws/terminal/${instance.id}${sizeQuery}`);
    socketRef.current = socket;

    socket.onopen = () => {
      setDisconnected(false);
      safeFit();
      const terminal = terminalRef.current;
      if (terminal !== null) {
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
        // A reconnect on mobile often coincides with the same background/foreground cycle
        // that can silently drop the WebGL context; force a full repaint so nothing is left
        // showing whatever was on screen before the drop.
        terminal.refresh(0, terminal.rows - 1);
      }
    };
    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") {
        terminalRef.current?.write(event.data, () => {
          writeCommittedForAckRef.current = true;
        });
      }
    };
    // A real disconnect (server restart from tsx watch, self-update, etc.) keeps retrying
    // every RECONNECT_DELAY_MS instead of stranding the user on the manual Reconnect button
    let reconnectTimeoutId: number | undefined;
    let reconnectCountdownIntervalId: number | undefined;
    socket.onclose = () => {
      setDisconnected(true);
      const retryStartedAt: number = Date.now();
      setReconnectMsRemaining(RECONNECT_DELAY_MS);
      reconnectCountdownIntervalId = window.setInterval(() => {
        setReconnectMsRemaining(Math.max(0, RECONNECT_DELAY_MS - (Date.now() - retryStartedAt)));
      }, 100);
      reconnectTimeoutId = window.setTimeout(() => {
        window.clearInterval(reconnectCountdownIntervalId);
        setConnectionEpoch((previousEpoch) => previousEpoch + 1);
      }, RECONNECT_DELAY_MS);
    };

    return () => {
      socket.onclose = null;
      socket.close();
      window.clearTimeout(reconnectTimeoutId);
      window.clearInterval(reconnectCountdownIntervalId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionEpoch, instance.id, hasBeenVisible, fontReady]);

  // The terminal already exists with the mount-time palette; on theme toggle
  // only the active palette needs reassigning, no need to recreate the session
  useEffect(() => {
    if (terminalRef.current !== null) {
      terminalRef.current.options.theme = terminalThemesByMode[theme];
    }
  }, [theme]);

  useEffect(() => {
    if (visible && !hasBeenVisible) {
      setHasBeenVisible(true);
    }
  }, [visible, hasBeenVisible]);

  // When becoming visible again the container recovers real dimensions: re-fit and focus.
  // Double rAF because returning from Settings may leave the flex layout not yet settled
  // on the first frame (a single rAF sometimes measures the container mid-transition).
  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          safeFit();
          // Coming back from background can leave the canvas stale if the WebGL context
          // was reclaimed while hidden; force a full repaint rather than waiting for the
          // next write to touch every row.
          const terminal = terminalRef.current;
          if (terminal !== null) {
            terminal.refresh(0, terminal.rows - 1);
          }
          if (focusOnVisible) {
            terminalRef.current?.focus();
          }
        });
      });
    }
  }, [visible, safeFit, focusOnVisible]);

  const reconnect = (): void => {
    terminalRef.current?.reset();
    setConnectionEpoch((previousEpoch) => previousEpoch + 1);
  };

  return (
    <div className={`flex-1 min-h-0 flex-col ${visible ? "flex" : "hidden"}`}>
      <div
        className="relative flex-1 min-h-0 overflow-hidden"
        style={{ background: terminalThemesByMode[theme].background }}
      >
        <div
          ref={containerRef}
          className="flex h-full w-full justify-center"
          style={{ touchAction: "none", willChange: "transform" }}
        />
        {disconnected && (
          <DisconnectedOverlay
            msRemaining={reconnectMsRemaining}
            totalMs={RECONNECT_DELAY_MS}
            onReconnect={reconnect}
          />
        )}
        <div className="absolute bottom-[12px] right-[14px] flex gap-[6px]">
          <button
            type="button"
            onClick={() => applyZoom(-1)}
            title="Decrease text size (Cmd -)"
            className="h-[22px] w-[22px] rounded-[5px] border border-border text-[10px] font-bold text-txt-dim hover:text-txt-secondary"
          >
            A-
          </button>
          <button
            type="button"
            onClick={() => applyZoom(1)}
            title="Increase text size (Cmd +)"
            className="h-[22px] w-[22px] rounded-[5px] border border-border text-[10px] font-bold text-txt-dim hover:text-txt-secondary"
          >
            A+
          </button>
        </div>
      </div>
    </div>
  );
});

TerminalView.displayName = "TerminalView";
