import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Instance } from "../types";
import type { Theme } from "../theme";

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
  onPersistFontSize: (instanceId: string, fontSize: number) => void;
  theme: Theme;
}

export function TerminalView({ instance, visible, onPersistFontSize, theme }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const persistTimerRef = useRef<number | null>(null);
  const [fontSize, setFontSize] = useState<number>(instance.fontSize);
  const [disconnected, setDisconnected] = useState<boolean>(false);
  const [connectionEpoch, setConnectionEpoch] = useState<number>(0);

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
            onPersistFontSize(instance.id, nextSize);
          }, 600);
        }
        return nextSize;
      });
    },
    [instance.id, onPersistFontSize, safeFit]
  );

  // Create the xterm terminal, once per instance
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    const terminal = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: instance.fontSize,
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
    socket.onclose = () => setDisconnected(true);

    return () => {
      socket.onclose = null;
      socket.close();
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
          terminalRef.current?.focus();
        });
      });
    }
  }, [visible, safeFit]);

  const reconnect = (): void => {
    terminalRef.current?.reset();
    setConnectionEpoch((previousEpoch) => previousEpoch + 1);
  };

  return (
    <div className={`flex-1 min-h-0 flex-col ${visible ? "flex" : "hidden"}`}>
      <div className="relative flex-1 min-h-0 px-[22px] pt-[16px]">
        <div ref={containerRef} className="h-full w-full" />
        {disconnected && (
          <div className="absolute inset-0 flex items-center justify-center bg-app/80">
            <div className="flex flex-col items-center gap-3">
              <span className="text-[13px] text-txt-dim">Session disconnected</span>
              <button
                type="button"
                onClick={reconnect}
                className="rounded-[6px] bg-accent px-[18px] py-[9px] text-[12.5px] font-semibold text-on-accent"
              >
                Reconnect
              </button>
            </div>
          </div>
        )}
        <div className="absolute bottom-[10px] right-[26px] flex gap-[6px]">
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
      <div
        className="cursor-text border-t border-border px-[22px] py-[12px]"
        onClick={() => terminalRef.current?.focus()}
      >
        <div className="font-mono text-txt-placeholder" style={{ fontSize: `${fontSize}px` }}>
          {">"}
        </div>
        <div className="mt-[6px] font-mono text-[10.5px] text-txt-dim">
          {instance.label} · {instance.model ?? "default model"}
          {instance.effort !== null ? ` · effort ${instance.effort}` : ""}
        </div>
      </div>
    </div>
  );
}
