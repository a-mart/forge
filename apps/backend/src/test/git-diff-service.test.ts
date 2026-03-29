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
        reviewRunId: "review-123",
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

  it("getFileLog follows renames and computes file history stats", async () => {
    const repo = await createTrackedRenameHistoryRepo();
    const service = new GitDiffService();

    const result = await service.getFileLog(repo.cwd, "profiles/alpha/reference/guide-renamed.md", 10, 0);

    expect(result.file).toBe("profiles/alpha/reference/guide-renamed.md");
    expect(result.commits.map((commit) => commit.sha)).toEqual([repo.headSha, repo.initialSha]);
    expect(result.stats.totalEdits).toBe(2);
    expect(result.stats.lastModifiedAt).not.toBeNull();
    expect(Math.abs(Date.parse(result.stats.lastModifiedAt ?? '') - Date.parse(repo.headDate))).toBeLessThan(1000);
    expect(result.stats.editsThisWeek).toBeGreaterThanOrEqual(1);
    expect(result.stats.editsToday).toBeGreaterThanOrEqual(1);
  });

  it("getFileLog paginates file history", async () => {
    const repo = await createTrackedRenameHistoryRepo();
    const service = new GitDiffService();

    const result = await service.getFileLog(repo.cwd, "profiles/alpha/reference/guide-renamed.md", 1, 1);

    expect(result.commits).toHaveLength(1);
    expect(result.commits[0]?.sha).toBe(repo.initialSha);
    expect(result.hasMore).toBe(false);
  });

  it("getFileSectionProvenance returns current-section commit metadata", async () => {
    const repo = await createSectionHistoryRepo();
    const service = new GitDiffService();

    const result = await service.getFileSectionProvenance(repo.cwd, "shared/knowledge/common.md");

    expect(result.file).toBe("shared/knowledge/common.md");
    expect(result.sections).toEqual([
      expect.objectContaining({
        heading: "Common",
        level: 1,
        lineStart: 1,
        lineEnd: 2,
        lastModifiedSummary: "initial knowledge",
        reviewRunId: null
      }),
      expect.objectContaining({
        heading: "Workflow Preferences",
        level: 2,
        lineStart: 3,
        lineEnd: 5,
        lastModifiedSha: repo.headSha,
        lastModifiedSummary: "update workflow section",
        reviewRunId: "review-456"
      }),
      expect.objectContaining({
        heading: "Technical Standards",
        level: 2,
        lineStart: 6,
        lineEnd: 8,
        lastModifiedSha: repo.initialSha,
        lastModifiedSummary: "initial knowledge",
        reviewRunId: null
      })
    ]);
  });

  it("getFileSectionProvenance returns an empty section list for files without headings", async () => {
    const repo = await createHeadinglessMarkdownRepo();
    const service = new GitDiffService();

    const result = await service.getFileSectionProvenance(repo.cwd, "shared/knowledge/common.md");

    expect(result).toEqual({
      file: "shared/knowledge/common.md",
      sections: []
    });
  });
});

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

async function createTrackedRenameHistoryRepo(): Promise<{ cwd: string; headSha: string; initialSha: string; headDate: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "git-diff-service-tracked-rename-"));
  activeRoots.push(cwd);

  await mkdir(join(cwd, "profiles", "alpha", "reference"), { recursive: true });
  await writeFile(join(cwd, "profiles", "alpha", "reference", "guide.md"), "# Guide\n\n- first\n", "utf8");

  await execGit(cwd, ["init"]);
  await execGit(cwd, ["config", "user.name", "Forge Test"]);
  await execGit(cwd, ["config", "user.email", "forge-test@example.com"]);
  await execGit(cwd, ["add", "profiles/alpha/reference/guide.md"]);
  await execGit(cwd, ["commit", "-m", "initial guide"], "2026-03-23T10:00:00.000Z");

  const initialSha = (await execGit(cwd, ["rev-parse", "HEAD"])).stdout.trim();
  await execGit(cwd, ["mv", "profiles/alpha/reference/guide.md", "profiles/alpha/reference/guide-renamed.md"]);
  await writeFile(join(cwd, "profiles", "alpha", "reference", "guide-renamed.md"), "# Guide\n\n- second\n", "utf8");

  await execGit(cwd, ["add", "-A"]);
  const headDate = new Date().toISOString();
  await execGit(cwd, ["commit", "-m", "rename guide"], headDate);

  const headSha = (await execGit(cwd, ["rev-parse", "HEAD"])).stdout.trim();
  return { cwd, headSha, initialSha, headDate };
}

async function createSectionHistoryRepo(): Promise<{ cwd: string; headSha: string; initialSha: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "git-diff-service-sections-"));
  activeRoots.push(cwd);

  await mkdir(join(cwd, "shared", "knowledge"), { recursive: true });
  await writeFile(
    join(cwd, "shared", "knowledge", "common.md"),
    [
      "# Common",
      "",
      "## Workflow Preferences",
      "- first",
      "",
      "## Technical Standards",
      "- stable"
    ].join("\n") + "\n",
    "utf8"
  );

  await execGit(cwd, ["init"]);
  await execGit(cwd, ["config", "user.name", "Forge Test"]);
  await execGit(cwd, ["config", "user.email", "forge-test@example.com"]);
  await execGit(cwd, ["add", "shared/knowledge/common.md"]);
  await execGit(cwd, ["commit", "-m", "initial knowledge"], "2026-03-23T10:00:00.000Z");

  const initialSha = (await execGit(cwd, ["rev-parse", "HEAD"])).stdout.trim();

  await writeFile(
    join(cwd, "shared", "knowledge", "common.md"),
    [
      "# Common",
      "",
      "## Workflow Preferences",
      "- updated",
      "",
      "## Technical Standards",
      "- stable"
    ].join("\n") + "\n",
    "utf8"
  );
  await execGit(cwd, ["add", "shared/knowledge/common.md"]);
  await execGit(
    cwd,
    [
      "commit",
      "-m",
      "update workflow section",
      "-m",
      [
        "Review-Run: review-456",
        "Paths:",
        "- shared/knowledge/common.md"
      ].join("\n")
    ],
    new Date().toISOString()
  );

  const headSha = (await execGit(cwd, ["rev-parse", "HEAD"])).stdout.trim();
  return { cwd, headSha, initialSha };
}

async function createHeadinglessMarkdownRepo(): Promise<{ cwd: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "git-diff-service-no-headings-"));
  activeRoots.push(cwd);

  await mkdir(join(cwd, "shared", "knowledge"), { recursive: true });
  await writeFile(join(cwd, "shared", "knowledge", "common.md"), "plain text only\n", "utf8");

  await execGit(cwd, ["init"]);
  await execGit(cwd, ["config", "user.name", "Forge Test"]);
  await execGit(cwd, ["config", "user.email", "forge-test@example.com"]);
  await execGit(cwd, ["add", "shared/knowledge/common.md"]);
  await execGit(cwd, ["commit", "-m", "initial plain markdown"], "2026-03-23T10:00:00.000Z");

  return { cwd };
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
