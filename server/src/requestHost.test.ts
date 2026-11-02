import { describe, expect, it } from "vitest";
import { clientAddressOf, isLocalRequest, isLocalRequestHost } from "./requestHost";

describe("isLocalRequestHost", () => {
  it("treats the local dev hostnames as local", () => {
    expect(isLocalRequestHost("ai.local")).toBe(true);
    expect(isLocalRequestHost("claude.local")).toBe(true);
    expect(isLocalRequestHost("ai.local:80")).toBe(true);
    expect(isLocalRequestHost("localhost:5173")).toBe(true);
    expect(isLocalRequestHost("127.0.0.1:3001")).toBe(true);
  });

  it("treats bare and bracketed IPv6 loopback as local", () => {
    expect(isLocalRequestHost("::1")).toBe(true);
    expect(isLocalRequestHost("[::1]:3001")).toBe(true);
  });

  it("treats private IPv4 ranges (LAN) as local", () => {
    expect(isLocalRequestHost("192.168.1.42")).toBe(true);
    expect(isLocalRequestHost("192.168.1.42:80")).toBe(true);
    expect(isLocalRequestHost("10.0.0.5")).toBe(true);
    expect(isLocalRequestHost("172.16.9.9")).toBe(true);
    expect(isLocalRequestHost("172.31.255.1")).toBe(true);
  });

  it("treats public IPv4 and the tunnel hostname as NOT local", () => {
    expect(isLocalRequestHost("protom4-mi.example.com")).toBe(false);
    expect(isLocalRequestHost("8.8.8.8")).toBe(false);
    expect(isLocalRequestHost("172.32.0.1")).toBe(false);
    expect(isLocalRequestHost("172.15.0.1")).toBe(false);
    expect(isLocalRequestHost("example.com:443")).toBe(false);
  });

  it("treats a missing Host header as local (raw loopback clients only)", () => {
    expect(isLocalRequestHost(undefined)).toBe(true);
    expect(isLocalRequestHost("")).toBe(true);
  });
});

describe("isLocalRequest", () => {
  it("is local for a local Host with no Cloudflare header", () => {
    expect(isLocalRequest({ headers: { host: "ai.local" } })).toBe(true);
    expect(isLocalRequest({ headers: { host: "192.168.1.42:80" } })).toBe(true);
  });

  it("is public for a public Host", () => {
    expect(isLocalRequest({ headers: { host: "protom4-mi.example.com" } })).toBe(false);
  });

  it("is public when cf-connecting-ip is present, even if the Quick Tunnel rewrote Host to ai.local", () => {
    expect(isLocalRequest({ headers: { host: "ai.local", "cf-connecting-ip": "203.0.113.7" } })).toBe(false);
  });
});

describe("clientAddressOf", () => {
  it("uses the cf-connecting-ip header when present", () => {
    expect(
      clientAddressOf({ headers: { "cf-connecting-ip": "203.0.113.7" }, socket: { remoteAddress: "127.0.0.1" } })
    ).toBe("203.0.113.7");
  });

  it("uses the first element when the header is an array", () => {
    expect(clientAddressOf({ headers: { "cf-connecting-ip": ["203.0.113.1", "203.0.113.2"] } })).toBe("203.0.113.1");
  });

  it("falls back to the socket address when the header is an empty string", () => {
    expect(clientAddressOf({ headers: { "cf-connecting-ip": "" }, socket: { remoteAddress: "127.0.0.1" } })).toBe(
      "127.0.0.1"
    );
  });

  it("uses the socket address when there is no header", () => {
    expect(clientAddressOf({ headers: {}, socket: { remoteAddress: "10.0.0.9" } })).toBe("10.0.0.9");
  });

  it("answers unknown when neither the header nor the socket address exist", () => {
    expect(clientAddressOf({ headers: {} })).toBe("unknown");
    expect(clientAddressOf({ headers: {}, socket: {} })).toBe("unknown");
  });
});
