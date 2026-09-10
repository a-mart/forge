import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DockerSecureExecutionBackend } from "../secure-sessions/execution/docker-secure-execution-backend.js";
import { SecureExecutionError } from "../secure-sessions/execution/secure-execution-error.js";

const execFileAsync = promisify(execFile);
const cleanupOperations: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanupOperations.splice(0).map((cleanup) => cleanup()));
});

// Kept separate from the Docker integration suite's module-level availability probe.
// These invalid mounts must fail before any invocation, including endpoint discovery.
function createBackend(scope: string) {
  const onDockerInvocation = vi.fn(() => {
    throw new Error("Unexpected Docker invocation");
  });
  const backend = new DockerSecureExecutionBackend({
    scope,
    dockerEnvironment: {
      DOCKER_HOST: process.platform === "win32"
        ? "npipe:////./pipe/docker_engine"
        : "unix:///tmp/forge-test-docker.sock",
    },
    onDockerInvocation,
  });
  return { backend, onDockerInvocation };
}

describe("Docker secure execution linked-worktree mount validation", () => {
  it("rejects a symlinked .git entry before invoking Docker", async () => {
    const temporaryRoot = await realpath(await mkdtemp(
      join(tmpdir(), "forge-secure-git-symlink-"),
    ));
    cleanupOperations.push(async () =>
      await rm(temporaryRoot, { recursive: true, force: true }),
    );
    const temporaryWorkspace = join(temporaryRoot, "workspace");
    const externalGitDirectory = join(temporaryRoot, "external.git");
    await mkdir(temporaryWorkspace);
    await mkdir(externalGitDirectory);
    await symlink(
      externalGitDirectory,
      join(temporaryWorkspace, ".git"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect((await lstat(join(temporaryWorkspace, ".git"))).isSymbolicLink()).toBe(true);

    const { backend, onDockerInvocation } = createBackend("git-symlink-rejection");
    await expect(
      backend.ensureTask({
        taskId: "git-symlink-rejection",
        workspacePath: temporaryWorkspace,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SecureExecutionError>>({
        code: "INVALID_TASK",
      }),
    );
    expect(onDockerInvocation).not.toHaveBeenCalled();
  });

  it("rejects a .git pointer whose gitdir is outside a standard worktrees directory", async () => {
    const temporaryRoot = await realpath(await mkdtemp(
      join(tmpdir(), "forge-secure-git-pointer-"),
    ));
    cleanupOperations.push(async () =>
      await rm(temporaryRoot, { recursive: true, force: true }),
    );
    const temporaryWorkspace = join(temporaryRoot, "workspace");
    const commonDirectory = join(temporaryRoot, ".git");
    const rogueGitDirectory = join(temporaryRoot, "rogue-worktree-metadata");
    await mkdir(temporaryWorkspace);
    await mkdir(commonDirectory);
    await mkdir(rogueGitDirectory);
    await writeFile(
      join(temporaryWorkspace, ".git"),
      `gitdir: ${rogueGitDirectory}\n`,
    );
    await writeFile(
      join(rogueGitDirectory, "commondir"),
      `${commonDirectory}\n`,
    );
    await writeFile(
      join(rogueGitDirectory, "gitdir"),
      `${join(temporaryWorkspace, ".git")}\n`,
    );

    const { backend, onDockerInvocation } = createBackend("git-pointer-rejection");
    await expect(
      backend.ensureTask({
        taskId: "git-pointer-rejection",
        workspacePath: temporaryWorkspace,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SecureExecutionError>>({
        code: "INVALID_TASK",
      }),
    );
    expect(onDockerInvocation).not.toHaveBeenCalled();
  });

  it("rejects a pointer to another repository's legitimate worktree metadata", async () => {
    const temporaryRoot = await realpath(await mkdtemp(
      join(tmpdir(), "forge-secure-cross-repo-git-pointer-"),
    ));
    cleanupOperations.push(async () =>
      await rm(temporaryRoot, { recursive: true, force: true }),
    );
    const donorRepository = join(temporaryRoot, "donor");
    const donorWorktree = join(temporaryRoot, "donor-worktree");
    const emptyHooksDirectory = join(temporaryRoot, "empty-hooks");
    const emptyGitConfig = join(temporaryRoot, "empty-git-config");
    await mkdir(donorRepository);
    await mkdir(emptyHooksDirectory);
    await writeFile(emptyGitConfig, "");
    // Keep inherited Git overrides, hooks, signing, and identity out of the fixture.
    const gitEnvironment = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
      ),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: emptyGitConfig,
    };
    const runFixtureGit = (cwd: string, args: string[]) => execFileAsync("git", [
      "-c", `core.hooksPath=${emptyHooksDirectory}`,
      "-c", "commit.gpgsign=false",
      "-c", "user.name=Secure Sessions Test",
      "-c", "user.email=secure-sessions-test@example.invalid",
      ...args,
    ], { cwd, env: gitEnvironment });
    await runFixtureGit(donorRepository, ["init", `--template=${emptyHooksDirectory}`, donorRepository]);
    await runFixtureGit(donorRepository, ["commit", "--allow-empty", "-m", "Fixture HEAD"]);
    await runFixtureGit(donorRepository, ["worktree", "add", "--detach", donorWorktree, "HEAD"]);
    const { stdout: gitDirectoryOutput } = await runFixtureGit(
      donorWorktree,
      ["rev-parse", "--absolute-git-dir"],
    );
    const legitimateGitDirectory = await realpath(gitDirectoryOutput.trim());
    expect(legitimateGitDirectory).toBe(
      await realpath(join(donorRepository, ".git", "worktrees", "donor-worktree")),
    );
    const reversePointer = (await readFile(join(legitimateGitDirectory, "gitdir"), "utf8")).trim();
    expect(await realpath(resolve(legitimateGitDirectory, reversePointer))).toBe(
      await realpath(join(donorWorktree, ".git")),
    );
    const commonPointer = (await readFile(join(legitimateGitDirectory, "commondir"), "utf8")).trim();
    expect(await realpath(resolve(legitimateGitDirectory, commonPointer))).toBe(
      await realpath(join(donorRepository, ".git")),
    );
    const temporaryWorkspace = join(temporaryRoot, "workspace");
    await mkdir(temporaryWorkspace);
    await writeFile(
      join(temporaryWorkspace, ".git"),
      `gitdir: ${legitimateGitDirectory}\n`,
    );

    const { backend, onDockerInvocation } = createBackend("cross-repo-git-pointer-rejection");
    await expect(
      backend.ensureTask({
        taskId: "cross-repo-git-pointer-rejection",
        workspacePath: temporaryWorkspace,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SecureExecutionError>>({
        code: "INVALID_TASK",
      }),
    );
    expect(onDockerInvocation).not.toHaveBeenCalled();
  });
});
