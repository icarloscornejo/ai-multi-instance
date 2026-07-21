import { useEffect, useState, type ReactNode } from "react";

const ESC = "\x1b";
const CTRL_C = "\x03";
const ENTER = "\r";
const ARROW_UP = "\x1b[A";
const ARROW_DOWN = "\x1b[B";
const ARROW_RIGHT = "\x1b[C";
const ARROW_LEFT = "\x1b[D";

interface KeyButtonProps {
  label: ReactNode;
  title: string;
  onPress: () => void;
}

function KeyButton({ label, title, onPress }: KeyButtonProps) {
  return (
    <button
      type="button"
      title={title}
      // Without this, the pointerdown blurs the terminal's helper textarea and
      // dismisses the keyboard before onPress ever runs
      onPointerDown={(event) => event.preventDefault()}
      onClick={onPress}
      className="flex h-[36px] min-w-[40px] shrink-0 items-center justify-center rounded-[6px] border border-border-strong bg-surface px-[10px] text-[12.5px] font-semibold text-txt-secondary active:bg-raised"
    >
      {label}
    </button>
  );
}

interface MobileKeyBarProps {
  onSendKey: (data: string) => void;
}

export function MobileKeyBar({ onSendKey }: MobileKeyBarProps) {
  const [pasteAvailable, setPasteAvailable] = useState<boolean>(false);

  // navigator.clipboard.readText requires a secure context; hide the button
  // entirely rather than show one that silently fails on plain http://
  useEffect(() => {
    setPasteAvailable(window.isSecureContext && navigator.clipboard?.readText !== undefined);
  }, []);

  const paste = async (): Promise<void> => {
    try {
      const text: string = await navigator.clipboard.readText();
      if (text !== "") {
        onSendKey(text);
      }
    } catch {
      // Permission denied or unsupported; nothing to recover from here
    }
  };

  return (
    <div className="flex shrink-0 items-center justify-center gap-[6px] overflow-x-auto border-t border-border bg-surface px-[8px] py-[4px] pb-[calc(4px+var(--safe-bottom))]">
      <KeyButton label="Esc" title="Escape" onPress={() => onSendKey(ESC)} />
      <KeyButton label="^C" title="Interrupt (Ctrl+C)" onPress={() => onSendKey(CTRL_C)} />
      <KeyButton label="←" title="Left" onPress={() => onSendKey(ARROW_LEFT)} />
      <KeyButton label="↑" title="Up" onPress={() => onSendKey(ARROW_UP)} />
      <KeyButton label="↓" title="Down" onPress={() => onSendKey(ARROW_DOWN)} />
      <KeyButton label="→" title="Right" onPress={() => onSendKey(ARROW_RIGHT)} />
      {pasteAvailable && <KeyButton label="^V" title="Paste from clipboard" onPress={() => void paste()} />}
      <KeyButton label="Enter" title="Enter" onPress={() => onSendKey(ENTER)} />
    </div>
  );
}
