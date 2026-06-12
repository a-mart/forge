import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitCli, normalizeGitCommandError } from "../versioning/git-cli.js";

describe("git-cli", () => {
  it("passes optional timeoutMs through to execFile and throws a timeout-specific error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "git-cli-timeout-"));
    const slowGit = join(dir, "slow-git.sh");
    await writeFile(
      slowGit,
      "#!/bin/sh\nsleep 2\necho ok\n",
      "utf8"
    );
    await chmod(slowGit, 0o755);

    const git = new GitCli({ cwd: dir, gitBinary: slowGit });

    await expect(git.run(["status"], { timeoutMs: 200 })).rejects.toThrow(/timed out/i);
  });

  it("classifies allowFailure timeout results as timeout even with empty stderr", async () => {
    const dir = await mkdtemp(join(tmpdir(), "git-cli-timeout-allow-failure-"));
    const slowGit = join(dir, "slow-git.sh");
    await writeFile(
      slowGit,
      "#!/bin/sh\nsleep 2\necho ok\n",
      "utf8"
    );
    await chmod(slowGit, 0o755);

    const git = new GitCli({ cwd: dir, gitBinary: slowGit });
    const result = await git.run(["status"], { allowFailure: true, timeoutMs: 200 });
    const normalized = normalizeGitCommandError(["status"], result);

    expect(result.stderr).toMatch(/timed out/i);
    expect(normalized.classification).toBe("timeout");
  });

  it("preserves existing allowFailure behavior for callers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "git-cli-allow-failure-"));
    const git = new GitCli({ cwd: dir, gitBinary: "git" });
    const result = await git.run(["rev-parse", "--show-toplevel"], { allowFailure: true });
    expect(result.exitCode).not.toBe(0);
  });

  it("normalizes git command errors with classification", () => {
    const normalized = normalizeGitCommandError(["status"], {
      stdout: "",
      stderr: "fatal: not a git repository (or any of the parent directories): .git",
      exitCode: 128
    });

    expect(normalized.classification).toBe("not_a_repository");
    expect(normalized.exitCode).toBe(128);
    expect(normalized.command).toBe("git status");
    expect(normalized.message).toContain("not a git repository");
  });

  it("classifies explicit ETIMEDOUT execFile failures as timeout", () => {
    const normalized = normalizeGitCommandError(["fetch"], {
      stdout: "",
      stderr: "git command timed out",
      exitCode: 1
    });

    expect(normalized.classification).toBe("timeout");
  });
});
