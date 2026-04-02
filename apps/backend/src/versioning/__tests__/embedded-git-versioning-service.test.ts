import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { EmbeddedGitVersioningService } from "../embedded-git-versioning-service.js";

const execFileAsync = promisify(execFile);

describe("EmbeddedGitVersioningService", () => {
  it("initializes an embedded repo, commits tracked writes, and ignores untracked secrets", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "embedded-git-versioning-"));
    const service = new EmbeddedGitVersioningService({
      dataDir,
      debounceMs: 10,
      reconcileIntervalMs: 0
    });

    await service.start();

    const commonKnowledgePath = join(dataDir, "shared", "knowledge", "common.md");
    await mkdir(join(dataDir, "shared", "knowledge"), { recursive: true });
    await writeFile(commonKnowledgePath, "# Common Knowledge\n\n- durable fact\n", "utf8");

    await service.recordMutation({
      path: commonKnowledgePath,
      action: "write",
      source: "api-write-file",
      profileId: "cortex"
    });
    await service.flushPending("test-write");

    const excludePath = join(dataDir, ".git", "info", "exclude");
    const excludeContent = await readFile(excludePath, "utf8");
    expect(excludeContent).toContain("*");
    expect(excludeContent).toContain("*.bak*");

    const logAfterTrackedWrite = await execGit(dataDir, ["rev-list", "--count", "HEAD"]);
    expect(logAfterTrackedWrite.stdout.trim()).toBe("1");
    const trackedHeadContents = await execGit(dataDir, ["show", "HEAD:shared/knowledge/common.md"]);
    expect(trackedHeadContents.stdout).toContain("durable fact");

    await mkdir(join(dataDir, "shared", "config"), { recursive: true });
    const secretsPath = join(dataDir, "shared", "config", "secrets.json");
    await writeFile(secretsPath, '{"token":"secret"}\n', "utf8");

    await service.recordMutation({
      path: secretsPath,
      action: "write",
      source: "api-write-file"
    });
    await service.flushPending("test-secret");

    const logAfterSecretWrite = await execGit(dataDir, ["rev-list", "--count", "HEAD"]);
    expect(logAfterSecretWrite.stdout.trim()).toBe("1");

    await service.stop();
  });

  it("reconciles out-of-band tracked edits", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "embedded-git-versioning-"));
    const service = new EmbeddedGitVersioningService({
      dataDir,
      debounceMs: 10,
      reconcileIntervalMs: 0
    });

    await service.start();

    const profileMemoryPath = join(dataDir, "profiles", "alpha", "memory.md");
    await mkdir(join(dataDir, "profiles", "alpha"), { recursive: true });
    await writeFile(profileMemoryPath, "# Swarm Memory\n\n## Decisions\n- first\n", "utf8");
    await service.reconcileNow("startup");

    await writeFile(profileMemoryPath, "# Swarm Memory\n\n## Decisions\n- second\n", "utf8");
    await service.reconcileNow("manual");

    const commitCount = await execGit(dataDir, ["rev-list", "--count", "HEAD"]);
    expect(commitCount.stdout.trim()).toBe("2");

    const headContents = await execGit(dataDir, ["show", "HEAD:profiles/alpha/memory.md"]);
    expect(headContents.stdout).toContain("- second");

    await service.stop();
  });

  it("retains pending mutations when flushPending fails and retries successfully later", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "embedded-git-versioning-"));
    const service = new EmbeddedGitVersioningService({
      dataDir,
      debounceMs: 10,
      reconcileIntervalMs: 0
    });

    await service.start();

    const commonKnowledgePath = join(dataDir, "shared", "knowledge", "common.md");
    await mkdir(join(dataDir, "shared", "knowledge"), { recursive: true });
    await writeFile(commonKnowledgePath, "# Common Knowledge\n\n- durable fact\n", "utf8");

    await service.recordMutation({
      path: commonKnowledgePath,
      action: "write",
      source: "api-write-file",
      profileId: "cortex"
    });

    const internal = service as any;
    const originalStageAndCommit = internal.stageAndCommit.bind(service);
    internal.stageAndCommit = vi.fn(async () => {
      throw new Error("synthetic git failure");
    });

    await expect(service.flushPending("test-failure")).rejects.toThrow("synthetic git failure");
    expect(internal.pendingMutations.size).toBe(1);

    internal.stageAndCommit = originalStageAndCommit;
    await service.flushPending("test-retry");
    expect(internal.pendingMutations.size).toBe(0);

    const commitCount = await execGit(dataDir, ["rev-list", "--count", "HEAD"]);
    expect(commitCount.stdout.trim()).toBe("1");

    await service.stop();
  });

  it("includes Review-Run metadata when every mutation shares the same review run id", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "embedded-git-versioning-"));
    const service = new EmbeddedGitVersioningService({
      dataDir,
      debounceMs: 10,
      reconcileIntervalMs: 0
    });

    await service.start();
    try {
      const built = await (service as any).buildCommitMessage(
        ["shared/knowledge/common.md", "profiles/alpha/memory.md"],
        [
          {
            path: "shared/knowledge/common.md",
            action: "write",
            source: "agent-edit-tool",
            profileId: "cortex",
            reviewRunId: "review-123"
          },
          {
            path: "profiles/alpha/memory.md",
            action: "write",
            source: "profile-memory-merge",
            profileId: "alpha",
            reviewRunId: "review-123"
          }
        ],
        "debounce"
      );

      expect(built.body).toContain("Review-Run: review-123");
    } finally {
      await service.stop();
    }
  });

  it("omits Review-Run metadata when the staged batch mixes review run ids", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "embedded-git-versioning-"));
    const service = new EmbeddedGitVersioningService({
      dataDir,
      debounceMs: 10,
      reconcileIntervalMs: 0
    });

    await service.start();
    try {
      const built = await (service as any).buildCommitMessage(
        ["shared/knowledge/common.md", "profiles/alpha/memory.md"],
        [
          {
            path: "shared/knowledge/common.md",
            action: "write",
            source: "agent-edit-tool",
            profileId: "cortex",
            reviewRunId: "review-123"
          },
          {
            path: "profiles/alpha/memory.md",
            action: "write",
            source: "profile-memory-merge",
            profileId: "alpha",
            reviewRunId: "review-456"
          }
        ],
        "debounce"
      );

      expect(built.body).not.toContain("Review-Run:");
    } finally {
      await service.stop();
    }
  });

  it("catches background debounce failures and disables versioning fail-open", async () => {
    const warn = vi.fn();
    const dataDir = await mkdtemp(join(tmpdir(), "embedded-git-versioning-"));
    const service = new EmbeddedGitVersioningService({
      dataDir,
      debounceMs: 5,
      reconcileIntervalMs: 0,
      logger: {
        info: vi.fn(),
        warn,
        error: vi.fn()
      }
    });

    await service.start();

    const commonKnowledgePath = join(dataDir, "shared", "knowledge", "common.md");
    await mkdir(join(dataDir, "shared", "knowledge"), { recursive: true });
    await writeFile(commonKnowledgePath, "# Common Knowledge\n\n- durable fact\n", "utf8");

    const internal = service as any;
    internal.stageAndCommit = vi.fn(async () => {
      throw new Error("background failure");
    });

    await service.recordMutation({
      path: commonKnowledgePath,
      action: "write",
      source: "api-write-file",
      profileId: "cortex"
    });

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("debounce flush failed: background failure"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Embedded Git versioning disabled: background failure"));
    expect(internal.started).toBe(false);
    expect(await service.recordMutation({
      path: commonKnowledgePath,
      action: "write",
      source: "api-write-file",
      profileId: "cortex"
    })).toBe(false);

    await service.stop();
  });
});

async function execGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8"
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr
  };
}
