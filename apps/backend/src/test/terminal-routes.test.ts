import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { TerminalServiceError } from "../terminal/terminal-service.js";
import { TerminalSettingsService } from "../terminal/terminal-settings-service.js";
import { createTerminalRoutes } from "../ws/routes/terminal-routes.js";

interface TestServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

const activeServers: TestServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.FORGE_DESKTOP;
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
});

describe("terminal routes", () => {
  it("lists terminals for a session", async () => {
    const terminalService = {
      listTerminals: vi.fn(() => [
        { terminalId: "term-1", sessionAgentId: "session-1", name: "Shell", cols: 80, rows: 24 },
      ]),
    };
    const server = await createTerminalRouteTestServer({ terminalService });

    const response = await fetch(`${server.baseUrl}/api/terminals?sessionAgentId=session-1`);
    expect(response.status).toBe(200);
    expect(terminalService.listTerminals).toHaveBeenCalledWith("session-1");
    await expect(response.json()).resolves.toEqual({
      terminals: [
        { terminalId: "term-1", sessionAgentId: "session-1", name: "Shell", cols: 80, rows: 24 },
      ],
    });
  });

  it("creates terminals and returns the created descriptor payload", async () => {
    const created = {
      terminalId: "term-1",
      sessionAgentId: "session-1",
      profileId: "profile-a",
      name: "Shell",
      cwd: "/workspace",
      cols: 100,
      rows: 30,
    };
    const terminalService = {
      create: vi.fn(async () => created),
    };
    const server = await createTerminalRouteTestServer({ terminalService });

    const response = await fetch(`${server.baseUrl}/api/terminals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionAgentId: "session-1",
        name: "Shell",
        shell: "/bin/zsh",
        shellArgs: ["-l"],
        cwd: "/workspace",
        cols: 100,
        rows: 30,
      }),
    });

    expect(response.status).toBe(201);
    expect(terminalService.create).toHaveBeenCalledWith({
      sessionAgentId: "session-1",
      name: "Shell",
      shell: "/bin/zsh",
      shellArgs: ["-l"],
      cwd: "/workspace",
      cols: 100,
      rows: 30,
    });
    await expect(response.json()).resolves.toEqual(created);
  });

  it("validates create payloads", async () => {
    const server = await createTerminalRouteTestServer({ terminalService: { create: vi.fn() } });

    const response = await fetch(`${server.baseUrl}/api/terminals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionAgentId: "session-1", shellArgs: [42] }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "shellArgs must be an array of strings.",
      code: "INVALID_REQUEST",
    });
  });

  it("resizes terminals and returns the updated descriptor", async () => {
    const terminalService = {
      resizeTerminal: vi.fn(async () => ({
        terminalId: "term-1",
        sessionAgentId: "session-1",
        cols: 120,
        rows: 40,
      })),
    };
    const server = await createTerminalRouteTestServer({ terminalService });

    const response = await fetch(`${server.baseUrl}/api/terminals/term-1/resize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionAgentId: "session-1", cols: 120, rows: 40 }),
    });

    expect(response.status).toBe(200);
    expect(terminalService.resizeTerminal).toHaveBeenCalledWith({
      terminalId: "term-1",
      request: { sessionAgentId: "session-1", cols: 120, rows: 40 },
    });
    await expect(response.json()).resolves.toEqual({
      terminal: {
        terminalId: "term-1",
        sessionAgentId: "session-1",
        cols: 120,
        rows: 40,
      },
    });
  });

  it("issues websocket tickets", async () => {
    const terminalService = {
      issueWsTicket: vi.fn(async () => ({
        ticket: "ticket-123",
        expiresAt: "2026-04-08T12:00:00.000Z",
        terminalId: "term-1",
      })),
    };
    const server = await createTerminalRouteTestServer({ terminalService });

    const response = await fetch(`${server.baseUrl}/api/terminals/term-1/ticket`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionAgentId: "session-1" }),
    });

    expect(response.status).toBe(200);
    expect(terminalService.issueWsTicket).toHaveBeenCalledWith({
      terminalId: "term-1",
      sessionAgentId: "session-1",
    });
    await expect(response.json()).resolves.toEqual({
      ticket: "ticket-123",
      expiresAt: "2026-04-08T12:00:00.000Z",
      terminalId: "term-1",
    });
  });

  it("maps TerminalServiceError codes to HTTP status codes", async () => {
    const terminalService = {
      create: vi.fn(async () => {
        throw new TerminalServiceError("TERMINAL_LIMIT_REACHED", "Too many terminals");
      }),
    };
    const server = await createTerminalRouteTestServer({ terminalService });

    const response = await fetch(`${server.baseUrl}/api/terminals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionAgentId: "session-1" }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Too many terminals",
      code: "TERMINAL_LIMIT_REACHED",
    });
  });

  it("rejects disallowed origins before hitting the terminal service", async () => {
    const terminalService = {
      listTerminals: vi.fn(() => []),
    };
    const server = await createTerminalRouteTestServer({ terminalService });

    const response = await fetch(`${server.baseUrl}/api/terminals?sessionAgentId=session-1`, {
      headers: { origin: "https://malicious.example" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Origin not allowed",
      code: "ORIGIN_NOT_ALLOWED",
    });
    expect(terminalService.listTerminals).not.toHaveBeenCalled();
  });

  it("returns 405 with allow headers for unsupported collection methods", async () => {
    const server = await createTerminalRouteTestServer({ terminalService: { listTerminals: vi.fn(() => []) } });
    const response = await fetch(`${server.baseUrl}/api/terminals`, { method: "PATCH" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, POST, OPTIONS");
    await expect(response.json()).resolves.toEqual({
      error: "Method Not Allowed",
      code: "METHOD_NOT_ALLOWED",
    });
  });
});

async function createTerminalRouteTestServer(options: {
  terminalService: Record<string, unknown>;
}): Promise<TestServer> {
  const settingsService = {
    getSettings: vi.fn(() => ({ defaultShell: null, persistedDefaultShell: null, source: "system" })),
  } as unknown as TerminalSettingsService;

  const routes = createTerminalRoutes({
    terminalService: options.terminalService as never,
    settingsService,
    discoverShells: async () => [],
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
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  const route = routes.find((candidate) => candidate.matches(requestUrl.pathname));
  if (!route) {
    response.statusCode = 404;
    response.end();
    return;
  }

  await route.handle(request, response, requestUrl);
}
