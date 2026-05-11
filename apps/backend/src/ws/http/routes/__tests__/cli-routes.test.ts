import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createTempConfig, getAvailablePort } from "../../../../test-support/index.js";
import {
  P0HttpRouteFakeSwarmManager as FakeSwarmManager,
  createP0HttpRouteManagerDescriptor as createManagerDescriptor,
  parseP0HttpRouteJsonResponse as parseJsonResponse,
} from "../../../../test-support/ws-integration-harness.js";
import { CliAccessService } from "../../../../swarm/cli-access-service.js";
import type { AgentDescriptor, ManagerProfile } from "../../../../swarm/types.js";
import { applyCorsHeaders, sendJson } from "../../../http-utils.js";
import { SwarmWebSocketServer } from "../../../server.js";
import { createCliRoutes } from "../cli-routes.js";

interface TestServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

const activeServers: TestServer[] = [];
const activeSwarmServers: SwarmWebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(activeSwarmServers.splice(0).map((server) => server.stop()));
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
});

describe("CLI routes and bearer auth", () => {
  it("requires bearer auth for /api/cli/* and returns capabilities for a valid stored key", async () => {
    const { service } = await makeCliAccessService();
    const generated = await service.generateKey({ name: "Route test" });
    const server = await createCliRouteTestServer(service, createCliRouteState());

    const missing = await fetch(`${server.baseUrl}/api/cli/capabilities`);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe('Bearer realm="forge-cli"');
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: "missing_authorization", status: 401 },
    });

    const invalid = await fetch(`${server.baseUrl}/api/cli/capabilities`, {
      headers: { authorization: "Bearer invalid" },
    });
    await expect(parseJsonResponse(invalid)).resolves.toMatchObject({
      status: 401,
      json: { error: { code: "invalid_token", status: 401 } },
    });

    const valid = await fetch(`${server.baseUrl}/api/cli/capabilities`, {
      headers: { authorization: `Bearer ${generated.plaintextKey}` },
    });
    const payload = await parseJsonResponse(valid);
    expect(payload.status).toBe(200);
    expect(payload.json).toMatchObject({
      serverVersion: "1.0.0",
      capabilities: {
        protocolVersion: 1,
        available: true,
        runtimeTarget: "builder",
        features: {
          bearerAuth: true,
          headlessWs: true,
          cliSourceContext: true,
          cliSessionMetadata: true,
          choiceOwnerLookup: false,
          activeToolSnapshot: true,
          projectAgentRunTarget: false,
          builderRuntimeOnly: true,
        },
      },
    });
    await expect(service.listKeys()).resolves.toMatchObject([
      { id: generated.key.id, lastUsedAt: "2026-05-11T00:00:00.000Z", lastUsedSource: "http" },
    ]);

    const unknown = await fetch(`${server.baseUrl}/api/cli/not-found`, {
      headers: { authorization: `Bearer ${generated.plaintextKey}` },
    });
    await expect(parseJsonResponse(unknown)).resolves.toMatchObject({
      status: 404,
      json: { error: { code: "not_found", status: 404 } },
    });

    const malformed = await fetch(`${server.baseUrl}/api/cli/profiles/%E0%A4%A`, {
      headers: { authorization: `Bearer ${generated.plaintextKey}` },
    });
    await expect(parseJsonResponse(malformed)).resolves.toMatchObject({
      status: 400,
      json: { error: { code: "bad_path", status: 400 } },
    });
  });

  it("allows authorization in CORS preflight responses", async () => {
    const { service } = await makeCliAccessService();
    const server = await createCliRouteTestServer(service, createCliRouteState());

    const response = await fetch(`${server.baseUrl}/api/cli/capabilities`, {
      method: "OPTIONS",
      headers: {
        origin: "http://127.0.0.1:47188",
        "access-control-request-headers": "authorization",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  it("requires bearer auth for every CLI read endpoint", async () => {
    const { service } = await makeCliAccessService();
    const server = await createCliRouteTestServer(service, createCliRouteState());
    const endpoints = [
      "/api/cli/status",
      "/api/cli/profiles",
      "/api/cli/profiles/profile-a",
      "/api/cli/agents?profileId=profile-a",
      "/api/cli/agents/session-a",
      "/api/cli/sessions?profileId=profile-a",
      "/api/cli/sessions/session-a",
      "/api/cli/project-agents?profileId=profile-a",
      "/api/cli/project-agents/docs?profileId=profile-a",
    ];

    for (const endpoint of endpoints) {
      await expect(parseJsonResponse(await fetch(`${server.baseUrl}${endpoint}`))).resolves.toMatchObject({
        status: 401,
        json: { error: { code: "missing_authorization", status: 401 } },
      });
      await expect(
        parseJsonResponse(await fetch(`${server.baseUrl}${endpoint}`, { headers: { authorization: "Bearer invalid" } }))
      ).resolves.toMatchObject({
        status: 401,
        json: { error: { code: "invalid_token", status: 401 } },
      });
    }
  });

  it("serves CLI status and read-only profile, session, agent, and project-agent DTOs", async () => {
    const { service } = await makeCliAccessService();
    const generated = await service.generateKey({ name: "Read route test" });
    const server = await createCliRouteTestServer(service, createCliRouteState());
    const headers = { authorization: `Bearer ${generated.plaintextKey}` };

    await expect(parseJsonResponse(await fetch(`${server.baseUrl}/api/cli/status`, { headers }))).resolves.toMatchObject({
      status: 200,
      json: {
        status: "ok",
        runtimeTarget: "builder",
        capabilities: {
          available: true,
          features: {
            bearerAuth: true,
            cliSourceContext: true,
            cliSessionMetadata: true,
            headlessWs: true,
          },
        },
        summary: { profileCount: 1, sessionCount: 2, agentCount: 3 },
      },
    });

    await expect(parseJsonResponse(await fetch(`${server.baseUrl}/api/cli/profiles`, { headers }))).resolves.toMatchObject({
      status: 200,
      json: { profiles: [{ profileId: "profile-a", displayName: "Profile A" }] },
    });
    await expect(parseJsonResponse(await fetch(`${server.baseUrl}/api/cli/profiles/profile-a`, { headers }))).resolves.toMatchObject({
      status: 200,
      json: { profile: { profileId: "profile-a", displayName: "Profile A" } },
    });

    const agents = await parseJsonResponse(await fetch(`${server.baseUrl}/api/cli/agents?profileId=profile-a`, { headers }));
    expect(agents.status).toBe(200);
    expect((agents.json.agents as Array<Record<string, unknown>>).map((agent) => agent.agentId)).toEqual([
      "session-a",
      "worker-a",
      "docs-agent",
    ]);
    expect(JSON.stringify(agents.json)).not.toContain("secret project prompt");
    expect(JSON.stringify(agents.json)).not.toContain("secret session prompt");

    await expect(parseJsonResponse(await fetch(`${server.baseUrl}/api/cli/agents/session-a`, { headers }))).resolves.toMatchObject({
      status: 200,
      json: { agent: { agentId: "session-a", profileId: "profile-a" } },
    });
    await expect(parseJsonResponse(await fetch(`${server.baseUrl}/api/cli/sessions?profileId=profile-a`, { headers }))).resolves.toMatchObject({
      status: 200,
      json: { sessions: [{ agentId: "session-a" }, { agentId: "docs-agent" }] },
    });
    await expect(parseJsonResponse(await fetch(`${server.baseUrl}/api/cli/sessions/session-a`, { headers }))).resolves.toMatchObject({
      status: 200,
      json: { session: { agentId: "session-a", role: "manager" } },
    });

    const projectAgents = await parseJsonResponse(
      await fetch(`${server.baseUrl}/api/cli/project-agents?profileId=profile-a`, { headers })
    );
    expect(projectAgents.status).toBe(200);
    expect(projectAgents.json).toMatchObject({
      projectAgents: [
        {
          profileId: "profile-a",
          agentId: "docs-agent",
          handle: "docs",
          whenToUse: "Use for documentation.",
          displayName: "Docs Agent",
        },
      ],
    });
    expect(JSON.stringify(projectAgents.json)).not.toContain("secret project prompt");
    await expect(
      parseJsonResponse(await fetch(`${server.baseUrl}/api/cli/project-agents/docs?profileId=profile-a`, { headers }))
    ).resolves.toMatchObject({
      status: 200,
      json: { projectAgent: { handle: "docs", agentId: "docs-agent" } },
    });
  });

  it("uses stable ids only and excludes system/collaboration surfaces", async () => {
    const { service } = await makeCliAccessService();
    const generated = await service.generateKey({ name: "Stable ID test" });
    const server = await createCliRouteTestServer(service, createCliRouteState());
    const headers = { authorization: `Bearer ${generated.plaintextKey}` };

    await expect(parseJsonResponse(await fetch(`${server.baseUrl}/api/cli/profiles/cortex`, { headers }))).resolves.toMatchObject({
      status: 404,
      json: { error: { code: "not_found" } },
    });
    await expect(parseJsonResponse(await fetch(`${server.baseUrl}/api/cli/agents/Docs%20Agent`, { headers }))).resolves.toMatchObject({
      status: 404,
      json: { error: { code: "not_found" } },
    });
    await expect(parseJsonResponse(await fetch(`${server.baseUrl}/api/cli/sessions/collab-session`, { headers }))).resolves.toMatchObject({
      status: 404,
      json: { error: { code: "not_found" } },
    });
    await expect(parseJsonResponse(await fetch(`${server.baseUrl}/api/cli/agents/cortex-session`, { headers }))).resolves.toMatchObject({
      status: 404,
      json: { error: { code: "not_found" } },
    });
    await expect(parseJsonResponse(await fetch(`${server.baseUrl}/api/cli/project-agents/Docs%20Agent?profileId=profile-a`, { headers }))).resolves.toMatchObject({
      status: 404,
      json: { error: { code: "not_found" } },
    });
  });

  it("does not register CLI HTTP routes for collaboration runtime", async () => {
    const configHandle = await createTempConfig({
      prefix: "cli-collab-route-",
      port: await getAvailablePort(),
      runtimeTarget: "collaboration-server",
    });
    activeServers.push({ baseUrl: "cleanup-only", close: configHandle.cleanup });
    const service = new CliAccessService({
      dataDir: configHandle.config.paths.dataDir,
      now: () => "2026-05-11T00:00:00.000Z",
    });
    const generated = await service.generateKey({ name: "Collab route test" });
    const manager = new FakeSwarmManager(configHandle.config, [
      createManagerDescriptor(configHandle.config.paths.rootDir, "manager"),
    ]);
    const server = new SwarmWebSocketServer({
      swarmManager: manager as unknown as never,
      host: configHandle.config.host,
      port: configHandle.config.port,
      allowNonManagerSubscriptions: false,
      cliAccessService: service,
    });
    activeSwarmServers.push(server);
    await server.start();

    const response = await fetch(`http://${configHandle.config.host}:${configHandle.config.port}/api/cli/capabilities`, {
      headers: { authorization: `Bearer ${generated.plaintextKey}` },
    });

    expect(response.status).toBe(404);
    await expect(service.listKeys()).resolves.toEqual([generated.key]);
  });

  it("authenticates /api/cli/ws before accepting the isolated headless socket", async () => {
    const configHandle = await createTempConfig({ prefix: "cli-ws-route-", port: await getAvailablePort() });
    activeServers.push({ baseUrl: "cleanup-only", close: configHandle.cleanup });
    const service = new CliAccessService({
      dataDir: configHandle.config.paths.dataDir,
      now: () => "2026-05-11T00:00:00.000Z",
    });
    const generated = await service.generateKey({ name: "WS test" });
    const manager = new FakeSwarmManager(configHandle.config, [
      createManagerDescriptor(configHandle.config.paths.rootDir, "manager"),
    ]);
    const server = new SwarmWebSocketServer({
      swarmManager: manager as unknown as never,
      host: configHandle.config.host,
      port: configHandle.config.port,
      allowNonManagerSubscriptions: false,
      cliAccessService: service,
    });
    activeSwarmServers.push(server);
    await server.start();

    await expect(connectWebSocket(`ws://${configHandle.config.host}:${configHandle.config.port}/api/cli/ws`)).resolves.toMatchObject({
      opened: false,
      errorMessage: expect.stringContaining("Unexpected server response: 401") as string,
    });

    await expect(
      connectWebSocket(`ws://${configHandle.config.host}:${configHandle.config.port}/api/cli/ws`, {
        authorization: "Bearer invalid",
      })
    ).resolves.toMatchObject({
      opened: false,
      errorMessage: expect.stringContaining("Unexpected server response: 401") as string,
    });

    await expect(
      connectWebSocket(`ws://${configHandle.config.host}:${configHandle.config.port}/api/cli/ws`, {
        authorization: `Bearer ${generated.plaintextKey}`,
      }, "not json")
    ).resolves.toMatchObject({
      opened: true,
      messages: [expect.objectContaining({ type: "cli_request_error", code: "bad_request" })],
    });

    await expect(service.listKeys()).resolves.toMatchObject([
      { id: generated.key.id, lastUsedAt: "2026-05-11T00:00:00.000Z", lastUsedSource: "ws" },
    ]);
  });

  it("returns 404 for /api/cli/ws on collaboration runtime before bearer auth is evaluated", async () => {
    const configHandle = await createTempConfig({
      prefix: "cli-ws-collab-",
      port: await getAvailablePort(),
      runtimeTarget: "collaboration-server",
    });
    activeServers.push({ baseUrl: "cleanup-only", close: configHandle.cleanup });
    const service = new CliAccessService({
      dataDir: configHandle.config.paths.dataDir,
      now: () => "2026-05-11T00:00:00.000Z",
    });
    const generated = await service.generateKey({ name: "Collab WS test" });
    const manager = new FakeSwarmManager(configHandle.config, [
      createManagerDescriptor(configHandle.config.paths.rootDir, "manager"),
    ]);
    const server = new SwarmWebSocketServer({
      swarmManager: manager as unknown as never,
      host: configHandle.config.host,
      port: configHandle.config.port,
      allowNonManagerSubscriptions: false,
      cliAccessService: service,
    });
    activeSwarmServers.push(server);
    await server.start();

    await expect(
      connectWebSocket(`ws://${configHandle.config.host}:${configHandle.config.port}/api/cli/ws`, {
        authorization: `Bearer ${generated.plaintextKey}`,
      })
    ).resolves.toMatchObject({
      opened: false,
      errorMessage: expect.stringContaining("Unexpected server response: 404") as string,
    });
    await expect(service.listKeys()).resolves.toEqual([generated.key]);
  });
});

function createCliRouteState(): {
  listProfiles(): ManagerProfile[];
  listAgents(): AgentDescriptor[];
} {
  const profiles: ManagerProfile[] = [
    {
      profileId: "profile-a",
      displayName: "Profile A",
      defaultSessionAgentId: "session-a",
      defaultModel: { provider: "openai-codex", modelId: "gpt-5.3-codex", thinkingLevel: "medium" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      profileId: "cortex",
      displayName: "Cortex",
      defaultSessionAgentId: "cortex-session",
      defaultModel: { provider: "openai-codex", modelId: "gpt-5.3-codex", thinkingLevel: "medium" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      profileType: "system",
    },
  ];
  const agents: AgentDescriptor[] = [
    createRouteAgent({ agentId: "session-a", profileId: "profile-a", sessionLabel: "Session A" }),
    createRouteAgent({ agentId: "worker-a", role: "worker", managerId: "session-a", profileId: "profile-a" }),
    createRouteAgent({
      agentId: "docs-agent",
      profileId: "profile-a",
      displayName: "Docs Agent",
      sessionLabel: "Docs Agent",
      projectAgent: {
        handle: "docs",
        whenToUse: "Use for documentation.",
        systemPrompt: "secret project prompt",
        capabilities: ["create_session"],
      },
      sessionSystemPrompt: "secret session prompt",
    }),
    createRouteAgent({
      agentId: "collab-session",
      profileId: "profile-a",
      sessionSurface: "collab",
      collab: { workspaceId: "workspace", channelId: "channel" },
    }),
    createRouteAgent({ agentId: "cortex-session", profileId: "cortex" }),
  ];

  return {
    listProfiles: () => profiles.map((profile) => ({ ...profile, defaultModel: { ...profile.defaultModel } })),
    listAgents: () => agents.map((agent) => ({ ...agent, model: { ...agent.model } })),
  };
}

function createRouteAgent(overrides: Partial<AgentDescriptor> & { agentId: string }): AgentDescriptor {
  const role = overrides.role ?? "manager";
  return {
    agentId: overrides.agentId,
    displayName: overrides.displayName ?? overrides.agentId,
    role,
    managerId: overrides.managerId ?? (role === "manager" ? overrides.agentId : "session-a"),
    status: overrides.status ?? "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/project",
    model: { provider: "openai-codex", modelId: "gpt-5.3-codex", thinkingLevel: "medium" },
    sessionFile: `/tmp/project/sessions/${overrides.agentId}.jsonl`,
    ...overrides,
  };
}

async function makeCliAccessService(): Promise<{ service: CliAccessService }> {
  const configHandle = await createTempConfig({ prefix: "cli-route-service-" });
  activeServers.push({
    baseUrl: "cleanup-only",
    close: configHandle.cleanup,
  });

  let counter = 0;
  return {
    service: new CliAccessService({
      dataDir: configHandle.config.paths.dataDir,
      now: () => "2026-05-11T00:00:00.000Z",
      generateId: () => {
        counter += 1;
        return `cli_key_${counter}`;
      },
      generateKeyBytes: () => Buffer.alloc(32, counter + 1),
    }),
  };
}

async function createCliRouteTestServer(
  cliAccessService: CliAccessService,
  swarmManager: ReturnType<typeof createCliRouteState>,
): Promise<TestServer> {
  const routes = createCliRoutes({ cliAccessService, runtimeTarget: "builder", swarmManager });
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
  routes: ReturnType<typeof createCliRoutes>,
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

async function connectWebSocket(
  url: string,
  headers?: Record<string, string>,
  sendOnOpen?: string,
): Promise<{ opened: boolean; errorMessage?: string; messages: unknown[] }> {
  return new Promise((resolve) => {
    const client = new WebSocket(url, { headers });
    const messages: unknown[] = [];
    let settled = false;

    const settle = (result: { opened: boolean; errorMessage?: string }): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ ...result, messages });
    };

    client.on("message", (raw) => {
      messages.push(JSON.parse(raw.toString()) as unknown);
    });
    client.once("error", (error) => {
      settle({ opened: false, errorMessage: error instanceof Error ? error.message : String(error) });
    });
    client.once("open", () => {
      const finish = (): void => {
        client.close();
        settle({ opened: true });
      };
      client.once("message", finish);
      client.once("close", finish);
      if (sendOnOpen !== undefined) {
        client.send(sendOnOpen);
      }
    });
  });
}
