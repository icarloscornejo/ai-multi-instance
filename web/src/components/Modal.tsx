import { useEffect, useRef, type ReactNode, type RefObject } from "react";

// Tracks nested modals/sheets so Escape closes only the topmost one instead of the whole stack
const openModalCloseHandlers: (() => void)[] = [];

const FOCUSABLE_SELECTOR: string =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Update opened as an overlay leaves the terminal mounted and connected behind it (see
// App.tsx/TerminalView.tsx comments on why it can't unmount). xterm listens for keydown on its
// own textarea regardless of the modal's z-index, so without this a keystroke meant for the
// modal would still execute in the covered terminal. Moving DOM focus into the modal and
// trapping Tab there is what actually stops that, not the overlay's z-index (which only blocks
// pointer/touch, already covered by the opaque full-screen backdrop). Shared by Modal and
// BottomSheet so every overlay in the app gets this for free.
export function useFocusTrap(containerRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    const previouslyFocused = document.activeElement as HTMLElement | null;
    previouslyFocused?.blur();
    const firstFocusable = container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (firstFocusable ?? container).focus();

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Tab") {
        return;
      }
      const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    container.addEventListener("keydown", handleKeyDown);

    return () => {
      container.removeEventListener("keydown", handleKeyDown);
      // Deliberately re-focus rather than relying on the terminal's own visibility effect:
      // that effect only fires when `visible` transitions, not when an overlay closes on top
      // of an already-visible terminal.
      if (previouslyFocused !== null && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

// Shared by Modal and BottomSheet so a sheet opened on top of a modal (or vice versa)
// still closes in the right order on Escape
export function useModalEscapeStack(onClose: () => void): void {
  useEffect(() => {
    openModalCloseHandlers.push(onClose);
    return () => {
      const index: number = openModalCloseHandlers.lastIndexOf(onClose);
      if (index !== -1) {
        openModalCloseHandlers.splice(index, 1);
      }
    };
  }, [onClose]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && openModalCloseHandlers[openModalCloseHandlers.length - 1] === onClose) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);
}

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  widthClassName?: string;
  // Extra controls next to the title (e.g. UpdateScreen's "check again" icon button), rendered
  // right-aligned in the header row instead of forcing callers to duplicate the dialog shell
  // just to add one.
  headerActions?: ReactNode;
}

export function Modal({ title, onClose, children, widthClassName = "w-[420px]", headerActions }: ModalProps) {
  useModalEscapeStack(onClose);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`flex ${widthClassName} max-w-[calc(100vw-32px)] max-h-[85vh] flex-col gap-[14px] overflow-y-auto rounded-xl border border-border bg-surface p-[24px] shadow-modal outline-none`}
      >
        <div className="flex items-center gap-[8px]">
          <h2 className="flex-1 text-[14px] font-semibold text-txt-bright">{title}</h2>
          {headerActions}
        </div>
        {children}
      </div>
    </div>
  );
}
