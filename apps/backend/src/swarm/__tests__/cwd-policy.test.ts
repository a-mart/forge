import { describe, expect, it } from "vitest";
import { resolveDirectoryPath } from "../cwd-policy.js";

describe("cwd-policy", () => {
  it("preserves POSIX absolute paths", () => {
    expect(resolveDirectoryPath("/tmp/project", "/repo/root")).toBe("/tmp/project");
  });

  it("preserves Windows absolute paths", () => {
    expect(resolveDirectoryPath("C:\\repo\\project", "/repo/root")).toBe("C:\\repo\\project");
  });

  it("resolves relative paths under the configured root", () => {
    expect(resolveDirectoryPath("packages/ui", "/repo/root")).toBe("/repo/root/packages/ui");
  });
});
