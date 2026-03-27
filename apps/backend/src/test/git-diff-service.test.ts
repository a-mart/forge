import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitDiffService } from "../ws/routes/git-diff-service.js";

const execFileAsync = promisify(execFile);
const activeRoots: string[] = [];

afterEach(async () => {
  await Promise.all(activeRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("GitDiffService", () => {
  it("getLog attaches parsed commit metadata", async () => {
    const repo = await createStructuredHistoryRepo();
    const service = new GitDiffService();

    const result = await service.getLog(repo.cwd, 10, 0);

    expect(result.hasMore).toBe(false);
    expect(result.commits[0]).toMatchObject({
      sha: repo.headSha,
      message: "memory(alpha): merge session alpha--s1",
      filesChanged: 1,
      metadata: {
        reason: "manual",
        source: "profile-memory-merge",
        sources: ["profile-memory-merge"],
        profileId: "alpha",
        sessionId: "alpha--s1",
        agentId: "alpha-worker-1",
        promptCategory: "archetype",
        promptId: "review",
        paths: ["profiles/alpha/memory-renamed.md"]
      }
    });
  });

  it("getCommitDetail merges numstat for renamed files and attaches metadata", async () => {
    const repo = await createStructuredHistoryRepo();
    const service = new GitDiffService();

    const result = await service.getCommitDetail(repo.cwd, repo.headSha);

    expect(result.metadata).toEqual({
      reason: "manual",
      source: "profile-memory-merge",
      sources: ["profile-memory-merge"],
      profileId: "alpha",
      sessionId: "alpha--s1",
      agentId: "alpha-worker-1",
      promptCategory: "archetype",
      promptId: "review",
      paths: ["profiles/alpha/memory-renamed.md"]
    });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      status: "renamed",
      oldPath: "profiles/alpha/memory.md",
      path: "profiles/alpha/memory-renamed.md"
    });
    expect(result.files[0]?.additions ?? 0).toBeGreaterThan(0);
    expect(result.files[0]?.deletions ?? 0).toBeGreaterThan(0);
  });
});

async function createStructuredHistoryRepo(): Promise<{ cwd: string; headSha: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "git-diff-service-"));
  activeRoots.push(cwd);

  await mkdir(join(cwd, "profiles", "alpha"), { recursive: true });
  await writeFile(join(cwd, "profiles", "alpha", "memory.md"), "# Memory\n\n- first\n- stable\n", "utf8");

  await execGit(cwd, ["init"]);
  await execGit(cwd, ["config", "user.name", "Forge Test"]);
  await execGit(cwd, ["config", "user.email", "forge-test@example.com"]);
  await execGit(cwd, ["add", "profiles/alpha/memory.md"]);
  await execGit(cwd, ["commit", "-m", "initial knowledge"]);

  await execGit(cwd, ["mv", "profiles/alpha/memory.md", "profiles/alpha/memory-renamed.md"]);
  await writeFile(
    join(cwd, "profiles", "alpha", "memory-renamed.md"),
    "# Memory\n\n- updated\n- stable\n- added\n",
    "utf8"
  );
  await execGit(cwd, ["add", "-A"]);
  await execGit(cwd, [
    "commit",
    "-m",
    "memory(alpha): merge session alpha--s1",
    "-m",
    [
      "Reason: manual",
      "Source: profile-memory-merge",
      "Profile: alpha",
      "Session: alpha--s1",
      "Agent: alpha-worker-1",
      "Prompt: archetype/review",
      "Paths:",
      "- profiles/alpha/memory-renamed.md"
    ].join("\n")
  ]);

  const headSha = (await execGit(cwd, ["rev-parse", "HEAD"])).stdout.trim();
  return { cwd, headSha };
}

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
