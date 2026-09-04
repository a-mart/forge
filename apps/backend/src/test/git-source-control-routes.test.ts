import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { delimiter as pathDelimiter, join } from "node:path";
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
  GitPushResult,
  GitWorktreeListResult
} from "@forge/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import {
  createWorktreeId,
  resolveStableWorktreePathKey
} from "../versioning/git-source-control-helpers.js";
import { createGitSourceControlRoutes } from "../ws/http/routes/git-source-control-routes.js";
import { configureGitTestIdentity } from "./test-helpers.js";

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

  it("rejects switching branches before an ignored local file would be overwritten", async () => {
    const server = await createSourceControlTestServer({
      descriptors: [createManagerSession("alpha", "alpha--s1")]
    });

    await writeFile(join(server.mainDir, ".gitignore"), "ignored.txt\n", "utf8");
    await execGit(server.mainDir, ["add", ".gitignore"]);
    await execGit(server.mainDir, ["commit", "-m", "ignore local generated file"]);
    await execGit(server.mainDir, ["switch", "-c", "release/ignored-target"]);
    await writeFile(join(server.mainDir, "ignored.txt"), "target tracked\n", "utf8");
    await execGit(server.mainDir, ["add", "-f", "ignored.txt"]);
    await execGit(server.mainDir, ["commit", "-m", "track ignored target file"]);
    await execGit(server.mainDir, ["switch", "main"]);
    await writeFile(join(server.mainDir, "ignored.txt"), "local ignored\n", "utf8");

    const branches = await fetchBranches(server, "alpha--s1");
    const mutation = await postMutation<GitMutationResult>(server, "/api/git/switch-branch", {
      agentId: "alpha--s1",
      branch: "release/ignored-target",
      expectedHead: branches.currentHead!,
      expectedStatusHash: branches.statusHash!
    });

    expect(mutation.status).toBe(409);
    expect(mutation.payload.success).toBe(false);
    expect(mutation.payload.errors.join(" ")).toContain("ignored local files");
    expect(mutation.payload.errors.join(" ")).toContain("ignored.txt");
    expect(await readFile(join(server.mainDir, "ignored.txt"), "utf8")).toBe("local ignored\n");
  });

  it("rejects switching branches when an ignored local file conflicts with tracked target directory contents", async () => {
    const server = await createSourceControlTestServer({
      descriptors: [createManagerSession("alpha", "alpha--s1")]
    });

    await writeFile(join(server.mainDir, ".gitignore"), "dist\n", "utf8");
    await execGit(server.mainDir, ["add", ".gitignore"]);
    await execGit(server.mainDir, ["commit", "-m", "ignore local dist path"]);
    await execGit(server.mainDir, ["switch", "-c", "release/ignored-parent-target"]);
    await mkdir(join(server.mainDir, "dist"), { recursive: true });
    await writeFile(join(server.mainDir, "dist", "a.txt"), "target tracked child\n", "utf8");
    await execGit(server.mainDir, ["add", "-f", "dist/a.txt"]);
    await execGit(server.mainDir, ["commit", "-m", "track ignored target child"]);
    await execGit(server.mainDir, ["switch", "main"]);
    await writeFile(join(server.mainDir, "dist"), "local ignored file\n", "utf8");

    const branches = await fetchBranches(server, "alpha--s1");
    const mutation = await postMutation<GitMutationResult>(server, "/api/git/switch-branch", {
      agentId: "alpha--s1",
      branch: "release/ignored-parent-target",
      expectedHead: branches.currentHead!,
      expectedStatusHash: branches.statusHash!
    });

    expect(mutation.status).toBe(409);
    expect(mutation.payload.success).toBe(false);
    expect(mutation.payload.errors.join(" ")).toContain("ignored local files");
    expect(mutation.payload.errors.join(" ")).toContain("dist");
    expect(await readFile(join(server.mainDir, "dist"), "utf8")).toBe("local ignored file\n");
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

  it("allows branch switch when a streaming agent is attached to the worktree", async () => {
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

    expect(mutation.status).toBe(200);
    expect(mutation.payload.success).toBe(true);
    expect(mutation.payload.currentBranch).toBe("release/test");
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

  it("rejects creating a branch from a start point that would overwrite an ignored local file", async () => {
    const server = await createSourceControlTestServer({
      descriptors: [createManagerSession("alpha", "alpha--s1")]
    });

    await writeFile(join(server.mainDir, ".gitignore"), "ignored.txt\n", "utf8");
    await execGit(server.mainDir, ["add", ".gitignore"]);
    await execGit(server.mainDir, ["commit", "-m", "ignore local generated file"]);
    await execGit(server.mainDir, ["switch", "-c", "release/ignored-start"]);
    await writeFile(join(server.mainDir, "ignored.txt"), "start tracked\n", "utf8");
    await execGit(server.mainDir, ["add", "-f", "ignored.txt"]);
    await execGit(server.mainDir, ["commit", "-m", "track ignored start file"]);
    await execGit(server.mainDir, ["switch", "main"]);
    await writeFile(join(server.mainDir, "ignored.txt"), "local ignored\n", "utf8");

    const branches = await fetchBranches(server, "alpha--s1");
    const mutation = await postMutation<GitMutationResult>(server, "/api/git/create-branch", {
      agentId: "alpha--s1",
      branch: "feature/from-ignored-start",
      startPoint: "release/ignored-start",
      expectedHead: branches.currentHead!,
      expectedStatusHash: branches.statusHash!
    });

    expect(mutation.status).toBe(409);
    expect(mutation.payload.success).toBe(false);
    expect(mutation.payload.errors.join(" ")).toContain("ignored local files");
    expect(mutation.payload.errors.join(" ")).toContain("ignored.txt");
    expect(await readFile(join(server.mainDir, "ignored.txt"), "utf8")).toBe("local ignored\n");
  });

  it("rejects creating a branch from a start point when an ignored local file conflicts with tracked target directory contents", async () => {
    const server = await createSourceControlTestServer({
      descriptors: [createManagerSession("alpha", "alpha--s1")]
    });

    await writeFile(join(server.mainDir, ".gitignore"), "dist\n", "utf8");
    await execGit(server.mainDir, ["add", ".gitignore"]);
    await execGit(server.mainDir, ["commit", "-m", "ignore local dist path"]);
    await execGit(server.mainDir, ["switch", "-c", "release/ignored-start-dir"]);
    await mkdir(join(server.mainDir, "dist"), { recursive: true });
    await writeFile(join(server.mainDir, "dist", "a.txt"), "start tracked child\n", "utf8");
    await execGit(server.mainDir, ["add", "-f", "dist/a.txt"]);
    await execGit(server.mainDir, ["commit", "-m", "track ignored start child"]);
    await execGit(server.mainDir, ["switch", "main"]);
    await writeFile(join(server.mainDir, "dist"), "local ignored file\n", "utf8");

    const branches = await fetchBranches(server, "alpha--s1");
    const mutation = await postMutation<GitMutationResult>(server, "/api/git/create-branch", {
      agentId: "alpha--s1",
      branch: "feature/from-ignored-start-dir",
      startPoint: "release/ignored-start-dir",
      expectedHead: branches.currentHead!,
      expectedStatusHash: branches.statusHash!
    });

    expect(mutation.status).toBe(409);
    expect(mutation.payload.success).toBe(false);
    expect(mutation.payload.errors.join(" ")).toContain("ignored local files");
    expect(mutation.payload.errors.join(" ")).toContain("dist");
    expect(await readFile(join(server.mainDir, "dist"), "utf8")).toBe("local ignored file\n");
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

  it("publishes a local-only branch and sets origin as its upstream", async () => {
    const server = await createRemoteBackedTestServer();

    await execGit(server.mainDir, ["switch", "-c", "task/publish-branch"]);
    await writeFile(join(server.mainDir, "feature.txt"), "feature\n", "utf8");
    await execGit(server.mainDir, ["add", "feature.txt"]);
    await execGit(server.mainDir, ["commit", "-m", "local feature commit"]);

    const branches = await fetchBranches(server, "alpha--s1");
    const current = branches.branches.find((branch) => branch.kind === "current");
    expect(current?.name).toBe("task/publish-branch");
    expect(current?.upstream).toBeFalsy();

    const preflightResponse = await fetch(
      `${server.baseUrl}/api/git/mutation-preflight?agentId=alpha--s1&action=push&remote=origin`
    );
    expect(preflightResponse.status).toBe(200);
    const preflight = (await preflightResponse.json()) as { allowed: boolean; issues: Array<{ code: string }> };
    expect(preflight.allowed).toBe(true);
    expect(preflight.issues.some((issue) => issue.code === "missing_upstream")).toBe(false);

    const mutation = await postMutation<GitPushResult>(server, "/api/git/push", {
      agentId: "alpha--s1",
      remote: "origin",
      expectedHead: branches.currentHead!,
      expectedStatusHash: branches.statusHash!
    });

    expect(mutation.status).toBe(200);
    expect(mutation.payload.success).toBe(true);
    expect(mutation.payload.pushed).toBe(true);
    expect(mutation.payload.upstream).toBe("origin/task/publish-branch");
    expect((await execGitCapture(server.mainDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).stdout.trim()).toBe(
      "origin/task/publish-branch"
    );
    expect((await execGitCapture(server.mainDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(
      (await execGitCapture(server.mainDir, ["rev-parse", "origin/task/publish-branch"])).stdout.trim()
    );
  });

  it("keeps pushed true when a local-only branch is published but upstream tracking fails", async () => {
    const server = await createRemoteBackedTestServer();

    await execGit(server.mainDir, ["switch", "-c", "task/publish-tracking-failure"]);
    await writeFile(join(server.mainDir, "feature.txt"), "feature\n", "utf8");
    await execGit(server.mainDir, ["add", "feature.txt"]);
    await execGit(server.mainDir, ["commit", "-m", "local feature commit"]);

    const branches = await fetchBranches(server, "alpha--s1");
    const gitShimDir = await createGitUpstreamTrackingFailureShim(server.root);
    const previousPath = process.env.PATH ?? "";
    process.env.PATH = `${gitShimDir}${pathDelimiter}${previousPath}`;
    try {
      const mutation = await postMutation<GitPushResult>(server, "/api/git/push", {
        agentId: "alpha--s1",
        remote: "origin",
        expectedHead: branches.currentHead!,
        expectedStatusHash: branches.statusHash!
      });

      expect(mutation.status).toBe(200);
      expect(mutation.payload.success).toBe(true);
      expect(mutation.payload.pushed).toBe(true);
      expect(mutation.payload.upstream).toBe("origin/task/publish-tracking-failure");
      expect(mutation.payload.warnings.join(" ")).toMatch(/upstream tracking/i);
      expect((await execGitCapture(server.mainDir, ["rev-parse", "origin/task/publish-tracking-failure"])).stdout.trim()).toBe(
        (await execGitCapture(server.mainDir, ["rev-parse", "HEAD"])).stdout.trim()
      );
      await expect(execGitCapture(server.mainDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).rejects.toThrow();
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("rejects publishing when the same remote branch already has extra commits", async () => {
    const server = await createRemoteBackedTestServer();
    const remoteCloneDir = join(server.root, "remote-publish-conflict");

    await execGit(server.mainDir, ["switch", "-c", "task/publish-conflict"]);
    await writeFile(join(server.mainDir, "local-feature.txt"), "local\n", "utf8");
    await execGit(server.mainDir, ["add", "local-feature.txt"]);
    await execGit(server.mainDir, ["commit", "-m", "local unpublished feature"]);

    await execGit(server.root, ["clone", join(server.root, "origin.git"), remoteCloneDir]);
    await configureGitTestIdentity(remoteCloneDir);
    await execGit(remoteCloneDir, ["switch", "-c", "task/publish-conflict"]);
    await writeFile(join(remoteCloneDir, "remote-feature.txt"), "remote\n", "utf8");
    await execGit(remoteCloneDir, ["add", "remote-feature.txt"]);
    await execGit(remoteCloneDir, ["commit", "-m", "remote extra commit"]);
    await execGit(remoteCloneDir, ["push", "-u", "origin", "task/publish-conflict"]);

    const branches = await fetchBranches(server, "alpha--s1");
    const mutation = await postMutation<GitPushResult>(server, "/api/git/push", {
      agentId: "alpha--s1",
      remote: "origin",
      expectedHead: branches.currentHead!,
      expectedStatusHash: branches.statusHash!
    });

    expect(mutation.status).toBe(409);
    expect(mutation.payload.success).toBe(false);
    expect(mutation.payload.pushed).toBe(false);
    expect(mutation.payload.errors.join(" ")).toContain("Force push is never used");
  });

  it("pushes unpublished commits to a local bare remote", async () => {
    const server = await createRemoteBackedTestServer({ aheadOnLocal: true });

    const branches = await fetchBranches(server, "alpha--s1");
    const mutation = await postMutation<GitPushResult>(server, "/api/git/push", {
      agentId: "alpha--s1",
      remote: "origin",
      expectedHead: branches.currentHead!,
      expectedStatusHash: branches.statusHash!
    });

    expect(mutation.status).toBe(200);
    expect(mutation.payload.success).toBe(true);
    expect(mutation.payload.pushed).toBe(true);
    expect(mutation.payload.upstream).toBe("origin/main");
    expect((await execGitCapture(server.mainDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(
      (await execGitCapture(server.mainDir, ["rev-parse", "origin/main"])).stdout.trim()
    );
  });

  it("rejects push when the current branch is already up to date", async () => {
    const server = await createRemoteBackedTestServer();

    const branches = await fetchBranches(server, "alpha--s1");
    const mutation = await postMutation<GitPushResult>(server, "/api/git/push", {
      agentId: "alpha--s1",
      remote: "origin",
      expectedHead: branches.currentHead!,
      expectedStatusHash: branches.statusHash!
    });

    expect(mutation.status).toBe(409);
    expect(mutation.payload.success).toBe(false);
    expect(mutation.payload.pushed).toBe(false);
    expect(mutation.payload.errors.join(" ")).toContain("already up to date");
  });

  it("pushes unpublished commits even when the worktree is dirty", async () => {
    const server = await createRemoteBackedTestServer({ aheadOnLocal: true });
    const dirtyPath = join(server.mainDir, "dirty.txt");
    await writeFile(dirtyPath, "local dirty work\n", "utf8");

    const branches = await fetchBranches(server, "alpha--s1");
    const mutation = await postMutation<GitPushResult>(server, "/api/git/push", {
      agentId: "alpha--s1",
      remote: "origin",
      expectedHead: branches.currentHead!,
      expectedStatusHash: branches.statusHash!
    });

    expect(mutation.status).toBe(200);
    expect(mutation.payload.success).toBe(true);
    expect(mutation.payload.pushed).toBe(true);
    expect(await readFile(dirtyPath, "utf8")).toBe("local dirty work\n");
  });

  it("rejects push after fetch when origin advanced since the confirmation snapshot", async () => {
    const server = await createRemoteBackedTestServer({ aheadOnLocal: true });
    const remoteCloneDir = join(server.root, "unfetched-remote-advance");
    await execGit(server.root, ["clone", join(server.root, "origin.git"), remoteCloneDir]);
    await configureGitTestIdentity(remoteCloneDir);
    await writeFile(join(remoteCloneDir, "remote-advance.txt"), "remote\n", "utf8");
    await execGit(remoteCloneDir, ["add", "remote-advance.txt"]);
    await execGit(remoteCloneDir, ["commit", "-m", "unfetched remote advance"]);
    await execGit(remoteCloneDir, ["push", "origin", "main"]);

    const branches = await fetchBranches(server, "alpha--s1");
    const mutation = await postMutation<GitPushResult>(server, "/api/git/push", {
      agentId: "alpha--s1",
      remote: "origin",
      expectedHead: branches.currentHead!,
      expectedStatusHash: branches.statusHash!
    });

    expect(mutation.status).toBe(409);
    expect(mutation.payload.success).toBe(false);
    expect(mutation.payload.pushed).toBe(false);
    expect(mutation.payload.errors.join(" ")).toContain("behind");
  });

  it("rejects push when the current branch is behind its upstream", async () => {
    const server = await createRemoteBackedTestServer({ aheadOnRemote: true });

    const branches = await fetchBranches(server, "alpha--s1");
    const mutation = await postMutation<GitPushResult>(server, "/api/git/push", {
      agentId: "alpha--s1",
      remote: "origin",
      expectedHead: branches.currentHead!,
      expectedStatusHash: branches.statusHash!
    });

    expect(mutation.status).toBe(409);
    expect(mutation.payload.success).toBe(false);
    expect(mutation.payload.pushed).toBe(false);
    expect(mutation.payload.errors.join(" ")).toContain("behind");
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

  it("rejects fast-forward pull after fetch before an ignored local file would be overwritten", async () => {
    const server = await createRemoteBackedTestServer();

    await writeFile(join(server.mainDir, ".gitignore"), "ignored.txt\n", "utf8");
    await execGit(server.mainDir, ["add", ".gitignore"]);
    await execGit(server.mainDir, ["commit", "-m", "ignore local generated file"]);
    await execGit(server.mainDir, ["push", "origin", "main"]);

    const remoteCloneDir = join(server.root, "remote-clobber");
    await execGit(server.root, ["clone", join(server.root, "origin.git"), remoteCloneDir]);
    await configureGitTestIdentity(remoteCloneDir);
    await writeFile(join(remoteCloneDir, "ignored.txt"), "remote tracked\n", "utf8");
    await execGit(remoteCloneDir, ["add", "-f", "ignored.txt"]);
    await execGit(remoteCloneDir, ["commit", "-m", "remote tracks ignored file"]);
    await execGit(remoteCloneDir, ["push", "origin", "main"]);
    await writeFile(join(server.mainDir, "ignored.txt"), "local ignored\n", "utf8");

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
    expect(mutation.payload.errors.join(" ")).toContain("ignored local files");
    expect(mutation.payload.errors.join(" ")).toContain("ignored.txt");
    expect(await readFile(join(server.mainDir, "ignored.txt"), "utf8")).toBe("local ignored\n");
  });

  it("rejects fast-forward pull when an ignored local file conflicts with tracked upstream directory contents", async () => {
    const server = await createRemoteBackedTestServer();

    await writeFile(join(server.mainDir, ".gitignore"), "dist\n", "utf8");
    await execGit(server.mainDir, ["add", ".gitignore"]);
    await execGit(server.mainDir, ["commit", "-m", "ignore local dist path"]);
    await execGit(server.mainDir, ["push", "origin", "main"]);

    const remoteCloneDir = join(server.root, "remote-clobber-dir");
    await execGit(server.root, ["clone", join(server.root, "origin.git"), remoteCloneDir]);
    await configureGitTestIdentity(remoteCloneDir);
    await mkdir(join(remoteCloneDir, "dist"), { recursive: true });
    await writeFile(join(remoteCloneDir, "dist", "a.txt"), "remote tracked child\n", "utf8");
    await execGit(remoteCloneDir, ["add", "-f", "dist/a.txt"]);
    await execGit(remoteCloneDir, ["commit", "-m", "remote tracks ignored child"]);
    await execGit(remoteCloneDir, ["push", "origin", "main"]);
    await writeFile(join(server.mainDir, "dist"), "local ignored file\n", "utf8");

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
    expect(mutation.payload.errors.join(" ")).toContain("ignored local files");
    expect(mutation.payload.errors.join(" ")).toContain("dist");
    expect(await readFile(join(server.mainDir, "dist"), "utf8")).toBe("local ignored file\n");
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

  it("does not treat attached agents as a mutation preflight issue", async () => {
    const server = await createSourceControlTestServer({
      descriptors: [
        createManagerSession("alpha", "alpha--s1"),
        createWorker("alpha-worker", "alpha--s1", { status: "idle" }),
        createWorker("alpha-streamer", "alpha--s1", { status: "streaming" })
      ]
    });

    await execGit(server.mainDir, ["branch", "release/test"]);
    const response = await fetch(
      `${server.baseUrl}/api/git/mutation-preflight?agentId=alpha--s1&action=switch-branch&targetBranch=release/test`
    );
    expect(response.status).toBe(200);

    const payload = (await response.json()) as { issues: Array<{ code: string; severity: string }> };
    expect(payload.issues.some((issue) => issue.code === "idle_agents_attached" || issue.code === "streaming_agents")).toBe(
      false
    );

    const pullResponse = await fetch(
      `${server.baseUrl}/api/git/mutation-preflight?agentId=alpha--s1&action=pull-ff-only&remote=origin`
    );
    expect(pullResponse.status).toBe(200);

    const pullPayload = (await pullResponse.json()) as { issues: Array<{ code: string; severity: string }> };
    expect(pullPayload.issues.some((issue) => issue.code === "idle_agents_attached" || issue.code === "streaming_agents")).toBe(
      false
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

  it("rejects versioning repo merge requests without invoking gh", async () => {
    const server = await createVersioningMutationTestServer();

    const response = await fetch(`${server.baseUrl}/api/git/pull-requests/428/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "cortex--s1",
        repoTarget: "versioning",
        method: "squash",
        expectedHeadSha: "abc123def456"
      })
    });

    expect(response.status).toBe(409);
    const payload = (await response.json()) as GitPullRequestMergeResult;
    expect(payload.success).toBe(false);
    expect(payload.errorCode).toBe("versioning_blocked");
    expect(payload.errors.join(" ")).toContain("workspace");
  });

  it("allows merge when pending checks are explicitly acknowledged", async () => {
    const server = await createPullRequestTestServer({
      ghAuth: "ok",
      detailCheckStatus: "pending",
      mergeBehavior: "success"
    });

    const response = await fetch(`${server.baseUrl}/api/git/pull-requests/428/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "alpha--s1",
        method: "squash",
        expectedHeadSha: "abc123def456",
        acknowledgeCheckFailures: true
      })
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as GitPullRequestMergeResult;
    expect(payload.success).toBe(true);
    expect(payload.state).toBe("merged");
  });

  it("returns 409 when merge method is not allowed for the repository", async () => {
    const server = await createPullRequestTestServer({
      ghAuth: "ok",
      repoMergeSettings: {
        mergeCommitAllowed: false,
        squashMergeAllowed: true,
        rebaseMergeAllowed: false
      }
    });

    const response = await fetch(`${server.baseUrl}/api/git/pull-requests/428/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "alpha--s1",
        method: "merge",
        expectedHeadSha: "abc123def456"
      })
    });

    expect(response.status).toBe(409);
    const payload = (await response.json()) as GitPullRequestMergeResult;
    expect(payload.success).toBe(false);
    expect(payload.errorCode).toBe("method_not_allowed");
  });

  it("returns submitted state when gh accepts merge but PR remains open", async () => {
    const server = await createPullRequestTestServer({
      ghAuth: "ok",
      mergeBehavior: "submitted"
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
    expect(payload.submitted).toBe(true);
    expect(payload.state).toBe("open");
    expect(payload.mergedAt).toBeUndefined();
  });

  it("maps auth and permission failures from gh merge commands", async () => {
    const authServer = await createPullRequestTestServer({
      ghAuth: "ok",
      mergeFailure: "auth"
    });
    const authResponse = await fetch(`${authServer.baseUrl}/api/git/pull-requests/428/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "alpha--s1",
        method: "squash",
        expectedHeadSha: "abc123def456"
      })
    });
    expect(authResponse.status).toBe(401);
    const authPayload = (await authResponse.json()) as GitPullRequestMergeResult;
    expect(authPayload.errorCode).toBe("auth");

    const permissionServer = await createPullRequestTestServer({
      ghAuth: "ok",
      mergeFailure: "permission"
    });
    const permissionResponse = await fetch(`${permissionServer.baseUrl}/api/git/pull-requests/428/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "alpha--s1",
        method: "squash",
        expectedHeadSha: "abc123def456"
      })
    });
    expect(permissionResponse.status).toBe(403);
    const permissionPayload = (await permissionResponse.json()) as GitPullRequestMergeResult;
    expect(permissionPayload.errorCode).toBe("permission");
  });

  it("never passes delete-branch or admin flags to gh merge", async () => {
    const root = await mkdtemp(join(tmpdir(), "git-source-control-pr-merge-argv-"));
    const fakeGhPath = await createFakeGhScript(root, "ok", undefined, undefined, {
      mergeBehavior: "success"
    });
    const mainDir = join(root, "main");
    await mkdir(mainDir, { recursive: true });
    await initGitRepo(mainDir, "README.md", "# repo\n", "initial commit");
    await execGit(mainDir, ["remote", "add", "origin", "git@github.com:a-mart/forge.git"]);
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
      hostedProviderOptions: { ghBinary: fakeGhPath }
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

    await fetch(`http://127.0.0.1:${address.port}/api/git/pull-requests/428/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "alpha--s1",
        method: "squash",
        expectedHeadSha: "abc123def456",
        deleteBranchAfterMerge: true
      })
    });

    const mergeLog = await readFile(join(root, "merge-calls.log"), "utf8");
    expect(mergeLog).not.toContain("--delete-branch");
    expect(mergeLog).not.toContain("--admin");

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(root, { recursive: true, force: true });
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
  await configureGitTestIdentity(cwd);
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

async function createGitUpstreamTrackingFailureShim(root: string): Promise<string> {
  const binDir = join(root, "git-shim");
  await mkdir(binDir, { recursive: true });
  const realGit = (await execFileAsync("which", ["git"], { encoding: "utf8" })).stdout.trim();
  if (!realGit) {
    throw new Error("Unable to locate the real git binary for the tracking-failure shim.");
  }
  const shimPath = join(binDir, "git");
  await writeFile(
    shimPath,
    `#!/bin/sh
if [ "$1" = "branch" ]; then
  for arg in "$@"; do
    case "$arg" in
      --set-upstream-to=*)
        echo "Published branch, but could not set upstream tracking." >&2
        exit 1
        ;;
    esac
  done
fi
exec ${JSON.stringify(realGit)} "$@"
`,
    "utf8"
  );
  await chmod(shimPath, 0o755);
  return binDir;
}

async function execGitCapture(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8"
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr
  };
}

async function createRemoteBackedTestServer(options: {
  aheadOnRemote?: boolean;
  aheadOnLocal?: boolean;
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

  if (options.aheadOnLocal) {
    await writeFile(join(mainDir, "local-only.txt"), "local\n", "utf8");
    await execGit(mainDir, ["add", "local-only.txt"]);
    await execGit(mainDir, ["commit", "-m", "local unpublished commit"]);
  }

  if (options.diverged) {
    await writeFile(join(mainDir, "local-only.txt"), "local\n", "utf8");
    await execGit(mainDir, ["add", "local-only.txt"]);
    await execGit(mainDir, ["commit", "-m", "local divergence"]);

    await execGit(root, ["clone", "-b", "main", bareDir, remoteCloneDir]);
    await configureGitTestIdentity(remoteCloneDir);
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

async function createPullRequestTestServer(options: {
  ghAuth: "ok" | "fail";
  ghBinary?: string;
  branch?: string;
  detailFailure?: "not_found" | "rate_limit" | "timeout" | "auth" | "permission";
  listFailure?: "rate_limit" | "timeout" | "network" | "permission";
  ghTimeoutMs?: number;
  mergeBehavior?: "success" | "stale_head" | "submitted";
  detailCheckStatus?: "success" | "failure" | "pending";
  mergeFailure?: "auth" | "permission";
  repoMergeSettings?: {
    mergeCommitAllowed: boolean;
    squashMergeAllowed: boolean;
    rebaseMergeAllowed: boolean;
  };
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
      detailCheckStatus: options.detailCheckStatus,
      mergeFailure: options.mergeFailure,
      repoMergeSettings: options.repoMergeSettings
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
    mergeBehavior?: "success" | "stale_head" | "submitted";
    detailCheckStatus?: "success" | "failure" | "pending";
    mergeFailure?: "auth" | "permission";
    repoMergeSettings?: {
      mergeCommitAllowed: boolean;
      squashMergeAllowed: boolean;
      rebaseMergeAllowed: boolean;
    };
  } = {}
): Promise<string> {
  const fakeGhPath = join(root, "fake-gh");
  const mergeLogPath = join(root, "merge-calls.log");
  const viewCountPath = join(root, "view-count.log");
  const repoMergeSettingsJson = JSON.stringify(
    options.repoMergeSettings ?? {
      mergeCommitAllowed: true,
      squashMergeAllowed: true,
      rebaseMergeAllowed: true
    }
  );
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
  process.stdout.write(${JSON.stringify(repoMergeSettingsJson)});
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
  return fakeGhPath;
}
