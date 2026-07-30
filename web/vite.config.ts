import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

const repoRoot: string = path.resolve(import.meta.dirname, "..");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    fs: {
      // The tunnel now points at Caddy -> this dev server (see server/src/tunnel.ts), so
      // /@fs/* is reachable from the public internet, not just localhost. Vite's default
      // fs.allow already keeps this out of ../data, but that default is
      // implicit and would silently widen if the workspace root ever moves; pin it
      // explicitly to just this project and the hoisted root node_modules (where
      // @fontsource/* and @xterm/xterm's CSS actually live).
      strict: true,
      allow: [import.meta.dirname, path.join(repoRoot, "node_modules")],
      // Re-list Vite's own defaults (fs.deny replaces them, it doesn't merge) plus the
      // one directory that must never be servable: data/ holds the scrypt password
      // hash and full app state.
      deny: [".env", ".env.*", "**/.git/**", "**/data/**"],
    },
    // Caddy (see Caddyfile, started by setup.sh) proxies http://ai.local to
    // 127.0.0.1:5173 explicitly, so Vite must bind that address rather than the
    // default "localhost", which can resolve to IPv6-only ([::1]) and leave
    // 127.0.0.1 unreachable.
    host: "127.0.0.1",
    // Fail loudly instead of silently hopping to another port when 5173 is taken:
    // Caddy's proxy target is fixed at 5173, so a silent port change would break
    // http://ai.local without any visible error.
    strictPort: true,
    allowedHosts: ["ai.local", "claude.local"],
    proxy: {
      "/api": "http://localhost:3001",
      "/ws": { target: "ws://localhost:3001", ws: true },
    },
  },
});
