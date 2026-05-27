import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  resolveWorkspaceRoster: vi.fn(async () => []),
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
  resolveWorkspaceRoster: (...args: unknown[]) => specialistRegistryState.resolveWorkspaceRoster(...args),
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
const tempDirs: string[] = [];

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
  specialistRegistryState.resolveWorkspaceRoster.mockImplementation(
    async (profileId: string, dataDir: string, _workspaceDir: string | undefined, targetSpace: string) =>
      specialistRegistryState.resolveRoster(profileId, dataDir, targetSpace)
  );
  delete process.env.CURSOR_API_KEY;
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("specialist routes", () => {
  it("shows Cursor SDK specialist rows from /api/settings/models when CURSOR_API_KEY is configured", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "specialist-routes-cursor-"));
    tempDirs.push(dataDir);
    await mkdir(join(dataDir, "shared", "config"), { recursive: true });
    await writeFile(join(dataDir, "shared", "config", "secrets.json"), JSON.stringify({ CURSOR_API_KEY: "cursor-test-key" }));
    const server = await createSpecialistRouteTestServer({ dataDir });

    const response = await fetch(`${server.baseUrl}/api/settings/models`);

    expect(response.status).toBe(200);
    const payload = await response.json() as { models: Array<{ provider?: string; modelId?: string; presetId?: string }> };
    expect(payload.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "cursor-sdk", modelId: "composer-2.5", presetId: "cursor-composer" })
    ]));
  });

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

  it("lists global specialists using explicit collaboration targetSpace", async () => {
    specialistRegistryState.resolveSharedRoster.mockResolvedValueOnce([
      {
        specialistId: "collab-specialist",
        displayName: "Collab",
        enabled: true,
        sourcePath: "/tmp/global/collab.md",
      },
    ]);

    const server = await createSpecialistRouteTestServer();
    const response = await fetch(`${server.baseUrl}/api/settings/specialists?targetSpace=collaboration`);

    expect(response.status).toBe(200);
    expect(specialistRegistryState.resolveSharedRoster).toHaveBeenCalledWith("/tmp/data", "collaboration");
    await expect(response.json()).resolves.toEqual({
      specialists: [
        {
          specialistId: "collab-specialist",
          displayName: "Collab",
          enabled: true,
        },
      ],
    });
  });

  it("rejects invalid targetSpace query values before resolving rosters", async () => {
    const server = await createSpecialistRouteTestServer();
    const response = await fetch(`${server.baseUrl}/api/settings/specialists?targetSpace=invalid`);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "targetSpace query must be builder or collaboration" });
    expect(specialistRegistryState.resolveSharedRoster).not.toHaveBeenCalled();
    expect(specialistRegistryState.resolveRoster).not.toHaveBeenCalled();
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

  it("uses session workspace context for profile-scoped specialists and roster prompt", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "specialist-route-workspace-"));
    tempDirs.push(workspace);
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    await mkdir(join(workspace, ".forge", "specialists"), { recursive: true });
    const workspaceRealpath = await realpath(workspace);
    specialistRegistryState.resolveWorkspaceRoster.mockResolvedValue([
      {
        specialistId: "repo-specialist",
        handle: "repo",
        displayName: "Repo",
        enabled: true,
        sourcePath: join(workspace, ".forge", "specialists", "repo.md"),
      },
    ]);
    specialistRegistryState.generateRosterBlock.mockReturnValueOnce("## Specialists\n- repo\n");

    const server = await createSpecialistRouteTestServer({
      profiles: [{ profileId: "alpha", displayName: "Alpha" }],
      agents: [{ agentId: "session-a", role: "manager", profileId: "alpha", cwd: workspace }],
    });

    const listResponse = await fetch(`${server.baseUrl}/api/settings/specialists?profileId=alpha&sessionAgentId=session-a`);
    expect(listResponse.status).toBe(200);
    expect(specialistRegistryState.resolveWorkspaceRoster).toHaveBeenNthCalledWith(
      1,
      "alpha",
      "/tmp/data",
      join(workspaceRealpath, ".forge", "specialists"),
      "builder",
    );
    await expect(listResponse.json()).resolves.toMatchObject({ specialists: [{ specialistId: "repo-specialist" }] });

    const promptResponse = await fetch(`${server.baseUrl}/api/settings/specialists/roster-prompt?profileId=alpha&sessionAgentId=session-a`);
    expect(promptResponse.status).toBe(200);
    expect(specialistRegistryState.resolveWorkspaceRoster).toHaveBeenNthCalledWith(
      2,
      "alpha",
      "/tmp/data",
      join(workspaceRealpath, ".forge", "specialists"),
      "builder",
    );
    await expect(promptResponse.json()).resolves.toEqual({ markdown: "## Specialists\n- repo\n" });
  });

  it("lists profile-scoped specialists and roster prompt using explicit collaboration targetSpace", async () => {
    specialistRegistryState.resolveRoster
      .mockResolvedValueOnce([
        {
          specialistId: "collab-specialist",
          handle: "collab",
          displayName: "Collab",
          enabled: true,
          sourcePath: "/tmp/profiles/alpha/collab.md",
        },
      ])
      .mockResolvedValueOnce([
        {
          specialistId: "collab-specialist",
          handle: "collab",
          displayName: "Collab",
          enabled: true,
          sourcePath: "/tmp/profiles/alpha/collab.md",
        },
      ]);
    specialistRegistryState.generateRosterBlock.mockReturnValueOnce("## Specialists\n- collab\n");

    const server = await createSpecialistRouteTestServer({
      profiles: [{ profileId: "alpha", displayName: "Alpha" }],
    });

    const listResponse = await fetch(
      `${server.baseUrl}/api/settings/specialists?profileId=alpha&targetSpace=collaboration`,
    );
    expect(listResponse.status).toBe(200);
    expect(specialistRegistryState.resolveRoster).toHaveBeenNthCalledWith(1, "alpha", "/tmp/data", "collaboration");
    await expect(listResponse.json()).resolves.toEqual({
      specialists: [
        {
          specialistId: "collab-specialist",
          handle: "collab",
          displayName: "Collab",
          enabled: true,
        },
      ],
    });

    const promptResponse = await fetch(
      `${server.baseUrl}/api/settings/specialists/roster-prompt?profileId=alpha&targetSpace=collaboration`,
    );
    expect(promptResponse.status).toBe(200);
    expect(specialistRegistryState.resolveRoster).toHaveBeenNthCalledWith(2, "alpha", "/tmp/data", "collaboration");
    await expect(promptResponse.json()).resolves.toEqual({ markdown: "## Specialists\n- collab\n" });
  });

  it("rejects invalid targetSpace entries in save payloads", async () => {
    const server = await createSpecialistRouteTestServer();
    const response = await fetch(`${server.baseUrl}/api/settings/specialists/releases`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validSpecialistPayload(), targetSpace: ["builder", "invalid"] }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "targetSpace entries must be builder or collaboration" });
    expect(specialistRegistryState.saveSharedSpecialist).not.toHaveBeenCalled();
  });

  it("saves global specialists with targetSpace from explicit query when body omits it", async () => {
    const server = await createSpecialistRouteTestServer({
      profiles: [{ profileId: "alpha", displayName: "Alpha" }],
    });

    const response = await fetch(`${server.baseUrl}/api/settings/specialists/collab?targetSpace=collaboration`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validSpecialistPayload(), targetSpace: undefined }),
    });

    expect(response.status).toBe(200);
    expect(specialistRegistryState.saveSharedSpecialist).toHaveBeenCalledWith(
      "/tmp/data",
      "collab",
      expect.objectContaining({ targetSpace: ["collaboration"] }),
    );
  });

  it("saves global specialists and notifies every user profile", async () => {
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
        updatedAt: expect.any(String),
      }),
    );
  });

  it("notifies collaboration backing sessions individually when global specialists change", async () => {
    specialistRegistryState.resolveRoster.mockImplementation(async (profileId: string) => [
      { specialistId: `${profileId}-specialist`, handle: "worker", sourcePath: `/tmp/${profileId}.md` },
    ]);

    const notifySpecialistRosterChanged = vi.fn(async () => undefined);
    const broadcastEvent = vi.fn<(event: ServerEvent) => void>();
    const server = await createSpecialistRouteTestServer({
      profiles: [
        { profileId: "alpha", displayName: "Alpha" },
        { profileId: "_collaboration", displayName: "Collaboration" },
      ],
      agents: [
        { agentId: "channel-a", role: "manager", profileId: "_collaboration", sessionSurface: "collab" },
        { agentId: "channel-b", role: "manager", profileId: "_collaboration", sessionSurface: "collab" },
      ],
      notifySpecialistRosterChanged,
      broadcastEvent,
    });

    const response = await fetch(`${server.baseUrl}/api/settings/specialists/collab?targetSpace=collaboration`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validSpecialistPayload()),
    });

    expect(response.status).toBe(200);
    expect(notifySpecialistRosterChanged).toHaveBeenCalledWith("alpha");
    expect(notifySpecialistRosterChanged).not.toHaveBeenCalledWith("_collaboration");
    expect(notifySpecialistRosterChanged).toHaveBeenCalledWith("_collaboration", { sessionAgentId: "channel-a" });
    expect(notifySpecialistRosterChanged).toHaveBeenCalledWith("_collaboration", { sessionAgentId: "channel-b" });
    expect(broadcastEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "specialist_roster_changed",
        profileId: "_collaboration",
        specialistIds: ["_collaboration-specialist"],
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
    modelId: "gpt-5.5",
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
  notifySpecialistRosterChanged?: (profileId: string, options?: { sessionAgentId?: string }) => Promise<void>;
  broadcastEvent?: (event: ServerEvent) => void;
  agents?: Array<{ agentId: string; role: string; profileId?: string; sessionSurface?: string; cwd?: string }>;
  dataDir?: string;
}): Promise<TestServer> {
  const profiles = options?.profiles ?? [];
  const dataDir = options?.dataDir ?? "/tmp/data";
  const swarmManager = {
    getConfig: () => ({
      paths: {
        dataDir,
        sharedAuthFile: join(dataDir, "shared", "config", "auth", "auth.json"),
        sharedSecretsFile: join(dataDir, "shared", "config", "secrets.json"),
        authFile: join(dataDir, "auth", "auth.json"),
        secretsFile: join(dataDir, "secrets.json"),
      },
    }),
    listProfiles: () => profiles,
    listUserProfiles: () => profiles.filter((profile) => profile.profileType !== "system"),
    listAgents: () => options?.agents ?? [],
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
