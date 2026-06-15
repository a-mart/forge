import { describe, expect, it } from "vitest";
import {
  computeFileVersion,
  decodeUtf8Strict,
  getFileEditability,
  isLikelyBinary,
  isPermissionDeniedError,
  MAX_EDITABLE_FILE_BYTES,
  MAX_FILE_SAVE_BYTES,
  normalizeRelativePathForTest,
  rethrowPermissionDenied,
} from "../../services/file-browser-service.js";

describe("file-browser-service helpers", () => {
  it("computes stable sha256-stat-v1 version tokens", () => {
    const buffer = Buffer.from("hello\n", "utf8");
    const stats = { size: buffer.length, mtimeMs: 1234 };

    expect(computeFileVersion(buffer, stats)).toEqual({
      kind: "sha256-stat-v1",
      sha256: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
      size: 6,
      mtimeMs: 1234,
    });
  });

  it("detects binary and UTF-8 editability", () => {
    const textBuffer = Buffer.from("plain text\n", "utf8");
    const binaryBuffer = Buffer.from([0, 1, 2, 0]);

    expect(isLikelyBinary(textBuffer)).toBe(false);
    expect(isLikelyBinary(binaryBuffer)).toBe(true);
    expect(decodeUtf8Strict(textBuffer)).toBe("plain text\n");

    expect(getFileEditability({ size: textBuffer.length, isFile: () => true }, textBuffer)).toEqual({
      editable: true,
      maxEditableBytes: MAX_EDITABLE_FILE_BYTES,
    });

    expect(getFileEditability({ size: MAX_FILE_SAVE_BYTES + 1, isFile: () => true }, textBuffer)).toEqual({
      editable: false,
      reason: "too_large",
      maxEditableBytes: MAX_EDITABLE_FILE_BYTES,
    });
  });

  it("preserves leading and trailing whitespace in relative paths", () => {
    expect(normalizeRelativePathForTest(" foo.txt")).toBe(" foo.txt");
    expect(normalizeRelativePathForTest("foo.txt ")).toBe("foo.txt ");
    expect(normalizeRelativePathForTest(" nested/ foo.txt ")).toBe(" nested/ foo.txt ");
    expect(normalizeRelativePathForTest("")).toBe("");
    expect(normalizeRelativePathForTest(".")).toBe("");
  });

  it("maps EACCES and EPERM filesystem errors to permission-denied messages", () => {
    // Route layer maps these messages to HTTP 403 via resolveHttpStatusCode().
    // End-to-end OS permission tests are omitted because ESM fs/promises exports
    // are not spy-able in vitest; service save paths use rethrowPermissionDenied().
    expect(isPermissionDeniedError({ code: "EACCES" })).toBe(true);
    expect(isPermissionDeniedError({ code: "EPERM" })).toBe(true);
    expect(isPermissionDeniedError({ code: "ENOENT" })).toBe(false);

    expect(() => rethrowPermissionDenied({ code: "EACCES" }, "read")).toThrow("File is not readable.");
    expect(() => rethrowPermissionDenied({ code: "EPERM" }, "write")).toThrow("File is not writable.");
  });
});
