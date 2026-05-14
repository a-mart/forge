import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installStdioEpipeGuard } from "../stdio-epipe-guard.js";

class SyntheticStream extends EventEmitter {
  readonly originalWrite = vi.fn((_chunk: unknown, callback?: (error?: Error | null) => void): boolean => {
    callback?.();
    return true;
  });

  write(...args: unknown[]): boolean {
    return this.originalWrite(...(args as [unknown, ((error?: Error | null) => void)?]));
  }
}

describe("stdio EPIPE guard", () => {
  it("downgrades emitted EPIPE errors and short-circuits later writes", async () => {
    const stream = new SyntheticStream();
    const restore = installStdioEpipeGuard([stream as never]);
    const callback = vi.fn();

    expect(() => {
      stream.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
    }).not.toThrow();

    expect(stream.write("after-close", callback)).toBe(false);
    expect(stream.originalWrite).not.toHaveBeenCalled();
    await new Promise((resolve) => process.nextTick(resolve));
    expect(callback).toHaveBeenCalledTimes(1);

    restore();
  });

  it("converts synchronous EPIPE write failures into closed-pipe state", () => {
    const stream = new SyntheticStream();
    stream.originalWrite.mockImplementationOnce(() => {
      throw Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    });
    const restore = installStdioEpipeGuard([stream as never]);

    expect(stream.write("first-write")).toBe(false);
    expect(stream.write("second-write")).toBe(false);
    expect(stream.originalWrite).toHaveBeenCalledTimes(1);

    restore();
  });

  it("swallows callback EPIPE failures and suppresses later writes", () => {
    const stream = new SyntheticStream();
    stream.originalWrite.mockImplementationOnce((_chunk: unknown, callback?: (error?: Error | null) => void) => {
      callback?.(Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
      return true;
    });
    const restore = installStdioEpipeGuard([stream as never]);
    const callback = vi.fn();

    expect(stream.write("first-write", callback)).toBe(true);
    expect(callback).not.toHaveBeenCalled();
    expect(stream.write("second-write")).toBe(false);
    expect(stream.originalWrite).toHaveBeenCalledTimes(1);

    restore();
  });

  it("does not suppress non-EPIPE stream errors", () => {
    const stream = new SyntheticStream();
    const restore = installStdioEpipeGuard([stream as never]);

    expect(() => {
      stream.emit("error", Object.assign(new Error("connection reset"), { code: "ECONNRESET" }));
    }).toThrow("connection reset");

    restore();
  });
});
