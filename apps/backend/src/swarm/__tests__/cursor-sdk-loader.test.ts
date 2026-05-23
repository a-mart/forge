import { describe, expect, it, afterEach } from "vitest";
import {
  CursorSdkUnavailableError,
  loadCursorSdkModule,
  resetCursorSdkLoaderForTests,
  setCursorSdkImporterForTests
} from "../runtime/cursor-sdk/cursor-sdk-loader.js";

describe("cursor-sdk-loader", () => {
  afterEach(() => {
    resetCursorSdkLoaderForTests();
  });

  it("loads the SDK through a non-literal importer seam and validates minimal APIs", async () => {
    const loaded = {
      Agent: { create: async () => ({}), resume: async () => ({}) },
      Cursor: { models: { list: async () => ({ items: [] }) } }
    };
    const seenSpecifiers: string[] = [];
    setCursorSdkImporterForTests(async (specifier) => {
      seenSpecifiers.push(specifier);
      return loaded;
    });

    await expect(loadCursorSdkModule()).resolves.toBe(loaded);
    await expect(loadCursorSdkModule()).resolves.toBe(loaded);
    expect(seenSpecifiers).toEqual(["@cursor/sdk"]);
  });

  it("wraps import failures without leaking secret-like details", async () => {
    const secret = "cursor_secret_value_that_must_not_leak";
    setCursorSdkImporterForTests(async () => {
      throw new Error(`native load failed ${secret}`);
    });

    const error = await loadCursorSdkModule().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CursorSdkUnavailableError);
    expect((error as Error).message).toBe("Cursor SDK runtime is unavailable: @cursor/sdk could not be loaded.");
    expect((error as Error).message).not.toContain(secret);
  });

  it("rejects modules missing the expected Agent/Cursor API surface", async () => {
    setCursorSdkImporterForTests(async () => ({ Agent: { create: async () => ({}) } }));

    await expect(loadCursorSdkModule()).rejects.toThrow(
      "Cursor SDK runtime is unavailable: @cursor/sdk did not expose the expected Agent and Cursor APIs."
    );
  });
});
