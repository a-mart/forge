import { describe, expect, it } from "vitest";
import { supportsSecureRuntimeProvider } from "../secure-sessions/runtime/secure-runtime-provider-policy.js";

describe("supportsSecureRuntimeProvider", () => {
  it("treats unknown legacy claude-sdk descriptors as Secure Sessions ineligible", () => {
    expect(supportsSecureRuntimeProvider("claude-sdk")).toBe(false);
    expect(supportsSecureRuntimeProvider("Claude-SDK")).toBe(false);
    expect(supportsSecureRuntimeProvider("  claude-sdk  ")).toBe(false);
  });

  it("keeps native Anthropic eligible for Secure Sessions", () => {
    expect(supportsSecureRuntimeProvider("anthropic")).toBe(true);
    expect(supportsSecureRuntimeProvider("Anthropic")).toBe(true);
  });

  it("continues to reject other unsupported SDK/ACP providers", () => {
    expect(supportsSecureRuntimeProvider("cursor-sdk")).toBe(false);
    expect(supportsSecureRuntimeProvider("cursor-acp")).toBe(false);
  });
});
