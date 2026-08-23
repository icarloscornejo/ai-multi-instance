import { useEffect, useState, type ReactNode } from "react";
import { KEY_BAR_CATALOG, type KeyBarKeyId, type KeyBarPref } from "../keyBar";

const ARROW_KEY_IDS: ReadonlySet<KeyBarKeyId> = new Set(["up", "down", "left", "right"]);

interface KeyButtonProps {
  label: ReactNode;
  title: string;
  // Arrow glyphs (↑↓←→) sit visually lower than text labels at the same baseline, so they get
  // nudged up a bit more to look centered alongside the text-label keys.
  nudgeUpPx: number;
  onPress: () => void;
}

function KeyButton({ label, title, nudgeUpPx, onPress }: KeyButtonProps) {
  return (
    <button
      type="button"
      title={title}
      // Without this, the pointerdown blurs the terminal's helper textarea and
      // dismisses the keyboard before onPress ever runs
      onPointerDown={(event) => event.preventDefault()}
      onClick={onPress}
      // Matches 12-mobile-terminal.html's .key: full-height, evenly divided by a border
      // instead of individual bordered/rounded chips with gaps between them.
      className="flex min-w-[40px] flex-1 shrink-0 items-center justify-center self-stretch border-r border-border bg-transparent px-[6px] text-[11px] font-semibold text-txt-secondary last:border-r-0 active:bg-raised"
    >
      <span style={{ transform: `translateY(-${nudgeUpPx}px)` }}>{label}</span>
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
    // The safe-area clearance lives on this outer wrapper (pb-safe, see index.css), separate
    // from the fixed-height row of keys below: putting both on the same box (an earlier pass
    // did) let the safe-area padding eat into the row's own height on notched phones instead
    // of just adding clearance underneath it.
    <div className="flex shrink-0 flex-col border-t border-border bg-surface pb-safe">
      <div className="flex h-[52px] items-stretch overflow-x-auto">
        {orderedEntries.map((entry) => {
          const nudgeUpPx: number = ARROW_KEY_IDS.has(entry.id) ? 2 : 1;
          return entry.id === "ctrlV" ? (
            pasteAvailable && (
              <KeyButton key={entry.id} label={entry.label} title={entry.title} nudgeUpPx={nudgeUpPx} onPress={() => void paste()} />
            )
          ) : (
            <KeyButton
              key={entry.id}
              label={entry.label}
              title={entry.title}
              nudgeUpPx={nudgeUpPx}
              onPress={() => onSendKey(entry.sequence!)}
            />
          );
        })}
      </div>
    </div>
  );
}
