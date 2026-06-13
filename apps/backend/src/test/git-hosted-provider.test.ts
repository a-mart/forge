import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GitHostedProviderService,
  aggregateCheckStatusFromRollup,
  classifyGhFailure,
  buildMergeGhArgs,
  buildMergeResultFromGhSuccess,
  classifyMergeGhFailure,
  evaluateMergePreflight,
  matchesCurrentBranchPullRequest,
  parseAllowedMergeMethods,
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

  it("surfaces PR list rate-limit failures as listError instead of a false empty state", async () => {
    const { fakeGhPath, repoDir } = await createFakeGhFixture({
      branch: "main",
      auth: "ok",
      openJson: "[]",
      closedJson: "[]",
      openListFailure: "rate_limit"
    });

    const service = new GitHostedProviderService({ ghBinary: fakeGhPath });
    const context = createContext({ cwd: repoDir, remoteSetup: true });
    const result = await service.listPullRequests(context);

    expect(result.listError?.code).toBe("rate_limit");
    expect(result.open).toEqual([]);
    expect(result.recentlyClosed).toEqual([]);
    expect(result.providerStatus.authenticated).toBe(true);
    expect(result.providerStatus.available).toBe(true);
  });

  it("surfaces PR list timeout and network failures as listError", async () => {
    const timeoutFixture = await createFakeGhFixture({
      branch: "main",
      auth: "ok",
      openJson: "[]",
      closedJson: "[]",
      openListFailure: "timeout"
    });

    const timeoutService = new GitHostedProviderService({ ghBinary: timeoutFixture.fakeGhPath });
    const timeoutContext = createContext({ cwd: timeoutFixture.repoDir, remoteSetup: true });
    const timeoutResult = await timeoutService.listPullRequests(timeoutContext);

    expect(timeoutResult.listError?.code).toBe("timeout");
    expect(timeoutResult.providerStatus.authenticated).toBe(true);

    const networkFixture = await createFakeGhFixture({
      branch: "main",
      auth: "ok",
      openJson: "[]",
      closedJson: "[]",
      openListFailure: "network"
    });

    const networkService = new GitHostedProviderService({ ghBinary: networkFixture.fakeGhPath });
    const networkContext = createContext({ cwd: networkFixture.repoDir, remoteSetup: true });
    const networkResult = await networkService.listPullRequests(networkContext);

    expect(networkResult.listError?.code).toBe("network");
    expect(networkResult.providerStatus.authenticated).toBe(true);
  });

  it("merges pull requests with method and match-head-commit via fake gh", async () => {
    const { fakeGhPath, repoDir, readMergeCalls } = await createFakeGhFixture({
      branch: "main",
      auth: "ok",
      openJson: "[]",
      closedJson: "[]",
      mergeBehavior: "success"
    });

    const service = new GitHostedProviderService({ ghBinary: fakeGhPath });
    const context = createContext({ cwd: repoDir, remoteSetup: true });
    const result = await service.mergePullRequest(context, 428, {
      method: "squash",
      expectedHeadSha: "abc123def456"
    });

    expect(result.success).toBe(true);
    expect(result.method).toBe("squash");
    expect(result.state).toBe("merged");
    const mergeCalls = await readMergeCalls();
    expect(mergeCalls).toHaveLength(1);
    expect(mergeCalls[0]).toContain("--squash");
    expect(mergeCalls[0]).toContain("--match-head-commit");
    expect(mergeCalls[0]).toContain("abc123def456");
    expect(mergeCalls[0]).not.toContain("--delete-branch");
    expect(mergeCalls[0]).not.toContain("--admin");
  });

  it("reports submitted state when gh succeeds but refreshed detail remains open", async () => {
    const { fakeGhPath, repoDir } = await createFakeGhFixture({
      branch: "main",
      auth: "ok",
      openJson: "[]",
      closedJson: "[]",
      mergeBehavior: "submitted"
    });

    const service = new GitHostedProviderService({ ghBinary: fakeGhPath });
    const context = createContext({ cwd: repoDir, remoteSetup: true });
    const result = await service.mergePullRequest(context, 428, {
      method: "squash",
      expectedHeadSha: "abc123def456"
    });

    expect(result.success).toBe(false);
    expect(result.submitted).toBe(true);
    expect(result.state).toBe("open");
    expect(result.mergedAt).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("still open");
  });

  it("returns stale head error when gh merge rejects modified head", async () => {
    const { fakeGhPath, repoDir } = await createFakeGhFixture({
      branch: "main",
      auth: "ok",
      openJson: "[]",
      closedJson: "[]",
      mergeBehavior: "stale_head"
    });

    const service = new GitHostedProviderService({ ghBinary: fakeGhPath });
    const context = createContext({ cwd: repoDir, remoteSetup: true });
    const result = await service.mergePullRequest(context, 428, {
      method: "merge",
      expectedHeadSha: "abc123def456"
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("stale_head");
  });

  it("blocks merge when checks are failing unless explicitly acknowledged", async () => {
    const detail = {
      number: 428,
      title: "PR",
      state: "open" as const,
      author: "adam",
      createdAt: "2026-06-10T10:00:00Z",
      updatedAt: "2026-06-12T09:00:00Z",
      headRef: "feature/x",
      baseRef: "main",
      isDraft: false,
      isCurrentBranch: false,
      checkStatus: "failure" as const,
      body: "",
      mergeable: true,
      checks: [],
      changedFiles: 1,
      additions: 1,
      deletions: 0,
      headSha: "abc123",
      allowedMergeMethods: ["squash", "merge", "rebase"] as const
    };

    const blocked = evaluateMergePreflight(detail, "squash", {
      expectedHeadSha: "abc123",
      acknowledgeCheckFailures: false
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.errorCode).toBe("checks_blocked");

    const allowed = evaluateMergePreflight(detail, "squash", {
      expectedHeadSha: "abc123",
      acknowledgeCheckFailures: true
    });
    expect(allowed.allowed).toBe(true);
  });

  it("builds merge gh args without delete-branch or admin flags", () => {
    const args = buildMergeGhArgs(
      { owner: "a-mart", repo: "forge", remoteUrl: "git@github.com:a-mart/forge.git" },
      428,
      "squash",
      "abc123def456"
    );

    expect(args).toEqual([
      "pr",
      "merge",
      "428",
      "--repo",
      "a-mart/forge",
      "--squash",
      "--match-head-commit",
      "abc123def456"
    ]);
    expect(args.some((arg) => arg.includes("delete-branch") || arg === "--admin")).toBe(false);
  });

  it("does not synthesize mergedAt when refreshed detail is still open", () => {
    const detail = {
      number: 428,
      title: "PR",
      state: "open" as const,
      author: "adam",
      createdAt: "2026-06-10T10:00:00Z",
      updatedAt: "2026-06-12T09:00:00Z",
      headRef: "feature/x",
      baseRef: "main",
      isDraft: false,
      isCurrentBranch: false,
      body: "",
      mergeable: true,
      checks: [],
      changedFiles: 1,
      additions: 1,
      deletions: 0,
      headSha: "abc123",
      providerUrl: "https://github.com/a-mart/forge/pull/428"
    };

    const result = buildMergeResultFromGhSuccess({
      number: 428,
      method: "squash",
      preflightWarnings: [],
      fallbackDetail: detail,
      refreshedDetail: detail
    });

    expect(result.success).toBe(false);
    expect(result.submitted).toBe(true);
    expect(result.mergedAt).toBeUndefined();
  });

  it("maps gh merge stale head failures", () => {
    const failure = classifyMergeGhFailure({
      stdout: "",
      stderr: "Head branch was modified. Review and try again.",
      exitCode: 1
    });

    expect(failure.code).toBe("stale_head");
  });

  it("parses allowed merge methods from repo view json", () => {
    expect(
      parseAllowedMergeMethods(
        JSON.stringify({
          mergeCommitAllowed: false,
          squashMergeAllowed: true,
          rebaseMergeAllowed: true
        })
      )
    ).toEqual(["squash", "rebase"]);
  });

  it("degrades merge when gh auth fails", async () => {
    const { fakeGhPath, repoDir } = await createFakeGhFixture({
      branch: "main",
      auth: "fail",
      openJson: "[]",
      closedJson: "[]"
    });

    const service = new GitHostedProviderService({ ghBinary: fakeGhPath });
    const context = createContext({ cwd: repoDir, remoteSetup: true });
    const result = await service.mergePullRequest(context, 428, {
      method: "squash",
      expectedHeadSha: "abc123def456"
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("provider_unavailable");
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
  openListFailure?: "rate_limit" | "timeout" | "network" | "permission";
  mergeBehavior?: "success" | "stale_head" | "submitted";
  mergeFailure?: "auth" | "permission";
  repoMergeSettings?: {
    mergeCommitAllowed: boolean;
    squashMergeAllowed: boolean;
    rebaseMergeAllowed: boolean;
  };
}): Promise<{ fakeGhPath: string; repoDir: string; readMergeCalls: () => Promise<string[]> }> {
  const root = await mkdtemp(join(tmpdir(), "git-hosted-provider-"));
  const repoDir = join(root, "repo");
  const fakeGhPath = join(root, "fake-gh");
  const mergeLogPath = join(root, "merge-calls.log");
  const viewCountPath = join(root, "view-count.log");
  const defaultDetailJson = JSON.stringify({
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
    statusCheckRollup: [{ state: "SUCCESS", status: "COMPLETED", conclusion: "SUCCESS" }],
    changedFiles: 7,
    additions: 184,
    deletions: 39,
    headRefOid: "abc123def456"
  });
  const mergedDetailJson = JSON.stringify({
    number: 428,
    title: "Enhanced Source Control workspace",
    state: "MERGED",
    author: { login: "adam" },
    createdAt: "2026-06-10T10:00:00Z",
    updatedAt: "2026-06-12T10:00:00Z",
    mergedAt: "2026-06-12T10:00:00Z",
    headRefName: "feature/git-source-control-workspace",
    baseRefName: "main",
    isDraft: false,
    url: "https://github.com/a-mart/forge/pull/428",
    body: "Read-only PR detail body",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    statusCheckRollup: [{ state: "SUCCESS", status: "COMPLETED", conclusion: "SUCCESS" }],
    changedFiles: 7,
    additions: 184,
    deletions: 39,
    headRefOid: "abc123def456"
  });

  const repoMergeSettingsJson = JSON.stringify(
    options.repoMergeSettings ?? {
      mergeCommitAllowed: true,
      squashMergeAllowed: true,
      rebaseMergeAllowed: true
    }
  );

  await writeFile(
    fakeGhPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
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

if (command.startsWith("repo view")) {
  process.stdout.write(${JSON.stringify(repoMergeSettingsJson)});
  process.exit(0);
}

if (command.includes("pr list") && command.includes("--state open")) {
  const openListFailure = ${JSON.stringify(options.openListFailure ?? null)};
  if (openListFailure === "rate_limit") {
    process.stderr.write("API rate limit exceeded for user\\n");
    process.exit(1);
  }
  if (openListFailure === "timeout") {
    process.stderr.write("gh command timed out.\\n");
    process.exit(1);
  }
  if (openListFailure === "network") {
    process.stderr.write("error connecting to api.github.com: network unavailable\\n");
    process.exit(1);
  }
  if (openListFailure === "permission") {
    process.stderr.write("HTTP 403: Resource not accessible by integration\\n");
    process.exit(1);
  }
  process.stdout.write(${JSON.stringify(options.openJson)});
  process.exit(0);
}

if (command.includes("pr list") && command.includes("--state closed")) {
  process.stdout.write(${JSON.stringify(options.closedJson)});
  process.exit(0);
}

if (command.startsWith("pr view")) {
  let viewCount = 0;
  try {
    viewCount = Number(fs.readFileSync(${JSON.stringify(viewCountPath)}, "utf8"));
  } catch {}
  viewCount += 1;
  fs.writeFileSync(${JSON.stringify(viewCountPath)}, String(viewCount));
  const mergedViews = ${JSON.stringify(options.mergeBehavior === "success")};
  if (mergedViews && viewCount > 1) {
    process.stdout.write(${JSON.stringify(mergedDetailJson)});
    process.exit(0);
  }
  process.stdout.write(${JSON.stringify(options.detailJson ?? defaultDetailJson)});
  process.exit(0);
}

if (command.startsWith("pr merge")) {
  fs.appendFileSync(${JSON.stringify(mergeLogPath)}, command + "\\n");
  const mergeBehavior = ${JSON.stringify(options.mergeBehavior ?? null)};
  const mergeFailure = ${JSON.stringify(options.mergeFailure ?? null)};
  if (mergeFailure === "auth") {
    process.stderr.write("HTTP 401: Bad credentials\\n");
    process.exit(1);
  }
  if (mergeFailure === "permission") {
    process.stderr.write("HTTP 403: Resource not accessible by integration\\n");
    process.exit(1);
  }
  if (mergeBehavior === "stale_head") {
    process.stderr.write("Head branch was modified. Review and try again.\\n");
    process.exit(1);
  }
  process.stdout.write("Merged pull request a-mart/forge#428\\n");
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
  const { mkdir, readFile, writeFile: writeRepoFile } = await import("node:fs/promises");

  await mkdir(repoDir, { recursive: true });
  await execFileAsync("git", ["init", "-b", options.branch], { cwd: repoDir });
  await writeRepoFile(join(repoDir, "README.md"), "# test\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });
  await execFileAsync("git", ["remote", "add", "origin", "git@github.com:a-mart/forge.git"], {
    cwd: repoDir
  });

  return {
    fakeGhPath,
    repoDir,
    readMergeCalls: async () => {
      try {
        const contents = await readFile(mergeLogPath, "utf8");
        return contents
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
      } catch {
        return [];
      }
    }
  };
}
