import { useEffect, useState } from "react";

// The native keyboard shrinks window.visualViewport (not window.innerHeight, and
// dvh does not track it on iOS Safari); a gap bigger than this between the layout
// viewport and the visual viewport means the keyboard is open.
const KEYBOARD_HEIGHT_THRESHOLD_PX = 120;

export interface VisualViewportState {
  height: number;
  keyboardOpen: boolean;
}

function readState(): VisualViewportState {
  const viewport: VisualViewport | null = window.visualViewport;
  if (viewport === null) {
    return { height: window.innerHeight, keyboardOpen: false };
  }
  const keyboardOpen: boolean = window.innerHeight - viewport.height > KEYBOARD_HEIGHT_THRESHOLD_PX;
  return { height: viewport.height, keyboardOpen };
}

export function useVisualViewport(): VisualViewportState {
  const [state, setState] = useState<VisualViewportState>(readState);

  useEffect(() => {
    const viewport: VisualViewport | null = window.visualViewport;
    if (viewport === null) {
      return;
    }
    const handleChange = (): void => setState(readState());
    viewport.addEventListener("resize", handleChange);
    viewport.addEventListener("scroll", handleChange);
    return () => {
      viewport.removeEventListener("resize", handleChange);
      viewport.removeEventListener("scroll", handleChange);
    };
  }, []);

  return state;
}
