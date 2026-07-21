import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
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
  const [fontSize, setFontSize] = useState<number>(() => getHostFontSize(instance.id, instance.fontSize));
  const [disconnected, setDisconnected] = useState<boolean>(false);
  const [reconnectMsRemaining, setReconnectMsRemaining] = useState<number>(RECONNECT_DELAY_MS);
  const [connectionEpoch, setConnectionEpoch] = useState<number>(0);
  const onAtBottomChangeRef = useRef(onAtBottomChange);
  onAtBottomChangeRef.current = onAtBottomChange;

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

  // Create the xterm terminal, once per instance
  useEffect(() => {
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

    // Force the font to load and re-fit once it is ready (font-display: swap
    // may take a moment to resolve JetBrains Mono on first use).
    document.fonts
      .load(`${terminal.options.fontSize}px "JetBrains Mono"`)
      .then(() => safeFit())
      .catch(() => safeFit());

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

    const resizeObserver = new ResizeObserver(() => safeFit());
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
      }
      socketRef.current?.close();
      terminal.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // WebSocket connection to the tmux bridge; connectionEpoch allows manual reconnect
  useEffect(() => {
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
      }
    };
    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") {
        terminalRef.current?.write(event.data);
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
  }, [connectionEpoch, instance.id]);

  // The terminal already exists with the mount-time palette; on theme toggle
  // only the active palette needs reassigning, no need to recreate the session
  useEffect(() => {
    if (terminalRef.current !== null) {
      terminalRef.current.options.theme = terminalThemesByMode[theme];
    }
  }, [theme]);

  // When becoming visible again the container recovers real dimensions: re-fit and focus.
  // Double rAF because returning from Settings may leave the flex layout not yet settled
  // on the first frame (a single rAF sometimes measures the container mid-transition).
  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          safeFit();
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
      <div className="relative flex-1 min-h-0 px-[6px] pt-[6px]">
        <div ref={containerRef} className="h-full w-full" />
        {disconnected && (
          <DisconnectedOverlay
            msRemaining={reconnectMsRemaining}
            totalMs={RECONNECT_DELAY_MS}
            onReconnect={reconnect}
          />
        )}
        <div className="absolute bottom-[4px] right-[10px] flex gap-[6px]">
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
