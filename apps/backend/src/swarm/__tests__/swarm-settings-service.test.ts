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

function createProfile(
  defaultModel = resolveModelDescriptorFromPreset("pi-codex")
): ManagerProfile {
  return {
    profileId: "manager",
    displayName: "Manager",
    defaultSessionAgentId: "manager",
    defaultModel: { ...defaultModel },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function createSession(
  rootDir: string,
  agentId: string,
  model = resolveModelDescriptorFromPreset("pi-codex"),
  modelOrigin: AgentDescriptor["modelOrigin"] = "profile_default"
): AgentDescriptor & {
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
    modelOrigin,
    sessionFile: join(rootDir, "data", "profiles", "manager", "sessions", agentId, "session.jsonl")
  };
}

function createService(options: {
  rootDir: string;
  sessions: Array<AgentDescriptor & { role: "manager"; profileId: string }>;
  profileDefaultModel?: AgentDescriptor["model"];
  profiles?: Map<string, ManagerProfile>;
  applyManagerRuntimeRecyclePolicy?: ReturnType<typeof vi.fn>;
  saveStore?: ReturnType<typeof vi.fn>;
  transactionDescriptors?: (callback: any) => Promise<any>;
  emitAgentsSnapshot?: ReturnType<typeof vi.fn>;
  emitProfilesSnapshot?: ReturnType<typeof vi.fn>;
  logDebug?: ReturnType<typeof vi.fn>;
  now?: () => string;
  secretsEnvService?: any;
}): SwarmSettingsService {
  const profiles = options.profiles ?? new Map<string, ManagerProfile>([["manager", createProfile(options.profileDefaultModel)]]);

  return new SwarmSettingsService({
    config: createConfig(options.rootDir),
    profiles,
    skillMetadataService: {} as any,
    skillFileService: {} as any,
    secretsEnvService: options.secretsEnvService ?? ({} as any),
    getSessionsForProfile: (profileId) => options.sessions.filter((session) => session.profileId === profileId),
    getAllManagerSessions: () => options.sessions,
    getSessionById: (agentId) => options.sessions.find((session) => session.agentId === agentId),
    resolveAndValidateCwd: async (cwd) => cwd,
    assertCanChangeManagerCwd: () => {},
    applyManagerRuntimeRecyclePolicy: options.applyManagerRuntimeRecyclePolicy ?? vi.fn(async () => "none"),
    now: options.now,
    transactionDescriptors: options.transactionDescriptors,
    saveStore: options.saveStore ?? vi.fn(async () => {}),
    emitAgentsSnapshot: options.emitAgentsSnapshot ?? vi.fn(),
    emitProfilesSnapshot: options.emitProfilesSnapshot ?? vi.fn(),
    logDebug: options.logDebug ?? vi.fn()
  });
}

function createOpenAICodexOAuthSecretsEnvService(): any {
  return {
    getCredentialPoolService: () => ({
      listPool: async (provider: string) => ({
        provider,
        strategy: "fill_first",
        credentials: [
          {
            id: "oauth-primary",
            provider,
            label: "OAuth Primary",
            addedAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            health: "healthy",
          },
        ],
      }),
    }),
  };
}

describe("SwarmSettingsService.updateManagerModel", () => {
  it("allows exact model selection with pooled-only OpenAI Codex OAuth availability", async () => {
    const root = await createTempRoot();
    const session = createSession(root, "manager");
    const service = createService({
      rootDir: root,
      sessions: [session],
      secretsEnvService: createOpenAICodexOAuthSecretsEnvService(),
    });

    const resolved = await service.updateSessionExactModel(
      session.agentId,
      { provider: "openai-codex", modelId: "gpt-5.5" },
      "xhigh"
    );

    expect(resolved).toMatchObject({ provider: "openai-codex", modelId: "gpt-5.5", thinkingLevel: "xhigh" });
    expect(session.model).toMatchObject(resolved);
  });

  it("strips stale service-tier fields when inheriting the project default model", async () => {
    const root = await createTempRoot();
    const staleDefaultModel = {
      ...resolveModelDescriptorFromPreset("pi-5.5"),
      serviceTier: "priority"
    } as AgentDescriptor["model"] & { serviceTier: string };
    const session = createSession(root, "manager--s2", resolveModelDescriptorFromPreset("pi-opus"), "session_override");
    const service = createService({
      rootDir: root,
      sessions: [session],
      profileDefaultModel: staleDefaultModel,
    });

    await service.updateSessionModel(session.agentId, "inherit");

    expect(session.model).toEqual({
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "xhigh"
    });
    expect((session.model as AgentDescriptor["model"] & { serviceTier?: unknown }).serviceTier).toBeUndefined();
    expect(session.modelOrigin).toBe("profile_default");
  });

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

  it("legacy session-targeted updateManagerModel creates sticky same-as-default overrides without recycling", async () => {
    const root = await createTempRoot();
    const defaultModel = resolveModelDescriptorFromPreset("pi-5.4");
    const session = createSession(root, "manager--s2", defaultModel, "profile_default");
    const applyManagerRuntimeRecyclePolicy = vi.fn(async () => "recycled");
    const saveStore = vi.fn(async () => {});
    const emitAgentsSnapshot = vi.fn();

    const service = createService({
      rootDir: root,
      sessions: [session],
      profileDefaultModel: defaultModel,
      applyManagerRuntimeRecyclePolicy,
      saveStore,
      emitAgentsSnapshot
    });

    await service.updateManagerModel(session.agentId, "pi-5.4");

    expect(session.model).toEqual(defaultModel);
    expect(session.modelOrigin).toBe("session_override");
    expect(applyManagerRuntimeRecyclePolicy).not.toHaveBeenCalled();
    expect(saveStore).toHaveBeenCalledTimes(1);
    expect(emitAgentsSnapshot).toHaveBeenCalledTimes(1);
    await expect(readFile(session.sessionFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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

  it("rolls back the profile default model when profile updates fail before session mutations apply", async () => {
    const root = await createTempRoot();
    const profiles = new Map<string, ManagerProfile>([["manager", createProfile()]]);
    const firstSession = createSession(root, "manager");
    const secondSession = createSession(root, "manager--s2");
    await mkdir(join(root, "data", "profiles", "manager", "sessions", secondSession.agentId), { recursive: true });
    await writeFile(secondSession.sessionFile, '{"type":"not-session","id":"broken"}\n', "utf8");

    const service = createService({
      rootDir: root,
      sessions: [firstSession, secondSession],
      profiles,
      now: () => "2026-01-02T00:00:00.000Z"
    });

    await expect(service.updateProfileDefaultModel("manager", "pi-5.4")).rejects.toThrow(/invalid session header/i);

    expect(profiles.get("manager")).toMatchObject({
      defaultModel: resolveModelDescriptorFromPreset("pi-codex"),
      updatedAt: "2026-01-01T00:00:00.000Z"
    });
    expect(firstSession.model).toEqual(resolveModelDescriptorFromPreset("pi-codex"));
    expect(secondSession.model).toEqual(resolveModelDescriptorFromPreset("pi-codex"));
  });

  it("rolls back session state and skips recycle when saveStore fails during a session model update", async () => {
    const root = await createTempRoot();
    const session = createSession(root, "manager--s2", resolveModelDescriptorFromPreset("pi-codex"), "profile_default");
    const applyManagerRuntimeRecyclePolicy = vi.fn(async () => "recycled");
    const saveStore = vi.fn(async () => {
      throw new Error("save failed");
    });
    const service = createService({
      rootDir: root,
      sessions: [session],
      applyManagerRuntimeRecyclePolicy,
      saveStore,
      now: () => "2026-01-02T00:00:00.000Z"
    });

    await expect(service.updateSessionModel(session.agentId, "override", "pi-5.4")).rejects.toThrow("save failed");

    expect(session.model).toEqual(resolveModelDescriptorFromPreset("pi-codex"));
    expect(session.modelOrigin).toBe("profile_default");
    expect(applyManagerRuntimeRecyclePolicy).not.toHaveBeenCalled();
  });

  it("rolls back profile and session state and skips recycle when saveStore fails during a profile default update", async () => {
    const root = await createTempRoot();
    const profiles = new Map<string, ManagerProfile>([["manager", createProfile()]]);
    const firstSession = createSession(root, "manager", resolveModelDescriptorFromPreset("pi-codex"), "profile_default");
    const secondSession = createSession(root, "manager--s2", resolveModelDescriptorFromPreset("pi-codex"), "profile_default");
    const applyManagerRuntimeRecyclePolicy = vi.fn(async () => "recycled");
    const saveStore = vi.fn(async () => {
      throw new Error("save failed");
    });
    const service = createService({
      rootDir: root,
      sessions: [firstSession, secondSession],
      profiles,
      applyManagerRuntimeRecyclePolicy,
      saveStore,
      now: () => "2026-01-02T00:00:00.000Z"
    });

    await expect(service.updateProfileDefaultModel("manager", "pi-5.4")).rejects.toThrow("save failed");

    expect(profiles.get("manager")).toMatchObject({
      defaultModel: resolveModelDescriptorFromPreset("pi-codex"),
      updatedAt: "2026-01-01T00:00:00.000Z"
    });
    expect(firstSession.model).toEqual(resolveModelDescriptorFromPreset("pi-codex"));
    expect(secondSession.model).toEqual(resolveModelDescriptorFromPreset("pi-codex"));
    expect(applyManagerRuntimeRecyclePolicy).not.toHaveBeenCalled();
  });

  it("treats session recycle failures after save as deferred and still completes the update", async () => {
    const root = await createTempRoot();
    const session = createSession(root, "manager--s2", resolveModelDescriptorFromPreset("pi-codex"), "profile_default");
    let saved = false;
    const applyManagerRuntimeRecyclePolicy = vi.fn(async () => {
      expect(saved).toBe(true);
      throw new Error("recycle failed");
    });
    const saveStore = vi.fn(async () => {
      saved = true;
    });
    const emitAgentsSnapshot = vi.fn();
    const service = createService({
      rootDir: root,
      sessions: [session],
      applyManagerRuntimeRecyclePolicy,
      saveStore,
      emitAgentsSnapshot,
      now: () => "2026-01-02T00:00:00.000Z"
    });

    await expect(service.updateSessionModel(session.agentId, "override", "pi-5.4")).resolves.toBeUndefined();

    expect(session.model).toEqual(resolveModelDescriptorFromPreset("pi-5.4"));
    expect(session.modelOrigin).toBe("session_override");
    expect(saveStore).toHaveBeenCalledTimes(1);
    expect(applyManagerRuntimeRecyclePolicy).toHaveBeenCalledTimes(1);
    expect(emitAgentsSnapshot).toHaveBeenCalledTimes(1);
  });

  it("treats profile-default recycle failures after save as deferred and still completes the update", async () => {
    const root = await createTempRoot();
    const profiles = new Map<string, ManagerProfile>([["manager", createProfile()]]);
    const firstSession = createSession(root, "manager", resolveModelDescriptorFromPreset("pi-codex"), "profile_default");
    const secondSession = createSession(root, "manager--s2", resolveModelDescriptorFromPreset("pi-codex"), "profile_default");
    let saved = false;
    const applyManagerRuntimeRecyclePolicy = vi.fn(async () => {
      expect(saved).toBe(true);
      throw new Error("recycle failed");
    });
    const saveStore = vi.fn(async () => {
      saved = true;
    });
    const emitAgentsSnapshot = vi.fn();
    const emitProfilesSnapshot = vi.fn();
    const service = createService({
      rootDir: root,
      sessions: [firstSession, secondSession],
      profiles,
      applyManagerRuntimeRecyclePolicy,
      saveStore,
      emitAgentsSnapshot,
      emitProfilesSnapshot,
      now: () => "2026-01-02T00:00:00.000Z"
    });

    await expect(service.updateProfileDefaultModel("manager", "pi-5.4")).resolves.toBeUndefined();

    expect(profiles.get("manager")).toMatchObject({
      defaultModel: resolveModelDescriptorFromPreset("pi-5.4"),
      updatedAt: "2026-01-02T00:00:00.000Z"
    });
    expect(firstSession.model).toEqual(resolveModelDescriptorFromPreset("pi-5.4"));
    expect(secondSession.model).toEqual(resolveModelDescriptorFromPreset("pi-5.4"));
    expect(saveStore).toHaveBeenCalledTimes(1);
    expect(applyManagerRuntimeRecyclePolicy).toHaveBeenCalledTimes(2);
    expect(emitAgentsSnapshot).toHaveBeenCalledTimes(1);
    expect(emitProfilesSnapshot).toHaveBeenCalledTimes(1);
  });

  it("updates only inherited sessions when the profile default model changes", async () => {
    const root = await createTempRoot();
    const inheritedRoot = createSession(root, "manager", resolveModelDescriptorFromPreset("pi-codex"), "profile_default");
    const inheritedSession = createSession(root, "manager--s2", resolveModelDescriptorFromPreset("pi-codex"), "profile_default");
    const overriddenSession = createSession(root, "manager--s3", resolveModelDescriptorFromPreset("pi-opus"), "session_override");
    const applyManagerRuntimeRecyclePolicy = vi.fn(async () => "recycled");
    const emitProfilesSnapshot = vi.fn();
    const service = createService({
      rootDir: root,
      sessions: [inheritedRoot, inheritedSession, overriddenSession],
      applyManagerRuntimeRecyclePolicy,
      emitProfilesSnapshot,
      now: () => "2026-01-02T00:00:00.000Z"
    });

    await service.updateProfileDefaultModel("manager", "pi-5.4");

    expect(inheritedRoot.model).toEqual(resolveModelDescriptorFromPreset("pi-5.4"));
    expect(inheritedSession.model).toEqual(resolveModelDescriptorFromPreset("pi-5.4"));
    expect(overriddenSession.model).toEqual(resolveModelDescriptorFromPreset("pi-opus"));
    expect(overriddenSession.modelOrigin).toBe("session_override");
    expect(applyManagerRuntimeRecyclePolicy.mock.calls).toEqual([
      ["manager", "model_change"],
      ["manager--s2", "model_change"]
    ]);
    expect(emitProfilesSnapshot).toHaveBeenCalledTimes(1);
  });

  it("applies profile default session descriptor patches in one transaction before recycling", async () => {
    const root = await createTempRoot();
    const profiles = new Map<string, ManagerProfile>([["manager", createProfile()]]);
    const firstSession = createSession(root, "manager", resolveModelDescriptorFromPreset("pi-codex"), "profile_default");
    const secondSession = createSession(root, "manager--s2", resolveModelDescriptorFromPreset("pi-codex"), "profile_default");
    const transactionCalls: string[][] = [];
    let saved = false;
    const transactionDescriptors = vi.fn(async (callback: any) => {
      const patchedDescriptors: string[] = [];
      const result = await callback({
        patchDescriptor: (agentId: string, patch: Partial<AgentDescriptor>) => {
          patchedDescriptors.push(agentId);
          const session = [firstSession, secondSession].find((candidate) => candidate.agentId === agentId);
          if (!session) throw new Error(`unknown descriptor ${agentId}`);
          Object.assign(session, patch);
          return session;
        },
        patchProfile: (profileId: string, patch: Partial<ManagerProfile>) => {
          const profile = profiles.get(profileId);
          if (!profile) throw new Error(`unknown profile ${profileId}`);
          Object.assign(profile, patch);
          return profile;
        }
      });
      transactionCalls.push(patchedDescriptors);
      saved = true;
      return result;
    });
    const applyManagerRuntimeRecyclePolicy = vi.fn(async () => {
      expect(saved).toBe(true);
      return "recycled";
    });
    const service = createService({
      rootDir: root,
      sessions: [firstSession, secondSession],
      profiles,
      transactionDescriptors,
      applyManagerRuntimeRecyclePolicy,
      now: () => "2026-01-02T00:00:00.000Z"
    });

    await service.updateProfileDefaultModel("manager", "pi-5.4");

    expect(transactionDescriptors).toHaveBeenCalledTimes(1);
    expect(transactionCalls).toEqual([["manager", "manager--s2"]]);
    expect(profiles.get("manager")).toMatchObject({
      defaultModel: resolveModelDescriptorFromPreset("pi-5.4"),
      updatedAt: "2026-01-02T00:00:00.000Z"
    });
    expect(applyManagerRuntimeRecyclePolicy).toHaveBeenCalledTimes(2);
  });

  it("persists metadata-only session override transitions without recycling when the effective model stays the same", async () => {
    const root = await createTempRoot();
    const session = createSession(root, "manager--s2", resolveModelDescriptorFromPreset("pi-codex"), "profile_default");
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

    await service.updateSessionModel(session.agentId, "override", "pi-codex");

    expect(session.model).toEqual(resolveModelDescriptorFromPreset("pi-codex"));
    expect(session.modelOrigin).toBe("session_override");
    expect(applyManagerRuntimeRecyclePolicy).not.toHaveBeenCalled();
    expect(saveStore).toHaveBeenCalledTimes(1);
    expect(emitAgentsSnapshot).toHaveBeenCalledTimes(1);
    await expect(readFile(session.sessionFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("SwarmSettingsService auth provider runtime recycling", () => {
  it("recycles matching provider managers after local auth updates, including collaboration sessions", async () => {
    const root = await createTempRoot();
    const builderOpenAISession = createSession(root, "manager", { provider: "openai-codex", modelId: "gpt-5.5" });
    const builderAnthropicSession = createSession(root, "manager--anthropic", {
      provider: "anthropic",
      modelId: "claude-sonnet-4.5"
    });
    const collaborationOpenAISession = {
      ...createSession(root, "collab-channel", { provider: "openai-codex", modelId: "gpt-5.5" }),
      managerId: "_collaboration",
      profileId: "_collaboration",
      sessionSurface: "collab" as const
    };
    const secretsEnvService = {
      updateSettingsAuth: vi.fn(async () => undefined)
    };
    const applyManagerRuntimeRecyclePolicy = vi.fn(async (agentId: string) =>
      agentId === collaborationOpenAISession.agentId ? "deferred" : "recycled"
    );
    const service = createService({
      rootDir: root,
      sessions: [builderOpenAISession, builderAnthropicSession, collaborationOpenAISession],
      applyManagerRuntimeRecyclePolicy,
      secretsEnvService
    });

    await service.updateSettingsAuth({ "openai-codex": "sk-test" });

    expect(secretsEnvService.updateSettingsAuth).toHaveBeenCalledWith({ "openai-codex": "sk-test" });
    expect(applyManagerRuntimeRecyclePolicy.mock.calls).toEqual([
      ["manager", "auth_source_change"],
      ["collab-channel", "auth_source_change"]
    ]);
  });

  it("does not recycle sessions whose model provider does not match the local auth mutation", async () => {
    const root = await createTempRoot();
    const openAISession = createSession(root, "manager", { provider: "openai-codex", modelId: "gpt-5.5" });
    const cursorSession = createSession(root, "manager--cursor", { provider: "cursor-sdk", modelId: "composer-2.5" });
    const secretsEnvService = {
      deleteSettingsAuth: vi.fn(async () => undefined)
    };
    const applyManagerRuntimeRecyclePolicy = vi.fn(async () => "recycled");
    const service = createService({
      rootDir: root,
      sessions: [openAISession, cursorSession],
      applyManagerRuntimeRecyclePolicy,
      secretsEnvService
    });

    await service.deleteSettingsAuth("anthropic");

    expect(secretsEnvService.deleteSettingsAuth).toHaveBeenCalledWith("anthropic");
    expect(applyManagerRuntimeRecyclePolicy).not.toHaveBeenCalled();
  });

  it("recycles matching provider managers after pooled credential source changes, including strategy", async () => {
    const root = await createTempRoot();
    const anthropicSession = createSession(root, "manager", {
      provider: "anthropic",
      modelId: "claude-sonnet-4.5"
    });
    const openAISession = createSession(root, "manager--openai", { provider: "openai-codex", modelId: "gpt-5.5" });
    const credentialPoolService = {
      removeCredential: vi.fn(async () => undefined),
      setPrimary: vi.fn(async () => undefined),
      setStrategy: vi.fn(async () => undefined),
      addCredential: vi.fn(async () => ({ id: "acct-ant-2" }))
    };
    const secretsEnvService = {
      getCredentialPoolService: () => credentialPoolService
    };
    const applyManagerRuntimeRecyclePolicy = vi.fn(async () => "recycled");
    const service = createService({
      rootDir: root,
      sessions: [anthropicSession, openAISession],
      applyManagerRuntimeRecyclePolicy,
      secretsEnvService
    });

    await service.removePooledCredential("anthropic", "acct-ant-1");
    await service.setPrimaryPooledCredential("anthropic", "acct-ant-2");
    await service.setCredentialPoolStrategy("anthropic", "least_used");
    await expect(service.addPooledCredential("anthropic", { type: "oauth" } as any)).resolves.toEqual({
      id: "acct-ant-2"
    });

    expect(credentialPoolService.removeCredential).toHaveBeenCalledWith("anthropic", "acct-ant-1");
    expect(credentialPoolService.setPrimary).toHaveBeenCalledWith("anthropic", "acct-ant-2");
    expect(credentialPoolService.setStrategy).toHaveBeenCalledWith("anthropic", "least_used");
    expect(credentialPoolService.addCredential).toHaveBeenCalledWith("anthropic", { type: "oauth" }, undefined);
    expect(applyManagerRuntimeRecyclePolicy.mock.calls).toEqual([
      ["manager", "auth_source_change"],
      ["manager", "auth_source_change"],
      ["manager", "auth_source_change"],
      ["manager", "auth_source_change"]
    ]);
  });
});

describe("SwarmSettingsService pooled credential broker boundary", () => {
  it("blocks OpenAI Codex pooled credential mutations at the service boundary when broker mode is active", async () => {
    const root = await createTempRoot();
    const previousMode = process.env.FORGE_OPENAI_CODEX_AUTH_MODE;
    process.env.FORGE_OPENAI_CODEX_AUTH_MODE = "central_broker";
    const credentialPoolService = {
      renameCredential: vi.fn(async () => undefined),
      removeCredential: vi.fn(async () => undefined),
      setPrimary: vi.fn(async () => undefined),
      setStrategy: vi.fn(async () => undefined),
      resetCooldown: vi.fn(async () => undefined),
      addCredential: vi.fn(async () => ({ id: "acct-1" })),
    };
    const service = createService({
      rootDir: root,
      sessions: [],
      secretsEnvService: { getCredentialPoolService: () => credentialPoolService },
    });

    try {
      await expect(service.renamePooledCredential("openai-codex", "acct-1", "Renamed")).rejects.toThrow(
        "central_broker_mode_active"
      );
      await expect(service.removePooledCredential("openai-codex", "acct-1")).rejects.toThrow(
        "central_broker_mode_active"
      );
      await expect(service.setPrimaryPooledCredential("openai-codex", "acct-1")).rejects.toThrow(
        "central_broker_mode_active"
      );
      await expect(service.setCredentialPoolStrategy("openai-codex", "least_used")).rejects.toThrow(
        "central_broker_mode_active"
      );
      await expect(service.resetPooledCredentialCooldown("openai-codex", "acct-1")).rejects.toThrow(
        "central_broker_mode_active"
      );
      await expect(service.addPooledCredential("openai-codex", { type: "oauth" } as any)).rejects.toThrow(
        "central_broker_mode_active"
      );

      expect(credentialPoolService.renameCredential).not.toHaveBeenCalled();
      expect(credentialPoolService.removeCredential).not.toHaveBeenCalled();
      expect(credentialPoolService.setPrimary).not.toHaveBeenCalled();
      expect(credentialPoolService.setStrategy).not.toHaveBeenCalled();
      expect(credentialPoolService.resetCooldown).not.toHaveBeenCalled();
      expect(credentialPoolService.addCredential).not.toHaveBeenCalled();
    } finally {
      if (previousMode === undefined) {
        delete process.env.FORGE_OPENAI_CODEX_AUTH_MODE;
      } else {
        process.env.FORGE_OPENAI_CODEX_AUTH_MODE = previousMode;
      }
    }
  });

  it("leaves non-OpenAI pooled credential mutations unchanged in broker mode", async () => {
    const root = await createTempRoot();
    const previousMode = process.env.FORGE_OPENAI_CODEX_AUTH_MODE;
    process.env.FORGE_OPENAI_CODEX_AUTH_MODE = "central_broker";
    const credentialPoolService = {
      renameCredential: vi.fn(async () => undefined),
      removeCredential: vi.fn(async () => undefined),
      setPrimary: vi.fn(async () => undefined),
      setStrategy: vi.fn(async () => undefined),
      resetCooldown: vi.fn(async () => undefined),
      addCredential: vi.fn(async () => ({ id: "acct-ant-1" })),
    };
    const service = createService({
      rootDir: root,
      sessions: [],
      secretsEnvService: { getCredentialPoolService: () => credentialPoolService },
    });

    try {
      await service.renamePooledCredential("anthropic", "acct-ant-1", "Renamed");
      await service.removePooledCredential("anthropic", "acct-ant-1");
      await service.setPrimaryPooledCredential("anthropic", "acct-ant-1");
      await service.setCredentialPoolStrategy("anthropic", "least_used");
      await service.resetPooledCredentialCooldown("anthropic", "acct-ant-1");
      await expect(service.addPooledCredential("anthropic", { type: "oauth" } as any)).resolves.toEqual({
        id: "acct-ant-1",
      });

      expect(credentialPoolService.renameCredential).toHaveBeenCalledWith("anthropic", "acct-ant-1", "Renamed");
      expect(credentialPoolService.removeCredential).toHaveBeenCalledWith("anthropic", "acct-ant-1");
      expect(credentialPoolService.setPrimary).toHaveBeenCalledWith("anthropic", "acct-ant-1");
      expect(credentialPoolService.setStrategy).toHaveBeenCalledWith("anthropic", "least_used");
      expect(credentialPoolService.resetCooldown).toHaveBeenCalledWith("anthropic", "acct-ant-1");
      expect(credentialPoolService.addCredential).toHaveBeenCalledWith("anthropic", { type: "oauth" }, undefined);
    } finally {
      if (previousMode === undefined) {
        delete process.env.FORGE_OPENAI_CODEX_AUTH_MODE;
      } else {
        process.env.FORGE_OPENAI_CODEX_AUTH_MODE = previousMode;
      }
    }
  });
});

describe("SwarmSettingsService.updateOpenAIAuthBrokerSettings", () => {
  it("recycles OpenAI Codex managers when active broker token changes but the masked suffix is unchanged", async () => {
    const root = await createTempRoot();
    const session = createSession(root, "manager", resolveModelDescriptorFromPreset("pi-codex"), "profile_default");
    const applyManagerRuntimeRecyclePolicy = vi.fn(async () => "recycled");
    const service = createService({
      rootDir: root,
      sessions: [session],
      applyManagerRuntimeRecyclePolicy,
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ ok: true })));

    try {
      await service.updateOpenAIAuthBrokerSettings({
        mode: "central_broker",
        broker: { url: "https://broker.example.test", token: "first-secret-same" },
      });
      expect(applyManagerRuntimeRecyclePolicy).toHaveBeenCalledTimes(1);
      applyManagerRuntimeRecyclePolicy.mockClear();

      await service.updateOpenAIAuthBrokerSettings({
        mode: "central_broker",
        broker: { token: "other-secret-same" },
      });

      expect(applyManagerRuntimeRecyclePolicy.mock.calls).toEqual([
        ["manager", "auth_source_change"],
      ]);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("does not recycle OpenAI Codex managers for inactive local-mode broker token edits", async () => {
    const root = await createTempRoot();
    const session = createSession(root, "manager", resolveModelDescriptorFromPreset("pi-codex"), "profile_default");
    const applyManagerRuntimeRecyclePolicy = vi.fn(async () => "recycled");
    const service = createService({
      rootDir: root,
      sessions: [session],
      applyManagerRuntimeRecyclePolicy,
    });

    await service.updateOpenAIAuthBrokerSettings({
      mode: "local",
      broker: { url: "https://broker.example.test", token: "first-secret-same" },
    });
    applyManagerRuntimeRecyclePolicy.mockClear();

    await service.updateOpenAIAuthBrokerSettings({
      mode: "local",
      broker: { token: "other-secret-same" },
    });

    expect(applyManagerRuntimeRecyclePolicy).not.toHaveBeenCalled();
  });
});

describe("SwarmSettingsService.updateManagerCwd", () => {
  it("patches all profile sessions in one transaction and recycles only after save", async () => {
    const root = await createTempRoot();
    const nextCwd = join(root, "workspace");
    const firstSession = createSession(root, "manager");
    const secondSession = createSession(root, "manager--s2");
    const patchedDescriptors: string[] = [];
    let saved = false;
    const transactionDescriptors = vi.fn(async (callback: any) => {
      const result = await callback({
        patchDescriptor: (agentId: string, patch: Partial<AgentDescriptor>) => {
          patchedDescriptors.push(agentId);
          const session = [firstSession, secondSession].find((candidate) => candidate.agentId === agentId);
          if (!session) throw new Error(`unknown descriptor ${agentId}`);
          Object.assign(session, patch);
          return session;
        },
        patchProfile: () => {
          throw new Error("unexpected profile patch");
        }
      });
      saved = true;
      return result;
    });
    const applyManagerRuntimeRecyclePolicy = vi.fn(async () => {
      expect(saved).toBe(true);
      return "recycled";
    });
    const emitAgentsSnapshot = vi.fn();
    const service = createService({
      rootDir: root,
      sessions: [firstSession, secondSession],
      transactionDescriptors,
      applyManagerRuntimeRecyclePolicy,
      emitAgentsSnapshot
    });

    await expect(service.updateManagerCwd("manager", nextCwd)).resolves.toBe(nextCwd);

    expect(transactionDescriptors).toHaveBeenCalledTimes(1);
    expect(patchedDescriptors).toEqual(["manager", "manager--s2"]);
    expect(firstSession.cwd).toBe(nextCwd);
    expect(secondSession.cwd).toBe(nextCwd);
    expect(applyManagerRuntimeRecyclePolicy.mock.calls).toEqual([
      ["manager", "cwd_change"],
      ["manager--s2", "cwd_change"]
    ]);
    expect(emitAgentsSnapshot).toHaveBeenCalledTimes(1);
  });

  it("emits the agents snapshot only after cwd recycle attempts finish", async () => {
    const root = await createTempRoot();
    const nextCwd = join(root, "workspace");
    const firstSession = createSession(root, "manager");
    const secondSession = createSession(root, "manager--s2");
    const events: string[] = [];
    const applyManagerRuntimeRecyclePolicy = vi.fn(async (agentId: string) => {
      events.push(`recycle-start:${agentId}`);
      await Promise.resolve();
      events.push(`recycle-finish:${agentId}`);
      return agentId === firstSession.agentId ? "recycled" : "deferred";
    });
    const emitAgentsSnapshot = vi.fn(() => {
      events.push("snapshot");
    });
    const service = createService({
      rootDir: root,
      sessions: [firstSession, secondSession],
      applyManagerRuntimeRecyclePolicy,
      emitAgentsSnapshot
    });

    await expect(service.updateManagerCwd("manager", nextCwd)).resolves.toBe(nextCwd);

    expect(events).toEqual([
      "recycle-start:manager",
      "recycle-finish:manager",
      "recycle-start:manager--s2",
      "recycle-finish:manager--s2",
      "snapshot"
    ]);
  });

  it("does not recycle or emit when cwd transaction save fails", async () => {
    const root = await createTempRoot();
    const nextCwd = join(root, "workspace");
    const session = createSession(root, "manager");
    const transactionDescriptors = vi.fn(async (callback: any) => {
      await callback({
        patchDescriptor: (agentId: string, patch: Partial<AgentDescriptor>) => {
          expect(agentId).toBe(session.agentId);
          Object.assign(session, patch);
          return session;
        },
        patchProfile: () => {
          throw new Error("unexpected profile patch");
        }
      });
      session.cwd = root;
      throw new Error("save failed");
    });
    const applyManagerRuntimeRecyclePolicy = vi.fn(async () => "recycled");
    const emitAgentsSnapshot = vi.fn();
    const service = createService({
      rootDir: root,
      sessions: [session],
      transactionDescriptors,
      applyManagerRuntimeRecyclePolicy,
      emitAgentsSnapshot
    });

    await expect(service.updateManagerCwd("manager", nextCwd)).rejects.toThrow("save failed");

    expect(session.cwd).toBe(root);
    expect(applyManagerRuntimeRecyclePolicy).not.toHaveBeenCalled();
    expect(emitAgentsSnapshot).not.toHaveBeenCalled();
  });
});
