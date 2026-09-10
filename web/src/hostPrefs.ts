// Per-host UI preference (this browser only, never synced through the server): each
// device that opens the dashboard (desktop, phone via ai.local/LAN/tunnel) keeps its own
// terminal zoom, shared by every instance/chat open on that device. Theme already works
// this way via theme.ts's own localStorage key; this mirrors that pattern for font size.
// FONT_SIZE_CHANGE_EVENT is what keeps every already-mounted TerminalView on the same
// page in sync when one of them changes the zoom.
const FONT_SIZE_STORAGE_KEY = "ccdash.fontSize";
export const FONT_SIZE_CHANGE_EVENT = "ccdash:fontsize";

export function getHostFontSize(fallback: number): number {
  const stored: string | null = localStorage.getItem(FONT_SIZE_STORAGE_KEY);
  const parsed: number = stored !== null ? Number(stored) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function setHostFontSize(fontSize: number): void {
  // Dispatch before persisting: every TerminalView applies the zoom only in reaction to
  // this event (see TerminalView.tsx), so a localStorage write failure (quota, private
  // mode) must not also block the zoom from applying.
  window.dispatchEvent(new CustomEvent<number>(FONT_SIZE_CHANGE_EVENT, { detail: fontSize }));
  localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(fontSize));
}

// Desktop rail width (InstanceRail), same per-host-only pattern as font size above: instance
// labels vary a lot in length, so the default width is just a starting point.
const RAIL_WIDTH_STORAGE_KEY = "ccdash.railWidth";

export function getHostRailWidth(fallback: number): number {
  const stored: string | null = localStorage.getItem(RAIL_WIDTH_STORAGE_KEY);
  const parsed: number = stored !== null ? Number(stored) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function setHostRailWidth(width: number): void {
  localStorage.setItem(RAIL_WIDTH_STORAGE_KEY, String(width));
}
