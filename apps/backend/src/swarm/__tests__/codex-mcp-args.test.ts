import { describe, expect, it } from "vitest";
import {
  boundCodexMcpToolArgs,
  formatCodexMcpToolFailureMessage,
  truncateBytesUtf8,
} from "../codex-app-server/codex-mcp-args.js";

describe("codex-mcp-args", () => {
  it("preserves raw argument values without logging sanitization", () => {
    const args = {
      token: "Bearer abc.def.ghi",
      nested: { secret: "sk-live-1234567890" },
    };

    const bounded = boundCodexMcpToolArgs(args, 16 * 1024);
    expect(bounded).toEqual(args);
  });

  it("rejects cyclic and oversize arguments", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => boundCodexMcpToolArgs(cyclic, 16 * 1024)).toThrow(/cycle/i);

    const oversized = { blob: "x".repeat(20_000) };
    expect(() => boundCodexMcpToolArgs(oversized, 128)).toThrow(/size limit/i);
  });

  it("truncates multibyte strings on UTF-8 byte boundaries", () => {
    const value = `hello ${"🙂".repeat(20)}`;
    const truncated = truncateBytesUtf8(value, 32);
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(32);
    expect(truncated.endsWith("…")).toBe(true);
    expect(() => Buffer.from(truncated, "utf8").toString("utf8")).not.toThrow();
  });
});

describe("formatCodexMcpToolFailureMessage", () => {
  it("redacts bearer, api keys, jwt, and email tokens", () => {
    const preview = formatCodexMcpToolFailureMessage(
      "failed for adam@secret.com Bearer sk-live-abcdef1234567890 eyJhbGciOiJIUzI1NiJ9.payload.sig",
    );

    expect(preview).toContain("[redacted]");
    expect(preview).not.toContain("sk-live-abcdef1234567890");
    expect(preview).not.toContain("adam@secret.com");
    expect(Buffer.byteLength(preview, "utf8")).toBeLessThanOrEqual(1024);
  });
});
