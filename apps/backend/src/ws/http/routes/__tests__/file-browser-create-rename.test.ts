import { afterEach, describe, expect, it, vi } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileCreateResponse, FileRenameResponse } from "@forge/protocol";
import { createFileBrowserRoutes } from "../file-browser-routes.js";
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

describe("file browser create and rename", () => {
  it("creates empty files in the requested directory with path whitespace preserved", async () => {
    const harness = await createHarness();
    await mkdir(join(harness.workspaceDir, "src"), { recursive: true });

    const response = await fetch(`${harness.server.baseUrl}/api/files/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "manager-1",
        directoryPath: "src",
        name: " new file.txt",
        type: "file",
      }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as FileCreateResponse).toEqual({
      success: true,
      path: "src/ new file.txt",
      entryType: "file",
    });
    await expect(readFile(join(harness.workspaceDir, "src", " new file.txt"), "utf8")).resolves.toBe("");
  });

  it("renames files and directories within cwd", async () => {
    const harness = await createHarness();
    await writeFile(join(harness.workspaceDir, "old.txt"), "content\n", "utf8");
    await mkdir(join(harness.workspaceDir, "folder"), { recursive: true });
    await writeFile(join(harness.workspaceDir, "folder", "child.txt"), "child\n", "utf8");

    const fileRename = await fetch(`${harness.server.baseUrl}/api/files/rename`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "manager-1", path: "old.txt", newName: "new.txt" }),
    });
    expect(fileRename.status).toBe(200);
    expect((await fileRename.json()) as FileRenameResponse).toEqual({
      success: true,
      path: "old.txt",
      newPath: "new.txt",
      entryType: "file",
    });

    const dirRename = await fetch(`${harness.server.baseUrl}/api/files/rename`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "manager-1", path: "folder", newName: "renamed" }),
    });
    expect(dirRename.status).toBe(200);
    expect((await dirRename.json()) as FileRenameResponse).toEqual({
      success: true,
      path: "folder",
      newPath: "renamed",
      entryType: "directory",
    });

    await expect(readFile(join(harness.workspaceDir, "new.txt"), "utf8")).resolves.toBe("content\n");
    await expect(readFile(join(harness.workspaceDir, "renamed", "child.txt"), "utf8")).resolves.toBe("child\n");
    await expect(access(join(harness.workspaceDir, "old.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects traversal, nested names, root rename, and overwrites", async () => {
    const harness = await createHarness();
    await writeFile(join(harness.workspaceDir, "old.txt"), "old\n", "utf8");
    await writeFile(join(harness.workspaceDir, "exists.txt"), "exists\n", "utf8");

    const rootRename = await fetch(`${harness.server.baseUrl}/api/files/rename`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "manager-1", path: ".", newName: "renamed" }),
    });
    expect(rootRename.status).toBe(400);

    const nestedName = await fetch(`${harness.server.baseUrl}/api/files/rename`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "manager-1", path: "old.txt", newName: "nested/name.txt" }),
    });
    expect(nestedName.status).toBe(400);

    const overwrite = await fetch(`${harness.server.baseUrl}/api/files/rename`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "manager-1", path: "old.txt", newName: "exists.txt" }),
    });
    expect(overwrite.status).toBe(409);

    const traversalCreate = await fetch(`${harness.server.baseUrl}/api/files/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "manager-1", directoryPath: "..", name: "escape.txt", type: "file" }),
    });
    expect(traversalCreate.status).toBe(403);
  });

  it("rejects create and rename through outside-target symlink parents", async () => {
    const harness = await createHarness();
    const outsideDir = join(harness.root, "outside");
    await mkdir(outsideDir, { recursive: true });
    await symlink(outsideDir, join(harness.workspaceDir, "escape-link"));

    const createThroughSymlink = await fetch(`${harness.server.baseUrl}/api/files/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "manager-1", directoryPath: "escape-link", name: "created.txt", type: "file" }),
    });
    expect(createThroughSymlink.status).toBe(403);

    await writeFile(join(outsideDir, "secret.txt"), "secret\n", "utf8");
    const renameThroughSymlink = await fetch(`${harness.server.baseUrl}/api/files/rename`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "manager-1", path: "escape-link/secret.txt", newName: "renamed.txt" }),
    });
    expect(renameThroughSymlink.status).toBe(403);
    await expect(readFile(join(outsideDir, "secret.txt"), "utf8")).resolves.toBe("secret\n");
  });
});

async function createHarness(): Promise<{
  root: string;
  workspaceDir: string;
  swarmManager: any;
  server: TestServer;
}> {
  const root = await mkdtemp(join(tmpdir(), "file-browser-create-rename-test-"));
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
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
  activeServers.push(testServer);
  return testServer;
}

async function handleRouteRequest(
  routes: ReturnType<typeof createFileBrowserRoutes>,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const route = routes.find((candidate) => candidate.matches(requestUrl.pathname));
  if (!route) {
    applyCorsHeaders(request, response);
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  await route.handle(request, response, requestUrl);
}
