export type Theme = "dark" | "light";
export type ThemePreference = "dark" | "light" | "system";

const STORAGE_KEY = "ccdash.theme";
const SYSTEM_QUERY = "(prefers-color-scheme: light)";

function resolveSystemTheme(): Theme {
  return window.matchMedia(SYSTEM_QUERY).matches ? "light" : "dark";
}

// Existing "dark"/"light" values in localStorage stay valid; "system" is additive
export function getInitialThemePreference(): ThemePreference {
  const storedPreference: string | null = localStorage.getItem(STORAGE_KEY);
  if (storedPreference === "dark" || storedPreference === "light" || storedPreference === "system") {
    return storedPreference;
  }
  return "light";
}

export function getInitialTheme(): Theme {
  const preference: ThemePreference = getInitialThemePreference();
  return preference === "system" ? resolveSystemTheme() : preference;
}

function syncThemeColorMeta(theme: Theme): void {
  const themeColorMeta: HTMLMetaElement | null = document.querySelector('meta[name="theme-color"]');
  if (themeColorMeta === null) {
    return;
  }
  // Hex values mirror --color-app in index.css for light/dark (kept as literal hex since
  // this meta tag is read by the browser chrome/status bar, not by CSS)
  themeColorMeta.content = theme === "light" ? "#f5f5f7" : "#0b0b0c";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("light", theme === "light");
  syncThemeColorMeta(theme);
}

export function persistThemePreference(preference: ThemePreference): void {
  localStorage.setItem(STORAGE_KEY, preference);
}

// Applies the resolved theme immediately and, for "system", keeps it in sync as the OS
// preference changes; returns a cleanup function to remove the listener. onThemeChange
// (optional) is called with each resolved theme, so callers can mirror it into React state.
export function applyThemePreference(preference: ThemePreference, onThemeChange?: (theme: Theme) => void): () => void {
  const apply = (theme: Theme): void => {
    applyTheme(theme);
    onThemeChange?.(theme);
  };
  if (preference !== "system") {
    apply(preference);
    return () => undefined;
  }
  apply(resolveSystemTheme());
  const mediaQueryList: MediaQueryList = window.matchMedia(SYSTEM_QUERY);
  const handleChange = (): void => apply(resolveSystemTheme());
  mediaQueryList.addEventListener("change", handleChange);
  return () => mediaQueryList.removeEventListener("change", handleChange);
}
