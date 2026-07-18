import { describe, expect, it } from "vitest";
import { previewCommand, PROVIDER_OPTIONS } from "./providerOptions";

describe("provider UI options", () => {
  it("exposes all supported provider choices", () => {
    expect(PROVIDER_OPTIONS.map((option) => option.value)).toEqual(["claude", "codex", "cursor", "custom"]);
  });

  it("shows only provider-supported preview flags", () => {
    expect(previewCommand("claude", "claude", "opus", "high")).toBe("claude --model 'opus' --effort high");
    expect(previewCommand("codex", "codex", "gpt-5", "high")).toBe("codex --model 'gpt-5'");
    expect(previewCommand("custom", "tool --raw", "ignored", "ignored")).toBe("tool --raw");
  });
});
