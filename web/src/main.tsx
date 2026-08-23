// The system-first redesign moved the UI font to the platform stack, but the terminal itself
// stays on JetBrains Mono: system monospace stacks (SFMono/ui-monospace/Menlo) fall through to
// a generic, worse-looking monospace on Android, and the terminal is the dominant surface on
// mobile, so that fallback is the one place worth the webfont cost.
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "./index.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";

// No StrictMode: the double effect mount in development would create two tmux
// attaches per terminal (two websockets against the same session)
createRoot(document.getElementById("root")!).render(<App />);
