import { describe, expect, it } from "vitest";
import { classifyPreflight, extractTunnelUrl } from "./tunnel";

const APP_SHELL_BODY = '<html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>';

describe("extractTunnelUrl", () => {
  it("extracts the trycloudflare URL from a stderr chunk", () => {
    const chunk = "2026-07-21T12:00:00Z INF |  https://random-words-here.trycloudflare.com  | \n";
    expect(extractTunnelUrl(chunk)).toBe("https://random-words-here.trycloudflare.com");
  });

  it("returns null when no URL is present yet", () => {
    expect(extractTunnelUrl("2026-07-21T12:00:00Z INF Starting tunnel\n")).toBeNull();
  });

  it("ignores unrelated https URLs", () => {
    expect(extractTunnelUrl("Connecting to https://api.cloudflare.com/health\n")).toBeNull();
  });

  it("finds the URL across accumulated multi-line output", () => {
    const chunk =
      "line one\nline two\n" +
      "+--------------------------------------------------------------------------------------------+\n" +
      "|  https://another-example.trycloudflare.com                                                  |\n" +
      "+--------------------------------------------------------------------------------------------+\n";
    expect(extractTunnelUrl(chunk)).toBe("https://another-example.trycloudflare.com");
  });
});

describe("classifyPreflight", () => {
  it("classifies a 200 with the app-shell markers as ok", () => {
    expect(classifyPreflight(200, APP_SHELL_BODY)).toBe("ok");
  });

  it("classifies a 200 without the app-shell markers as wrong-origin", () => {
    expect(classifyPreflight(200, "<html><body>Hello from some other server</body></html>")).toBe("wrong-origin");
  });

  it("classifies a 404 as wrong-origin", () => {
    expect(classifyPreflight(404, "Not Found")).toBe("wrong-origin");
  });

  it("classifies a 502 as upstream-down", () => {
    expect(classifyPreflight(502, "")).toBe("upstream-down");
  });

  it("classifies a 503 as upstream-down", () => {
    expect(classifyPreflight(503, "")).toBe("upstream-down");
  });

  it("classifies Vite's host-check rejection as wrong-origin", () => {
    expect(classifyPreflight(403, "Blocked request. This host is not allowed.")).toBe("wrong-origin");
  });
});
