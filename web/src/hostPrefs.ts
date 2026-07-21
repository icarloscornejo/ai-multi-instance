// Per-host UI preferences (this browser only, never synced through the server): each
// device that opens the dashboard (desktop, phone via ai.local/LAN/tunnel) keeps its own
// terminal zoom, independent from every other device. Theme already works this way via
// theme.ts's own localStorage key; this mirrors that pattern for font size.
const FONT_SIZE_STORAGE_KEY = "ccdash.fontSizeByInstance";

function readFontSizeMap(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(FONT_SIZE_STORAGE_KEY) ?? "{}");
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function getHostFontSize(instanceId: string, fallback: number): number {
  const storedSize: number | undefined = readFontSizeMap()[instanceId];
  return typeof storedSize === "number" ? storedSize : fallback;
}

export function setHostFontSize(instanceId: string, fontSize: number): void {
  const map: Record<string, number> = readFontSizeMap();
  map[instanceId] = fontSize;
  localStorage.setItem(FONT_SIZE_STORAGE_KEY, JSON.stringify(map));
}
