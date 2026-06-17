import { afterEach, describe, expect, it, vi } from "vitest";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileDeleteResponse } from "@forge/protocol";
import { createFileBrowserRoutes } from "../../../routes/file-browser-routes.js";
import { applyCorsHeaders, sendJson } from "../../../http-utils.js";

interface TestServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

const activeServers: TestServer[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("file browser delete", () => {
  it("deletes files and folders within cwd with path whitespace preserved", async () => {
    const harness = await createHarness();
    const spacedFile = " foo.txt";
    await writeFile(join(harness.workspaceDir, spacedFile), "leading-space\n", "utf8");
    await mkdir(join(harness.workspaceDir, "nested"), { recursive: true });
    await writeFile(join(harness.workspaceDir, "nested", "child.txt"), "child\n", "utf8");

    const fileDelete = await fetch(
      `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent(spacedFile)}`,
      { method: "DELETE" },
    );
    expect(fileDelete.status).toBe(200);
    expect((await fileDelete.json()) as FileDeleteResponse).toEqual({
      success: true,
      path: spacedFile,
      entryType: "file",
    });

    const folderDelete = await fetch(
      `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent("nested")}`,
      { method: "DELETE" },
    );
    expect(folderDelete.status).toBe(200);
    expect((await folderDelete.json()) as FileDeleteResponse).toEqual({
      success: true,
      path: "nested",
      entryType: "directory",
    });

    await expect(readFile(join(harness.workspaceDir, spacedFile), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(harness.workspaceDir, "nested", "child.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects workspace root deletion and traversal escapes", async () => {
    const harness = await createHarness();
    await writeFile(join(harness.workspaceDir, "safe.txt"), "safe\n", "utf8");

    const rootDelete = await fetch(
      `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent(".")}`,
      { method: "DELETE" },
    );
    expect(rootDelete.status).toBe(400);

    const traversalDelete = await fetch(
      `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent("../escape.txt")}`,
      { method: "DELETE" },
    );
    expect(traversalDelete.status).toBe(403);

    const outsideRoot = join(harness.root, "outside.txt");
    await writeFile(outsideRoot, "outside\n", "utf8");
    const outsideDelete = await fetch(
      `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent("../../outside.txt")}`,
      { method: "DELETE" },
    );
    expect(outsideDelete.status).toBe(403);
    await expect(readFile(outsideRoot, "utf8")).resolves.toBe("outside\n");
  });

  it("rejects outside-target symlink traversal and deletes only in-workspace symlinks", async () => {
    const harness = await createHarness();
    const outsideDir = join(harness.root, "outside");
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, "secret.txt"), "secret\n", "utf8");
    await symlink(outsideDir, join(harness.workspaceDir, "escape-link"));

    const symlinkDelete = await fetch(
      `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent("escape-link")}`,
      { method: "DELETE" },
    );
    expect(symlinkDelete.status).toBe(200);
    expect((await symlinkDelete.json()) as FileDeleteResponse).toEqual({
      success: true,
      path: "escape-link",
      entryType: "directory",
    });
    await expect(access(join(harness.workspaceDir, "escape-link"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(outsideDir, "secret.txt"), "utf8")).resolves.toBe("secret\n");

    await symlink(outsideDir, join(harness.workspaceDir, "escape-link"));
    const traversalDelete = await fetch(
      `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent("escape-link/secret.txt")}`,
      { method: "DELETE" },
    );
    expect(traversalDelete.status).toBe(403);
  });

  it("rejects deletes through nested paths behind outside-target symlinks", async () => {
    const harness = await createHarness();
    const outsideNested = join(harness.root, "outside-nested");
    await mkdir(join(outsideNested, "nested"), { recursive: true });
    await writeFile(join(outsideNested, "nested", "leaf.txt"), "leaf\n", "utf8");
    await symlink(outsideNested, join(harness.workspaceDir, "middle"));

    const traversalDelete = await fetch(
      `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent("middle/nested/leaf.txt")}`,
      { method: "DELETE" },
    );
    expect(traversalDelete.status).toBe(403);
    await expect(readFile(join(outsideNested, "nested", "leaf.txt"), "utf8")).resolves.toBe("leaf\n");
  });

  it("deletes internal file and directory symlinks without removing their targets", async () => {
    const harness = await createHarness();
    const targetFile = join(harness.workspaceDir, "target.txt");
    const fileLink = join(harness.workspaceDir, "file-link");
    await writeFile(targetFile, "target-content\n", "utf8");
    await symlink(targetFile, fileLink);

    const targetDir = join(harness.workspaceDir, "target-dir");
    const dirLink = join(harness.workspaceDir, "dir-link");
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, "kept.txt"), "kept\n", "utf8");
    await symlink(targetDir, dirLink);

    const fileLinkDelete = await fetch(
      `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent("file-link")}`,
      { method: "DELETE" },
    );
    expect(fileLinkDelete.status).toBe(200);
    expect((await fileLinkDelete.json()) as FileDeleteResponse).toEqual({
      success: true,
      path: "file-link",
      entryType: "file",
    });

    const dirLinkDelete = await fetch(
      `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent("dir-link")}`,
      { method: "DELETE" },
    );
    expect(dirLinkDelete.status).toBe(200);
    expect((await dirLinkDelete.json()) as FileDeleteResponse).toEqual({
      success: true,
      path: "dir-link",
      entryType: "directory",
    });

    await expect(access(fileLink)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(dirLink)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(targetFile, "utf8")).resolves.toBe("target-content\n");
    await expect(readFile(join(targetDir, "kept.txt"), "utf8")).resolves.toBe("kept\n");
  });

  it("records tracked deletes", async () => {
    const harness = await createHarness();
    const trackedPath = join(harness.workspaceDir, "tracked.txt");
    await writeFile(trackedPath, "tracked\n", "utf8");
    const workspaceRoot = await realpath(harness.workspaceDir);
    const resolvedTrackedPath = join(workspaceRoot, "tracked.txt");
    const recordMutation = vi.fn(async () => true);
    harness.swarmManager.getVersioningService = () => ({
      isTrackedPath: (pathValue: string) => pathValue === resolvedTrackedPath || pathValue === trackedPath,
      recordMutation,
    }) as never;

    const trackedDelete = await fetch(
      `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent("tracked.txt")}`,
      { method: "DELETE" },
    );
    expect(trackedDelete.status).toBe(200);
    expect(recordMutation).toHaveBeenCalledWith({
      path: resolvedTrackedPath,
      action: "delete",
      source: "api-write-file",
      agentId: "manager-1",
    });
  });

  it("returns 404 for missing paths", async () => {
    const harness = await createHarness();
    const response = await fetch(
      `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent("missing.txt")}`,
      { method: "DELETE" },
    );
    expect(response.status).toBe(404);
  });
});

async function createHarness(): Promise<{
  root: string;
  workspaceDir: string;
  swarmManager: any;
  server: TestServer;
}> {
  const root = await mkdtemp(join(tmpdir(), "file-browser-delete-test-"));
  tempRoots.push(root);

  const workspaceDir = join(root, "workspace");
  const dataDir = join(root, "data");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(join(dataDir, "uploads"), { recursive: true });

  const swarmManager: any = {
    getConfig: () => ({
      paths: {
        rootDir: root,
        dataDir,
        uploadsDir: join(dataDir, "uploads"),
      },
      cwdAllowlistRoots: [root],
    }),
    getAgent: (agentId: string) => {
      if (agentId === "manager-1") {
        return {
          agentId: "manager-1",
          role: "manager",
          cwd: workspaceDir,
        };
      }

      return undefined;
    },
    getVersioningService: () => undefined,
  };

  return {
    root,
    workspaceDir,
    swarmManager,
    server: await startRouteServer(swarmManager),
  };
}

async function startRouteServer(swarmManager: any): Promise<TestServer> {
  const routes = createFileBrowserRoutes({ swarmManager });
  const server = createServer((request, response) => {
    void handleRouteRequest(routes, request, response);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve test server address");
  }

  const testServer: TestServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
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
    },
  };

  activeServers.push(testServer);
  return testServer;
}

async function handleRouteRequest(
  routes: Array<{
    methods: string;
    matches: (pathname: string) => boolean;
    handle: (request: IncomingMessage, response: ServerResponse, requestUrl: URL) => Promise<void>;
  }>,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const route = routes.find((candidate) => candidate.matches(requestUrl.pathname));
  if (!route) {
    response.statusCode = 404;
    response.end();
    return;
  }

  try {
    await route.handle(request, response, requestUrl);
  } catch (error) {
    if (response.writableEnded || response.headersSent) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    applyCorsHeaders(request, response, route.methods);
    sendJson(response, 500, { error: message });
  }
}
