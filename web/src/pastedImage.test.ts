import { describe, expect, it } from "vitest";
import { pickPastedImage } from "./pastedImage";

function fileOfType(type: string): File {
  return new File(["bytes"], "clipboard", { type });
}

describe("pickPastedImage", () => {
  it("returns the image when the clipboard holds only an image", () => {
    const screenshot: File = fileOfType("image/png");

    expect(pickPastedImage([screenshot], "")).toBe(screenshot);
  });

  it("returns null when the image comes with text (cells copied from Numbers or Excel)", () => {
    expect(pickPastedImage([fileOfType("image/png")], "a\tb\n1\t2")).toBeNull();
  });

  it("treats whitespace-only text as no text", () => {
    const screenshot: File = fileOfType("image/png");

    expect(pickPastedImage([screenshot], "  \n")).toBe(screenshot);
  });

  it("returns null for text only", () => {
    expect(pickPastedImage([], "hola")).toBeNull();
  });

  it("returns null for an image type Claude Code would not read", () => {
    expect(pickPastedImage([fileOfType("image/tiff")], "")).toBeNull();
  });

  it("skips non-image files and picks the first supported image", () => {
    const photo: File = fileOfType("image/jpeg");

    expect(pickPastedImage([fileOfType("application/pdf"), photo], "")).toBe(photo);
  });
});
