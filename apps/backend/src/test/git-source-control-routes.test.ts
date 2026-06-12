import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentDescriptor, GitWorktreeListResult } from "@forge/protocol";
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
  await execGit(cwd, ["init"]);
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
