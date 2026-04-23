import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CortexFileReviewHistoryResult } from "@forge/protocol";
import { appendCortexReviewRun } from "../swarm/cortex-review-runs.js";
import { appendCortexReviewLogEntry, writeCortexPromotionManifest } from "../swarm/scripts/cortex-review-state.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { createCortexRoutes } from "../ws/routes/cortex-routes.js";

interface TestServer {
  readonly baseUrl: string;
  readonly root: string;
  readonly dataDir: string;
  readonly close: () => Promise<void>;
}

const activeServers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
});

describe("cortex file review history routes", () => {
  it("includes tracked Cortex documents in GET /api/cortex/scan", async () => {
    const server = await createCortexTestServer({ profileIds: ["alpha"] });

    await mkdir(join(server.dataDir, "shared", "knowledge"), { recursive: true });
    await mkdir(join(server.dataDir, "profiles", "alpha", "reference"), { recursive: true });
    await mkdir(join(server.dataDir, "profiles", "alpha", "prompts", "archetypes"), { recursive: true });

    await Promise.all([
      writeFile(join(server.dataDir, "shared", "knowledge", "common.md"), "# Common Knowledge\n", "utf8"),
      writeFile(join(server.dataDir, "shared", "knowledge", ".cortex-notes.md"), "# Cortex Notes\n", "utf8"),
      writeFile(join(server.dataDir, "profiles", "alpha", "memory.md"), "# Swarm Memory\n", "utf8"),
      writeFile(join(server.dataDir, "profiles", "alpha", "reference", "overview.md"), "# Overview\n", "utf8"),
      writeFile(join(server.dataDir, "profiles", "alpha", "prompts", "archetypes", "review.md"), "# Review Prompt\n", "utf8")
    ]);

    const response = await fetch(`${server.baseUrl}/api/cortex/scan`);

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { documents: Array<Record<string, unknown>> };

    expect(payload.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "shared/knowledge/common.md",
          label: "Common Knowledge",
          group: "commonKnowledge",
          surface: "knowledge",
          gitPath: "shared/knowledge/common.md",
          exists: true,
          editable: true
        }),
        expect.objectContaining({
          id: "shared/knowledge/.cortex-notes.md",
          label: "Cortex Notes",
          group: "notes",
          surface: "knowledge",
          gitPath: "shared/knowledge/.cortex-notes.md",
          exists: true,
          editable: true
        }),
        expect.objectContaining({
          id: "profiles/alpha/memory.md",
          label: "Profile Memory: alpha",
          group: "profileMemory",
          surface: "memory",
          gitPath: "profiles/alpha/memory.md",
          profileId: "alpha",
          exists: true,
          editable: true
        }),
        expect.objectContaining({
          id: "profiles/alpha/reference/overview.md",
          label: "alpha / overview.md",
          group: "referenceDocs",
          surface: "reference",
          gitPath: "profiles/alpha/reference/overview.md",
          profileId: "alpha",
          exists: true,
          editable: true
        }),
        expect.objectContaining({
          id: "profiles/alpha/prompts/archetypes/review.md",
          label: "alpha / archetype / review",
          group: "promptOverrides",
          surface: "prompt",
          gitPath: "profiles/alpha/prompts/archetypes/review.md",
          profileId: "alpha",
          exists: true,
          editable: true
        })
      ])
    );
  });

  it("filters review history by tracked file, joins run metadata, and reports manifest existence", async () => {
    const server = await createCortexTestServer();
    const commonKnowledgePath = join(server.dataDir, "shared", "knowledge", "common.md");
    await mkdir(join(server.dataDir, "shared", "knowledge"), { recursive: true });

    await appendCortexReviewRun(server.dataDir, {
      runId: "review-1",
      trigger: "scheduled",
      scope: { mode: "session", profileId: "alpha", sessionId: "alpha--s1", axes: ["memory"] },
      scopeLabel: "alpha/alpha--s1 (memory)",
      requestText: "Review session alpha/alpha--s1 (memory freshness)",
      requestedAt: "2026-03-29T12:00:00.000Z",
      sessionAgentId: "cortex-review-session-1",
      scheduleName: "nightly-cortex"
    });
    await writeCortexPromotionManifest({
      dataDir: server.dataDir,
      reviewId: "review-1",
      content: "# Manifest\n- updated common knowledge"
    });
    await appendCortexReviewLogEntry({
      dataDir: server.dataDir,
      entry: {
        reviewId: "review-1",
        ownerId: "cortex",
        status: "success",
        reviewed: ["alpha/alpha--s1"],
        changedFiles: ["shared/knowledge/common.md", "profiles/alpha/memory.md"],
        notes: ["promoted durable guidance"],
        blockers: [],
        watermarksAdvanced: true,
        recordedAt: "2026-03-29T12:05:00.000Z"
      }
    });
    await appendCortexReviewLogEntry({
      dataDir: server.dataDir,
      entry: {
        reviewId: "review-2",
        ownerId: "cortex",
        status: "no-op",
        reviewed: ["beta/beta--s1"],
        changedFiles: ["profiles/beta/memory.md"],
        notes: [],
        blockers: [],
        watermarksAdvanced: false,
        recordedAt: "2026-03-29T12:10:00.000Z"
      }
    });

    const response = await fetch(
      `${server.baseUrl}/api/cortex/file-review-history?path=${encodeURIComponent(commonKnowledgePath)}&limit=10`
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as CortexFileReviewHistoryResult;
    expect(payload.file).toBe("shared/knowledge/common.md");
    expect(payload.latestRun?.reviewId).toBe("review-1");
    expect(payload.runs).toHaveLength(1);
    expect(payload.runs[0]).toMatchObject({
      reviewId: "review-1",
      status: "success",
      trigger: "scheduled",
      scopeLabel: "alpha/alpha--s1 (memory)",
      sessionAgentId: "cortex-review-session-1",
      scheduleName: "nightly-cortex",
      manifestExists: true,
      changedFiles: ["shared/knowledge/common.md", "profiles/alpha/memory.md"]
    });
    expect(payload.runs[0]?.manifestPath).toBe(join(server.dataDir, "shared", "knowledge", ".cortex-promotion-manifests", "review-1.md"));
  });

  it("returns legacy rows without joined run metadata and reports missing manifests", async () => {
    const server = await createCortexTestServer();

    await appendCortexReviewLogEntry({
      dataDir: server.dataDir,
      entry: {
        reviewId: "review-legacy",
        ownerId: "cortex",
        status: "blocked",
        reviewed: ["alpha/alpha--s2"],
        changedFiles: ["profiles/alpha/memory.md"],
        blockers: ["missing context"],
        notes: [],
        watermarksAdvanced: false,
        recordedAt: "2026-03-29T13:00:00.000Z"
      }
    });

    const response = await fetch(
      `${server.baseUrl}/api/cortex/file-review-history?path=profiles/alpha/memory.md&limit=10`
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as CortexFileReviewHistoryResult;
    expect(payload.runs).toHaveLength(1);
    expect(payload.runs[0]).toMatchObject({
      reviewId: "review-legacy",
      status: "blocked",
      blockers: ["missing context"],
      manifestExists: false
    });
    expect(payload.runs[0]?.trigger).toBeUndefined();
    expect(payload.runs[0]?.scope).toBeUndefined();
  });
});

async function createCortexTestServer(options?: { profileIds?: string[] }): Promise<TestServer> {
  const root = await mkdtemp(join(tmpdir(), "cortex-file-history-routes-"));
  const dataDir = await realpath(await ensureDir(join(root, "data")));

  const swarmManager = {
    getConfig: () => ({ paths: { dataDir } }),
    listUserProfiles: () => (options?.profileIds ?? []).map((profileId) => ({ profileId }))
  } as unknown as SwarmManager;

  const routes = createCortexRoutes({ swarmManager });
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
    dataDir,
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

async function ensureDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return path;
}

async function handleRouteRequest(
  routes: ReturnType<typeof createCortexRoutes>,
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
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Unexpected route error." }));
  }
}
