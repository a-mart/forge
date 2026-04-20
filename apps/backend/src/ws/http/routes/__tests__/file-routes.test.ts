import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { createFileRoutes } from "../../../routes/file-routes.js";
import { createFileBrowserRoutes } from "../../../routes/file-browser-routes.js";
import { applyCorsHeaders, sendJson } from "../../../http-utils.js";
import { getCommonKnowledgePath, getProfileMemoryPath } from "../../../../swarm/data-paths.js";
import { getAvailablePort } from "../../../../test-support/index.js";
import {
  WsServerTestSwarmManager as TestSwarmManager,
  bootWsServerTestManager as bootWithDefaultManager,
  makeWsServerTempConfig as makeTempConfig,
} from "../../../../test-support/ws-integration-harness.js";
import { SwarmWebSocketServer } from "../../../server.js";

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

describe("file routes", () => {
  it("reads files as JSON via POST and raw bytes via GET", async () => {
    const harness = await createFileRouteHarness();
    const filePath = join(harness.workspaceDir, "notes.txt");
    await writeFile(filePath, "hello world\n", "utf8");

    const postResponse = await fetch(`${harness.server.baseUrl}/api/read-file`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: filePath, agentId: "manager-1" }),
    });
    expect(postResponse.status).toBe(200);
    await expect(postResponse.json()).resolves.toEqual({
      path: filePath,
      content: "hello world\n",
    });

    const getResponse = await fetch(
      `${harness.server.baseUrl}/api/read-file?path=${encodeURIComponent(filePath)}&agentId=manager-1`,
    );
    expect(getResponse.status).toBe(200);
    expect(getResponse.headers.get("content-type")).toBe("application/octet-stream");
    await expect(getResponse.text()).resolves.toBe("hello world\n");
  });

  it("returns 404 for unknown agents and allows absolute reads outside the agent cwd", async () => {
    const harness = await createFileRouteHarness();
    const outsideFile = join(harness.root, "outside.txt");
    await writeFile(outsideFile, "outside workspace\n", "utf8");

    const unknownAgentResponse = await fetch(`${harness.server.baseUrl}/api/read-file`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "anything", agentId: "missing-agent" }),
    });
    expect(unknownAgentResponse.status).toBe(404);
    await expect(unknownAgentResponse.json()).resolves.toEqual({ error: "Unknown agent: missing-agent" });

    const outsideResponse = await fetch(`${harness.server.baseUrl}/api/read-file`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: outsideFile, agentId: "manager-1" }),
    });
    expect(outsideResponse.status).toBe(200);
    await expect(outsideResponse.json()).resolves.toEqual({
      path: outsideFile,
      content: "outside workspace\n",
    });
  });

  it("serves attachment bytes and rejects invalid attachment references", async () => {
    const harness = await createFileRouteHarness();
    await writeFile(join(harness.uploadsDir, "image.png"), "png-data", "utf8");

    const goodResponse = await fetch(`${harness.server.baseUrl}/api/attachments/image.png`);
    expect(goodResponse.status).toBe(200);
    expect(goodResponse.headers.get("content-type")).toBe("image/png");
    await expect(goodResponse.text()).resolves.toBe("png-data");

    const badResponse = await fetch(`${harness.server.baseUrl}/api/attachments/${encodeURIComponent("../secret.txt")}`);
    expect(badResponse.status).toBe(400);
    await expect(badResponse.json()).resolves.toEqual({ error: "Invalid attachment reference." });
  });

  it("writes files and records versioning mutations with the default source", async () => {
    const harness = await createFileRouteHarness();
    const recordMutation = vi.fn(async () => undefined);
    harness.swarmManager.getVersioningService = () => ({ recordMutation }) as never;

    const filePath = join(harness.workspaceDir, "created", "file.txt");
    const response = await fetch(`${harness.server.baseUrl}/api/write-file`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: filePath, content: "new content" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, bytesWritten: 11 });
    await expect(readFile(filePath, "utf8")).resolves.toBe("new content");
    expect(recordMutation).toHaveBeenCalledWith({
      path: filePath,
      action: "write",
      source: "api-write-file",
    });
  });

  it("validates write-file payloads and versioningSource", async () => {
    const harness = await createFileRouteHarness();

    const missingContent = await fetch(`${harness.server.baseUrl}/api/write-file`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: join(harness.workspaceDir, "a.txt") }),
    });
    expect(missingContent.status).toBe(400);
    await expect(missingContent.json()).resolves.toEqual({ error: "content must be a string." });

    const invalidVersioningSource = await fetch(`${harness.server.baseUrl}/api/write-file`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: join(harness.workspaceDir, "a.txt"),
        content: "x",
        versioningSource: "invalid-source",
      }),
    });
    expect(invalidVersioningSource.status).toBe(500);
    await expect(invalidVersioningSource.json()).resolves.toEqual({
      error: "versioningSource must be one of: api-write-file, api-write-file-restore.",
    });
  });

  it("lists directories through file-browser routes while filtering non-git noisy entries", async () => {
    const harness = await createFileRouteHarness();
    await mkdir(join(harness.workspaceDir, "src"), { recursive: true });
    await mkdir(join(harness.workspaceDir, "node_modules"), { recursive: true });
    await writeFile(join(harness.workspaceDir, "README.md"), "# Readme\n", "utf8");
    await writeFile(join(harness.workspaceDir, "src", "index.ts"), "export const value = 1;\n", "utf8");

    const response = await fetch(
      `${harness.server.baseUrl}/api/files/list?agentId=manager-1&path=${encodeURIComponent(".")}`,
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      cwd: string;
      path: string;
      entries: Array<{ name: string; type: string }>;
      isGitRepo: boolean;
      repoName: string;
      branch: string | null;
    };
    expect(payload.cwd).toBe(harness.workspaceDir);
    expect(payload.path).toBe("");
    expect(payload.isGitRepo).toBe(false);
    expect(payload.entries).toEqual([
      { name: "src", type: "directory" },
      { name: "README.md", type: "file", size: 9, extension: "md" },
    ]);
  });

  it("searches non-git workspaces as unavailable and reads file-browser content", async () => {
    const harness = await createFileRouteHarness();
    await mkdir(join(harness.workspaceDir, "src"), { recursive: true });
    await writeFile(join(harness.workspaceDir, "src", "index.ts"), "line one\nline two\n", "utf8");

    const searchResponse = await fetch(
      `${harness.server.baseUrl}/api/files/search?agentId=manager-1&query=${encodeURIComponent("index")}`,
    );
    expect(searchResponse.status).toBe(200);
    await expect(searchResponse.json()).resolves.toEqual({
      results: [],
      totalMatches: 0,
      unavailable: true,
    });

    const contentResponse = await fetch(
      `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent("src/index.ts")}`,
    );
    expect(contentResponse.status).toBe(200);
    await expect(contentResponse.json()).resolves.toEqual({
      content: "line one\nline two\n",
      binary: false,
      size: 18,
      lines: 3,
    });
  });

  it("rejects file-browser traversal outside the agent cwd", async () => {
    const harness = await createFileRouteHarness();
    const response = await fetch(
      `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent("../secret.txt")}`,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Path is outside CWD." });
  });

  it("hides symlinked directories that resolve outside the cwd", async () => {
    const harness = await createFileRouteHarness();
    const outsideDir = join(harness.root, "outside");
    await mkdir(outsideDir, { recursive: true });
    await symlink(outsideDir, join(harness.workspaceDir, "external-link"), "dir");

    const response = await fetch(`${harness.server.baseUrl}/api/files/list?agentId=manager-1`);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { entries: Array<{ name: string }> };
    expect(payload.entries.some((entry) => entry.name === "external-link")).toBe(false);
  });
});

async function createFileRouteHarness(): Promise<{
  root: string;
  workspaceDir: string;
  uploadsDir: string;
  swarmManager: any;
  server: TestServer;
}> {
  const root = await mkdtemp(join(tmpdir(), "file-routes-test-"));
  tempRoots.push(root);

  const workspaceDir = join(root, "workspace");
  const dataDir = join(root, "data");
  const uploadsDir = join(dataDir, "uploads");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(uploadsDir, { recursive: true });

  const swarmManager: any = {
    getConfig: () => ({
      paths: {
        rootDir: root,
        dataDir,
        uploadsDir,
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

  const routes = [
    ...createFileRoutes({ swarmManager }),
    ...createFileBrowserRoutes({ swarmManager }),
  ];
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
  return { root, workspaceDir, uploadsDir, swarmManager, server: testServer };
}

async function handleRouteRequest(
  routes: Array<{ methods: string; matches: (pathname: string) => boolean; handle: (request: IncomingMessage, response: ServerResponse, requestUrl: URL) => Promise<void> }>,
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
    const statusCode =
      message.includes("must be") ||
      message.includes("Invalid") ||
      message.includes("Missing") ||
      message.includes("too large")
        ? 400
        : 500;

    applyCorsHeaders(request, response, route.methods);
    sendJson(response, statusCode, { error: message });
  }
}

describe("SwarmWebSocketServer", () => {

  it('reads allowed files through POST /api/read-file', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const artifactPath = join(config.paths.rootDir, 'artifact.md')
    const artifactContent = '# Artifact\n\nHello from Swarm.\n'
    await writeFile(artifactPath, artifactContent, 'utf8')

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/read-file`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          path: artifactPath,
        }),
      })

      expect(response.status).toBe(200)
      const payload = (await response.json()) as { path: string; content: string }

      expect(payload.path).toBe(artifactPath)
      expect(payload.content).toBe(artifactContent)
    } finally {
      await server.stop()
    }
  })

  it('allows absolute files through POST /api/read-file', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const outsideFile = join(tmpdir(), `forge-read-file-${process.pid}-${Date.now()}.txt`)
    const outsideContent = 'outside root\n'
    await writeFile(outsideFile, outsideContent, 'utf8')

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/read-file`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          path: outsideFile,
        }),
      })

      expect(response.status).toBe(200)

      const payload = (await response.json()) as { path: string; content: string }
      expect(payload.path).toBe(outsideFile)
      expect(payload.content).toBe(outsideContent)
    } finally {
      await rm(outsideFile, { force: true })
      await server.stop()
    }
  })

  it('resolves relative /api/read-file paths against the requested agent workspace', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const workspaceDir = join(config.paths.rootDir, 'worktrees', 'session-a')
    await mkdir(workspaceDir, { recursive: true })

    const secondary = await manager.createManager('manager', {
      name: 'Workspace Manager',
      cwd: workspaceDir,
    })

    const workspaceFile = join(workspaceDir, 'notes.md')
    await writeFile(workspaceFile, '# Workspace\n', 'utf8')

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/read-file`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          path: 'notes.md',
          agentId: secondary.agentId,
        }),
      })

      expect(response.status).toBe(200)
      const payload = (await response.json()) as { path: string; content: string }
      expect(normalize(await realpath(payload.path))).toBe(normalize(await realpath(workspaceFile)))
      expect(payload.content).toBe('# Workspace\n')
    } finally {
      await server.stop()
    }
  })

  it('allows data-dir reads with agent context and absolute reads outside the contextual workspace', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const workspaceDir = join(config.paths.rootDir, 'worktrees', 'session-b')
    await mkdir(workspaceDir, { recursive: true })

    const secondary = await manager.createManager('manager', {
      name: 'Context Manager',
      cwd: workspaceDir,
    })

    const outsideWorkspaceFile = join(config.paths.rootDir, 'root-only.md')
    await writeFile(outsideWorkspaceFile, 'root only\n', 'utf8')

    const profileMemoryPath = getProfileMemoryPath(config.paths.dataDir, secondary.agentId)
    await mkdir(dirname(profileMemoryPath), { recursive: true })
    await writeFile(profileMemoryPath, '# Profile Memory\n', 'utf8')

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const outsideResponse = await fetch(`http://${config.host}:${config.port}/api/read-file`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          path: outsideWorkspaceFile,
          agentId: secondary.agentId,
        }),
      })

      expect(outsideResponse.status).toBe(200)
      await expect(outsideResponse.json()).resolves.toEqual({
        path: outsideWorkspaceFile,
        content: 'root only\n',
      })

      const allowedResponse = await fetch(`http://${config.host}:${config.port}/api/read-file`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          path: profileMemoryPath,
          agentId: secondary.agentId,
        }),
      })

      expect(allowedResponse.status).toBe(200)
      const payload = (await allowedResponse.json()) as { path: string; content: string }
      expect(payload.path).toBe(profileMemoryPath)
      expect(payload.content).toBe('# Profile Memory\n')
    } finally {
      await server.stop()
    }
  })

  it('writes files through POST /api/write-file and creates parent directories', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const targetPath = join(config.paths.rootDir, 'knowledge', 'notes.md')
    const content = '# Notes\n\nSaved from dashboard.\n'

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/write-file`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          path: targetPath,
          content,
        }),
      })

      expect(response.status).toBe(200)
      const payload = (await response.json()) as { success: boolean; bytesWritten: number }

      expect(payload).toEqual({
        success: true,
        bytesWritten: Buffer.byteLength(content, 'utf8'),
      })

      const savedContent = await readFile(targetPath, 'utf8')
      expect(savedContent).toBe(content)
    } finally {
      await server.stop()
    }
  })

  it('records versioning mutations for tracked data-dir writes through POST /api/write-file', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)
    const recordMutation = vi.fn(async () => true)

    const manager = new TestSwarmManager(config, {
      versioningService: {
        isTrackedPath: () => true,
        recordMutation,
        flushPending: async () => {},
        reconcileNow: async () => {},
      },
    })
    await bootWithDefaultManager(manager, config)
    recordMutation.mockClear()

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const targetPath = getCommonKnowledgePath(config.paths.dataDir)
    const content = '# Common Knowledge\n\nTracked dashboard write.\n'

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/write-file`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          path: targetPath,
          content,
        }),
      })

      expect(response.status).toBe(200)
      expect(recordMutation).toHaveBeenCalledWith({
        path: targetPath,
        action: 'write',
        source: 'api-write-file',
      })
    } finally {
      await server.stop()
    }
  })

  it('records restore mutations for tracked data-dir writes through POST /api/write-file', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)
    const recordMutation = vi.fn(async () => true)

    const manager = new TestSwarmManager(config, {
      versioningService: {
        isTrackedPath: () => true,
        recordMutation,
        flushPending: async () => {},
        reconcileNow: async () => {},
      },
    })
    await bootWithDefaultManager(manager, config)
    recordMutation.mockClear()

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const targetPath = getCommonKnowledgePath(config.paths.dataDir)
    const content = '# Common Knowledge\n\nTracked restore write.\n'

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/write-file`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          path: targetPath,
          content,
          versioningSource: 'api-write-file-restore',
        }),
      })

      expect(response.status).toBe(200)
      expect(recordMutation).toHaveBeenCalledWith({
        path: targetPath,
        action: 'write',
        source: 'api-write-file-restore',
      })
    } finally {
      await server.stop()
    }
  })

  it('writes files through POST /api/write-file inside os.tmpdir()', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const targetPath = join(tmpdir(), `forge-ws-test-${process.pid}-${Date.now()}.md`)
    const content = '# Temp Notes\n\nSaved from tmpdir.\n'

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/write-file`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          path: targetPath,
          content,
        }),
      })

      expect(response.status).toBe(200)
      expect(await readFile(targetPath, 'utf8')).toBe(content)
    } finally {
      await rm(targetPath, { force: true })
      await server.stop()
    }
  })

  it('rejects disallowed files through POST /api/write-file', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const outsideFile =
      process.platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/hosts'

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/write-file`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          path: outsideFile,
          content: 'blocked',
        }),
      })

      expect(response.status).toBe(403)
      const payload = (await response.json()) as { error: string }
      expect(payload.error).toContain('outside allowed roots')
    } finally {
      await server.stop()
    }
  })

})
