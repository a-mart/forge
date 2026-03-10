import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renameMocks = vi.hoisted(() => ({
  asyncRename: vi.fn(),
  syncRename: vi.fn()
}));

vi.mock("node:fs/promises", () => ({
  rename: renameMocks.asyncRename
}));

vi.mock("node:fs", () => ({
  renameSync: renameMocks.syncRename
}));

import { renameSyncWithRetry, renameWithRetry } from "../retry-rename.js";

describe("retry-rename", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    renameMocks.asyncRename.mockReset();
    renameMocks.syncRename.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries async rename on transient EPERM/EBUSY failures", async () => {
    renameMocks.asyncRename
      .mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EPERM" }))
      .mockRejectedValueOnce(Object.assign(new Error("still busy"), { code: "EBUSY" }))
      .mockResolvedValueOnce(undefined);

    const promise = renameWithRetry("from", "to", {
      retries: 3,
      baseDelayMs: 10,
      maxDelayMs: 20
    });

    await vi.advanceTimersByTimeAsync(30);
    await expect(promise).resolves.toBeUndefined();
    expect(renameMocks.asyncRename).toHaveBeenCalledTimes(3);
  });

  it("uses bounded immediate retries for sync rename", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    renameMocks.syncRename
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("locked"), { code: "EBUSY" });
      })
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("locked"), { code: "EPERM" });
      })
      .mockImplementationOnce(() => undefined);

    expect(() =>
      renameSyncWithRetry("from", "to", {
        retries: 3
      })
    ).not.toThrow();
    expect(renameMocks.syncRename).toHaveBeenCalledTimes(3);
    expect(setTimeoutSpy).not.toHaveBeenCalled();

    setTimeoutSpy.mockRestore();
  });
});
