import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type {
  AgentDescriptor,
  GitCommitDetail,
  GitFileLogResult,
  GitFileSectionProvenanceResult,
  GitLogResult,
  GitStatusResult
} from "@forge/protocol";
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
        "Review-Run: review-123",
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
      reviewRunId: "review-123",
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
      reviewRunId: "review-123",
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

  it("returns file-scoped versioning history with pagination and stats", async () => {
    const server = await createGitDiffTestServer({
      descriptors: [createManagerSession("cortex", "cortex--s1")]
    });

    await initGitRepo(server.dataDir, "profiles/alpha/reference/guide.md", "# Guide\n\n- first\n", "initial guide");
    await execGit(server.dataDir, ["mv", "profiles/alpha/reference/guide.md", "profiles/alpha/reference/guide-renamed.md"]);
    await writeFile(join(server.dataDir, "profiles/alpha/reference/guide-renamed.md"), "# Guide\n\n- second\n", "utf8");
    await commitGit(server.dataDir, "guide update", ["Paths:", "- profiles/alpha/reference/guide-renamed.md"].join("\n"));

    const trackedPath = join(server.dataDir, "profiles/alpha/reference/guide-renamed.md");
    const response = await fetch(
      `${server.baseUrl}/api/git/file-log?agentId=cortex--s1&repoTarget=versioning&file=${encodeURIComponent(trackedPath)}&limit=1&offset=0`
    );
    expect(response.status).toBe(200);

    const payload = (await response.json()) as GitFileLogResult;
    expect(payload.file).toBe("profiles/alpha/reference/guide-renamed.md");
    expect(payload.commits).toHaveLength(1);
    expect(payload.hasMore).toBe(true);
    expect(payload.stats.totalEdits).toBe(2);
    expect(payload.stats.lastModifiedAt).toBe(payload.commits[0]?.date ?? null);

    const secondPageResponse = await fetch(
      `${server.baseUrl}/api/git/file-log?agentId=cortex--s1&repoTarget=versioning&file=profiles/alpha/reference/guide-renamed.md&limit=1&offset=1`
    );
    expect(secondPageResponse.status).toBe(200);
    const secondPage = (await secondPageResponse.json()) as GitFileLogResult;
    expect(secondPage.commits).toHaveLength(1);
    expect(secondPage.hasMore).toBe(false);
  });

  it("returns markdown section provenance for current headings", async () => {
    const server = await createGitDiffTestServer({
      descriptors: [createManagerSession("cortex", "cortex--s1")]
    });

    await initGitRepo(
      server.dataDir,
      "shared/knowledge/common.md",
      [
        "# Common",
        "",
        "## Workflow Preferences",
        "- first",
        "",
        "## Technical Standards",
        "- stable",
        "",
        "## Known Gotchas",
        "- note"
      ].join("\n") + "\n",
      "initial knowledge"
    );

    await writeFile(
      join(server.dataDir, "shared/knowledge", "common.md"),
      [
        "# Common",
        "",
        "## Workflow Preferences",
        "- updated workflow",
        "",
        "## Technical Standards",
        "- stable",
        "",
        "## Known Gotchas",
        "- note"
      ].join("\n") + "\n",
      "utf8"
    );
    await commitGit(
      server.dataDir,
      "update common knowledge",
      [
        "Review-Run: review-2026-03-29-0230",
        "Paths:",
        "- shared/knowledge/common.md"
      ].join("\n")
    );

    const response = await fetch(
      `${server.baseUrl}/api/git/file-section-provenance?agentId=cortex--s1&repoTarget=versioning&file=shared/knowledge/common.md`
    );
    expect(response.status).toBe(200);

    const payload = (await response.json()) as GitFileSectionProvenanceResult;
    expect(payload.file).toBe("shared/knowledge/common.md");
    expect(payload.notInitialized).toBeUndefined();
    expect(payload.sections).toHaveLength(4);

    expect(payload.sections).toEqual(
      expect.arrayContaining([
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
          lastModifiedSummary: "update common knowledge",
          reviewRunId: "review-2026-03-29-0230"
        }),
        expect.objectContaining({
          heading: "Technical Standards",
          level: 2,
          lineStart: 6,
          lineEnd: 8,
          lastModifiedSummary: "initial knowledge",
          reviewRunId: null
        }),
        expect.objectContaining({
          heading: "Known Gotchas",
          level: 2,
          lineStart: 9,
          lineEnd: 11,
          lastModifiedSummary: "initial knowledge",
          reviewRunId: null
        })
      ])
    );
    expect(payload.sections.every((section) => typeof section.lastModifiedSha === "string")).toBe(true);
    expect(payload.sections.every((section) => typeof section.lastModifiedAt === "string")).toBe(true);
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

  it("rejects file-log requests for non-Cortex versioning access", async () => {
    const server = await createGitDiffTestServer({
      descriptors: [createManagerSession("alpha", "alpha--s1")]
    });

    const response = await fetch(
      `${server.baseUrl}/api/git/file-log?agentId=alpha--s1&repoTarget=versioning&file=shared/knowledge/common.md&limit=10&offset=0`
    );

    expect(response.status).toBe(403);
    const payload = (await response.json()) as { error?: string };
    expect(payload.error).toContain("versioning repo is only available to Cortex sessions");
  });

  it("rejects file-section-provenance requests for non-Cortex versioning access", async () => {
    const server = await createGitDiffTestServer({
      descriptors: [createManagerSession("alpha", "alpha--s1")]
    });

    const response = await fetch(
      `${server.baseUrl}/api/git/file-section-provenance?agentId=alpha--s1&repoTarget=versioning&file=shared/knowledge/common.md`
    );

    expect(response.status).toBe(403);
    const payload = (await response.json()) as { error?: string };
    expect(payload.error).toContain("versioning repo is only available to Cortex sessions");
  });

  it("returns section provenance with null commit metadata when the versioning repo is not initialized", async () => {
    const server = await createGitDiffTestServer({
      descriptors: [createManagerSession("cortex", "cortex--s1")]
    });

    await mkdir(join(server.dataDir, "shared", "knowledge"), { recursive: true });
    await writeFile(
      join(server.dataDir, "shared", "knowledge", "common.md"),
      ["# Common", "", "## Workflow Preferences", "- draft"].join("\n") + "\n",
      "utf8"
    );

    const response = await fetch(
      `${server.baseUrl}/api/git/file-section-provenance?agentId=cortex--s1&repoTarget=versioning&file=shared/knowledge/common.md`
    );
    expect(response.status).toBe(200);

    const payload = (await response.json()) as GitFileSectionProvenanceResult;
    expect(payload).toEqual({
      file: "shared/knowledge/common.md",
      sections: [
        {
          heading: "Common",
          level: 1,
          lineStart: 1,
          lineEnd: 2,
          lastModifiedSha: null,
          lastModifiedAt: null,
          lastModifiedSummary: null,
          reviewRunId: null
        },
        {
          heading: "Workflow Preferences",
          level: 2,
          lineStart: 3,
          lineEnd: 5,
          lastModifiedSha: null,
          lastModifiedAt: null,
          lastModifiedSummary: null,
          reviewRunId: null
        }
      ],
      notInitialized: true
    });
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

    const fileLogResponse = await fetch(
      `${server.baseUrl}/api/git/file-log?agentId=cortex--s1&repoTarget=versioning&file=shared/knowledge/common.md&limit=10&offset=0`
    );
    expect(fileLogResponse.status).toBe(200);

    const fileLogPayload = (await fileLogResponse.json()) as GitFileLogResult;
    expect(fileLogPayload).toEqual({
      file: "shared/knowledge/common.md",
      commits: [],
      stats: {
        totalEdits: 0,
        lastModifiedAt: null,
        editsToday: 0,
        editsThisWeek: 0
      },
      hasMore: false,
      notInitialized: true
    });
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
