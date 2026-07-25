import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readDesktopSecureControlToken } from "../desktop-secure-control-token.js";

describe("desktop secure control token pipe", () => {
  it("accepts one bounded base64url capability", async () => {
    const token = "a".repeat(43);
    await expect(
      readDesktopSecureControlToken(Readable.from([token])),
    ).resolves.toBe(token);
  });

  it("rejects malformed and oversized input", async () => {
    await expect(
      readDesktopSecureControlToken(Readable.from(["too-short"])),
    ).rejects.toThrow("invalid");
    await expect(
      readDesktopSecureControlToken(Readable.from(["a".repeat(129)])),
    ).rejects.toThrow("invalid");
  });

  it("fails closed when the desktop pipe never completes", async () => {
    const stream = new PassThrough();
    await expect(
      readDesktopSecureControlToken(stream, { timeoutMs: 5 }),
    ).rejects.toThrow("not received");
    stream.destroy();
  });
});
