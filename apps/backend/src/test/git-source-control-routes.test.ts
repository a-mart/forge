import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  AgentDescriptor,
  GitBranchListResult,
  GitFetchResult,
  GitMutationResult,
  GitHostedProviderStatus,
  GitPullRequestDetail,
  GitPullRequestListResult,
  GitPullRequestMergeResult,
  GitPullResult,
  GitWorktreeListResult
} from "@forge/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import {
  createWorktreeId,
  resolveStableWorktreePathKey
} from "../versioning/git-source-control-helpers.js";
import { createGitSourceControlRoutes } from "../ws/routes/git-source-control-routes.js";

const execFileAsync = promisify(execFile);

interface TestServer {
  readonly baseUrl: string;
  readonly root: string;
  readonly mainDir: string;
  readonly secondaryDir: string;
  readonly close: () => Promise<void>;
}

const activeServers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
});

describe("git-source-control-routes", () => {
  it("lists repository worktrees with dirty state and active agents", async () => {
    const server = await createSourceControlTestServer({
      descriptors: [
        createManagerSession("alpha", "alpha--s1"),
        createWorker("alpha-worker", "alpha--s1")
      ]
    });

    await writeFile(join(server.mainDir, "main.txt"), "main v2\n", "utf8");
    await writeFile(join(server.secondaryDir, "feature.txt"), "feature change\n", "utf8");

    const response = await fetch(`${server.baseUrl}/api/git/worktrees?agentId=alpha--s1`);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as GitWorktreeListResult;
    expect(payload.repoKind).toBe("workspace");
    expect(payload.worktrees).toHaveLength(2);

    const mainWorktree = payload.worktrees.find((entry) => entry.isMainWorktree);
    const linkedWorktree = payload.worktrees.find((entry) => !entry.isMainWorktree);
    expect(mainWorktree?.dirty).toBe(true);
    expect(mainWorktree?.isCurrentContext).toBe(true);
    expect(linkedWorktree?.branch).toBe("feature/worktree-test");
    expect(linkedWorktree?.dirty).toBe(true);
    expect(linkedWorktree?.activeAgents.map((agent) => agent.agentId)).toContain("alpha-worker");
  });

  it("keeps the main worktree stable when the requester cwd is a linked worktree", async () => {
    const server = await createSourceControlTestServer({
      descriptors: [createManagerSession("alpha", "alpha--s1")],
      managerCwd: "linked"
    });

    const response = await fetch(`${server.baseUrl}/api/git/worktrees?agentId=alpha--s1`);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as GitWorktreeListResult;
    const mainWorktrees = payload.worktrees.filter((entry) => entry.isMainWorktree);
    expect(mainWorktrees).toHaveLength(1);
    expect(mainWorktrees[0]?.path).toBe(server.mainDir);
    expect(payload.repoRoot).toBe(server.mainDir);

    const linkedWorktree = payload.worktrees.find((entry) => entry.path === server.secondaryDir);
    expect(linkedWorktree?.isMainWorktree).toBe(false);
    expect(linkedWorktree?.isCurrentContext).toBe(true);
  });

  it("attaches agents whose cwd is inside a worktree root", async () => {
    const server = await createSourceControlTestServer({
      descriptors: [createManagerSession("alpha", "alpha--s1"), createWorker("alpha-worker", "alpha--s1")],
      workerCwdRelative: "apps/backend"
    });

    const response = await fetch(`${server.baseUrl}/api/git/worktrees?agentId=alpha--s1`);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as GitWorktreeListResult;
    const linkedWorktree = payload.worktrees.find((entry) => entry.path === server.secondaryDir);
    expect(linkedWorktree?.activeAgents.map((agent) => agent.agentId)).toContain("alpha-worker");
  });

  it("returns prunable worktrees after the linked directory is deleted without 500", async () => {
    const server = await createSourceControlTestServer({
      descriptors: [createManagerSession("alpha", "alpha--s1")]
    });

    await rm(server.secondaryDir, { recursive: true, force: true });

    const response = await fetch(`${server.baseUrl}/api/git/worktrees?agentId=alpha--s1`);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as GitWorktreeListResult;
    expect(payload.worktrees).toHaveLength(2);

    const prunableWorktree = payload.worktrees.find((entry) => entry.prunable);
    expect(prunableWorktree).toBeDefined();
    expect(prunableWorktree?.dirty).toBe(false);
    expect(prunableWorktree?.dirtySummary).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
    expect(prunableWorktree?.activeAgents).toEqual([]);
    expect(prunableWorktree?.id).toBe(
      createWorktreeId(resolveStableWorktreePathKey(server.secondaryDir))
    );
  });

  it("rejects unknown worktreeId values fail-closed", async () => {
    const server = await createSourceControlTestServer({
      descriptors: [createManagerSession("alpha", "alpha--s1")]
    });

    const response = await fetch(
      `${server.baseUrl}/api/git/worktrees?agentId=alpha--s1&worktreeId=deadbeefdeadbeef`
    );
    expect(response.status).toBe(400);

    const payload = (await response.json()) as { error: string };
    expect(payload.error).toContain("Unknown or invalid worktreeId");
  });

  it("rejects prunable worktreeId values fail-closed", async () => {
    const server = await createSourceControlTestServer({
      descriptors: [createManagerSession("alpha", "alpha--s1")]
    });

    await rm(server.secondaryDir, { recursive: true, force: true });
    const prunableId = createWorktreeId(resolveStableWorktreePathKey(server.secondaryDir));

    const response = await fetch(
      `${server.baseUrl}/api/git/worktrees?agentId=alpha--s1&worktreeId=${prunableId}`
    );
    expect(response.status).toBe(400);

    const payload = (await response.json()) as { error: string };
    expect(payload.error).toContain("Unknown or invalid worktreeId");
  });

  it("accepts a valid worktreeId and marks that worktree as current context", async () => {
    const server = await createSourceControlTestServer({
      descriptors: [createManagerSession("alpha", "alpha--s1")]
    });

    const secondaryId = createWorktreeId(server.secondaryDir);
    const response = await fetch(
      `${server.baseUrl}/api/git/worktrees?agentId=alpha--s1&worktreeId=${secondaryId}`
    );
    expect(response.status).toBe(200);

    const payload = (await response.json()) as GitWorktreeListResult;
    const linkedWorktree = payload.worktrees.find((entry) => entry.id === secondaryId);
    expect(linkedWorktree?.isCurrentContext).toBe(true);
    expect(payload.context.worktreeId).toBe(secondaryId);
  });

  it("lists branches with current head and status hash", async () => {
    const server = await createSourceControlTestServer({
      descriptors: [createManagerSession("alpha", "alpha--s1")]
    });

    const response = await fetch(`${server.baseUrl}/api/git/branches?agentId=alpha--s1`);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as GitBranchListResult;
    expect(payload.currentBranch).toBe("main");
    expect(payload.currentHead).toMatch(/^[a-f0-9]{40}$/);
    expect(payload.statusHash).toHaveLength(16);
    expect(payload.branches.some((branch) => branch.kind === "current" && branch.name === "main")).toBe(
      true
    );
    expect(payload.branches.some((branch) => branch.name === "feature/worktree-test")).toBe(true);
  });

  it("switches branches on a clean worktree", async () => {
    const server = await createSourceControlTestServer({
      descriptors: [createManagerSession("alpha", "alpha--s1")]
    });

    await execGit(server.mainDir, ["branch", "release/test"]);

    const branches = await fetchBranches(server, "alpha--s1");
    const mutation = await postMutation<GitMutationResult>(server, "/api/git/switch-branch", {
      agentId: "alpha--s1",
      branch: "release/test",
      expectedHead: branches.currentHead!,
      expectedStatusHash: branches.statusHash!
    });

    expect(mutation.status).toBe(200);
    expect(mutation.payload.success).toBe(true);
    expect(mutation.payload.currentBranch).toBe("release/test");
  });

  it("rejects branch switch when the worktree is dirty", async () => {
    const server = await createSourceControlTestServer({
      descriptors: [createManagerSession("alpha", "alpha--s1")]
    });

    await writeFile(join(server.mainDir, "dirty.txt"), "dirty\n", "utf8");
    const branches = await fetchBranches(server, "alpha--s1");

    const mutation = await postMutation<GitMutationResult>(server, "/api/git/switch-branch", {
      agentId: "alpha--s1",
      branch: "feature/worktree-test",
      expectedHead: branches.currentHead!,
      expectedStatusHash: branches.statusHash!
    });

    expect(mutation.status).toBe(409);
    expect(mutation.payload.success).toBe(false);
    expect(mutation.payload.errors.join(" ")).toContain("uncommitted changes");
  });

  it("rejects switching to a branch checked out in another worktree", async () => {
    const server = await createSourceControlTestServer({
      descriptors: [createManagerSession("alpha", "alpha--s1")]
    });

    const branches = await fetchBranches(server, "alpha--s1");
    const mutation = await postMutation<GitMutationResult>(server, "/api/git/switch-branch", {
      agentId: "alpha--s1",
      branch: "feature/worktree-test",
      expectedHead: branches.currentHead!,
      expectedStatusHash: branches.statusHash!
    });

    expect(mutation.status).toBe(409);
    expect(mutation.payload.success).toBe(false);
    expect(mutation.payload.errors.join(" ")).toContain("already checked out");
  });

  it("rejects branch switch when a streaming agent is attached to the worktree", async () => {
    const server = await createSourceControlTestServer({
      descriptors: [
        createManagerSession("alpha", "alpha--s1"),
        createWorker("alpha-worker", "alpha--s1", { status: "streaming" })
      ],
      managerCwd: "linked"
    });

    await execGit(server.mainDir, ["branch", "release/test"]);
    const branches = await fetchBranches(server, "alpha--s1", {
      worktreeId: createWorktreeId(server.secondaryDir)
    });

    const mutation = await postMutation<GitMutationResult>(server, "/api/git/switch-branch", {
      agentId: "alpha--s1",
      branch: "release/test",
      worktreeId: createWorktreeId(server.secondaryDir),
      expectedHead: branches.currentHead!,
      expectedStatusHash: branches.statusHash!
    });

    expect(mutation.status).toBe(409);
    expect(mutation.payload.success).toBe(false);
    expect(mutation.payload.errors.join(" ")).toContain("Stop active agents");
  });

  it("rejects stale preflight when expected head no longer matches", async () => {
    const server = await createSourceControlTestServer({
      descriptors: [createManagerSession("alpha", "alpha--s1")]
    });

    const branches = await fetchBranches(server, "alpha--s1");
    const mutation = await postMutation<GitMutationResult>(server, "/api/git/switch-branch", {
      agentId: "alpha--s1",
      branch: "feature/worktree-test",
      expectedHead: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      expectedStatusHash: branches.statusHash!
    });

    expect(mutation.status).toBe(409);
    expect(mutation.payload.success).toBe(false);
    expect(mutation.payload.errors.join(" ")).toContain("HEAD changed");
  });

  it("creates a branch from the current head on a clean worktree", async () => {
    const server = await createSourceControlTestServer({
      descriptors: [createManagerSession("alpha", "alpha--s1")]
    });

    const branches = await fetchBranches(server, "alpha--s1");
    const mutation = await postMutation<GitMutationResult>(server, "/api/git/create-branch", {
      agentId: "alpha--s1",
      branch: "feature/new-branch",
      expectedHead: branches.currentHead!,
      expectedStatusHash: branches.statusHash!
    });

    expect(mutation.status).toBe(200);
    expect(mutation.payload.success).toBe(true);
    expect(mutation.payload.currentBranch).toBe("feature/new-branch");
  });

  it("fetches from a local bare remote", async () => {
    const server = await createRemoteBackedTestServer();

    const branches = await fetchBranches(server, "alpha--s1");
    const mutation = await postMutation<GitFetchResult>(server, "/api/git/fetch", {
      agentId: "alpha--s1",
      remote: "origin",
      expectedHead: branches.currentHead!,
      expectedStatusHash: branches.statusHash!
    });

    expect(mutation.status).toBe(200);
    expect(mutation.payload.success).toBe(true);
    expect(mutation.payload.remote).toBe("origin");
  });

  it("fast-forward pulls from a local bare remote", async () => {
    const server = await createRemoteBackedTestServer({ aheadOnRemote: true });

    const branches = await fetchBranches(server, "alpha--s1");
    const mutation = await postMutation<GitPullResult>(server, "/api/git/pull-ff-only", {
      agentId: "alpha--s1",
      remote: "origin",
      expectedHead: branches.currentHead!,
      expectedStatusHash: branches.statusHash!
    });

    expect(mutation.status).toBe(200);
    expect(mutation.payload.success).toBe(true);
    expect(mutation.payload.fastForward).toBe(true);
  });

  it("rejects fast-forward pull when the branch has diverged", async () => {
    const server = await createRemoteBackedTestServer({ diverged: true });

    const branches = await fetchBranches(server, "alpha--s1");
    const mutation = await postMutation<GitPullResult>(server, "/api/git/pull-ff-only", {
      agentId: "alpha--s1",
      remote: "origin",
      expectedHead: branches.currentHead!,
      expectedStatusHash: branches.statusHash!
    });

    expect(mutation.status).toBe(409);
    expect(mutation.payload.success).toBe(false);
    expect(mutation.payload.fastForward).toBe(false);
  });

  it("rejects option-like remote names for fetch", async () => {
    const server = await createRemoteBackedTestServer();

    const branches = await fetchBranches(server, "alpha--s1");
    const mutation = await postMutation<GitFetchResult>(server, "/api/git/fetch", {
      agentId: "alpha--s1",
      remote: "--all",
      expectedHead: branches.currentHead!,
      expectedStatusHash: branches.statusHash!
    });

    expect(mutation.status).toBe(400);
    expect((mutation.payload as { error?: string }).error ?? mutation.payload.errors?.join(" ")).toContain(
      "Invalid remote"
    );
  });

  it("rejects option-like startPoint values for create-branch", async () => {
    const server = await createSourceControlTestServer({
      descriptors: [createManagerSession("alpha", "alpha--s1")]
    });

    const branches = await fetchBranches(server, "alpha--s1");
    const mutation = await postMutation<GitMutationResult>(server, "/api/git/create-branch", {
      agentId: "alpha--s1",
      branch: "feature/safe-branch",
      startPoint: "--discard-changes",
      expectedHead: branches.currentHead!,
      expectedStatusHash: branches.statusHash!
    });

    expect(mutation.status).toBe(400);
    expect((mutation.payload as { error?: string }).error ?? "").toContain("Invalid startPoint");
  });

  it("rejects fetch when an AA unmerged conflict is present", async () => {
    const server = await createSourceControlTestServer({
      descriptors: [createManagerSession("alpha", "alpha--s1")]
    });

    await writeFile(join(server.mainDir, "shared.txt"), "base\n", "utf8");
    await execGit(server.mainDir, ["add", "shared.txt"]);
    await execGit(server.mainDir, ["commit", "-m", "add shared"]);
    await execGit(server.mainDir, ["checkout", "-b", "side"]);
    await writeFile(join(server.mainDir, "both.txt"), "side\n", "utf8");
    await execGit(server.mainDir, ["add", "both.txt"]);
    await execGit(server.mainDir, ["commit", "-m", "side adds both"]);
    await execGit(server.mainDir, ["checkout", "main"]);
    await writeFile(join(server.mainDir, "both.txt"), "main\n", "utf8");
    await execGit(server.mainDir, ["add", "both.txt"]);
    await execGit(server.mainDir, ["commit", "-m", "main adds both"]);
    await execGit(server.mainDir, ["merge", "side"], { allowFailure: true });

    const branches = await fetchBranches(server, "alpha--s1");
    const mutation = await postMutation<GitFetchResult>(server, "/api/git/fetch", {
      agentId: "alpha--s1",
      remote: "origin",
      expectedHead: branches.currentHead!,
      expectedStatusHash: branches.statusHash!
    });

    expect(mutation.status).toBe(409);
    expect(mutation.payload.success).toBe(false);
    expect(mutation.payload.errors.join(" ")).toContain("Unresolved merge conflicts");
  });

  it("rejects stale status hash mutations", async () => {
    const server = await createSourceControlTestServer({
      descriptors: [createManagerSession("alpha", "alpha--s1")]
    });

    const branches = await fetchBranches(server, "alpha--s1");
    const mutation = await postMutation<GitMutationResult>(server, "/api/git/switch-branch", {
      agentId: "alpha--s1",
      branch: "feature/worktree-test",
      expectedHead: branches.currentHead!,
      expectedStatusHash: "stale-status-hash"
    });

    expect(mutation.status).toBe(409);
    expect(mutation.payload.errors.join(" ")).toContain("status changed");
  });

  it("rejects unknown remote names for pull", async () => {
    const server = await createRemoteBackedTestServer();

    const branches = await fetchBranches(server, "alpha--s1");
    const mutation = await postMutation<GitPullResult>(server, "/api/git/pull-ff-only", {
      agentId: "alpha--s1",
      remote: "upstream",
      expectedHead: branches.currentHead!,
      expectedStatusHash: branches.statusHash!
    });

    expect(mutation.status).toBe(409);
    expect(mutation.payload.errors.join(" ")).toContain("not found");
  });

  it("rejects versioning repo mutations", async () => {
    const server = await createVersioningMutationTestServer();

    const branches = await fetchBranches(server, "cortex--s1", { repoTarget: "versioning" });
    const mutation = await postMutation<GitFetchResult>(server, "/api/git/fetch", {
      agentId: "cortex--s1",
      repoTarget: "versioning",
      remote: "origin",
      expectedHead: branches.currentHead ?? "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      expectedStatusHash: branches.statusHash ?? "0000000000000000"
    });

    expect(mutation.status).toBe(409);
    expect(mutation.payload.errors.join(" ")).toContain("versioning");
  });

  it("exposes idle-agent warnings from mutation preflight", async () => {
    const server = await createSourceControlTestServer({
      descriptors: [
        createManagerSession("alpha", "alpha--s1"),
        createWorker("alpha-worker", "alpha--s1", { status: "idle" })
      ]
    });

    await execGit(server.mainDir, ["branch", "release/test"]);
    const response = await fetch(
      `${server.baseUrl}/api/git/mutation-preflight?agentId=alpha--s1&action=switch-branch&targetBranch=release/test`
    );
    expect(response.status).toBe(200);

    const payload = (await response.json()) as { issues: Array<{ code: string; severity: string }> };
    expect(payload.issues.some((issue) => issue.code === "idle_agents_attached" && issue.severity === "warn")).toBe(
      true
    );
  });

  it("rejects fast-forward pull on a dirty worktree", async () => {
    const server = await createRemoteBackedTestServer({ aheadOnRemote: true });

    await writeFile(join(server.mainDir, "dirty.txt"), "dirty\n", "utf8");
    const branches = await fetchBranches(server, "alpha--s1");
    const mutation = await postMutation<GitPullResult>(server, "/api/git/pull-ff-only", {
      agentId: "alpha--s1",
      remote: "origin",
      expectedHead: branches.currentHead!,
      expectedStatusHash: branches.statusHash!
    });

    expect(mutation.status).toBe(409);
    expect(mutation.payload.success).toBe(false);
    expect(mutation.payload.errors.join(" ")).toContain("uncommitted changes");
  });

  it("returns degraded provider status when gh is unavailable", async () => {
    const server = await createPullRequestTestServer({
      ghAuth: "ok",
      ghBinary: "/definitely/missing/gh"
    });

    const response = await fetch(`${server.baseUrl}/api/git/provider/status?agentId=alpha--s1`);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as GitHostedProviderStatus;
    expect(payload.provider).toBe("github");
    expect(payload.available).toBe(false);
    expect(payload.authenticated).toBe(false);
  });

  it("returns unauthenticated provider status from fake gh auth failure", async () => {
    const server = await createPullRequestTestServer({ ghAuth: "fail" });

    const response = await fetch(`${server.baseUrl}/api/git/provider/status?agentId=alpha--s1`);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as GitHostedProviderStatus;
    expect(payload.provider).toBe("github");
    expect(payload.available).toBe(true);
    expect(payload.authenticated).toBe(false);
    expect(payload.message).toContain("gh auth login");
  });

  it("lists open and recently closed pull requests with current branch highlight", async () => {
    const server = await createPullRequestTestServer({ ghAuth: "ok", branch: "feature/git-source-control-workspace" });

    const response = await fetch(`${server.baseUrl}/api/git/pull-requests?agentId=alpha--s1&closedLimit=5`);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as GitPullRequestListResult;
    expect(payload.open).toHaveLength(1);
    expect(payload.recentlyClosed).toHaveLength(1);
    expect(payload.open[0]?.isCurrentBranch).toBe(true);
    expect(payload.currentBranchPullRequest?.number).toBe(428);
    expect(payload.listError).toBeNull();
  });

  it("returns listError for PR list rate-limit failures", async () => {
    const server = await createPullRequestTestServer({ ghAuth: "ok", listFailure: "rate_limit" });

    const response = await fetch(`${server.baseUrl}/api/git/pull-requests?agentId=alpha--s1`);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as GitPullRequestListResult;
    expect(payload.listError?.code).toBe("rate_limit");
    expect(payload.open).toEqual([]);
    expect(payload.recentlyClosed).toEqual([]);
    expect(payload.providerStatus.authenticated).toBe(true);
    expect(payload.providerStatus.available).toBe(true);
  });

  it("returns listError for PR list timeout/network failures", async () => {
    const timeoutServer = await createPullRequestTestServer({ ghAuth: "ok", listFailure: "timeout" });
    const timeoutResponse = await fetch(`${timeoutServer.baseUrl}/api/git/pull-requests?agentId=alpha--s1`);
    expect(timeoutResponse.status).toBe(200);
    const timeoutPayload = (await timeoutResponse.json()) as GitPullRequestListResult;
    expect(timeoutPayload.listError?.code).toBe("timeout");

    const networkServer = await createPullRequestTestServer({ ghAuth: "ok", listFailure: "network" });
    const networkResponse = await fetch(`${networkServer.baseUrl}/api/git/pull-requests?agentId=alpha--s1`);
    expect(networkResponse.status).toBe(200);
    const networkPayload = (await networkResponse.json()) as GitPullRequestListResult;
    expect(networkPayload.listError?.code).toBe("network");
  });

  it("returns pull request detail for a selected number", async () => {
    const server = await createPullRequestTestServer({ ghAuth: "ok" });

    const response = await fetch(`${server.baseUrl}/api/git/pull-requests/428?agentId=alpha--s1`);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as GitPullRequestDetail;
    expect(payload.number).toBe(428);
    expect(payload.mergeable).toBe(true);
    expect(payload.checks.length).toBeGreaterThan(0);
  });

  it("returns 404 when gh reports a missing pull request", async () => {
    const server = await createPullRequestTestServer({
      ghAuth: "ok",
      detailFailure: "not_found"
    });

    const response = await fetch(`${server.baseUrl}/api/git/pull-requests/999?agentId=alpha--s1`);
    expect(response.status).toBe(404);

    const payload = (await response.json()) as { error: string; code?: string };
    expect(payload.code).toBe("not_found");
    expect(payload.error).toContain("not found");
  });

  it("returns 429 when gh reports rate limiting", async () => {
    const server = await createPullRequestTestServer({
      ghAuth: "ok",
      detailFailure: "rate_limit"
    });

    const response = await fetch(`${server.baseUrl}/api/git/pull-requests/428?agentId=alpha--s1`);
    expect(response.status).toBe(429);

    const payload = (await response.json()) as { error: string; code?: string };
    expect(payload.code).toBe("rate_limit");
  });

  it("returns 504 when gh detail lookup times out", async () => {
    const server = await createPullRequestTestServer({
      ghAuth: "ok",
      detailFailure: "timeout"
    });

    const response = await fetch(`${server.baseUrl}/api/git/pull-requests/428?agentId=alpha--s1`);
    expect(response.status).toBe(504);

    const payload = (await response.json()) as { error: string; code?: string };
    expect(payload.code).toBe("timeout");
  });

  it("merges pull request via POST with match-head-commit guard", async () => {
    const server = await createPullRequestTestServer({ ghAuth: "ok", mergeBehavior: "success" });

    const response = await fetch(`${server.baseUrl}/api/git/pull-requests/428/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "alpha--s1",
        method: "squash",
        expectedHeadSha: "abc123def456"
      })
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as GitPullRequestMergeResult;
    expect(payload.success).toBe(true);
    expect(payload.method).toBe("squash");
    expect(payload.state).toBe("merged");
    expect(payload.invalidateCaches).toBe(true);
  });

  it("returns 409 when merge preflight detects stale head sha", async () => {
    const server = await createPullRequestTestServer({ ghAuth: "ok" });

    const response = await fetch(`${server.baseUrl}/api/git/pull-requests/428/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "alpha--s1",
        method: "merge",
        expectedHeadSha: "stale-sha"
      })
    });

    expect(response.status).toBe(409);
    const payload = (await response.json()) as GitPullRequestMergeResult;
    expect(payload.success).toBe(false);
    expect(payload.errorCode).toBe("stale_head");
  });

  it("returns 409 when checks are failing and merge is not acknowledged", async () => {
    const server = await createPullRequestTestServer({
      ghAuth: "ok",
      detailCheckStatus: "failure"
    });

    const response = await fetch(`${server.baseUrl}/api/git/pull-requests/428/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "alpha--s1",
        method: "squash",
        expectedHeadSha: "abc123def456"
      })
    });

    expect(response.status).toBe(409);
    const payload = (await response.json()) as GitPullRequestMergeResult;
    expect(payload.success).toBe(false);
    expect(payload.errorCode).toBe("checks_blocked");
  });

  it("returns 503 when gh is unavailable for merge", async () => {
    const server = await createPullRequestTestServer({
      ghAuth: "ok",
      ghBinary: "/definitely/missing/gh"
    });

    const response = await fetch(`${server.baseUrl}/api/git/pull-requests/428/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "alpha--s1",
        method: "squash",
        expectedHeadSha: "abc123def456"
      })
    });

    expect(response.status).toBe(503);
    const payload = (await response.json()) as GitPullRequestMergeResult;
    expect(payload.success).toBe(false);
    expect(payload.errorCode).toBe("provider_unavailable");
  });
});

async function createSourceControlTestServer(options: {
  descriptors: AgentDescriptor[];
  managerCwd?: "main" | "linked";
  workerCwdRelative?: string;
}): Promise<TestServer> {
  const root = await mkdtemp(join(tmpdir(), "git-source-control-routes-"));
  const mainDir = join(root, "main");
  const secondaryDir = join(root, "linked");
  await mkdir(mainDir, { recursive: true });

  await initGitRepo(mainDir, "main.txt", "main v1\n", "initial commit");
  await execGit(mainDir, ["branch", "feature/worktree-test"]);
  await execGit(mainDir, ["worktree", "add", secondaryDir, "feature/worktree-test"]);

  const mainRealPath = await realpath(mainDir);
  const secondaryRealPath = await realpath(secondaryDir);
  const descriptorById = new Map(options.descriptors.map((descriptor) => [descriptor.agentId, descriptor]));

  if (options.workerCwdRelative) {
    await mkdir(join(secondaryDir, options.workerCwdRelative), { recursive: true });
  }

  for (const descriptor of options.descriptors) {
    if (descriptor.agentId === "alpha-worker") {
      descriptor.cwd = options.workerCwdRelative
        ? await realpath(join(secondaryRealPath, options.workerCwdRelative))
        : secondaryRealPath;
    } else if (options.managerCwd === "linked") {
      descriptor.cwd = secondaryRealPath;
    } else {
      descriptor.cwd = mainRealPath;
    }
  }

  const swarmManager = {
    getConfig: () => ({ paths: { dataDir: join(root, "unused-data") } }),
    getAgent: (agentId: string) => descriptorById.get(agentId),
    listAgents: () => options.descriptors
  } as unknown as SwarmManager;

  const routes = createGitSourceControlRoutes({ swarmManager });
  const server = createServer((request, response) => {
    void handleRouteRequest(routes, request, response);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine test server address.");
  }

  const testServer: TestServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    root,
    mainDir: mainRealPath,
    secondaryDir: secondaryRealPath,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });

      await rm(root, { recursive: true, force: true });
    }
  };

  activeServers.push(testServer);
  return testServer;
}

async function handleRouteRequest(
  routes: ReturnType<typeof createGitSourceControlRoutes>,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  const route = routes.find((entry) => entry.matches(requestUrl.pathname));

  if (!route) {
    response.statusCode = 404;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ error: "Not Found" }));
    return;
  }

  try {
    await route.handle(request, response, requestUrl);
  } catch (error) {
    response.statusCode = 500;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unexpected route error." })
    );
  }
}

function createManagerSession(
  profileId: string,
  sessionId: string,
  overrides: Partial<AgentDescriptor> = {}
): AgentDescriptor {
  const timestamp = new Date().toISOString();

  return {
    agentId: sessionId,
    managerId: sessionId,
    displayName: sessionId,
    role: "manager",
    status: "idle",
    createdAt: timestamp,
    updatedAt: timestamp,
    cwd: "/tmp",
    model: {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "medium"
    },
    sessionFile: `/tmp/${sessionId}.jsonl`,
    profileId,
    sessionLabel: "Session 1",
    ...overrides
  };
}

function createWorker(
  agentId: string,
  managerId: string,
  overrides: Partial<AgentDescriptor> = {}
): AgentDescriptor {
  const timestamp = new Date().toISOString();

  return {
    agentId,
    managerId,
    displayName: agentId,
    role: "worker",
    status: "streaming",
    createdAt: timestamp,
    updatedAt: timestamp,
    cwd: "/tmp",
    model: {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "medium"
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
    ...overrides
  };
}

async function initGitRepo(
  cwd: string,
  relativePath: string,
  content: string,
  message: string,
  branch = "main"
): Promise<void> {
  await mkdir(join(cwd, dirnameSafe(relativePath)), { recursive: true });
  await writeFile(join(cwd, relativePath), content, "utf8");
  await execGit(cwd, ["init", "-b", branch]);
  await execGit(cwd, ["config", "user.name", "Forge Test"]);
  await execGit(cwd, ["config", "user.email", "forge-test@example.com"]);
  await execGit(cwd, ["add", relativePath]);
  await execGit(cwd, ["commit", "-m", message]);
}

function dirnameSafe(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "." : normalized.slice(0, index);
}

async function execGit(
  cwd: string,
  args: string[],
  options: { allowFailure?: boolean } = {}
): Promise<void> {
  try {
    await execFileAsync("git", args, {
      cwd,
      encoding: "utf8"
    });
  } catch (error) {
    if (options.allowFailure) {
      return;
    }

    throw error;
  }
}

async function createVersioningMutationTestServer(): Promise<TestServer> {
  const root = await mkdtemp(join(tmpdir(), "git-source-control-versioning-"));
  const dataDir = join(root, "forge-data");
  await mkdir(dataDir, { recursive: true });
  await initGitRepo(dataDir, "common.md", "# knowledge\n", "initial knowledge");

  const dataRealPath = await realpath(dataDir);
  const descriptors = [
    createManagerSession("cortex", "cortex--s1", { profileId: "cortex", cwd: dataRealPath })
  ];
  const descriptorById = new Map(descriptors.map((descriptor) => [descriptor.agentId, descriptor]));

  const swarmManager = {
    getConfig: () => ({ paths: { dataDir: dataRealPath } }),
    getAgent: (agentId: string) => descriptorById.get(agentId),
    listAgents: () => descriptors
  } as unknown as SwarmManager;

  const routes = createGitSourceControlRoutes({ swarmManager });
  const server = createServer((request, response) => {
    void handleRouteRequest(routes, request, response);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine test server address.");
  }

  const testServer: TestServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    root,
    mainDir: dataRealPath,
    secondaryDir: dataRealPath,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });

      await rm(root, { recursive: true, force: true });
    }
  };

  activeServers.push(testServer);
  return testServer;
}

async function fetchBranches(
  server: TestServer,
  agentId: string,
  options: { worktreeId?: string; repoTarget?: string } = {}
): Promise<GitBranchListResult> {
  const params = new URLSearchParams({ agentId });
  if (options.worktreeId) {
    params.set("worktreeId", options.worktreeId);
  }
  if (options.repoTarget) {
    params.set("repoTarget", options.repoTarget);
  }

  const response = await fetch(`${server.baseUrl}/api/git/branches?${params.toString()}`);
  expect(response.status).toBe(200);
  return (await response.json()) as GitBranchListResult;
}

async function postMutation<T>(
  server: TestServer,
  endpoint: string,
  body: Record<string, unknown>
): Promise<{ status: number; payload: T }> {
  const response = await fetch(`${server.baseUrl}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  return {
    status: response.status,
    payload: (await response.json()) as T
  };
}

async function createRemoteBackedTestServer(options: {
  aheadOnRemote?: boolean;
  diverged?: boolean;
} = {}): Promise<TestServer> {
  const root = await mkdtemp(join(tmpdir(), "git-source-control-remote-"));
  const bareDir = join(root, "origin.git");
  const mainDir = join(root, "main");
  const remoteCloneDir = join(root, "remote-clone");
  await mkdir(mainDir, { recursive: true });

  await execGit(root, ["init", "--bare", bareDir]);
  await initGitRepo(mainDir, "main.txt", "main v1\n", "initial commit");
  await execGit(mainDir, ["remote", "add", "origin", bareDir]);
  await execGit(mainDir, ["push", "-u", "origin", "main"]);
  await execGit(bareDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);

  if (options.aheadOnRemote) {
    await writeFile(join(mainDir, "remote-only.txt"), "remote\n", "utf8");
    await execGit(mainDir, ["add", "remote-only.txt"]);
    await execGit(mainDir, ["commit", "-m", "remote advance"]);
    await execGit(mainDir, ["push", "origin", "main"]);
    await execGit(mainDir, ["reset", "--hard", "HEAD^"]);
  }

  if (options.diverged) {
    await writeFile(join(mainDir, "local-only.txt"), "local\n", "utf8");
    await execGit(mainDir, ["add", "local-only.txt"]);
    await execGit(mainDir, ["commit", "-m", "local divergence"]);

    await execGit(root, ["clone", "-b", "main", bareDir, remoteCloneDir]);
    await writeFile(join(remoteCloneDir, "remote-only.txt"), "remote\n", "utf8");
    await execGit(remoteCloneDir, ["add", "remote-only.txt"]);
    await execGit(remoteCloneDir, ["commit", "-m", "remote divergence"]);
    await execGit(remoteCloneDir, ["push", "origin", "main"]);
  }

  const mainRealPath = await realpath(mainDir);
  const descriptors = [createManagerSession("alpha", "alpha--s1")];
  descriptors[0]!.cwd = mainRealPath;

  const descriptorById = new Map(descriptors.map((descriptor) => [descriptor.agentId, descriptor]));
  const swarmManager = {
    getConfig: () => ({ paths: { dataDir: join(root, "unused-data") } }),
    getAgent: (agentId: string) => descriptorById.get(agentId),
    listAgents: () => descriptors
  } as unknown as SwarmManager;

  const routes = createGitSourceControlRoutes({ swarmManager });
  const server = createServer((request, response) => {
    void handleRouteRequest(routes, request, response);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine test server address.");
  }

  const testServer: TestServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    root,
    mainDir: mainRealPath,
    secondaryDir: mainRealPath,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });

      await rm(root, { recursive: true, force: true });
    }
  };

  activeServers.push(testServer);
  return testServer;
}

async function revParse(cwd: string, ref: string): Promise<string> {
  const result = await execFileAsync("git", ["rev-parse", ref], {
    cwd,
    encoding: "utf8"
  });
  return result.stdout.trim();
}

async function createPullRequestTestServer(options: {
  ghAuth: "ok" | "fail";
  ghBinary?: string;
  branch?: string;
  detailFailure?: "not_found" | "rate_limit" | "timeout" | "auth" | "permission";
  listFailure?: "rate_limit" | "timeout" | "network" | "permission";
  ghTimeoutMs?: number;
  mergeBehavior?: "success" | "stale_head";
  detailCheckStatus?: "success" | "failure" | "pending";
}): Promise<TestServer> {
  const root = await mkdtemp(join(tmpdir(), "git-source-control-pr-"));
  const mainDir = join(root, "main");
  await mkdir(mainDir, { recursive: true });
  await initGitRepo(mainDir, "README.md", "# repo\n", "initial commit", options.branch ?? "main");
  await execGit(mainDir, ["remote", "add", "origin", "git@github.com:a-mart/forge.git"]);

  const fakeGhPath =
    options.ghBinary ??
    (await createFakeGhScript(root, options.ghAuth, options.detailFailure, options.listFailure, {
      mergeBehavior: options.mergeBehavior,
      detailCheckStatus: options.detailCheckStatus
    }));
  const mainRealPath = await realpath(mainDir);
  const descriptors = [createManagerSession("alpha", "alpha--s1")];
  descriptors[0]!.cwd = mainRealPath;

  const descriptorById = new Map(descriptors.map((descriptor) => [descriptor.agentId, descriptor]));
  const swarmManager = {
    getConfig: () => ({ paths: { dataDir: join(root, "unused-data") } }),
    getAgent: (agentId: string) => descriptorById.get(agentId),
    listAgents: () => descriptors
  } as unknown as SwarmManager;

  const routes = createGitSourceControlRoutes({
    swarmManager,
    hostedProviderOptions: {
      ghBinary: fakeGhPath,
      timeoutMs: options.ghTimeoutMs
    }
  });
  const server = createServer((request, response) => {
    void handleRouteRequest(routes, request, response);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine test server address.");
  }

  const testServer: TestServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    root,
    mainDir: mainRealPath,
    secondaryDir: mainRealPath,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });

      await rm(root, { recursive: true, force: true });
    }
  };

  activeServers.push(testServer);
  return testServer;
}

async function createFakeGhScript(
  root: string,
  auth: "ok" | "fail",
  detailFailure?: "not_found" | "rate_limit" | "timeout" | "auth" | "permission",
  listFailure?: "rate_limit" | "timeout" | "network" | "permission",
  options: {
    mergeBehavior?: "success" | "stale_head";
    detailCheckStatus?: "success" | "failure" | "pending";
  } = {}
): Promise<string> {
  const fakeGhPath = join(root, "fake-gh");
  const mergeLogPath = join(root, "merge-calls.log");
  const viewCountPath = join(root, "view-count.log");
  const openJson = JSON.stringify([
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
  ]);
  const closedJson = JSON.stringify([
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
  ]);
  const detailJson = JSON.stringify({
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
    statusCheckRollup:
      options.detailCheckStatus === "failure"
        ? [{ name: "Backend tests", status: "COMPLETED", conclusion: "FAILURE" }]
        : options.detailCheckStatus === "pending"
          ? [{ name: "Backend tests", status: "IN_PROGRESS" }]
          : [{ state: "SUCCESS", status: "COMPLETED", conclusion: "SUCCESS", name: "UI typecheck" }],
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
    statusCheckRollup: [{ state: "SUCCESS", status: "COMPLETED", conclusion: "SUCCESS", name: "UI typecheck" }],
    changedFiles: 7,
    additions: 184,
    deletions: 39,
    headRefOid: "abc123def456"
  });

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
  if (${JSON.stringify(auth)} === "fail") {
    process.stderr.write("You are not logged into any GitHub hosts\\n");
    process.exit(1);
  }
  process.stdout.write("github.com\\n  ✓ Logged in\\n");
  process.exit(0);
}

if (command.startsWith("repo view")) {
  process.stdout.write(JSON.stringify({
    mergeCommitAllowed: true,
    squashMergeAllowed: true,
    rebaseMergeAllowed: true
  }));
  process.exit(0);
}

if (command.includes("pr list") && command.includes("--state open")) {
  const listFailure = ${JSON.stringify(listFailure ?? null)};
  if (listFailure === "rate_limit") {
    process.stderr.write("API rate limit exceeded for user\\n");
    process.exit(1);
  }
  if (listFailure === "timeout") {
    process.stderr.write("gh command timed out.\\n");
    process.exit(1);
  }
  if (listFailure === "network") {
    process.stderr.write("error connecting to api.github.com: network unavailable\\n");
    process.exit(1);
  }
  if (listFailure === "permission") {
    process.stderr.write("HTTP 403: Resource not accessible by integration\\n");
    process.exit(1);
  }
  process.stdout.write(${JSON.stringify(openJson)});
  process.exit(0);
}

if (command.includes("pr list") && command.includes("--state closed")) {
  process.stdout.write(${JSON.stringify(closedJson)});
  process.exit(0);
}

if (command.startsWith("pr view")) {
  let viewCount = 0;
  try {
    viewCount = Number(fs.readFileSync(${JSON.stringify(viewCountPath)}, "utf8"));
  } catch {}
  viewCount += 1;
  fs.writeFileSync(${JSON.stringify(viewCountPath)}, String(viewCount));
  const detailFailure = ${JSON.stringify(detailFailure ?? null)};
  if (detailFailure === "timeout") {
    process.stderr.write("gh command timed out.\\n");
    process.exit(1);
  }
  if (detailFailure === "not_found") {
    process.stderr.write("GraphQL: Could not resolve to a PullRequest with the number of 999\\n");
    process.exit(1);
  }
  if (detailFailure === "rate_limit") {
    process.stderr.write("API rate limit exceeded for user\\n");
    process.exit(1);
  }
  if (detailFailure === "auth") {
    process.stderr.write("HTTP 401: Bad credentials\\n");
    process.exit(1);
  }
  if (detailFailure === "permission") {
    process.stderr.write("HTTP 403: Resource not accessible by integration\\n");
    process.exit(1);
  }
  const mergedViews = ${JSON.stringify(options.mergeBehavior === "success")};
  if (mergedViews && viewCount > 1) {
    process.stdout.write(${JSON.stringify(mergedDetailJson)});
    process.exit(0);
  }
  process.stdout.write(${JSON.stringify(detailJson)});
  process.exit(0);
}

if (command.startsWith("pr merge")) {
  fs.appendFileSync(${JSON.stringify(mergeLogPath)}, command + "\\n");
  const mergeBehavior = ${JSON.stringify(options.mergeBehavior ?? null)};
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
  return fakeGhPath;
}
