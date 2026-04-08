import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { parseVersioningCommitMetadata } from "../versioning-commit-metadata.js";
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

  it("emits post-commit observer payloads with sha, metadata, and deduped profile ids", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "embedded-git-versioning-"));
    const onCommit = vi.fn();
    const service = new EmbeddedGitVersioningService({
      dataDir,
      debounceMs: 10,
      reconcileIntervalMs: 0,
      onCommit,
    });

    await service.start();

    const alphaMemoryPath = join(dataDir, "profiles", "alpha", "memory.md");
    const betaMemoryPath = join(dataDir, "profiles", "beta", "memory.md");
    await mkdir(join(dataDir, "profiles", "alpha"), { recursive: true });
    await mkdir(join(dataDir, "profiles", "beta"), { recursive: true });
    await writeFile(alphaMemoryPath, "# Swarm Memory\n", "utf8");
    await writeFile(betaMemoryPath, "# Swarm Memory\n", "utf8");

    await service.recordMutation({
      path: alphaMemoryPath,
      action: "write",
      source: "profile-memory-merge",
      profileId: "alpha",
      sessionId: "alpha--s1",
    });
    await service.recordMutation({
      path: betaMemoryPath,
      action: "write",
      source: "reference-doc",
      profileId: "beta",
    });
    await service.flushPending("observer-test");

    expect(onCommit).toHaveBeenCalledTimes(1);
    const [event] = onCommit.mock.calls[0];
    expect(event.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(event.reason).toBe("observer-test");
    expect(event.paths).toEqual(["profiles/alpha/memory.md", "profiles/beta/memory.md"]);
    expect(event.profileIds).toEqual(["alpha", "beta"]);
    expect(event.subject).toContain("tracked files");
    expect(parseVersioningCommitMetadata(event.body)).toMatchObject({
      reason: "observer-test",
      paths: ["profiles/alpha/memory.md", "profiles/beta/memory.md"],
    });

    await service.stop();
  });

  it("keeps commits fail-open when the post-commit observer throws", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "embedded-git-versioning-"));
    const onCommit = vi.fn(async () => {
      throw new Error("observer failed");
    });
    const warn = vi.fn();
    const service = new EmbeddedGitVersioningService({
      dataDir,
      debounceMs: 10,
      reconcileIntervalMs: 0,
      onCommit,
      logger: {
        info: vi.fn(),
        warn,
        error: vi.fn(),
      },
    });

    await service.start();

    const commonKnowledgePath = join(dataDir, "shared", "knowledge", "common.md");
    await mkdir(join(dataDir, "shared", "knowledge"), { recursive: true });
    await writeFile(commonKnowledgePath, "# Common Knowledge\n", "utf8");

    await service.recordMutation({
      path: commonKnowledgePath,
      action: "write",
      source: "api-write-file",
    });
    await service.flushPending("observer-failure");

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Post-commit observer failed: observer failed"));
    const commitCount = await execGit(dataDir, ["rev-list", "--count", "HEAD"]);
    expect(commitCount.stdout.trim()).toBe("1");

    await service.stop();
  });

  it("reports empty profile ids when a commit batch has no profile-scoped metadata", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "embedded-git-versioning-"));
    const onCommit = vi.fn();
    const service = new EmbeddedGitVersioningService({
      dataDir,
      debounceMs: 10,
      reconcileIntervalMs: 0,
      onCommit,
    });

    await service.start();

    const sharedNotesPath = join(dataDir, "shared", "notes.md");
    await mkdir(join(dataDir, "shared"), { recursive: true });
    await writeFile(sharedNotesPath, "notes\n", "utf8");

    await (service as any).stageAndCommit({
      explicitPaths: ["shared/notes.md"],
      mutations: [{
        path: "shared/notes.md",
        action: "write",
        source: "reconcile",
      }],
      reason: "shared-only",
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    const [event] = onCommit.mock.calls[0];
    expect(event.paths).toEqual(["shared/notes.md"]);
    expect(event.profileIds).toEqual([]);

    await service.stop();
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
