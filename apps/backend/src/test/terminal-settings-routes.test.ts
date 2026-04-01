import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AvailableTerminalShell, GetAvailableTerminalShellsResponse, GetTerminalSettingsResponse } from "@forge/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalSettingsService } from "../terminal/terminal-settings-service.js";
import { createTerminalRoutes } from "../ws/routes/terminal-routes.js";

interface TestServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

const activeServers: TestServer[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("terminal settings routes", () => {
  it("returns the effective default shell from settings or env", async () => {
    const dataDir = await createTempDataDir();
    const settingsService = new TerminalSettingsService({
      dataDir,
      env: { FORGE_TERMINAL_DEFAULT_SHELL: "/bin/bash" },
    });
    await settingsService.load();

    const server = await createTerminalSettingsTestServer({
      settingsService,
      discoverShells: async () => [],
    });

    const response = await fetch(`${server.baseUrl}/api/terminals/settings`);
    expect(response.status).toBe(200);

    const payload = await response.json() as GetTerminalSettingsResponse;
    expect(payload.settings).toEqual({
      defaultShell: "/bin/bash",
      persistedDefaultShell: null,
      source: "env",
    });
  });

  it("persists updates and returns discovered shells", async () => {
    const dataDir = await createTempDataDir();
    const settingsService = new TerminalSettingsService({ dataDir, env: {} });
    await settingsService.load();

    let requestedShell: string | undefined;
    const shells: AvailableTerminalShell[] = [
      { path: "/bin/zsh", name: "Zsh", available: true },
      { path: "/bin/bash", name: "Bash", available: true },
    ];

    const server = await createTerminalSettingsTestServer({
      settingsService,
      discoverShells: async (currentDefaultShell) => {
        requestedShell = currentDefaultShell;
        return shells;
      },
    });

    const updateResponse = await fetch(`${server.baseUrl}/api/terminals/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultShell: "/bin/zsh" }),
    });
    expect(updateResponse.status).toBe(200);

    const shellsResponse = await fetch(`${server.baseUrl}/api/terminals/available-shells`);
    expect(shellsResponse.status).toBe(200);

    const payload = await shellsResponse.json() as GetAvailableTerminalShellsResponse;
    expect(requestedShell).toBe("/bin/zsh");
    expect(payload.settings).toEqual({
      defaultShell: "/bin/zsh",
      persistedDefaultShell: "/bin/zsh",
      source: "settings",
    });
    expect(payload.shells).toEqual(shells);
  });

  it("rejects invalid settings payloads", async () => {
    const dataDir = await createTempDataDir();
    const settingsService = new TerminalSettingsService({ dataDir, env: {} });
    await settingsService.load();

    const server = await createTerminalSettingsTestServer({
      settingsService,
      discoverShells: async () => [],
    });

    const response = await fetch(`${server.baseUrl}/api/terminals/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultShell: 42 }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json() as { error?: string };
    expect(payload.error).toContain("defaultShell must be a string or null");
  });
});

async function createTempDataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "terminal-settings-routes-"));
  tempRoots.push(root);
  return join(root, "data");
}

async function createTerminalSettingsTestServer(options: {
  settingsService: TerminalSettingsService;
  discoverShells: (currentDefaultShell?: string) => Promise<AvailableTerminalShell[]>;
}): Promise<TestServer> {
  const routes = createTerminalRoutes({
    terminalService: {} as any,
    settingsService: options.settingsService,
    discoverShells: options.discoverShells,
  });

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
  routes: ReturnType<typeof createTerminalRoutes>,
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

  await route.handle(request, response, requestUrl);
}
