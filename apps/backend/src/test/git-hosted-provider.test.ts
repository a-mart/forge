import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GitHostedProviderService,
  aggregateCheckStatusFromRollup,
  classifyGhFailure,
  matchesCurrentBranchPullRequest,
  parseCheckSummariesFromRollup,
  parseGitHubRepoFromRemoteUrl
} from "../ws/http/services/git-hosted-provider.js";
import type { GitSourceControlContext } from "../ws/http/shared/route-helpers.js";

describe("parseGitHubRepoFromRemoteUrl", () => {
  it("parses SSH and HTTPS GitHub remotes", () => {
    expect(parseGitHubRepoFromRemoteUrl("git@github.com:a-mart/forge.git")).toEqual({
      owner: "a-mart",
      repo: "forge",
      remoteUrl: "git@github.com:a-mart/forge.git"
    });

    expect(parseGitHubRepoFromRemoteUrl("https://github.com/a-mart/forge")).toEqual({
      owner: "a-mart",
      repo: "forge",
      remoteUrl: "https://github.com/a-mart/forge"
    });
  });

  it("returns null for non-GitHub remotes", () => {
    expect(parseGitHubRepoFromRemoteUrl("git@gitlab.com:group/project.git")).toBeNull();
  });
});

describe("GitHostedProviderService", () => {
  it("reports missing gh binary as unavailable", async () => {
    const service = new GitHostedProviderService({ ghBinary: "/definitely/missing/gh" });
    const context = createContext({
      cwd: "/tmp/repo",
      remoteSetup: false
    });

    const status = await service.getProviderStatus(context);
    expect(status.provider).toBe("none");
    expect(status.available).toBe(false);
    expect(status.message).toContain("not initialized");
  });

  it("lists open and recently closed pull requests via fake gh", async () => {
    const { fakeGhPath, repoDir } = await createFakeGhFixture({
      branch: "feature/git-source-control-workspace",
      auth: "ok",
      openJson: JSON.stringify([
        {
          number: 428,
          title: "Enhanced Source Control workspace",
          state: "OPEN",
          author: { login: "adam" },
          createdAt: "2026-06-10T10:00:00Z",
          updatedAt: "2026-06-12T09:00:00Z",
          headRefName: "feature/git-source-control-workspace",
          baseRefName: "main",
          isDraft: false,
          url: "https://github.com/a-mart/forge/pull/428",
          statusCheckRollup: { state: "SUCCESS" },
          reviewDecision: "APPROVED"
        }
      ]),
      closedJson: JSON.stringify([
        {
          number: 417,
          title: "Archive recency cleanup",
          state: "MERGED",
          author: { login: "backend-specialist" },
          createdAt: "2026-06-01T10:00:00Z",
          updatedAt: "2026-06-02T10:00:00Z",
          mergedAt: "2026-06-02T10:00:00Z",
          headRefName: "fix/archive-recency",
          baseRefName: "main",
          isDraft: false,
          url: "https://github.com/a-mart/forge/pull/417",
          statusCheckRollup: { state: "SUCCESS" }
        }
      ])
    });

    const service = new GitHostedProviderService({ ghBinary: fakeGhPath });
    const context = createContext({ cwd: repoDir, remoteSetup: true });
    const result = await service.listPullRequests(context, { closedLimit: 5 });

    expect(result.providerStatus.provider).toBe("github");
    expect(result.providerStatus.available).toBe(true);
    expect(result.providerStatus.authenticated).toBe(true);
    expect(result.open).toHaveLength(1);
    expect(result.open[0]?.number).toBe(428);
    expect(result.open[0]?.isCurrentBranch).toBe(true);
    expect(result.open[0]?.checkStatus).toBe("success");
    expect(result.recentlyClosed).toHaveLength(1);
    expect(result.recentlyClosed[0]?.state).toBe("merged");
    expect(result.currentBranchPullRequest?.number).toBe(428);
  });

  it("degrades when gh auth fails", async () => {
    const { fakeGhPath, repoDir } = await createFakeGhFixture({
      branch: "main",
      auth: "fail",
      openJson: "[]",
      closedJson: "[]"
    });

    const service = new GitHostedProviderService({ ghBinary: fakeGhPath });
    const context = createContext({ cwd: repoDir, remoteSetup: true });
    const status = await service.getProviderStatus(context);

    expect(status.provider).toBe("github");
    expect(status.available).toBe(true);
    expect(status.authenticated).toBe(false);
    expect(status.message).toContain("gh auth login");
  });

  it("returns pull request detail via fake gh", async () => {
    const { fakeGhPath, repoDir } = await createFakeGhFixture({
      branch: "main",
      auth: "ok",
      openJson: "[]",
      closedJson: "[]",
      detailJson: JSON.stringify({
        number: 428,
        title: "Enhanced Source Control workspace",
        state: "OPEN",
        author: { login: "adam" },
        createdAt: "2026-06-10T10:00:00Z",
        updatedAt: "2026-06-12T09:00:00Z",
        headRefName: "feature/git-source-control-workspace",
        baseRefName: "main",
        isDraft: false,
        url: "https://github.com/a-mart/forge/pull/428",
        body: "Read-only PR detail body",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED",
        statusCheckRollup: [{ state: "SUCCESS", status: "UI typecheck" }],
        changedFiles: 7,
        additions: 184,
        deletions: 39,
        headRefOid: "abc123def456"
      })
    });

    const service = new GitHostedProviderService({ ghBinary: fakeGhPath });
    const context = createContext({ cwd: repoDir, remoteSetup: true });
    const detail = await service.getPullRequestDetail(context, 428);

    expect(detail?.number).toBe(428);
    expect(detail?.body).toContain("Read-only PR detail");
    expect(detail?.mergeable).toBe(true);
    expect(detail?.changedFiles).toBe(7);
    expect(detail?.checks).toHaveLength(1);
  });

  it("aggregates check status by severity and uses conclusions for completed runs", () => {
    expect(
      aggregateCheckStatusFromRollup([
        { name: "UI typecheck", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "Backend tests", status: "COMPLETED", conclusion: "FAILURE" }
      ])
    ).toBe("failure");

    expect(
      aggregateCheckStatusFromRollup([
        { name: "UI typecheck", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "Backend tests", status: "COMPLETED", conclusion: "SUCCESS" }
      ])
    ).toBe("success");

    const summaries = parseCheckSummariesFromRollup([
      {
        name: "Backend tests",
        status: "COMPLETED",
        conclusion: "FAILURE",
        detailsUrl: "https://github.com/a-mart/forge/actions/runs/1"
      },
      {
        name: "UI typecheck",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        detailsUrl: "https://github.com/a-mart/forge/actions/runs/2"
      }
    ]);

    expect(summaries).toHaveLength(2);
    expect(summaries[0]?.name).toBe("Backend tests");
    expect(summaries[0]?.status).toBe("failure");
    expect(summaries[0]?.url).toContain("/actions/runs/1");
  });

  it("does not mark fork pull requests as current branch when branch names match", async () => {
    const { fakeGhPath, repoDir } = await createFakeGhFixture({
      branch: "feature/shared-name",
      auth: "ok",
      openJson: JSON.stringify([
        {
          number: 501,
          title: "Same branch from fork",
          state: "OPEN",
          author: { login: "fork-user" },
          createdAt: "2026-06-10T10:00:00Z",
          updatedAt: "2026-06-12T09:00:00Z",
          headRefName: "feature/shared-name",
          baseRefName: "main",
          isDraft: false,
          isCrossRepository: true,
          headRepositoryOwner: { login: "fork-user" },
          headRepository: { name: "forge-fork", owner: { login: "fork-user" } },
          url: "https://github.com/a-mart/forge/pull/501"
        },
        {
          number: 502,
          title: "Same branch from origin",
          state: "OPEN",
          author: { login: "adam" },
          createdAt: "2026-06-10T10:00:00Z",
          updatedAt: "2026-06-12T09:00:00Z",
          headRefName: "feature/shared-name",
          baseRefName: "main",
          isDraft: false,
          isCrossRepository: false,
          headRepositoryOwner: { login: "a-mart" },
          headRepository: { name: "forge", owner: { login: "a-mart" } },
          url: "https://github.com/a-mart/forge/pull/502"
        }
      ]),
      closedJson: "[]"
    });

    const service = new GitHostedProviderService({ ghBinary: fakeGhPath });
    const context = createContext({ cwd: repoDir, remoteSetup: true });
    const result = await service.listPullRequests(context);

    const forkPullRequest = result.open.find((entry) => entry.number === 501);
    const originPullRequest = result.open.find((entry) => entry.number === 502);
    expect(forkPullRequest?.isCurrentBranch).toBe(false);
    expect(originPullRequest?.isCurrentBranch).toBe(true);
    expect(result.currentBranchPullRequest?.number).toBe(502);
  });

  it("matches current branch for cross-repo PRs when head repo matches origin", () => {
    const origin = parseGitHubRepoFromRemoteUrl("git@github.com:a-mart/forge.git");
    expect(origin).not.toBeNull();

    expect(
      matchesCurrentBranchPullRequest(
        {
          headRefName: "feature/shared-name",
          isCrossRepository: true,
          headRepositoryOwner: { login: "a-mart" },
          headRepository: { name: "forge", owner: { login: "a-mart" } }
        },
        "feature/shared-name",
        origin
      )
    ).toBe(true);

    expect(
      matchesCurrentBranchPullRequest(
        {
          headRefName: "feature/shared-name",
          isCrossRepository: true,
          headRepositoryOwner: { login: "fork-user" },
          headRepository: { name: "forge-fork", owner: { login: "fork-user" } }
        },
        "feature/shared-name",
        origin
      )
    ).toBe(false);
  });

  it("classifies timed out gh executions as timeout errors", () => {
    const error = classifyGhFailure({
      stdout: "",
      stderr: "gh command timed out.",
      exitCode: 1,
      timedOut: true
    });

    expect(error.httpStatus).toBe(504);
    expect(error.code).toBe("timeout");
  });
});

function createContext(options: {
  cwd: string;
  remoteSetup: boolean;
}): GitSourceControlContext {
  return {
    cwd: options.cwd,
    baseCwd: options.cwd,
    repoTarget: "workspace",
    repoKind: "workspace",
    repoLabel: "Workspace",
    notInitialized: !options.remoteSetup
  };
}

async function createFakeGhFixture(options: {
  branch: string;
  auth: "ok" | "fail";
  openJson: string;
  closedJson: string;
  detailJson?: string;
}): Promise<{ fakeGhPath: string; repoDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "git-hosted-provider-"));
  const repoDir = join(root, "repo");
  const fakeGhPath = join(root, "fake-gh");

  await writeFile(
    fakeGhPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const command = args.join(" ");

if (command === "--version") {
  process.stdout.write("gh version 2.67.0\\n");
  process.exit(0);
}

if (command.startsWith("auth status")) {
  if (${JSON.stringify(options.auth)} === "fail") {
    process.stderr.write("You are not logged into any GitHub hosts\\n");
    process.exit(1);
  }
  process.stdout.write("github.com\\n  ✓ Logged in\\n");
  process.exit(0);
}

if (command.includes("pr list") && command.includes("--state open")) {
  process.stdout.write(${JSON.stringify(options.openJson)});
  process.exit(0);
}

if (command.includes("pr list") && command.includes("--state closed")) {
  process.stdout.write(${JSON.stringify(options.closedJson)});
  process.exit(0);
}

if (command.startsWith("pr view")) {
  process.stdout.write(${JSON.stringify(options.detailJson ?? "{}")});
  process.exit(0);
}

process.stderr.write("unexpected gh args: " + command + "\\n");
process.exit(1);
`,
    "utf8"
  );
  await chmod(fakeGhPath, 0o755);

  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const { mkdir, writeFile: writeRepoFile } = await import("node:fs/promises");

  await mkdir(repoDir, { recursive: true });
  await execFileAsync("git", ["init", "-b", options.branch], { cwd: repoDir });
  await writeRepoFile(join(repoDir, "README.md"), "# test\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });
  await execFileAsync("git", ["remote", "add", "origin", "git@github.com:a-mart/forge.git"], {
    cwd: repoDir
  });

  return { fakeGhPath, repoDir };
}
