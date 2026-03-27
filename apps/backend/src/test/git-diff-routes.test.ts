import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { AgentDescriptor, GitCommitDetail, GitLogResult, GitStatusResult } from "@forge/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { createGitDiffRoutes } from "../ws/routes/git-diff-routes.js";

const execFileAsync = promisify(execFile);

interface TestServer {
  readonly baseUrl: string;
  readonly root: string;
  readonly close: () => Promise<void>;
}

const activeServers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
});

describe("git-diff-routes", () => {
  it("defaults to workspace targeting and returns workspace repo metadata", async () => {
    const server = await createGitDiffTestServer({
      descriptors: [createManagerSession("alpha", "alpha--s1")]
    });

    await initGitRepo(server.workspaceDir, "workspace.txt", "workspace v1\n", "workspace commit");
    await writeFile(join(server.workspaceDir, "workspace.txt"), "workspace v2\n", "utf8");

    const defaultResponse = await fetch(`${server.baseUrl}/api/git/status?agentId=alpha--s1`);
    expect(defaultResponse.status).toBe(200);

    const defaultPayload = (await defaultResponse.json()) as GitStatusResult;
    expect(defaultPayload.repoKind).toBe("workspace");
    expect(defaultPayload.repoLabel).toBe("Workspace");
    expect(defaultPayload.repoRoot).toBe(server.workspaceDir);
    expect(defaultPayload.repoName).toBe(basename(server.workspaceDir));
    expect(defaultPayload.files.map((file) => file.path)).toContain("workspace.txt");

    const explicitResponse = await fetch(
      `${server.baseUrl}/api/git/status?agentId=alpha--s1&repoTarget=workspace`
    );
    expect(explicitResponse.status).toBe(200);

    const explicitPayload = (await explicitResponse.json()) as GitStatusResult;
    expect(explicitPayload.repoKind).toBe("workspace");
    expect(explicitPayload.repoRoot).toBe(server.workspaceDir);
    expect(explicitPayload.files.map((file) => file.path)).toContain("workspace.txt");
  });

  it("routes Cortex versioning requests to the data-dir repo", async () => {
    const server = await createGitDiffTestServer({
      descriptors: [createManagerSession("alpha", "review--s1", { sessionPurpose: "cortex_review" })]
    });

    await initGitRepo(server.workspaceDir, "workspace.txt", "workspace v1\n", "workspace commit");
    await initGitRepo(server.dataDir, "shared/knowledge/common.md", "# Common\n", "knowledge commit");
    await writeFile(join(server.dataDir, "shared/knowledge/common.md"), "# Common\n\n- updated\n", "utf8");

    const statusResponse = await fetch(
      `${server.baseUrl}/api/git/status?agentId=review--s1&repoTarget=versioning`
    );
    expect(statusResponse.status).toBe(200);

    const statusPayload = (await statusResponse.json()) as GitStatusResult;
    expect(statusPayload.repoKind).toBe("versioning");
    expect(statusPayload.repoLabel).toBe("Cortex Knowledge");
    expect(statusPayload.repoRoot).toBe(server.dataDir);
    expect(statusPayload.repoName).toBe(basename(server.dataDir));
    expect(statusPayload.files.map((file) => file.path)).toContain("shared/knowledge/common.md");

    const logResponse = await fetch(
      `${server.baseUrl}/api/git/log?agentId=review--s1&repoTarget=versioning&limit=10&offset=0`
    );
    expect(logResponse.status).toBe(200);

    const logPayload = (await logResponse.json()) as GitLogResult;
    expect(logPayload.notInitialized).toBeUndefined();
    expect(logPayload.commits[0]?.message).toBe("knowledge commit");
  });

  it("returns parsed metadata and numstat in versioning history responses", async () => {
    const server = await createGitDiffTestServer({
      descriptors: [createManagerSession("cortex", "cortex--s1")]
    });

    await initGitRepo(server.dataDir, "profiles/alpha/memory.md", "# Memory\n\n- first\n", "initial knowledge");
    await execGit(server.dataDir, ["mv", "profiles/alpha/memory.md", "profiles/alpha/memory-renamed.md"]);
    await writeFile(
      join(server.dataDir, "profiles/alpha/memory-renamed.md"),
      "# Memory\n\n- second\n- third\n",
      "utf8"
    );
    await commitGit(
      server.dataDir,
      "memory(alpha): merge session alpha--s1",
      [
        "Reason: manual",
        "Source: profile-memory-merge",
        "Profile: alpha",
        "Session: alpha--s1",
        "Agent: alpha-worker-1",
        "Paths:",
        "- profiles/alpha/memory-renamed.md"
      ].join("\n")
    );

    const headSha = (await execGit(server.dataDir, ["rev-parse", "HEAD"])).stdout.trim();

    const logResponse = await fetch(
      `${server.baseUrl}/api/git/log?agentId=cortex--s1&repoTarget=versioning&limit=10&offset=0`
    );
    expect(logResponse.status).toBe(200);

    const logPayload = (await logResponse.json()) as GitLogResult;
    expect(logPayload.commits[0]?.sha).toBe(headSha);
    expect(logPayload.commits[0]?.metadata).toEqual({
      reason: "manual",
      source: "profile-memory-merge",
      sources: ["profile-memory-merge"],
      profileId: "alpha",
      sessionId: "alpha--s1",
      agentId: "alpha-worker-1",
      paths: ["profiles/alpha/memory-renamed.md"]
    });

    const commitResponse = await fetch(
      `${server.baseUrl}/api/git/commit?agentId=cortex--s1&repoTarget=versioning&sha=${headSha}`
    );
    expect(commitResponse.status).toBe(200);

    const commitPayload = (await commitResponse.json()) as GitCommitDetail;
    expect(commitPayload.metadata).toEqual({
      reason: "manual",
      source: "profile-memory-merge",
      sources: ["profile-memory-merge"],
      profileId: "alpha",
      sessionId: "alpha--s1",
      agentId: "alpha-worker-1",
      paths: ["profiles/alpha/memory-renamed.md"]
    });
    expect(commitPayload.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "profiles/alpha/memory-renamed.md",
          additions: expect.any(Number)
        })
      ])
    );
    expect(
      commitPayload.files.some(
        (file) => file.path === "profiles/alpha/memory-renamed.md" && (file.additions ?? 0) > 0
      )
    ).toBe(true);
    expect(commitPayload.files.some((file) => (file.deletions ?? 0) > 0)).toBe(true);
  });

  it("rejects versioning access for non-Cortex sessions", async () => {
    const server = await createGitDiffTestServer({
      descriptors: [createManagerSession("alpha", "alpha--s1")]
    });

    const response = await fetch(
      `${server.baseUrl}/api/git/status?agentId=alpha--s1&repoTarget=versioning`
    );

    expect(response.status).toBe(403);
    const payload = (await response.json()) as { error?: string };
    expect(payload.error).toContain("versioning repo is only available to Cortex sessions");
  });

  it("rejects versioning access for workers whose manager session is not Cortex", async () => {
    const server = await createGitDiffTestServer({
      descriptors: [
        createManagerSession("alpha", "alpha--s1"),
        createWorker("alpha--w1", "alpha--s1", { archetypeId: "cortex" })
      ]
    });

    const response = await fetch(
      `${server.baseUrl}/api/git/status?agentId=alpha--w1&repoTarget=versioning`
    );

    expect(response.status).toBe(403);
    const payload = (await response.json()) as { error?: string };
    expect(payload.error).toContain("versioning repo is only available to Cortex sessions");
  });

  it("returns a graceful empty state when the versioning repo is not initialized", async () => {
    const server = await createGitDiffTestServer({
      descriptors: [createManagerSession("cortex", "cortex--s1")]
    });

    const statusResponse = await fetch(
      `${server.baseUrl}/api/git/status?agentId=cortex--s1&repoTarget=versioning`
    );
    expect(statusResponse.status).toBe(200);

    const statusPayload = (await statusResponse.json()) as GitStatusResult;
    expect(statusPayload.notInitialized).toBe(true);
    expect(statusPayload.repoKind).toBe("versioning");
    expect(statusPayload.repoLabel).toBe("Cortex Knowledge");
    expect(statusPayload.repoRoot).toBe(server.dataDir);
    expect(statusPayload.files).toEqual([]);
    expect(statusPayload.summary).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });

    const logResponse = await fetch(
      `${server.baseUrl}/api/git/log?agentId=cortex--s1&repoTarget=versioning&limit=10&offset=0`
    );
    expect(logResponse.status).toBe(200);

    const logPayload = (await logResponse.json()) as GitLogResult;
    expect(logPayload).toEqual({ commits: [], hasMore: false, notInitialized: true });
  });
});

async function createGitDiffTestServer(options: {
  descriptors: AgentDescriptor[];
}): Promise<TestServer & { workspaceDir: string; dataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "git-diff-routes-"));
  const workspaceDir = join(root, "workspace");
  const dataDir = join(root, "data");
  const descriptorById = new Map(options.descriptors.map((descriptor) => [descriptor.agentId, descriptor]));

  await mkdir(workspaceDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const workspaceRealPath = await realpath(workspaceDir);
  const dataRealPath = await realpath(dataDir);

  for (const descriptor of options.descriptors) {
    descriptor.cwd = workspaceRealPath;
  }

  const swarmManager = {
    getConfig: () => ({ paths: { dataDir: dataRealPath } }),
    getAgent: (agentId: string) => descriptorById.get(agentId)
  } as unknown as SwarmManager;

  const routes = createGitDiffRoutes({ swarmManager });
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

  const testServer: TestServer & { workspaceDir: string; dataDir: string } = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    root,
    workspaceDir: workspaceRealPath,
    dataDir: dataRealPath,
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
  routes: ReturnType<typeof createGitDiffRoutes>,
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
      modelId: "gpt-5.3-codex",
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
    status: "idle",
    createdAt: timestamp,
    updatedAt: timestamp,
    cwd: "/tmp",
    model: {
      provider: "openai-codex",
      modelId: "gpt-5.3-codex",
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

async function commitGit(cwd: string, subject: string, body: string): Promise<void> {
  await execGit(cwd, ["add", "-A"]);
  await execGit(cwd, ["commit", "-m", subject, "-m", body]);
}

function dirnameSafe(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "." : normalized.slice(0, index);
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
