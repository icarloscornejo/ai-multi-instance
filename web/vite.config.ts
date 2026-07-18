import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
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
