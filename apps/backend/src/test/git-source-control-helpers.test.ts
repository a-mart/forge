import { describe, expect, it } from "vitest";
import {
  computeStatusHash,
  createWorktreeId,
  hasUnmergedPorcelain,
  isDirtyPorcelain,
  isOptionLikeGitRef,
  isPathContainedInRoot,
  isValidGitRemoteNameShape,
  parseWorktreeListPorcelain,
  resolveStableWorktreePathKey
} from "../versioning/git-source-control-helpers.js";

describe("git-source-control-helpers", () => {
  it("parses git worktree list porcelain -z output", () => {
    const output = [
      "worktree /repo/main",
      "HEAD abcdef1234567890abcdef1234567890abcdef12",
      "branch refs/heads/main",
      "",
      "worktree /repo/feature",
      "HEAD fedcba0987654321fedcba0987654321fedcba09",
      "branch refs/heads/feature/foo",
      "locked reason here",
      "",
      "worktree /repo/stale",
      "HEAD abcdef1234567890abcdef1234567890abcdef12",
      "prunable gitdir file points to non-existent location",
      ""
    ].join("\0");

    const entries = parseWorktreeListPorcelain(output);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      path: "/repo/main",
      branch: "main",
      headSha: "abcdef1234567890abcdef1234567890abcdef12",
      isLocked: false,
      isPrunable: false
    });
    expect(entries[1]).toMatchObject({
      path: "/repo/feature",
      branch: "feature/foo",
      isLocked: true,
      lockReason: "reason here"
    });
    expect(entries[2]).toMatchObject({
      path: "/repo/stale",
      isPrunable: true
    });
  });

  it("creates stable worktree ids from normalized paths", () => {
    const first = createWorktreeId("/Users/adam/repos/middleman");
    const second = createWorktreeId("/Users/adam/repos/middleman");
    expect(first).toHaveLength(16);
    expect(first).toBe(second);
  });

  it("creates stable ids for reported paths when realpath is unavailable", () => {
    const stableKey = resolveStableWorktreePathKey("/tmp/missing-worktree");
    expect(createWorktreeId(stableKey)).toHaveLength(16);
  });

  it("computes deterministic status hashes", () => {
    const porcelain = " M apps/backend/src/ws/server.ts\n?? notes.txt\n";
    expect(computeStatusHash(porcelain)).toHaveLength(16);
    expect(computeStatusHash(porcelain)).toBe(computeStatusHash(porcelain));
  });

  it("detects dirty and unmerged porcelain", () => {
    expect(isDirtyPorcelain("")).toBe(false);
    expect(isDirtyPorcelain("?? new.txt\n")).toBe(true);
    expect(hasUnmergedPorcelain("UU conflict.txt\n")).toBe(true);
    expect(hasUnmergedPorcelain(" M clean-edit.txt\n")).toBe(false);
  });

  it("detects full unmerged porcelain variants", () => {
    for (const status of ["DD", "AU", "UD", "UA", "DU", "AA", "UU"] as const) {
      expect(hasUnmergedPorcelain(`${status} conflict.txt\n`)).toBe(true);
    }
  });

  it("rejects option-like git refs and invalid remote names", () => {
    expect(isOptionLikeGitRef("--discard-changes")).toBe(true);
    expect(isOptionLikeGitRef("main")).toBe(false);
    expect(isValidGitRemoteNameShape("origin")).toBe(true);
    expect(isValidGitRemoteNameShape("--all")).toBe(false);
    expect(isValidGitRemoteNameShape("bad remote")).toBe(false);
    expect(isValidGitRemoteNameShape("-origin")).toBe(false);
  });

  it("matches agent cwd containment with separator boundaries", () => {
    expect(isPathContainedInRoot("/repo/main", "/repo/main")).toBe(true);
    expect(isPathContainedInRoot("/repo/main/apps/backend", "/repo/main")).toBe(true);
    expect(isPathContainedInRoot("/repo/main-backup", "/repo/main")).toBe(false);
    expect(isPathContainedInRoot("/repo/other", "/repo/main")).toBe(false);
  });
});
