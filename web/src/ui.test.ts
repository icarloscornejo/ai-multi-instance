import { describe, expect, it } from "vitest";
import { formatCountdown } from "./ui";

describe("formatCountdown", () => {
  it("formats whole minutes", () => {
    expect(formatCountdown(300_000)).toBe("5:00");
  });

  it("formats minutes and seconds", () => {
    expect(formatCountdown(61_000)).toBe("1:01");
  });

  it("pads single-digit seconds", () => {
    expect(formatCountdown(999)).toBe("0:01");
  });

  it("clamps zero and negative values to 0:00", () => {
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-5000)).toBe("0:00");
  });
});
