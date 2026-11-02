import { describe, expect, it } from "vitest";
import { decodeOsc52Payload } from "./osc52";

function toBase64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

describe("decodeOsc52Payload", () => {
  it("decodes a plain payload", () => {
    expect(decodeOsc52Payload("c;aG9sYQ==")).toBe("hola");
  });

  it("decodes UTF-8 with accents and emoji", () => {
    const text: string = "¿en qué quedamos? 👍";
    expect(decodeOsc52Payload(`c;${toBase64(text)}`)).toBe(text);
  });

  it("accepts an empty or multi-letter selection field", () => {
    expect(decodeOsc52Payload(";aG9sYQ==")).toBe("hola");
    expect(decodeOsc52Payload("cp;aG9sYQ==")).toBe("hola");
  });

  it("never answers the clipboard query", () => {
    expect(decodeOsc52Payload("c;?")).toBeNull();
  });

  it("ignores invalid base64", () => {
    expect(decodeOsc52Payload("c;@@@not-base64@@@")).toBeNull();
  });

  it("ignores invalid UTF-8", () => {
    expect(decodeOsc52Payload(`c;${Buffer.from([0xff, 0xfe]).toString("base64")}`)).toBeNull();
  });

  it("ignores an empty payload and a payload with no separator", () => {
    expect(decodeOsc52Payload("c;")).toBeNull();
    expect(decodeOsc52Payload("aG9sYQ==")).toBeNull();
  });
});
