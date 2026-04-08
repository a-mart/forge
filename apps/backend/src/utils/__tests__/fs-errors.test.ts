import { describe, expect, it } from "vitest";
import {
  isEnoentError,
  isErrnoCode,
  isErrnoCodeIn,
  isNotDirLikeMissingError,
} from "../fs-errors.js";

describe("fs-errors", () => {
  it("detects ENOENT errors from Error subclasses and plain objects", () => {
    const enoentError = Object.assign(new Error("missing"), { code: "ENOENT" });

    expect(isErrnoCode(enoentError, "ENOENT")).toBe(true);
    expect(isEnoentError(enoentError)).toBe(true);
    expect(isEnoentError({ code: "ENOENT" })).toBe(true);
  });

  it("returns false for non-ENOENT errno codes", () => {
    expect(isErrnoCode({ code: "EACCES" }, "ENOENT")).toBe(false);
    expect(isEnoentError({ code: "ENOTDIR" })).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isEnoentError(null)).toBe(false);
    expect(isEnoentError(undefined)).toBe(false);
    expect(isEnoentError("ENOENT")).toBe(false);
    expect(isEnoentError(404)).toBe(false);
  });

  it("matches any code in isErrnoCodeIn", () => {
    expect(isErrnoCodeIn({ code: "ENOENT" }, ["EACCES", "ENOENT"])).toBe(true);
    expect(isErrnoCodeIn({ code: "ENOTDIR" }, ["ENOENT", "ENOTDIR"])).toBe(true);
    expect(isErrnoCodeIn({ code: "EISDIR" }, ["ENOENT", "ENOTDIR"])).toBe(false);
  });

  it("treats ENOENT and ENOTDIR as not-dir-like missing errors", () => {
    expect(isNotDirLikeMissingError({ code: "ENOENT" })).toBe(true);
    expect(isNotDirLikeMissingError({ code: "ENOTDIR" })).toBe(true);
    expect(isNotDirLikeMissingError({ code: "EACCES" })).toBe(false);
  });
});
