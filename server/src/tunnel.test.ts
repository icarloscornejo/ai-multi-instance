import { describe, expect, it } from "vitest";
import { extractTunnelUrl } from "./tunnel";

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
