import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
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

    const logAfterTrackedWrite = await execGit(dataDir, ["log", "--oneline"]);
    expect(logAfterTrackedWrite.stdout).toContain("knowledge(cortex)");

    await mkdir(join(dataDir, "shared"), { recursive: true });
    const secretsPath = join(dataDir, "shared", "secrets.json");
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
