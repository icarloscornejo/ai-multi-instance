import { useEffect, useState, type ReactNode } from "react";
import { KEY_BAR_CATALOG, type KeyBarKeyId, type KeyBarPref } from "../keyBar";

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
  prefs: KeyBarPref[];
  onSendKey: (data: string) => void;
}

export function MobileKeyBar({ prefs, onSendKey }: MobileKeyBarProps) {
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

  const enabledIds = new Set<KeyBarKeyId>(prefs.filter((pref) => pref.enabled).map((pref) => pref.id));
  const orderedEntries = prefs
    .filter((pref) => enabledIds.has(pref.id))
    .map((pref) => KEY_BAR_CATALOG.find((entry) => entry.id === pref.id))
    .filter((entry): entry is (typeof KEY_BAR_CATALOG)[number] => entry !== undefined);

  return (
    <div className="flex shrink-0 items-center justify-center gap-[6px] overflow-x-auto border-t border-border bg-surface px-[8px] py-[4px] pb-[calc(4px+var(--safe-bottom))]">
      {orderedEntries.map((entry) =>
        entry.id === "ctrlV" ? (
          pasteAvailable && <KeyButton key={entry.id} label={entry.label} title={entry.title} onPress={() => void paste()} />
        ) : (
          <KeyButton key={entry.id} label={entry.label} title={entry.title} onPress={() => onSendKey(entry.sequence!)} />
        )
      )}
    </div>
  );
}
