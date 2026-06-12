import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  AgentDescriptor,
  GitBranchListResult,
  GitFetchResult,
  GitMutationResult,
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

async function initGitRepo(cwd: string, relativePath: string, content: string, message: string): Promise<void> {
  await mkdir(join(cwd, dirnameSafe(relativePath)), { recursive: true });
  await writeFile(join(cwd, relativePath), content, "utf8");
  await execGit(cwd, ["init", "-b", "main"]);
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

async function execGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    encoding: "utf8"
  });
}

async function fetchBranches(
  server: TestServer,
  agentId: string,
  options: { worktreeId?: string } = {}
): Promise<GitBranchListResult> {
  const params = new URLSearchParams({ agentId });
  if (options.worktreeId) {
    params.set("worktreeId", options.worktreeId);
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
