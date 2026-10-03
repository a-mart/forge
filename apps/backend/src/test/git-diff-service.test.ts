import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitDiffService } from "../ws/http/services/git-diff-service.js";

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
      parents: [repo.initialSha],
      refs: [{ name: "main", kind: "current" }],
      metadata: {
        reason: "manual",
        source: "profile-memory-merge",
        sources: ["profile-memory-merge"],
        profileId: "alpha",
        sessionId: "alpha--s1",
        agentId: "alpha-worker-1",
        reviewRunId: "review-123",
        promptCategory: "archetype",
        promptId: "review",
        paths: ["profiles/alpha/memory-renamed.md"]
      }
    });
    expect(result.commits[1]).toMatchObject({
      sha: repo.initialSha,
      message: "initial knowledge",
      parents: []
    });
    expect(result.commits[1]?.refs).toBeUndefined();
  });

  it("getLog decorates local and remote refs on the matching commits", async () => {
    const repo = await createStructuredHistoryRepo();
    await execGit(repo.cwd, ["branch", "-M", "main"]);
    const bareDir = join(repo.cwd, "origin.git");
    await execGit(repo.cwd, ["init", "--bare", bareDir]);
    await execGit(repo.cwd, ["remote", "add", "origin", bareDir]);
    await execGit(repo.cwd, ["push", "-u", "origin", "main"]);
    await writeFile(join(repo.cwd, "profiles", "alpha", "memory-renamed.md"), "# Memory\n\n- local ahead\n", "utf8");
    await execGit(repo.cwd, ["add", "profiles/alpha/memory-renamed.md"]);
    await execGit(repo.cwd, ["commit", "-m", "local unpublished commit"], new Date().toISOString());
    const headSha = (await execGit(repo.cwd, ["rev-parse", "HEAD"])).stdout.trim();
    const originSha = (await execGit(repo.cwd, ["rev-parse", "origin/main"])).stdout.trim();
    const service = new GitDiffService();

    const result = await service.getLog(repo.cwd, 10, 0);

    expect(result.commits[0]).toMatchObject({
      sha: headSha,
      refs: [{ name: "main", kind: "current" }]
    });
    expect(result.commits.find((commit) => commit.sha === originSha)?.refs).toEqual([
      { name: "origin/main", kind: "remote" }
    ]);
  });

  it("getLog peels annotated tags onto the tagged commit", async () => {
    const repo = await createStructuredHistoryRepo();
    await execGit(repo.cwd, ["tag", "-a", "v1.0.0", repo.initialSha, "-m", "annotated release"]);
    const service = new GitDiffService();

    const result = await service.getLog(repo.cwd, 10, 0);
    const initial = result.commits.find((commit) => commit.sha === repo.initialSha);

    expect(initial?.refs).toEqual([{ name: "v1.0.0", kind: "tag" }]);
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
      reviewRunId: "review-123",
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

  it("refuses to read a working-tree file through a symlink that escapes the repo root", async () => {
    const repo = await createMinimalRepo();

    const outsideDir = await mkdtemp(join(tmpdir(), "git-diff-service-outside-"));
    activeRoots.push(outsideDir);
    await writeFile(join(outsideDir, "secret.txt"), "TOP SECRET", "utf8");

    // A symlink inside the repo pointing at the outside secret. It is lexically an
    // in-repo path, so resolveSafeRepoPath's lexical check alone would allow the read.
    await symlink(join(outsideDir, "secret.txt"), join(repo.cwd, "escape.txt"));

    const service = new GitDiffService();

    await expect(service.getUntrackedFileContent(repo.cwd, "escape.txt")).rejects.toThrow(
      /outside repository root/
    );
    await expect(service.getFileDiff(repo.cwd, "escape.txt")).rejects.toThrow(
      /outside repository root/
    );

    // A genuine untracked file inside the repo still reads normally.
    await writeFile(join(repo.cwd, "real.txt"), "hello real", "utf8");
    await expect(service.getUntrackedFileContent(repo.cwd, "real.txt")).resolves.toBe("hello real");
  });
});

async function createMinimalRepo(): Promise<{ cwd: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "git-diff-service-symlink-"));
  activeRoots.push(cwd);

  await writeFile(join(cwd, "README.md"), "# repo\n", "utf8");
  await execGit(cwd, ["init"]);
  await execGit(cwd, ["config", "user.name", "Forge Test"]);
  await execGit(cwd, ["config", "user.email", "forge-test@example.com"]);
  await execGit(cwd, ["add", "README.md"]);
  await execGit(cwd, ["commit", "-m", "initial"], "2026-03-23T10:00:00.000Z");

  return { cwd };
}

async function createStructuredHistoryRepo(): Promise<{ cwd: string; headSha: string; initialSha: string; headDate: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "git-diff-service-"));
  activeRoots.push(cwd);

  await mkdir(join(cwd, "profiles", "alpha"), { recursive: true });
  await writeFile(join(cwd, "profiles", "alpha", "memory.md"), "# Memory\n\n- first\n- stable\n", "utf8");

  await execGit(cwd, ["init"]);
  await execGit(cwd, ["config", "user.name", "Forge Test"]);
  await execGit(cwd, ["config", "user.email", "forge-test@example.com"]);
  await execGit(cwd, ["add", "profiles/alpha/memory.md"]);
  await execGit(
    cwd,
    ["commit", "-m", "initial knowledge"],
    "2026-03-23T10:00:00.000Z"
  );
  await execGit(cwd, ["branch", "-M", "main"]);

  const initialSha = (await execGit(cwd, ["rev-parse", "HEAD"])).stdout.trim();

  await execGit(cwd, ["mv", "profiles/alpha/memory.md", "profiles/alpha/memory-renamed.md"]);
  await writeFile(
    join(cwd, "profiles", "alpha", "memory-renamed.md"),
    "# Memory\n\n- updated\n- stable\n- added\n",
    "utf8"
  );
  await execGit(cwd, ["add", "-A"]);
  const headDate = new Date().toISOString();
  await execGit(
    cwd,
    [
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
        "Review-Run: review-123",
        "Prompt: archetype/review",
        "Paths:",
        "- profiles/alpha/memory-renamed.md"
      ].join("\n")
    ],
    headDate
  );

  const headSha = (await execGit(cwd, ["rev-parse", "HEAD"])).stdout.trim();
  return { cwd, headSha, initialSha, headDate };
}

async function execGit(cwd: string, args: string[], gitDate?: string): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitDate
      ? {
          ...process.env,
          GIT_AUTHOR_DATE: gitDate,
          GIT_COMMITTER_DATE: gitDate
        }
      : process.env
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr
  };
}
