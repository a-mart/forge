import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveModelDescriptorFromPreset } from "../model-presets.js";
import {
  findLatestPendingModelChangeContinuityRequest,
  findLatestUnappliedModelChangeContinuityRequestForSession,
  loadModelChangeContinuityState
} from "../runtime/model-change-continuity.js";
import { SwarmSettingsService } from "../swarm-settings-service.js";
import type { AgentDescriptor, ManagerProfile, SwarmConfig } from "../types.js";

const createdDirs: string[] = [];

afterEach(async () => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (!dir) {
      continue;
    }

    await rm(dir, { recursive: true, force: true });
  }
});

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "swarm-settings-service-"));
  createdDirs.push(root);
  return root;
}

function createConfig(rootDir: string): SwarmConfig {
  const dataDir = join(rootDir, "data");
  return {
    host: "127.0.0.1",
    port: 47187,
    debug: false,
    isDesktop: false,
    cortexEnabled: true,
    allowNonManagerSubscriptions: false,
    managerDisplayName: "Manager",
    defaultModel: resolveModelDescriptorFromPreset("pi-codex"),
    defaultCwd: rootDir,
    cwdAllowlistRoots: [rootDir],
    paths: {
      rootDir,
      dataDir,
      swarmDir: join(dataDir, "swarm"),
      uploadsDir: join(dataDir, "uploads"),
      agentsStoreFile: join(dataDir, "swarm", "agents.json"),
      profilesDir: join(dataDir, "profiles"),
      sharedDir: join(dataDir, "shared"),
      sharedConfigDir: join(dataDir, "shared", "config"),
      sharedCacheDir: join(dataDir, "shared", "cache"),
      sharedStateDir: join(dataDir, "shared", "state"),
      sharedAuthDir: join(dataDir, "shared", "config", "auth"),
      sharedAuthFile: join(dataDir, "shared", "config", "auth", "auth.json"),
      sharedSecretsFile: join(dataDir, "shared", "config", "secrets.json"),
      sharedIntegrationsDir: join(dataDir, "shared", "config", "integrations"),
      sessionsDir: join(dataDir, "sessions"),
      memoryDir: join(dataDir, "memory"),
      authDir: join(dataDir, "auth"),
      authFile: join(dataDir, "auth", "auth.json"),
      secretsFile: join(dataDir, "secrets.json"),
      agentDir: join(rootDir, "agent"),
      managerAgentDir: join(rootDir, "manager-agent"),
      repoArchetypesDir: join(rootDir, "archetypes"),
      repoMemorySkillFile: join(rootDir, "memory-skill.md")
    }
  };
}

function createProfile(): ManagerProfile {
  return {
    profileId: "manager",
    displayName: "Manager",
    defaultSessionAgentId: "manager",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function createSession(rootDir: string, agentId: string, model = resolveModelDescriptorFromPreset("pi-codex")): AgentDescriptor & {
  role: "manager";
  profileId: string;
} {
  return {
    agentId,
    displayName: agentId,
    role: "manager",
    managerId: "manager",
    profileId: "manager",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: rootDir,
    model: { ...model },
    sessionFile: join(rootDir, "data", "profiles", "manager", "sessions", agentId, "session.jsonl")
  };
}

function createService(options: {
  rootDir: string;
  sessions: Array<AgentDescriptor & { role: "manager"; profileId: string }>;
  applyManagerRuntimeRecyclePolicy?: ReturnType<typeof vi.fn>;
  saveStore?: ReturnType<typeof vi.fn>;
  emitAgentsSnapshot?: ReturnType<typeof vi.fn>;
  logDebug?: ReturnType<typeof vi.fn>;
  now?: () => string;
}): SwarmSettingsService {
  const profiles = new Map<string, ManagerProfile>([["manager", createProfile()]]);

  return new SwarmSettingsService({
    config: createConfig(options.rootDir),
    profiles,
    skillMetadataService: {} as any,
    skillFileService: {} as any,
    secretsEnvService: {} as any,
    getSessionsForProfile: () => options.sessions,
    getSessionById: (agentId) => options.sessions.find((session) => session.agentId === agentId),
    resolveAndValidateCwd: async (cwd) => cwd,
    assertCanChangeManagerCwd: () => {},
    applyManagerRuntimeRecyclePolicy: options.applyManagerRuntimeRecyclePolicy ?? vi.fn(async () => "none"),
    now: options.now,
    saveStore: options.saveStore ?? vi.fn(async () => {}),
    emitAgentsSnapshot: options.emitAgentsSnapshot ?? vi.fn(),
    logDebug: options.logDebug ?? vi.fn()
  });
}

describe("SwarmSettingsService.updateManagerModel", () => {
  it("writes continuity requests before mutating models for both active and inactive sessions", async () => {
    const root = await createTempRoot();
    const activeSession = createSession(root, "manager");
    const inactiveSession = createSession(root, "manager--s2");
    const applyManagerRuntimeRecyclePolicy = vi.fn(async (agentId: string) =>
      agentId === activeSession.agentId ? "recycled" : "none"
    );
    const saveStore = vi.fn(async () => {});
    const emitAgentsSnapshot = vi.fn();
    let tick = 0;
    const service = createService({
      rootDir: root,
      sessions: [activeSession, inactiveSession],
      applyManagerRuntimeRecyclePolicy,
      saveStore,
      emitAgentsSnapshot,
      now: () => `2026-01-02T00:00:0${tick++}.000Z`
    });

    await service.updateManagerModel("manager", "pi-5.4");

    expect(activeSession.model).toEqual(resolveModelDescriptorFromPreset("pi-5.4"));
    expect(inactiveSession.model).toEqual(resolveModelDescriptorFromPreset("pi-5.4"));
    expect(applyManagerRuntimeRecyclePolicy.mock.calls).toEqual([
      [activeSession.agentId, "model_change"],
      [inactiveSession.agentId, "model_change"]
    ]);
    expect(saveStore).toHaveBeenCalledTimes(1);
    expect(emitAgentsSnapshot).toHaveBeenCalledTimes(1);

    const activeState = await loadModelChangeContinuityState(activeSession.sessionFile);
    const inactiveState = await loadModelChangeContinuityState(inactiveSession.sessionFile);
    expect(activeState.requests).toHaveLength(1);
    expect(inactiveState.requests).toHaveLength(1);
    expect(activeState.requests[0]).toMatchObject({
      sessionAgentId: activeSession.agentId,
      sourceModel: resolveModelDescriptorFromPreset("pi-codex"),
      targetModel: resolveModelDescriptorFromPreset("pi-5.4")
    });
    expect(inactiveState.requests[0]).toMatchObject({
      sessionAgentId: inactiveSession.agentId,
      sourceModel: resolveModelDescriptorFromPreset("pi-codex"),
      targetModel: resolveModelDescriptorFromPreset("pi-5.4")
    });
  });

  it("treats no-op model changes as a true no-op without writing requests or recycling, including x-high normalization", async () => {
    const root = await createTempRoot();
    const session = createSession(root, "manager", {
      ...resolveModelDescriptorFromPreset("pi-5.4"),
      thinkingLevel: "x-high"
    });
    const applyManagerRuntimeRecyclePolicy = vi.fn(async () => "recycled");
    const saveStore = vi.fn(async () => {});
    const emitAgentsSnapshot = vi.fn();

    const service = createService({
      rootDir: root,
      sessions: [session],
      applyManagerRuntimeRecyclePolicy,
      saveStore,
      emitAgentsSnapshot
    });

    await service.updateManagerModel("manager", "pi-5.4");

    await expect(readFile(session.sessionFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(applyManagerRuntimeRecyclePolicy).not.toHaveBeenCalled();
    expect(saveStore).not.toHaveBeenCalled();
    expect(emitAgentsSnapshot).not.toHaveBeenCalled();
  });

  it("aborts before any model mutation or recycle when any request write fails, leaving partial writes inert", async () => {
    const root = await createTempRoot();
    const firstSession = createSession(root, "manager");
    const secondSession = createSession(root, "manager--s2");
    await mkdir(join(root, "data", "profiles", "manager", "sessions", secondSession.agentId), { recursive: true });
    const invalidHeader = '{"type":"not-session","id":"broken"}\n';
    await writeFile(secondSession.sessionFile, invalidHeader, "utf8");

    const applyManagerRuntimeRecyclePolicy = vi.fn(async () => "recycled");
    const saveStore = vi.fn(async () => {});
    const emitAgentsSnapshot = vi.fn();
    const service = createService({
      rootDir: root,
      sessions: [firstSession, secondSession],
      applyManagerRuntimeRecyclePolicy,
      saveStore,
      emitAgentsSnapshot,
      now: () => "2026-01-02T00:00:00.000Z"
    });

    await expect(service.updateManagerModel("manager", "pi-5.4")).rejects.toThrow(/invalid session header/i);

    expect(firstSession.model).toEqual(resolveModelDescriptorFromPreset("pi-codex"));
    expect(secondSession.model).toEqual(resolveModelDescriptorFromPreset("pi-codex"));
    expect(applyManagerRuntimeRecyclePolicy).not.toHaveBeenCalled();
    expect(saveStore).not.toHaveBeenCalled();
    expect(emitAgentsSnapshot).not.toHaveBeenCalled();
    await expect(readFile(secondSession.sessionFile, "utf8")).resolves.toBe(invalidHeader);

    const firstState = await loadModelChangeContinuityState(firstSession.sessionFile);
    expect(firstState.requests).toHaveLength(1);
    expect(
      findLatestPendingModelChangeContinuityRequest({
        sessionAgentId: firstSession.agentId,
        requests: firstState.requests,
        applied: firstState.applied,
        targetModel: firstSession.model
      })
    ).toBeUndefined();
  });

  it("updates only the targeted session when called with a session agent id", async () => {
    const root = await createTempRoot();
    const firstSession = createSession(root, "manager");
    const secondSession = createSession(root, "manager--s2");
    const applyManagerRuntimeRecyclePolicy = vi.fn(async () => "recycled");
    const service = createService({
      rootDir: root,
      sessions: [firstSession, secondSession],
      applyManagerRuntimeRecyclePolicy,
      now: () => "2026-01-02T00:00:00.000Z"
    });

    await service.updateManagerModel(secondSession.agentId, "pi-5.4");

    expect(firstSession.model).toEqual(resolveModelDescriptorFromPreset("pi-codex"));
    expect(secondSession.model).toEqual(resolveModelDescriptorFromPreset("pi-5.4"));
    expect(applyManagerRuntimeRecyclePolicy.mock.calls).toEqual([
      [secondSession.agentId, "model_change"]
    ]);
  });

  it("uses the original pending source model when a busy session is changed twice before replacement attaches", async () => {
    const root = await createTempRoot();
    const session = createSession(root, "manager", resolveModelDescriptorFromPreset("pi-codex"));
    const applyManagerRuntimeRecyclePolicy = vi.fn(async () => "deferred");
    const service = createService({
      rootDir: root,
      sessions: [session],
      applyManagerRuntimeRecyclePolicy,
      now: () => "2026-01-02T00:00:00.000Z"
    });

    await service.updateManagerModel("manager", "pi-5.4");
    expect(session.model).toEqual(resolveModelDescriptorFromPreset("pi-5.4"));

    await service.updateManagerModel("manager", "pi-opus");
    expect(session.model).toEqual(resolveModelDescriptorFromPreset("pi-opus"));

    const state = await loadModelChangeContinuityState(session.sessionFile);
    expect(state.requests).toHaveLength(2);
    expect(state.requests[0]).toMatchObject({
      sessionAgentId: session.agentId,
      sourceModel: resolveModelDescriptorFromPreset("pi-codex"),
      targetModel: resolveModelDescriptorFromPreset("pi-5.4")
    });
    expect(state.requests[1]).toMatchObject({
      sessionAgentId: session.agentId,
      sourceModel: resolveModelDescriptorFromPreset("pi-codex"),
      targetModel: resolveModelDescriptorFromPreset("pi-opus")
    });

    const latestPending = findLatestUnappliedModelChangeContinuityRequestForSession({
      sessionAgentId: session.agentId,
      requests: state.requests,
      applied: state.applied
    });
    expect(latestPending).toMatchObject({
      sourceModel: resolveModelDescriptorFromPreset("pi-codex"),
      targetModel: resolveModelDescriptorFromPreset("pi-opus")
    });
  });
});
