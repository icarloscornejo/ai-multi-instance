import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "./index.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";

// No StrictMode: the double effect mount in development would create two tmux
// attaches per terminal (two websockets against the same session)
createRoot(document.getElementById("root")!).render(<App />);
