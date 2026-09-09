import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITheme } from "@xterm/xterm";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useIsMobile } from "../hooks/useIsMobile";
import { useWakeRetry } from "../hooks/useWakeRetry";
import { getHostFontSize, setHostFontSize } from "../hostPrefs";
import { INITIAL_RECONNECT_STATE, reduceConnection, type ReconnectState } from "../reconnectPolicy";
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
// Most drops (tsx watch restarting the server, a brief mobile network blip) resolve well
// under this, so the overlay is delayed instead of shown immediately: flashing "Session
// disconnected" for a reconnect that completes in a few hundred ms is just noise. A real
// outage still shows it soon enough to matter.
const DISCONNECTED_OVERLAY_DELAY_MS = 1_500;
// Application-level ping sent the instant the socket opens (before the server has even
// spawned the pty), purely to get a bridgeReady signal deterministically: see the
// "bridgeReady" event dispatched from onmessage below and reconnectPolicy.ts's comment on
// why attachStreak cannot reset on "open" alone. The server only registers its own message
// handler (which is what answers ping with a pong) after a successful attach, so this ping
// sits harmlessly in the server's pre-attach buffer until then; a healthy but otherwise-silent
// session would not produce any frame within HEARTBEAT_INTERVAL_MS otherwise.

// ANSI palette aligned to the design tokens. The neutrals (background/foreground/cursor) mirror
// --color-terminal/-terminal-text/-terminal-muted from index.css so the terminal surface itself
// is monochromatic per the approved redesign; the ANSI colors (red/green/blue/...) are kept as
// semantic content coloring, not branding, so they stay saturated and are not derived from
// tokens.
const terminalThemeDark: ITheme = {
  background: "#101011",
  foreground: "#ededf0",
  cursor: "#ededf0",
  cursorAccent: "#101011",
  selectionBackground: "rgba(255,255,255,0.18)",
  black: "#4d5058",
  red: "#c1615c",
  green: "#7ec699",
  yellow: "#d7ba7d",
  blue: "#7d9fc4",
  magenta: "#b491c8",
  cyan: "#7dcfb6",
  white: "#a2a2a8",
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
  foreground: "#202124",
  cursor: "#202124",
  cursorAccent: "#ffffff",
  selectionBackground: "rgba(0,0,0,0.14)",
  black: "#2b2c2f",
  red: "#b3413a",
  green: "#2f8f5b",
  yellow: "#a67c1e",
  blue: "#3f6fa8",
  magenta: "#8a5aa8",
  cyan: "#1f8f7d",
  white: "#626268",
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
  // True while the desktop rail has an inline rename open. Selecting a row starts this
  // instance's terminal becoming visible before the double-click that opens the rename
  // input is even processed, so without this the visibility effect's own focus() (two rAF
  // later, see below) steals focus back from the still-open rename field. The rail is
  // responsible for keeping this true until the rename commits or cancels.
  suppressAutoFocus?: boolean;
}

// tmux runs with mouse mode off (see disableTmuxMouseAndAltScreen in server/src/tmux.ts), so
// terminal.modes.mouseTrackingMode reflects only whatever the app running INSIDE the pane
// asked for (a TUI like Claude Code's own fullscreen mode) - tmux itself no longer claims it.
// When an app does own the mouse, xterm's own built-in touch-scroll goes to sleep (it only
// runs while no mouse tracking is active) and a WheelEvent's deltaY is discarded by xterm's
// mouse encoder (it always emits exactly one mouse report per event, see @xterm/xterm's
// Terminal.ts wheel handler), so we drive the app's scroll ourselves by dispatching synthetic
// wheel events. Measured against Claude Code's own fullscreen TUI by feel: 1 line per report
// was too slow, 3 too fast.
const APP_OWNED_TICK_LINES = 2;
// Floor between dispatch passes while draining an app-owned gesture; the app decides its own
// scroll step per report and there is nothing to acknowledge back, so this is a plain rate
// limit instead of pacing against a round trip.
const APP_OWNED_REPORT_INTERVAL_MS = 16;
// A single touchmove or momentum tick can accumulate several lines' worth of finger
// movement; without a cap here a fast swipe would fall further and further behind since
// each pass only advances the timer by one report. This still self-limits report rate
// (multiplied by APP_OWNED_REPORT_INTERVAL_MS between passes) instead of firing unboundedly.
const APP_OWNED_MAX_REPORTS_PER_DISPATCH = 4;
// Every call while coasting is spaced at a flat MOMENTUM_TICK_INTERVAL_MS (see
// dispatchAppOwnedTicks), so this is calibrated per call, not per elapsed time. Higher value =
// slower decay = longer coast; tune by feel.
const APP_OWNED_MOMENTUM_DECAY_PER_TICK = 0.98;

// Floor for momentum's own re-check cadence while coasting after the finger lifts (there
// is no touchmove to drive it, so it must re-arm itself).
const MOMENTUM_TICK_INTERVAL_MS = 20;
const MOMENTUM_MIN_VELOCITY_PX_PER_MS = 0.02;

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


function DisconnectedOverlay({
  onReconnect,
  fatalReason,
}: {
  onReconnect: () => void;
  // Present only for a close code that will not clear on retry (see FATAL_CLOSE_CODES in
  // reconnectPolicy.ts): swaps the tone to danger, stops the ring spinning (nothing is
  // actually in progress), and shows the server's actual reason instead of the generic
  // auto-retry copy.
  fatalReason: string | null;
}) {
  const tone: "accent" | "danger" = fatalReason !== null ? "danger" : "accent";
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-app/80">
      <div className="flex w-[280px] flex-col items-center gap-[14px] rounded-lg border border-border bg-surface p-[26px] shadow-modal">
        <RetryRing size={38} tone={tone} spinning={fatalReason === null}>
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
          <span className="break-words text-[11.5px] text-txt-dim">
            {fatalReason ?? "Retrying automatically..."}
          </span>
        </div>
        <button type="button" onClick={onReconnect} className={`${btnGhost} px-[14px] py-[6px] text-[11.5px]`}>
          Reconnect now
        </button>
      </div>
    </div>
  );
}

// The fix for the plan's explicit requirement that the error message be visible "from the
// first failure, alongside the retry spinner": DisconnectedOverlay alone cannot satisfy that.
// It is delayed by DISCONNECTED_OVERLAY_DELAY_MS (1.5s) on purpose, to avoid flashing "Session
// disconnected" for a reconnect that resolves in a few hundred ms - but the first several
// retry attempts (250/500/1000ms) all land well inside that window, so simply adding the
// reason to the overlay would have left the first ~4 failures completely invisible. This is a
// second, independent, non-blocking element that shows reason+spinner together from the very
// first close through bridgeReady, is never subject to the 1.5s debounce, and is not hidden by
// a subsequent "open" (an open is not proof of recovery - see lastErrorReason's comment in
// reconnectPolicy.ts). It intentionally does not render while fatalDisconnectReason is set:
// the fatal overlay already shows that reason with its spinner stopped, and this indicator
// spinning at the same time would visually contradict "this will not resolve on its own".
function ReconnectIndicator({ reason }: { reason: string }) {
  return (
    <div className="flex items-center gap-[8px] rounded-md border border-border-strong bg-surface px-[12px] py-[6px] shadow-lg">
      <RetryRing size={13} tone="accent">
        <span />
      </RetryRing>
      <span className="max-w-[280px] break-words text-[11.5px] text-txt-dim">{reason}</span>
    </div>
  );
}

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(function TerminalView(
  { instance, visible, theme, focusOnVisible = true, suppressAutoFocus = false },
  forwardedRef
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const persistTimerRef = useRef<number | null>(null);
  // Lives outside the connection effect (which reruns on every connectionEpoch bump) so the
  // backoff keeps counting across reconnect attempts instead of resetting each time. This is
  // the ONLY place normalAttempt/attachStreak/fatalReason/transientNotice are written; every
  // callback below (onopen, onmessage, onclose, wake, manual reconnect) goes through
  // reduceConnection instead of mutating a counter directly. That single-writer rule is what
  // makes reconnectPolicy.test.ts meaningful: while any callback could still reach in and
  // reset a counter on its own, the original bug (backoff never growing because onopen reset
  // it) could always be reintroduced with every reducer test still green.
  const reconnectStateRef = useRef<ReconnectState>(INITIAL_RECONNECT_STATE);
  // performance.now() of the last sign of life on the current socket while OPEN (real output,
  // a heartbeat pong); read by both the heartbeat interval below and the wake-retry override
  // to tell a genuinely live socket apart from a zombie one still reporting OPEN.
  const lastActivityAtRef = useRef<number>(0);
  // performance.now() when the current connection attempt started; read by the connect
  // timeout below and by wake-retry to tell a fresh CONNECTING handshake from one that has
  // been hanging past CONNECT_TIMEOUT_MS.
  const connectStartedAtRef = useRef<number>(0);
  // See DISCONNECTED_OVERLAY_DELAY_MS: holds the pending "show the overlay" timer so a
  // reconnect that lands before it fires can cancel it instead of the overlay flashing on
  // and immediately off.
  const disconnectedOverlayTimeoutIdRef = useRef<number | undefined>(undefined);
  // Set by the connect-timeout/liveness-timeout watchdogs (inside the connection effect
  // below) and by useWakeRetry (a separate hook/effect) IMMEDIATELY BEFORE each calls
  // socket.close() itself, so onclose can read WHY this process forced the close instead of
  // trusting event.reason - which for exactly these three cases is always empty (a plain
  // client-initiated close carries no reason of its own; only the SERVER can set one). This
  // is the only way "why is it retrying" is knowable at all for the most common disconnect of
  // all: one this process caused itself. A plain ref (not React state) because it is written
  // and read entirely within the synchronous onclose handler's own turn, never rendered.
  const pendingLocalCloseReasonRef = useRef<string | null>(null);
  const isMobile = useIsMobile();
  // Mobile screens are small enough that the server's default (tuned for desktop) reads
  // cramped-in-a-good-way but wastes space here; default to the smallest zoom on mobile
  // until the user picks their own (still persisted separately per-device via hostPrefs).
  const [fontSize, setFontSize] = useState<number>(() =>
    getHostFontSize(instance.id, isMobile ? MIN_FONT_SIZE : instance.fontSize)
  );
  const [disconnected, setDisconnected] = useState<boolean>(false);
  // Non-null only for close codes the server sends when retrying can never succeed on its
  // own (4004 unknown instance, 4005 out-of-ptys/missing folder, see index.ts). The reason
  // string, when the server sent one, is what DisconnectedOverlay shows instead of "Retrying
  // automatically..."; retry scheduling is skipped entirely for these. Mirrors
  // reconnectStateRef.current.fatalReason; kept as separate React state purely so it
  // re-renders the overlay (the ref itself is not observed by React).
  const [fatalDisconnectReason, setFatalDisconnectReason] = useState<string | null>(null);
  // Non-blocking notice for a discarded-input close (4007, see reconnectPolicy.ts). Distinct
  // from fatalDisconnectReason: the connection keeps retrying normally, this only tells the
  // user some typed input never made it to the server.
  const [transientNotice, setTransientNotice] = useState<string | null>(null);
  // Mirrors reconnectStateRef.current.lastErrorReason (see reconnectPolicy.ts): the last
  // known reason a non-fatal close happened, shown alongside a spinner in the compact
  // ReconnectIndicator below from the very first failure - unlike the full DisconnectedOverlay,
  // which is deliberately delayed by DISCONNECTED_OVERLAY_DELAY_MS to avoid flashing for a
  // reconnect that resolves in a few hundred ms. Null whenever fatalDisconnectReason is set:
  // the fatal overlay already shows the terminal reason with its spinner stopped, and this
  // indicator's own spinning would visually contradict "this will not resolve on its own".
  const [lastErrorReason, setLastErrorReason] = useState<string | null>(null);
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
  // Whether the "scroll to bottom" button is shown; driven by the .xterm-viewport "scroll"
  // listener in the terminal-creation effect below (xterm's own buffer sync suppresses its
  // onScroll event for this, see that listener's own comment).
  const [showScrollToBottom, setShowScrollToBottom] = useState<boolean>(false);
  // Set inside the terminal-creation effect to that render's stopDraining, so
  // handleScrollToBottomClick (defined outside the effect) can reach it without depending on
  // effect internals across re-runs.
  const stopActiveGestureRef = useRef<() => void>(() => {});
  const touchScrollRef = useRef<{ lastClientY: number; accumulatedPx: number; released: boolean } | null>(null);

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

  // The single point where reconnectStateRef is written (see its declaration above): every
  // caller below hands this an event instead of touching the counters directly, and reads
  // back only the effect it needs (a retry delay). fatalDisconnectReason/transientNotice are
  // mirrored into React state here so the overlay re-renders; reconnectStateRef itself stays
  // a plain ref since nothing else needs a render off of normalAttempt/attachStreak changing.
  const applyConnectionEvent = useCallback((event: Parameters<typeof reduceConnection>[1]) => {
    const { state, effect } = reduceConnection(reconnectStateRef.current, event);
    reconnectStateRef.current = state;
    setFatalDisconnectReason(state.fatalReason);
    setTransientNotice(state.transientNotice);
    setLastErrorReason(state.lastErrorReason);
    return effect;
  }, []);

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
      // tmux itself no longer claims the mouse (see disableTmuxMouseAndAltScreen in
      // server/src/tmux.ts), but an app running inside the pane still can (Claude Code's own
      // fullscreen TUI, vim, ...) and normal click-drag is then captured by that app; holding
      // Option forces xterm's native selection for copying regardless.
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

    // terminal.open() (above) creates .xterm-viewport internally: the actual scrollable
    // element xterm's own touch/wheel handling and local scrollback (buffer.active) live on
    // (see @xterm/xterm's Viewport.ts).
    const viewportElement = container.querySelector<HTMLDivElement>(".xterm-viewport");

    // xterm syncs its own scrollTop from buffer state with suppressScrollEvent: true (see
    // Viewport.ts's _handleScroll), so terminal.onScroll never fires for a plain user scroll.
    // This DOM listener on the underlying element fires for every scroll regardless of source
    // (touch, wheel, or xterm auto-following new output), which is what the button needs.
    const handleViewportScroll = (): void => {
      const activeTerminal = terminalRef.current;
      if (activeTerminal === null) {
        return;
      }
      const buffer = activeTerminal.buffer.active;
      setShowScrollToBottom(buffer.viewportY < buffer.baseY);
    };
    viewportElement?.addEventListener("scroll", handleViewportScroll, { passive: true });

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

    // Touch scroll only needs custom handling when the pane's mouse tracking is owned by an
    // app running inside it (see APP_OWNED_TICK_LINES above): xterm's own built-in touch-scroll
    // goes to sleep while that's active, so we drive the app's scroll via synthetic wheel
    // reports instead. Otherwise (the common case: tmux itself never claims the mouse, see
    // disableTmuxMouseAndAltScreen in server/src/tmux.ts) xterm's own touchstart/touchmove
    // listeners on its own element already move .xterm-viewport's scrollTop directly against
    // the local scrollback - there is nothing for this component to do.
    let dragVelocityPxPerMs = 0;
    let lastMoveTimestamp = 0;
    let lastMomentumTimestamp = 0;
    let momentumTimeoutId: number | null = null;

    const stopDraining = (): void => {
      if (momentumTimeoutId !== null) {
        window.clearTimeout(momentumTimeoutId);
        momentumTimeoutId = null;
      }
      touchScrollRef.current = null;
    };
    // Exposes stopDraining to handleScrollToBottomClick (defined outside this effect), so a
    // click can immediately kill any in-flight app-owned momentum coast.
    stopActiveGestureRef.current = stopDraining;

    // Advances the coast's velocity/accumulated distance for one momentum step while the
    // finger is up. Returns false once the coast has decayed below the stop threshold (caller
    // should stopDraining()); a no-op (returns true) while the finger is still down, since an
    // active drag is driven by handleTouchMove's own accumulation instead.
    const advanceMomentumIfReleased = (
      touchState: { accumulatedPx: number; released: boolean },
      decayPerTick: number
    ): boolean => {
      if (!touchState.released) {
        return true;
      }
      const now: number = performance.now();
      const elapsedMs: number = lastMomentumTimestamp === 0 ? 0 : now - lastMomentumTimestamp;
      lastMomentumTimestamp = now;
      if (Math.abs(dragVelocityPxPerMs) < MOMENTUM_MIN_VELOCITY_PX_PER_MS) {
        return false;
      }
      touchState.accumulatedPx += dragVelocityPxPerMs * elapsedMs;
      dragVelocityPxPerMs *= decayPerTick;
      return true;
    };

    // The pane's mouse tracking is owned by whatever app is running (not tmux, see
    // APP_OWNED_TICK_LINES above), so there's no ack to pace against and no known per-report
    // scroll amount to visually compensate for. Sends plain wheel reports at a flat rate
    // instead, draining as much of the accumulated finger distance as it can each pass.
    const dispatchAppOwnedTicks = (
      activeTerminal: Terminal,
      touchState: { lastClientY: number; accumulatedPx: number; released: boolean }
    ): void => {
      if (momentumTimeoutId !== null) {
        window.clearTimeout(momentumTimeoutId);
        momentumTimeoutId = null;
      }
      if (touchState.released && !advanceMomentumIfReleased(touchState, APP_OWNED_MOMENTUM_DECAY_PER_TICK)) {
        stopDraining();
        return;
      }
      const lineHeightPx: number = container.clientHeight / Math.max(1, activeTerminal.rows);
      const tickPx: number = APP_OWNED_TICK_LINES * lineHeightPx;
      let reportsSent = 0;
      while (Math.abs(touchState.accumulatedPx) >= tickPx && reportsSent < APP_OWNED_MAX_REPORTS_PER_DISPATCH) {
        const direction: number = Math.sign(touchState.accumulatedPx);
        touchState.accumulatedPx -= direction * tickPx;
        activeTerminal.element?.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: direction * tickPx,
            deltaMode: WheelEvent.DOM_DELTA_PIXEL,
            bubbles: true,
            cancelable: true,
          })
        );
        reportsSent += 1;
      }
      // Re-arm whenever there's more coasting to do (release) or this pass hit the burst
      // cap with distance still left over (active drag outrunning the cap); an active drag
      // still under the cap needs nothing further, the next handleTouchMove drives it.
      const hasLeftoverDistance: boolean = Math.abs(touchState.accumulatedPx) >= tickPx;
      if (touchState.released || hasLeftoverDistance) {
        // While coasting, re-arm at MOMENTUM_TICK_INTERVAL_MS, not APP_OWNED_REPORT_INTERVAL_MS:
        // APP_OWNED_MOMENTUM_DECAY_PER_TICK is calibrated per call, not per elapsed time (see
        // its definition), assuming the ~50 calls/sec that constant produces. Re-arming faster
        // here would call advanceMomentumIfReleased more often per real second, decaying
        // velocity away quicker than intended and cutting the coast short. Only the leftover-
        // distance case (active drag outrunning the burst cap) needs the tighter interval, to
        // keep up with a fast finger instead of falling behind it.
        const rearmDelayMs: number = touchState.released ? MOMENTUM_TICK_INTERVAL_MS : APP_OWNED_REPORT_INTERVAL_MS;
        momentumTimeoutId = window.setTimeout(() => dispatchAppOwnedTicks(activeTerminal, touchState), rearmDelayMs);
      }
    };

    const handleTouchStart = (event: TouchEvent): void => {
      if (event.touches.length !== 1) {
        stopDraining();
        return;
      }
      touchScrollRef.current = { lastClientY: event.touches[0].clientY, accumulatedPx: 0, released: false };
      dragVelocityPxPerMs = 0;
      lastMoveTimestamp = event.timeStamp;
      lastMomentumTimestamp = 0;
    };

    const handleTouchMove = (event: TouchEvent): void => {
      const activeTerminal = terminalRef.current;
      const touchState = touchScrollRef.current;
      if (activeTerminal === null || touchState === null || event.touches.length !== 1) {
        return;
      }
      const currentClientY: number = event.touches[0].clientY;
      const movedPx: number = touchState.lastClientY - currentClientY;
      const elapsedMs: number = Math.max(1, event.timeStamp - lastMoveTimestamp);
      dragVelocityPxPerMs = movedPx / elapsedMs;
      lastMoveTimestamp = event.timeStamp;
      touchState.lastClientY = currentClientY;
      if (activeTerminal.modes.mouseTrackingMode === "none") {
        // No app inside the pane wants the mouse: let xterm's own native touch-scroll
        // (already registered on its own element) handle the drag against its local
        // scrollback directly. Nothing further to do here.
        return;
      }
      // Without this the browser treats the gesture as unhandled and falls back to native
      // pull-to-refresh/rubber-banding once it reaches an edge.
      event.preventDefault();
      touchState.accumulatedPx += movedPx;
      dispatchAppOwnedTicks(activeTerminal, touchState);
    };

    const handleTouchRelease = (event: TouchEvent): void => {
      if (event.touches.length > 0) {
        return;
      }
      const activeTerminal = terminalRef.current;
      const touchState = touchScrollRef.current;
      if (activeTerminal === null || touchState === null) {
        return;
      }
      touchState.released = true;
      if (
        activeTerminal.modes.mouseTrackingMode === "none" ||
        Math.abs(dragVelocityPxPerMs) < MOMENTUM_MIN_VELOCITY_PX_PER_MS
      ) {
        stopDraining();
        return;
      }
      lastMomentumTimestamp = performance.now();
      dispatchAppOwnedTicks(activeTerminal, touchState);
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
      viewportElement?.removeEventListener("scroll", handleViewportScroll);
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
        // See pendingLocalCloseReasonRef's declaration: a plain socket.close() carries no
        // reason of its own, so this is the only place that can ever know WHY this
        // particular close is about to happen.
        pendingLocalCloseReasonRef.current = "Connection attempt timed out.";
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
        pendingLocalCloseReasonRef.current = "Connection went silent (no response from the server).";
        socket.close();
        return;
      }
      socket.send(JSON.stringify({ type: "ping" }));
    }, HEARTBEAT_INTERVAL_MS);

    // See attachStreak's comment in reconnectPolicy.ts: this fires exactly once per
    // connection attempt, the moment ANY frame (string output or the binary pong) arrives,
    // and is the only proof that the server's bridge actually came up. Guards against
    // calling applyConnectionEvent on every subsequent message, which would be harmless
    // (bridgeReady is idempotent) but pointless.
    let bridgeReadySignaled = false;

    socket.onopen = () => {
      window.clearTimeout(connectTimeoutId);
      window.clearTimeout(disconnectedOverlayTimeoutIdRef.current);
      applyConnectionEvent({ kind: "open" });
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
      // Sent immediately, before the server could possibly have finished attaching (it
      // spawns the pty and registers its message handler only after a successful attach,
      // see bridgeTerminal in server/src/terminal.ts). This ping sits in the server's
      // pre-attach buffer until then, so the pong that eventually comes back is a
      // deterministic bridgeReady signal even for a session that produces no output on its
      // own - without this, a silent session would leave attachStreak stale until the next
      // HEARTBEAT_INTERVAL_MS tick, or forever if the socket drops before that.
      socket.send(JSON.stringify({ type: "ping" }));
    };
    socket.onmessage = (event: MessageEvent) => {
      lastActivityAtRef.current = performance.now();
      if (!bridgeReadySignaled) {
        bridgeReadySignaled = true;
        applyConnectionEvent({ kind: "bridgeReady" });
      }
      if (typeof event.data === "string") {
        // Apple Color Emoji has no art at all for U+23F5 (auto-accept), so without this
        // swap iOS draws nothing there, not even a fallback emoji. U+25B6/U+25CF are
        // common dingbats with much wider default text-presentation font coverage.
        // Pause (U+23F8) has real emoji art and is left as-is on purpose.
        const text = event.data
          .replace(/\u23F5/g, "\u25B6")
          .replace(/\u23FA/g, "\u25CF");
        terminalRef.current?.write(text);
      }
      // A binary frame is the server's heartbeat pong (see terminal.ts): it carries no
      // terminal output, updating lastActivityAtRef (and bridgeReadySignaled) above is its
      // entire purpose.
    };
    // A real disconnect (server restart from tsx watch, self-update, etc.) keeps retrying
    // on a growing backoff instead of stranding the user on the manual Reconnect button
    let reconnectTimeoutId: number | undefined;
    socket.onclose = (event: CloseEvent) => {
      // A locally-forced close (connect-timeout/liveness-timeout/wake-stale) always carries
      // an empty event.reason - only the SERVER can set one - so this is what lets the
      // reducer show something more useful than a bare spinner for a disconnect this process
      // caused itself. Read once and cleared immediately: it describes only THIS close.
      const localReason = pendingLocalCloseReasonRef.current;
      pendingLocalCloseReasonRef.current = null;
      const { retryDelayMs: delayMs } = applyConnectionEvent({
        kind: "close",
        code: event.code,
        reason: localReason ?? event.reason,
      });
      if (delayMs === null) {
        // Fatal (4004/4005, see reconnectPolicy.ts): no point debouncing behind
        // DISCONNECTED_OVERLAY_DELAY_MS, this is a final state, not a drop that might
        // resolve itself in the next few hundred ms.
        setDisconnected(true);
        return;
      }
      disconnectedOverlayTimeoutIdRef.current = window.setTimeout(() => {
        setDisconnected(true);
      }, DISCONNECTED_OVERLAY_DELAY_MS);
      reconnectTimeoutId = window.setTimeout(() => {
        setConnectionEpoch((previousEpoch) => previousEpoch + 1);
      }, delayMs);
    };

    return () => {
      socket.onclose = null;
      socket.close();
      window.clearTimeout(reconnectTimeoutId);
      window.clearTimeout(connectTimeoutId);
      window.clearTimeout(disconnectedOverlayTimeoutIdRef.current);
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
    applyConnectionEvent({ kind: "wake" });
    if (socket !== null && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
      // Past its own timeout/liveness window: force a real "close" so the effect's
      // onclose-driven backoff (now reset to attempt 0, so it fires almost immediately)
      // picks it up, instead of silently doing nothing because readyState looked fine. See
      // pendingLocalCloseReasonRef's declaration for why this must be set before close().
      pendingLocalCloseReasonRef.current = "Reconnecting after the tab was inactive.";
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

  // Read inside the rAF callback below (not closed over directly) so a rename that opens or
  // closes between this effect scheduling and the rAF actually firing is still respected.
  const suppressAutoFocusRef = useRef<boolean>(suppressAutoFocus);
  suppressAutoFocusRef.current = suppressAutoFocus;

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
          if (focusOnVisible && !suppressAutoFocusRef.current) {
            terminalRef.current?.focus();
          }
        });
      });
    }
  }, [visible, safeFit, focusOnVisible]);

  // Selecting a rail row and double-clicking to rename it race: the click already made this
  // instance visible (see suppressAutoFocusRef above), so once the rename actually commits or
  // cancels, hand focus back to the terminal instead of leaving it stranded on whatever the
  // rail did with its own input.
  const wasSuppressingAutoFocusRef = useRef<boolean>(suppressAutoFocus);
  useEffect(() => {
    const wasSuppressing = wasSuppressingAutoFocusRef.current;
    wasSuppressingAutoFocusRef.current = suppressAutoFocus;
    if (wasSuppressing && !suppressAutoFocus && visible && focusOnVisible) {
      terminalRef.current?.focus();
    }
  }, [suppressAutoFocus, visible, focusOnVisible]);

  const reconnect = (): void => {
    terminalRef.current?.reset();
    applyConnectionEvent({ kind: "manualReconnect" });
    setConnectionEpoch((previousEpoch) => previousEpoch + 1);
  };

  const handleScrollToBottomClick = useCallback((): void => {
    // Kill any in-flight app-owned momentum coast immediately, so a mobile swipe-then-tap
    // can't keep dispatching wheel ticks into the pane after this click.
    stopActiveGestureRef.current();
    // Scrolls xterm's own local buffer; the .xterm-viewport "scroll" listener above hides
    // the button once viewportY catches up to baseY, no need to set state here.
    terminalRef.current?.scrollToBottom();
  }, []);

  return (
    <div className={`flex-1 min-h-0 flex-col ${visible ? "flex" : "hidden"}`}>
      <div
        className="relative flex-1 min-h-0 overflow-hidden"
        style={{ background: terminalThemesByMode[theme].background }}
      >
        <div
          ref={containerRef}
          className="flex h-full w-full justify-center"
          style={{ touchAction: "none" }}
        />
        {disconnected && <DisconnectedOverlay onReconnect={reconnect} fatalReason={fatalDisconnectReason} />}
        {/* Both notices share one top-center stack (rather than each being independently
            absolutely-positioned at the same spot) because they CAN legitimately both be
            non-null at once: transientNotice (4007) deliberately survives a subsequent 4006
            close (see reconnectPolicy.test.ts), which is exactly when lastErrorReason gets
            set again - without stacking, the two would render on top of each other. */}
        <div className="absolute top-[10px] left-1/2 flex -translate-x-1/2 flex-col items-center gap-[6px]">
          {/* Non-blocking: a 4007 close (see reconnectPolicy.ts) means some input was dropped
              but the connection is still retrying normally, possibly without ever showing the
              full DisconnectedOverlay at all (see DISCONNECTED_OVERLAY_DELAY_MS). Shown
              independently of `disconnected` so the user actually sees it. */}
          {transientNotice !== null && (
            <div className="rounded-md border border-border-strong bg-surface px-[12px] py-[6px] text-[11.5px] text-txt-dim shadow-lg">
              {transientNotice}
            </div>
          )}
          {/* See ReconnectIndicator's own comment: visible from the first failure, unlike
              DisconnectedOverlay's 1.5s-delayed full-screen version below. Hidden while fatal
              (fatalDisconnectReason set) since that overlay already shows the terminal reason
              with its spinner stopped. */}
          {lastErrorReason !== null && fatalDisconnectReason === null && <ReconnectIndicator reason={lastErrorReason} />}
        </div>
        {showScrollToBottom && (
          <button
            type="button"
            onClick={handleScrollToBottomClick}
            aria-label="Scroll to bottom"
            title="Scroll to bottom"
            // z-10: xterm draws internal canvases (e.g. .xterm-link-layer) with their own
            // explicit z-index (up to 8, see @xterm/xterm/css/xterm.css) inside containerRef;
            // without a higher z-index of our own this sibling button sits behind them and
            // never receives (or shows through) a click.
            className="absolute bottom-[42px] right-[14px] z-10 flex h-[30px] w-[30px] items-center justify-center rounded-full border border-border-strong bg-surface text-txt-secondary shadow-lg"
          >
            ↓
          </button>
        )}
        <div className="absolute bottom-[12px] right-[14px] z-10 flex gap-[6px]">
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
