import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ServerEvent } from "@forge/protocol";
import { applyCorsHeaders, sendJson } from "../ws/http-utils.js";

vi.mock("@forge/protocol", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@forge/protocol").catch(() => ({}));
  return {
    ...actual,
    isSystemProfile:
      typeof actual.isSystemProfile === "function"
        ? actual.isSystemProfile
        : (profile: { profileType?: string }) => profile.profileType === "system",
    MANAGER_REASONING_LEVELS: ["none", "low", "medium", "high"],
  };
});

const specialistRegistryState = vi.hoisted(() => ({
  deleteProfileSpecialist: vi.fn(async () => undefined),
  deleteSharedSpecialist: vi.fn(async () => undefined),
  resolveRoster: vi.fn(async () => []),
  resolveSharedRoster: vi.fn(async () => []),
  generateRosterBlock: vi.fn(() => ""),
  getWorkerTemplate: vi.fn(async () => "# Worker template\n"),
  getSpecialistsEnabled: vi.fn(async () => true),
  setSpecialistsEnabled: vi.fn(async () => undefined),
  saveProfileSpecialist: vi.fn(async () => undefined),
  saveSharedSpecialist: vi.fn(async () => undefined),
  invalidateSpecialistCache: vi.fn(),
}));

vi.mock("../swarm/specialists/specialist-registry.js", () => ({
  deleteProfileSpecialist: (...args: unknown[]) => specialistRegistryState.deleteProfileSpecialist(...args),
  deleteSharedSpecialist: (...args: unknown[]) => specialistRegistryState.deleteSharedSpecialist(...args),
  resolveRoster: (...args: unknown[]) => specialistRegistryState.resolveRoster(...args),
  resolveSharedRoster: (...args: unknown[]) => specialistRegistryState.resolveSharedRoster(...args),
  generateRosterBlock: (...args: unknown[]) => specialistRegistryState.generateRosterBlock(...args),
  getWorkerTemplate: (...args: unknown[]) => specialistRegistryState.getWorkerTemplate(...args),
  getSpecialistsEnabled: (...args: unknown[]) => specialistRegistryState.getSpecialistsEnabled(...args),
  setSpecialistsEnabled: (...args: unknown[]) => specialistRegistryState.setSpecialistsEnabled(...args),
  saveProfileSpecialist: (...args: unknown[]) => specialistRegistryState.saveProfileSpecialist(...args),
  saveSharedSpecialist: (...args: unknown[]) => specialistRegistryState.saveSharedSpecialist(...args),
  invalidateSpecialistCache: (...args: unknown[]) => specialistRegistryState.invalidateSpecialistCache(...args),
}));

import { createSpecialistRoutes } from "../ws/routes/specialist-routes.js";

interface TestServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

const activeServers: TestServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  Object.values(specialistRegistryState).forEach((mock) => {
    if (typeof mock === "function" && "mockReset" in mock) {
      mock.mockReset();
    }
  });
  specialistRegistryState.getWorkerTemplate.mockResolvedValue("# Worker template\n");
  specialistRegistryState.getSpecialistsEnabled.mockResolvedValue(true);
  specialistRegistryState.generateRosterBlock.mockReturnValue("");
  specialistRegistryState.resolveRoster.mockResolvedValue([]);
  specialistRegistryState.resolveSharedRoster.mockResolvedValue([]);
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
});

describe("specialist routes", () => {
  it("returns the builtin worker template", async () => {
    specialistRegistryState.getWorkerTemplate.mockResolvedValueOnce("# Worker\n");

    const server = await createSpecialistRouteTestServer();
    const response = await fetch(`${server.baseUrl}/api/settings/specialists/template`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ template: "# Worker\n" });
  });

  it("lists global specialists and strips sourcePath from the payload", async () => {
    specialistRegistryState.resolveSharedRoster.mockResolvedValueOnce([
      {
        specialistId: "release-manager",
        handle: "releases",
        displayName: "Releases",
        enabled: true,
        sourcePath: "/tmp/global/releases.md",
      },
    ]);

    const server = await createSpecialistRouteTestServer();
    const response = await fetch(`${server.baseUrl}/api/settings/specialists`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      specialists: [
        {
          specialistId: "release-manager",
          handle: "releases",
          displayName: "Releases",
          enabled: true,
        },
      ],
    });
  });

  it("returns 404 for unknown profile-scoped specialist requests", async () => {
    const server = await createSpecialistRouteTestServer({
      profiles: [{ profileId: "alpha", displayName: "Alpha" }],
    });
    const response = await fetch(`${server.baseUrl}/api/settings/specialists?profileId=missing`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Unknown profile: missing" });
    expect(specialistRegistryState.resolveRoster).not.toHaveBeenCalled();
  });

  it("lists profile-scoped specialists and returns roster prompt markdown", async () => {
    specialistRegistryState.resolveRoster
      .mockResolvedValueOnce([
        {
          specialistId: "backend-specialist",
          handle: "backend",
          displayName: "Backend",
          enabled: true,
          sourcePath: "/tmp/profiles/alpha/backend.md",
        },
      ])
      .mockResolvedValueOnce([
        {
          specialistId: "backend-specialist",
          handle: "backend",
          displayName: "Backend",
          enabled: true,
          sourcePath: "/tmp/profiles/alpha/backend.md",
        },
      ]);
    specialistRegistryState.generateRosterBlock.mockReturnValueOnce("## Specialists\n- backend\n");

    const server = await createSpecialistRouteTestServer({
      profiles: [{ profileId: "alpha", displayName: "Alpha" }],
    });

    const listResponse = await fetch(`${server.baseUrl}/api/settings/specialists?profileId=alpha`);
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual({
      specialists: [
        {
          specialistId: "backend-specialist",
          handle: "backend",
          displayName: "Backend",
          enabled: true,
        },
      ],
    });

    const promptResponse = await fetch(`${server.baseUrl}/api/settings/specialists/roster-prompt?profileId=alpha`);
    expect(promptResponse.status).toBe(200);
    await expect(promptResponse.json()).resolves.toEqual({ markdown: "## Specialists\n- backend\n" });
  });

  it("saves global specialists and notifies every profile", async () => {
    specialistRegistryState.resolveRoster.mockImplementation(async (profileId: string) => [
      { specialistId: `${profileId}-one`, handle: "worker", sourcePath: `/tmp/${profileId}.md` },
    ]);

    const notifySpecialistRosterChanged = vi.fn(async () => undefined);
    const broadcastEvent = vi.fn<(event: ServerEvent) => void>();
    const server = await createSpecialistRouteTestServer({
      profiles: [
        { profileId: "alpha", displayName: "Alpha" },
        { profileId: "beta", displayName: "Beta" },
      ],
      notifySpecialistRosterChanged,
      broadcastEvent,
    });

    const response = await fetch(`${server.baseUrl}/api/settings/specialists/releases`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validSpecialistPayload()),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(specialistRegistryState.saveSharedSpecialist).toHaveBeenCalledWith(
      "/tmp/data",
      "releases",
      expect.objectContaining({ displayName: "Releases" }),
    );
    expect(notifySpecialistRosterChanged).toHaveBeenCalledWith("alpha");
    expect(notifySpecialistRosterChanged).toHaveBeenCalledWith("beta");
    expect(broadcastEvent).toHaveBeenCalledTimes(2);
    expect(broadcastEvent.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        type: "specialist_roster_changed",
        profileId: "alpha",
        specialistIds: ["alpha-one"],
      }),
    );
  });

  it("saves profile-scoped specialists and only notifies the targeted profile", async () => {
    specialistRegistryState.resolveRoster.mockResolvedValueOnce([
      { specialistId: "backend-specialist", handle: "backend", sourcePath: "/tmp/alpha/backend.md" },
    ]);

    const notifySpecialistRosterChanged = vi.fn(async () => undefined);
    const broadcastEvent = vi.fn<(event: ServerEvent) => void>();
    const server = await createSpecialistRouteTestServer({
      profiles: [{ profileId: "alpha", displayName: "Alpha" }],
      notifySpecialistRosterChanged,
      broadcastEvent,
    });

    const response = await fetch(`${server.baseUrl}/api/settings/specialists/backend?profileId=alpha`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validSpecialistPayload()),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(specialistRegistryState.saveProfileSpecialist).toHaveBeenCalledWith(
      "/tmp/data",
      "alpha",
      "backend",
      expect.objectContaining({ displayName: "Releases" }),
    );
    expect(notifySpecialistRosterChanged).toHaveBeenCalledWith("alpha");
    expect(broadcastEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "specialist_roster_changed",
        profileId: "alpha",
        specialistIds: ["backend-specialist"],
      }),
    );
  });

  it("rejects profile-scoped specialist saves for system-managed profiles", async () => {
    const server = await createSpecialistRouteTestServer({
      profiles: [
        { profileId: "alpha", displayName: "Alpha" },
        { profileId: "_collaboration", displayName: "Collaboration", profileType: "system" },
      ],
    });

    const response = await fetch(`${server.baseUrl}/api/settings/specialists/backend?profileId=_collaboration`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validSpecialistPayload()),
    });

    expect(response.status).toBe(403);
    expect(specialistRegistryState.saveProfileSpecialist).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ error: "Cannot modify system-managed profile" });
  });

  it("deletes profile-scoped specialists and only notifies the targeted profile", async () => {
    specialistRegistryState.resolveRoster.mockResolvedValueOnce([
      { specialistId: "backend-specialist", handle: "backend", sourcePath: "/tmp/alpha/backend.md" },
    ]);

    const notifySpecialistRosterChanged = vi.fn(async () => undefined);
    const broadcastEvent = vi.fn<(event: ServerEvent) => void>();
    const server = await createSpecialistRouteTestServer({
      profiles: [{ profileId: "alpha", displayName: "Alpha" }],
      notifySpecialistRosterChanged,
      broadcastEvent,
    });

    const response = await fetch(`${server.baseUrl}/api/settings/specialists/backend?profileId=alpha`, {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(specialistRegistryState.deleteProfileSpecialist).toHaveBeenCalledWith("/tmp/data", "alpha", "backend");
    expect(notifySpecialistRosterChanged).toHaveBeenCalledWith("alpha");
    expect(broadcastEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "specialist_roster_changed",
        profileId: "alpha",
        specialistIds: ["backend-specialist"],
      }),
    );
  });

  it("rejects profile-scoped specialist deletes for system-managed profiles", async () => {
    const server = await createSpecialistRouteTestServer({
      profiles: [
        { profileId: "alpha", displayName: "Alpha" },
        { profileId: "_collaboration", displayName: "Collaboration", profileType: "system" },
      ],
    });

    const response = await fetch(`${server.baseUrl}/api/settings/specialists/backend?profileId=_collaboration`, {
      method: "DELETE",
    });

    expect(response.status).toBe(403);
    expect(specialistRegistryState.deleteProfileSpecialist).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ error: "Cannot modify system-managed profile" });
  });

  it("returns the enabled flag for the current installation", async () => {
    specialistRegistryState.getSpecialistsEnabled.mockResolvedValueOnce(false);

    const server = await createSpecialistRouteTestServer();
    const response = await fetch(`${server.baseUrl}/api/settings/specialists/enabled`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ enabled: false });
  });

  it("validates enabled-route payloads", async () => {
    const server = await createSpecialistRouteTestServer();
    const response = await fetch(`${server.baseUrl}/api/settings/specialists/enabled`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "enabled must be a boolean" });
  });

  it("updates the enabled flag, invalidates cache, and notifies all profiles", async () => {
    specialistRegistryState.resolveRoster.mockImplementation(async (profileId: string) => [
      { specialistId: `${profileId}-worker`, handle: "worker", sourcePath: `/tmp/${profileId}.md` },
    ]);

    const notifySpecialistRosterChanged = vi.fn(async () => undefined);
    const broadcastEvent = vi.fn<(event: ServerEvent) => void>();
    const server = await createSpecialistRouteTestServer({
      profiles: [
        { profileId: "alpha", displayName: "Alpha" },
        { profileId: "beta", displayName: "Beta" },
      ],
      notifySpecialistRosterChanged,
      broadcastEvent,
    });

    const response = await fetch(`${server.baseUrl}/api/settings/specialists/enabled`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(specialistRegistryState.setSpecialistsEnabled).toHaveBeenCalledWith("/tmp/data", false);
    expect(specialistRegistryState.invalidateSpecialistCache).toHaveBeenCalledTimes(1);
    expect(notifySpecialistRosterChanged).toHaveBeenCalledTimes(2);
    expect(broadcastEvent).toHaveBeenCalledTimes(2);
  });

  it("maps builtin delete conflicts to 409 responses", async () => {
    specialistRegistryState.deleteSharedSpecialist.mockImplementationOnce(async () => {
      throw new Error("Cannot delete builtin specialist: backend");
    });

    const server = await createSpecialistRouteTestServer();
    const response = await fetch(`${server.baseUrl}/api/settings/specialists/backend`, {
      method: "DELETE",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Cannot delete builtin specialist: backend" });
  });
});

function validSpecialistPayload(): Record<string, unknown> {
  return {
    displayName: "Releases",
    color: "violet",
    enabled: true,
    whenToUse: "Use for release notes",
    modelId: "gpt-5.3-codex",
    provider: "openai-codex",
    reasoningLevel: "medium",
    fallbackModelId: "claude-sonnet-4.5",
    fallbackProvider: "anthropic",
    fallbackReasoningLevel: "high",
    pinned: true,
    webSearch: false,
    promptBody: "You own releases.",
  };
}

async function createSpecialistRouteTestServer(options?: {
  profiles?: Array<{ profileId: string; displayName: string; profileType?: "user" | "system" }>;
  notifySpecialistRosterChanged?: (profileId: string) => Promise<void>;
  broadcastEvent?: (event: ServerEvent) => void;
}): Promise<TestServer> {
  const profiles = options?.profiles ?? [];
  const swarmManager = {
    getConfig: () => ({ paths: { dataDir: "/tmp/data" } }),
    listProfiles: () => profiles,
    listUserProfiles: () => profiles.filter((profile) => profile.profileType !== "system"),
    notifySpecialistRosterChanged: options?.notifySpecialistRosterChanged ?? vi.fn(async () => undefined),
  };

  const routes = createSpecialistRoutes({
    swarmManager: swarmManager as never,
    broadcastEvent: options?.broadcastEvent ?? vi.fn(),
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
  routes: ReturnType<typeof createSpecialistRoutes>,
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
