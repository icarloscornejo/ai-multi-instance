import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITheme } from "@xterm/xterm";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { api } from "../api";
import { useIsMobile } from "../hooks/useIsMobile";
import { useWakeRetry } from "../hooks/useWakeRetry";
import { getHostFontSize, setHostFontSize } from "../hostPrefs";
import { retryDelayMs } from "../retry";
import { btnGhost } from "../ui";
import { RetryRing } from "./RetryRing";
import type { Instance } from "../types";
import type { Theme } from "../theme";

export interface TerminalViewHandle {
  sendInput: (data: string) => void;
}

const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 18;
// Caps recreation attempts after a WebGL context loss so a genuinely dead GPU/driver falls
// back to the DOM renderer instead of retrying forever.
const MAX_WEBGL_CONTEXT_LOSS_RETRIES = 3;

// Mobile OSes and flaky networks can kill a socket's underlying TCP connection without
// either side ever seeing a "close" event: readyState stays OPEN and no error fires, it
// just silently stops carrying data (a half-open/"zombie" socket). Since the whole reconnect
// flow below hangs off "close" (see socket.onclose), a zombie socket used to strand the user
// on the disconnected overlay's manual "Reconnect now" button. This app-level ping/pong (the
// server answers with a binary frame the client's onmessage below already ignores as terminal
// output) plus the liveness check give the client its own signal that a socket claiming to be
// OPEN is actually dead, so it can force a real close and let the existing backoff take over.
const HEARTBEAT_INTERVAL_MS = 10_000;
// If neither real output, a resize ack side effect, nor a heartbeat pong has updated
// lastActivityAtRef within this window while the socket claims to be OPEN, treat it as dead.
// Set comfortably above HEARTBEAT_INTERVAL_MS so one slow tick isn't mistaken for a zombie.
const LIVENESS_TIMEOUT_MS = 25_000;
// A reconnect attempt whose handshake never resolves (network changed mid-connect, a tunnel
// hop not yet re-routed) would otherwise sit in CONNECTING forever: no "close" fires, so
// nothing retries. Force-closing it past this point feeds it back into the same onclose-driven
// backoff instead of hanging indefinitely.
const CONNECT_TIMEOUT_MS = 8_000;

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
}

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

// Desktop's real mouse wheel never goes through the touch-scroll machinery above; it's
// forwarded by xterm itself as an SGR mouse report through onData. Button code 64 is
// wheel-up, the signal that a scroll-to-bottom button should appear.
const WHEEL_UP_SGR_PATTERN = /\x1b\[<64;/;

// tmux draws this position indicator ("[<line>/<total>]") at the far right of row 0
// while a pane is in copy-mode (the status bar is off, see server/src/tmux.ts). Reading
// it back is how the scroll-to-bottom button knows when to hide again, independent of
// the gesture that triggered the scroll (wheel, touch, or the pane's own keybindings).
const COPY_MODE_INDICATOR_PATTERN = /\[(\d+)\/\d+\]\s*$/;
const COPY_MODE_INDICATOR_SCAN_THROTTLE_MS = 100;

// macOS trackpads keep emitting decaying native wheel events for roughly a second after
// the fingers lift; those trailing ticks arrive after the click already exited copy-mode
// and drag the pane back into it. This window (renewed on every trailing tick, not one
// fixed timer) keeps re-issuing the exit instead of showing the button again, until a real
// gap appears that tells trailing momentum apart from a deliberate new scroll-up.
const TRAILING_MOMENTUM_SUPPRESS_MS = 400;

// xterm-addon-webgl keeps ONE glyph texture atlas per render config (font/size/theme/dpr)
// shared across every terminal that matches it, not one atlas per terminal (see
// acquireTextureAtlas in @xterm/addon-webgl's source). Every instance in this app mounts
// at once and stays mounted (see App.tsx's terminal pool), so with a shared font/size they
// all share the same atlas object. clearTextureAtlas() wipes that shared atlas's texture but
// only re-queues a redraw for the terminal that called it; every other terminal is left with
// its glyph model pointing at texture coordinates that are now stale or hold a different
// glyph, which reads as corrupted/shifted characters. This registry lets the one-time font-
// ready wipe (below) reach every live terminal, not just the one that triggered it.
const liveWebglAddons = new Set<WebglAddon>();
const liveTerminals = new Set<Terminal>();
// Guards the atlas wipe below to run exactly once per page load: a terminal mounted after
// fonts have already finished loading has nothing to wipe, and wiping again would just
// re-trigger the same cross-terminal corruption this fix is for.
let fontsAtlasWipeDone = false;

function DisconnectedOverlay({ onReconnect }: { onReconnect: () => void }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-app/80">
      <div className="flex w-[280px] flex-col items-center gap-[14px] rounded-lg border border-border bg-surface p-[26px] shadow-modal">
        <RetryRing size={38} tone="accent">
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
        </RetryRing>
        <div className="flex flex-col items-center gap-[3px] text-center">
          <span className="text-[13px] font-semibold text-txt-bright">Session disconnected</span>
          <span className="text-[11.5px] text-txt-dim">Retrying automatically...</span>
        </div>
        <button type="button" onClick={onReconnect} className={`${btnGhost} px-[14px] py-[6px] text-[11.5px]`}>
          Reconnect now
        </button>
      </div>
    </div>
  );
}

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(function TerminalView(
  { instance, visible, theme, focusOnVisible = true },
  forwardedRef
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const persistTimerRef = useRef<number | null>(null);
  // Lives outside the connection effect (which reruns on every connectionEpoch bump) so the
  // backoff keeps counting across reconnect attempts instead of resetting each time.
  const reconnectAttemptRef = useRef<number>(0);
  // performance.now() of the last sign of life on the current socket while OPEN (real output,
  // a heartbeat pong); read by both the heartbeat interval below and the wake-retry override
  // to tell a genuinely live socket apart from a zombie one still reporting OPEN.
  const lastActivityAtRef = useRef<number>(0);
  // performance.now() when the current connection attempt started; read by the connect
  // timeout below and by wake-retry to tell a fresh CONNECTING handshake from one that has
  // been hanging past CONNECT_TIMEOUT_MS.
  const connectStartedAtRef = useRef<number>(0);
  const isMobile = useIsMobile();
  // Mobile screens are small enough that the server's default (tuned for desktop) reads
  // cramped-in-a-good-way but wastes space here; default to the smallest zoom on mobile
  // until the user picks their own (still persisted separately per-device via hostPrefs).
  const [fontSize, setFontSize] = useState<number>(() =>
    getHostFontSize(instance.id, isMobile ? MIN_FONT_SIZE : instance.fontSize)
  );
  const [disconnected, setDisconnected] = useState<boolean>(false);
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
    // Also waits on 600 (the weight the terminal renders bold text with, see
    // fontWeightBold below): if only 400 were awaited here, a bold glyph drawn before 600
    // finishes downloading would render with synthesized (faux) bold and, under the WebGL
    // renderer, get baked into its texture atlas with that wrong shape permanently.
    Promise.all([
      document.fonts.load(`${fontSize}px "JetBrains Mono"`),
      document.fonts.load(`600 ${fontSize}px "JetBrains Mono"`),
    ])
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
  // Whether the "scroll to bottom" button is shown; see the two signals that drive it
  // (wheel-up/swipe-up detection to show, tmux's copy-mode position indicator to hide)
  // in the terminal-creation effect below.
  const [showScrollToBottom, setShowScrollToBottom] = useState<boolean>(false);
  // performance.now() timestamp until which a wheel-up SGR report is treated as trailing
  // native trackpad momentum (re-issue the exit-copy-mode call) instead of a fresh scroll-up
  // (show the button). Armed by handleScrollToBottomClick, renewed by each trailing tick.
  const suppressWheelUpUntilRef = useRef<number>(0);
  // Set inside the terminal-creation effect to that render's stopDraining, so
  // handleScrollToBottomClick (defined outside the effect) can reach it without depending on
  // effect internals across re-runs.
  const stopActiveGestureRef = useRef<() => void>(() => {});
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
      // "Apple Symbols" is the only font in this stack with monochrome glyphs for
      // Claude Code's status icons (play/pause); without it iOS falls through to
      // Apple Color Emoji for the glyphs it does have and draws nothing for the
      // ones it doesn't
      fontFamily: '"JetBrains Mono", "Apple Symbols", ui-monospace, monospace',
      fontSize,
      // xterm's default bold weight is 700, which main.tsx never imports (only 400/500/600
      // are); requesting an unloaded weight makes the browser synthesize (faux) bold by
      // algorithmically thickening the nearest available glyph, which visibly warps curved
      // letters. 600 is loaded and reads as bold in a monospace terminal.
      fontWeightBold: 600,
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
    liveTerminals.add(terminal);

    // DOM renderer repaints the whole pane's DOM nodes on every redraw; on mobile that's
    // the single most expensive step in the touch-scroll round trip. WebGL renders to a
    // canvas instead, which is cheap enough that it stops being the bottleneck. Mobile
    // browsers reclaim the WebGL context whenever the app is backgrounded, which used to
    // degrade to the DOM renderer for the rest of the session; the DOM renderer draws text
    // through the browser's own text engine instead of the WebGL glyph atlas, so the font
    // visibly changed shape mid-session until the next reload. Recreating the addon on loss
    // (bounded by MAX_WEBGL_CONTEXT_LOSS_RETRIES, since a real GPU/driver failure would
    // otherwise retry forever) keeps the renderer, and therefore the glyph shapes, stable.
    let webglRetries = 0;
    const attachWebglAddon = (): void => {
      try {
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          liveWebglAddons.delete(webglAddon);
          webglAddon.dispose();
          webglAddonRef.current = null;
          if (webglRetries < MAX_WEBGL_CONTEXT_LOSS_RETRIES) {
            webglRetries += 1;
            attachWebglAddon();
          }
          // Whether the retry above lands on WebGL again or the catch below falls through
          // to the DOM renderer, the canvas is stale until new data writes a row; if
          // nothing is being written (e.g. a prompt already sitting idle), force every row
          // to repaint immediately.
          terminal.refresh(0, terminal.rows - 1);
        });
        terminal.loadAddon(webglAddon);
        webglAddonRef.current = webglAddon;
        liveWebglAddons.add(webglAddon);
      } catch {
        // no WebGL support; xterm keeps using its default DOM renderer
      }
    };
    attachWebglAddon();

    terminal.onData((typedData: string) => {
      if (WHEEL_UP_SGR_PATTERN.test(typedData)) {
        const now: number = performance.now();
        if (now < suppressWheelUpUntilRef.current) {
          // Trailing native trackpad momentum: forwarding this to tmux would re-enter
          // copy-mode through its own WheelPane binding, undoing the exit the click just
          // triggered, so it's dropped entirely instead of merely hiding the button.
          suppressWheelUpUntilRef.current = now + TRAILING_MOMENTUM_SUPPRESS_MS;
          return;
        }
        setShowScrollToBottom(true);
      }
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
    // Exposes stopDraining to handleScrollToBottomClick (defined outside this effect), so a
    // click can immediately kill any in-flight touch-momentum coast instead of letting it
    // keep firing scroll-up ticks after the button already exited copy-mode.
    stopActiveGestureRef.current = stopDraining;

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
      if (direction < 0) {
        setShowScrollToBottom(true);
      }
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

    // Separate subscription from the ack-gate onRender above (deliberately not merged
    // into it: that one drives the delicate touch-scroll pacing state machine, this one
    // only reads the screen). Throttled because onRender fires on every redraw, including
    // ones unrelated to scrolling (e.g. Claude's output streaming in).
    let lastIndicatorScanTimestamp = 0;
    let indicatorEverSeen = false;
    terminal.onRender(() => {
      const now: number = performance.now();
      if (now - lastIndicatorScanTimestamp < COPY_MODE_INDICATOR_SCAN_THROTTLE_MS) {
        return;
      }
      lastIndicatorScanTimestamp = now;
      const topLine = terminal.buffer.active.getLine(0);
      const topLineText: string = topLine?.translateToString(true) ?? "";
      const indicatorMatch: RegExpMatchArray | null = topLineText.match(COPY_MODE_INDICATOR_PATTERN);
      if (indicatorMatch !== null) {
        indicatorEverSeen = true;
        setShowScrollToBottom(Number(indicatorMatch[1]) > 0);
      } else if (indicatorEverSeen) {
        // No indicator this render means the pane just left copy-mode (exited, hit the
        // bottom, or new output arrived); only trust this once the indicator has actually
        // been observed at least once, otherwise a host tmux that doesn't draw it at all
        // would hide the button on every render and it could never show.
        setShowScrollToBottom(false);
      }
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
      liveTerminals.delete(terminal);
      if (webglAddonRef.current !== null) {
        liveWebglAddons.delete(webglAddonRef.current);
      }
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

  // fontReady above only gates on the latin subset of 400/600 (the unicode-range that
  // document.fonts.load's plain-ASCII probe string matches); other subsets (latin-ext,
  // greek, cyrillic, ...) can still be mid-download when the terminal starts drawing. The
  // WebGL renderer bakes whatever glyph shape was current into its texture atlas and never
  // re-checks it, so a glyph drawn from a still-loading subset stays wrong until something
  // clears the atlas. document.fonts.ready resolves once every requested font this page has
  // asked for (including those late subsets) has finished, so it is the right point to wipe
  // the atlas and let the next repaint redraw everything with the fonts actually loaded.
  //
  // This must run exactly once for the whole page, not once per instance: the atlas is a
  // single object shared by every terminal with the same render config (see liveWebglAddons
  // above), so clearing it from one instance's effect already invalidates every other live
  // terminal's glyph model. Wiping every live atlas (there can be more than one if instances
  // differ in font size, see hostPrefs) and then force-refreshing every live terminal keeps
  // all of them in sync with the clear instead of just the one that triggered it. A terminal
  // that mounts after this has already run has nothing to fix: fonts finished loading before
  // its own atlas was ever populated.
  useEffect(() => {
    let cancelled = false;
    document.fonts.ready.then(() => {
      if (cancelled || fontsAtlasWipeDone) {
        return;
      }
      fontsAtlasWipeDone = true;
      for (const addon of liveWebglAddons) {
        addon.clearTextureAtlas();
      }
      for (const liveTerminal of liveTerminals) {
        liveTerminal.refresh(0, liveTerminal.rows - 1);
      }
    });
    return () => {
      cancelled = true;
    };
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
    connectStartedAtRef.current = performance.now();
    lastActivityAtRef.current = performance.now();

    // See CONNECT_TIMEOUT_MS above: without this a handshake that never resolves (readyState
    // stuck at CONNECTING) never fires "close" and so never enters the reconnect path below.
    const connectTimeoutId = window.setTimeout(() => {
      if (socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    }, CONNECT_TIMEOUT_MS);

    // See HEARTBEAT_INTERVAL_MS/LIVENESS_TIMEOUT_MS above: proactively catches a zombie OPEN
    // socket even while the tab stays foregrounded the whole time (so useWakeRetry's visibility
    // events never fire to catch it), e.g. toggling DevTools' offline mode.
    const heartbeatIntervalId = window.setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      if (performance.now() - lastActivityAtRef.current > LIVENESS_TIMEOUT_MS) {
        socket.close();
        return;
      }
      socket.send(JSON.stringify({ type: "ping" }));
    }, HEARTBEAT_INTERVAL_MS);

    socket.onopen = () => {
      window.clearTimeout(connectTimeoutId);
      reconnectAttemptRef.current = 0;
      lastActivityAtRef.current = performance.now();
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
      lastActivityAtRef.current = performance.now();
      if (typeof event.data === "string") {
        // Apple Color Emoji has no art at all for U+23F5 (auto-accept), so without this
        // swap iOS draws nothing there, not even a fallback emoji. U+25B6/U+25CF are
        // common dingbats with much wider default text-presentation font coverage.
        // Pause (U+23F8) has real emoji art and is left as-is on purpose.
        const text = event.data
          .replace(/\u23F5/g, "\u25B6")
          .replace(/\u23FA/g, "\u25CF");
        terminalRef.current?.write(text, () => {
          writeCommittedForAckRef.current = true;
        });
      }
      // A binary frame is the server's heartbeat pong (see terminal.ts): it carries no
      // terminal output, updating lastActivityAtRef above is its entire purpose.
    };
    // A real disconnect (server restart from tsx watch, self-update, etc.) keeps retrying
    // on a growing backoff instead of stranding the user on the manual Reconnect button
    let reconnectTimeoutId: number | undefined;
    socket.onclose = () => {
      setDisconnected(true);
      reconnectTimeoutId = window.setTimeout(() => {
        setConnectionEpoch((previousEpoch) => previousEpoch + 1);
      }, retryDelayMs(reconnectAttemptRef.current));
      reconnectAttemptRef.current += 1;
    };

    return () => {
      socket.onclose = null;
      socket.close();
      window.clearTimeout(reconnectTimeoutId);
      window.clearTimeout(connectTimeoutId);
      window.clearInterval(heartbeatIntervalId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionEpoch, instance.id, hasBeenVisible, fontReady]);

  // A backgrounded tab freezes JS timers, so the socket can die (a zombie half-open
  // connection, see HEARTBEAT_INTERVAL_MS above, or a genuine server restart) without the
  // in-effect heartbeat/connect-timeout getting a chance to catch it while backgrounded; this
  // only runs once the tab wakes back up. Trusting readyState alone here used to be the bug:
  // CONNECTING and OPEN both read as "leave it alone", which is exactly wrong for a socket
  // that has been hanging in CONNECTING past its own timeout or sitting OPEN-but-dead past the
  // liveness window the whole time it was backgrounded. Checking the same timestamps the
  // in-effect watchdog uses instead of the raw readyState tells a genuinely fresh/live socket
  // apart from a stuck one, and resetting the backoff on every wake (not just on eventual
  // reconnect) means coming back to the app never inherits whatever delay had built up while
  // it was hidden.
  useWakeRetry(() => {
    const socket = socketRef.current;
    const now = performance.now();
    if (socket !== null) {
      if (socket.readyState === WebSocket.CONNECTING && now - connectStartedAtRef.current < CONNECT_TIMEOUT_MS) {
        return;
      }
      if (socket.readyState === WebSocket.OPEN && now - lastActivityAtRef.current < LIVENESS_TIMEOUT_MS) {
        return;
      }
    }
    reconnectAttemptRef.current = 0;
    if (socket !== null && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
      // Past its own timeout/liveness window: force a real "close" so the effect's
      // onclose-driven backoff (now reset to attempt 0, so it fires almost immediately)
      // picks it up, instead of silently doing nothing because readyState looked fine.
      socket.close();
      return;
    }
    setConnectionEpoch((previousEpoch) => previousEpoch + 1);
  });

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
    reconnectAttemptRef.current = 0;
    setConnectionEpoch((previousEpoch) => previousEpoch + 1);
  };

  const handleScrollToBottomClick = useCallback((): void => {
    // Hide optimistically; the indicator scan above will resurface it on the next
    // render if this didn't actually land us at the bottom.
    setShowScrollToBottom(false);
    // Kill any in-flight touch-momentum coast immediately, so a mobile swipe-then-tap can't
    // keep dispatching scroll-up ticks after this call already exited copy-mode.
    stopActiveGestureRef.current();
    // Arms the suppression window for trailing native trackpad momentum (see onData above):
    // any wheel-up SGR report that arrives before this expires re-issues the exit instead of
    // showing the button again.
    suppressWheelUpUntilRef.current = performance.now() + TRAILING_MOMENTUM_SUPPRESS_MS;
    api.scrollTerminalToBottom(instance.id).catch((error: Error) => {
      console.error("Could not scroll the terminal to the bottom:", error.message);
    });
  }, [instance.id]);

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
        {disconnected && <DisconnectedOverlay onReconnect={reconnect} />}
        {showScrollToBottom && (
          <button
            type="button"
            onClick={handleScrollToBottomClick}
            aria-label="Scroll to bottom"
            title="Scroll to bottom"
            className="absolute bottom-[42px] right-[14px] flex h-[30px] w-[30px] items-center justify-center rounded-full border border-border-strong bg-surface text-txt-secondary shadow-lg"
          >
            ↓
          </button>
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
