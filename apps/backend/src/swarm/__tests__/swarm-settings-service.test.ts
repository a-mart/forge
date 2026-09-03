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
  hasActiveSecureSession?: ReturnType<typeof vi.fn>;
  stopSecureSessionForLifecycle?: ReturnType<typeof vi.fn>;
  beginSecureSessionLifecycleFence?: ReturnType<typeof vi.fn>;
  cancelSecureSessionLifecycleFence?: ReturnType<typeof vi.fn>;
  completeSecureSessionLifecycleFence?: ReturnType<typeof vi.fn>;
  saveStore?: ReturnType<typeof vi.fn>;
  transactionDescriptors?: (callback: any) => Promise<any>;
  emitAgentsSnapshot?: ReturnType<typeof vi.fn>;
  emitProfilesSnapshot?: ReturnType<typeof vi.fn>;
  emitModelChangeNotice?: ReturnType<typeof vi.fn>;
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
    hasActiveSecureSession: options.hasActiveSecureSession ?? vi.fn(() => false),
    stopSecureSessionForLifecycle:
      options.stopSecureSessionForLifecycle ?? vi.fn(async () => undefined),
    beginSecureSessionLifecycleFence:
      options.beginSecureSessionLifecycleFence ?? vi.fn(async () => "cwd-fence"),
    cancelSecureSessionLifecycleFence:
      options.cancelSecureSessionLifecycleFence ?? vi.fn(async () => undefined),
    completeSecureSessionLifecycleFence:
      options.completeSecureSessionLifecycleFence ?? vi.fn(async () => undefined),
    now: options.now,
    transactionDescriptors: options.transactionDescriptors,
    saveStore: options.saveStore ?? vi.fn(async () => {}),
    emitAgentsSnapshot: options.emitAgentsSnapshot ?? vi.fn(),
    emitProfilesSnapshot: options.emitProfilesSnapshot ?? vi.fn(),
    emitModelChangeNotice: options.emitModelChangeNotice,
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

describe("SwarmSettingsService delegation settings", () => {
  it("changes session posture with one runtime recycle while roster-only changes stay runtime-stable", async () => {
    const root = await createTempRoot();
    const session = Object.assign(createSession(root, "manager"), {
      managerPosture: "delegation_first" as const,
      managerPostureOrigin: "product_default" as const,
      delegationRosterId: "balanced",
      delegationRosterOrigin: "global_default" as const,
    });
    const applyManagerRuntimeRecyclePolicy = vi.fn(async () => "recycled");
    const service = createService({
      rootDir: root,
      sessions: [session],
      applyManagerRuntimeRecyclePolicy,
    });

    await service.updateSessionDelegation(session.agentId, {
      managerPosture: { mode: "override", value: "hands_on" },
      delegationRoster: { mode: "override", rosterId: "balanced" },
    });

    expect(session).toMatchObject({
      managerPosture: "hands_on",
      managerPostureOrigin: "session_override",
      delegationRosterId: "balanced",
      delegationRosterOrigin: "session_override",
    });
    expect(applyManagerRuntimeRecyclePolicy).toHaveBeenCalledTimes(1);
    expect(applyManagerRuntimeRecyclePolicy).toHaveBeenCalledWith(
      session.agentId,
      "prompt_mode_change",
    );

    await service.updateSessionDelegation(session.agentId, {
      delegationRoster: { mode: "inherit" },
    });
    expect(session.delegationRosterOrigin).toBe("global_default");
    expect(applyManagerRuntimeRecyclePolicy).toHaveBeenCalledTimes(1);
  });

  it("backfills a legacy missing roster during a posture-only update", async () => {
    const root = await createTempRoot();
    const session = Object.assign(createSession(root, "manager"), {
      managerPosture: "delegation_first" as const,
      managerPostureOrigin: "product_default" as const,
    });
    const saveStore = vi.fn(async () => undefined);
    const applyManagerRuntimeRecyclePolicy = vi.fn(async () => "recycled");
    const service = createService({
      rootDir: root,
      sessions: [session],
      saveStore,
      applyManagerRuntimeRecyclePolicy,
    });
    const { defaultRosterId } = await service.getDelegationRosterSettings();

    await service.updateSessionDelegation(session.agentId, {
      managerPosture: { mode: "override", value: "hands_on" },
    });

    expect(session).toMatchObject({
      managerPosture: "hands_on",
      managerPostureOrigin: "session_override",
      delegationRosterId: defaultRosterId,
      delegationRosterOrigin: "global_default",
    });
    expect(saveStore).toHaveBeenCalledOnce();
    expect(applyManagerRuntimeRecyclePolicy).toHaveBeenCalledWith(
      session.agentId,
      "prompt_mode_change",
    );
  });

  it("does not recycle when a posture update only backfills the inherited posture", async () => {
    const root = await createTempRoot();
    const session = Object.assign(createSession(root, "manager"), {
      delegationRosterId: "balanced",
      delegationRosterOrigin: "global_default" as const,
    });
    const applyManagerRuntimeRecyclePolicy = vi.fn(async () => "recycled");
    const service = createService({
      rootDir: root,
      sessions: [session],
      applyManagerRuntimeRecyclePolicy,
    });

    await service.updateSessionDelegation(session.agentId, {
      managerPosture: { mode: "inherit" },
    });

    expect(session).toMatchObject({
      managerPosture: "delegation_first",
      managerPostureOrigin: "product_default",
    });
    expect(applyManagerRuntimeRecyclePolicy).not.toHaveBeenCalled();
  });

  it("backfills a legacy missing posture during a roster-only update", async () => {
    const root = await createTempRoot();
    const session = Object.assign(createSession(root, "manager"), {
      delegationRosterId: "balanced",
      delegationRosterOrigin: "global_default" as const,
    });
    const saveStore = vi.fn(async () => undefined);
    const applyManagerRuntimeRecyclePolicy = vi.fn(async () => "recycled");
    const service = createService({
      rootDir: root,
      sessions: [session],
      saveStore,
      applyManagerRuntimeRecyclePolicy,
    });

    await service.updateSessionDelegation(session.agentId, {
      delegationRoster: { mode: "override", rosterId: "balanced" },
    });

    expect(session).toMatchObject({
      managerPosture: "delegation_first",
      managerPostureOrigin: "product_default",
      delegationRosterId: "balanced",
      delegationRosterOrigin: "session_override",
    });
    expect(saveStore).toHaveBeenCalledOnce();
    expect(applyManagerRuntimeRecyclePolicy).not.toHaveBeenCalled();
  });

  it("does not recycle when only the posture inheritance origin changes", async () => {
    const root = await createTempRoot();
    const session = Object.assign(createSession(root, "manager"), {
      managerPosture: "hands_on" as const,
      managerPostureOrigin: "session_override" as const,
      delegationRosterId: "balanced",
      delegationRosterOrigin: "global_default" as const,
    });
    const applyManagerRuntimeRecyclePolicy = vi.fn(async () => "recycled");
    const profile = createProfile();
    profile.defaultManagerPosture = "hands_on";
    const service = createService({
      rootDir: root,
      sessions: [session],
      profiles: new Map([["manager", profile]]),
      applyManagerRuntimeRecyclePolicy,
    });

    await service.updateSessionDelegation(session.agentId, {
      managerPosture: { mode: "inherit" },
    });

    expect(session).toMatchObject({
      managerPosture: "hands_on",
      managerPostureOrigin: "project_default",
    });
    expect(applyManagerRuntimeRecyclePolicy).not.toHaveBeenCalled();
  });

  it("updates project inheritance independently for posture and roster", async () => {
    const root = await createTempRoot();
    const inherited = Object.assign(createSession(root, "manager"), {
      managerPosture: "delegation_first" as const,
      managerPostureOrigin: "product_default" as const,
      delegationRosterId: "old-global",
      delegationRosterOrigin: "global_default" as const,
    });
    const postureOverride = Object.assign(createSession(root, "manager--posture"), {
      managerPosture: "delegation_first" as const,
      managerPostureOrigin: "session_override" as const,
      delegationRosterId: "old-global",
      delegationRosterOrigin: "global_default" as const,
    });
    const rosterOverride = Object.assign(createSession(root, "manager--roster"), {
      managerPosture: "delegation_first" as const,
      managerPostureOrigin: "product_default" as const,
      delegationRosterId: "special",
      delegationRosterOrigin: "session_override" as const,
    });
    const applyManagerRuntimeRecyclePolicy = vi.fn(async () => "recycled");
    const profiles = new Map([["manager", createProfile()]]);
    const service = createService({
      rootDir: root,
      sessions: [inherited, postureOverride, rosterOverride],
      profiles,
      applyManagerRuntimeRecyclePolicy,
    });

    await service.updateProjectDelegationDefaults("manager", {
      managerPosture: "hands_on",
      delegationRosterId: "balanced",
    });

    expect(profiles.get("manager")).toMatchObject({
      defaultManagerPosture: "hands_on",
      defaultDelegationRosterId: "balanced",
    });
    expect(inherited).toMatchObject({
      managerPosture: "hands_on",
      managerPostureOrigin: "project_default",
      delegationRosterId: "balanced",
      delegationRosterOrigin: "project_default",
    });
    expect(postureOverride).toMatchObject({
      managerPosture: "delegation_first",
      managerPostureOrigin: "session_override",
      delegationRosterId: "balanced",
      delegationRosterOrigin: "project_default",
    });
    expect(rosterOverride).toMatchObject({
      managerPosture: "hands_on",
      managerPostureOrigin: "project_default",
      delegationRosterId: "special",
      delegationRosterOrigin: "session_override",
    });
    expect(applyManagerRuntimeRecyclePolicy.mock.calls).toEqual([
      [inherited.agentId, "prompt_mode_change"],
      [rosterOverride.agentId, "prompt_mode_change"],
    ]);
  });

  it("owns roster validation, persistence, and global-default projection", async () => {
    const root = await createTempRoot();
    const session = Object.assign(createSession(root, "manager"), {
      delegationRosterId: "balanced",
      delegationRosterOrigin: "global_default" as const,
    });
    const saveStore = vi.fn(async () => undefined);
    const service = createService({ rootDir: root, sessions: [session], saveStore });
    const settings = {
      version: 1 as const,
      defaultRosterId: "focused",
      rosters: [{
        rosterId: "focused",
        revision: 1,
        name: "Focused",
        defaultRouteId: "builder",
        routes: [{
          routeId: "builder",
          label: "Builder",
          useWhen: "Use for ordinary implementation.",
          provider: "openai-codex",
          modelId: "gpt-5.5",
          reasoningLevel: "medium" as const,
        }],
      }],
    };

    const saved = await service.saveDelegationRosterSettings(settings);

    expect(saved).toMatchObject(settings);
    await expect(service.getDelegationRosterSettings()).resolves.toEqual(saved);
    expect(session).toMatchObject({
      delegationRosterId: "focused",
      delegationRosterOrigin: "global_default",
    });
    expect(saveStore).toHaveBeenCalledOnce();
  });

  it("rejects unavailable models and removal of referenced rosters before writing", async () => {
    const root = await createTempRoot();
    const profile = createProfile();
    profile.defaultDelegationRosterId = "focused";
    const service = createService({
      rootDir: root,
      sessions: [],
      profiles: new Map([["manager", profile]]),
    });
    const settings = await service.getDelegationRosterSettings();
    const invalidModel = {
      ...settings,
      rosters: settings.rosters.map((roster) => ({
        ...roster,
        routes: roster.routes.map((route, index) => index === 0
          ? { ...route, provider: "missing-provider", modelId: "missing-model" }
          : route),
      })),
    };

    await expect(service.saveDelegationRosterSettings(invalidModel))
      .rejects.toThrow("references unavailable model");
    await expect(service.saveDelegationRosterSettings(settings))
      .rejects.toThrow('Cannot remove roster "focused"');
  });
});

describe("SwarmSettingsService.updateManagerModel", () => {
  it("preserves Secure Session authority while recycling the model runtime", async () => {
    const root = await createTempRoot();
    const session = createSession(root, "manager");
    const saveStore = vi.fn(async () => undefined);
    const applyManagerRuntimeRecyclePolicy = vi.fn(async () => "recycled");
    const hasActiveSecureSession = vi.fn(() => true);
    const stopSecureSessionForLifecycle = vi.fn(async () => undefined);
    const service = createService({
      rootDir: root,
      sessions: [session],
      saveStore,
      applyManagerRuntimeRecyclePolicy,
      hasActiveSecureSession,
      stopSecureSessionForLifecycle,
    });

    await service.updateManagerModel("manager", "pi-5.6", "high");

    expect(stopSecureSessionForLifecycle).not.toHaveBeenCalled();
    expect(hasActiveSecureSession).toHaveBeenCalledWith(session.agentId);
    expect(session.model).toMatchObject({ modelId: "gpt-5.6-sol", thinkingLevel: "high" });
    expect(saveStore).toHaveBeenCalled();
    expect(applyManagerRuntimeRecyclePolicy).toHaveBeenCalledWith(
      session.agentId,
      "model_change",
    );
  });

  it("rejects an unsupported runtime before persisting or recycling an active Secure Session", async () => {
    const root = await createTempRoot();
    const session = createSession(root, "manager");
    const originalModel = { ...session.model };
    const saveStore = vi.fn(async () => undefined);
    const applyManagerRuntimeRecyclePolicy = vi.fn(async () => "recycled");
    const hasActiveSecureSession = vi.fn(() => true);
    const stopSecureSessionForLifecycle = vi.fn(async () => undefined);
    const service = createService({
      rootDir: root,
      sessions: [session],
      saveStore,
      applyManagerRuntimeRecyclePolicy,
      hasActiveSecureSession,
      stopSecureSessionForLifecycle,
    });

    await expect(
      service.updateManagerModel(session.agentId, "cursor-composer", "high"),
    ).rejects.toThrow("Secure Sessions are not supported by this runtime provider.");

    expect(hasActiveSecureSession).toHaveBeenCalledWith(session.agentId);
    expect(stopSecureSessionForLifecycle).not.toHaveBeenCalled();
    expect(session.model).toEqual(originalModel);
    expect(session.modelOrigin).toBe("profile_default");
    expect(saveStore).not.toHaveBeenCalled();
    expect(applyManagerRuntimeRecyclePolicy).not.toHaveBeenCalled();
    await expect(readFile(session.sessionFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

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

  it("normalizes Cursor preset reasoning overrides before persisting manager settings", async () => {
    const root = await createTempRoot();
    const session = createSession(root, "manager");
    const service = createService({ rootDir: root, sessions: [session] });

    await service.updateManagerModel(session.agentId, "cursor-composer", "high");

    expect(session.model).toEqual({
      provider: "cursor-sdk",
      modelId: "composer-2.5",
      thinkingLevel: "none",
    });
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

    await service.updateManagerModel("manager", "pi-5.6");

    expect(activeSession.model).toEqual(resolveModelDescriptorFromPreset("pi-5.6"));
    expect(inactiveSession.model).toEqual(resolveModelDescriptorFromPreset("pi-5.6"));
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
      targetModel: resolveModelDescriptorFromPreset("pi-5.6")
    });
    expect(inactiveState.requests[0]).toMatchObject({
      sessionAgentId: inactiveSession.agentId,
      sourceModel: resolveModelDescriptorFromPreset("pi-codex"),
      targetModel: resolveModelDescriptorFromPreset("pi-5.6")
    });
  });

  it("emits one marker per effective change, including reasoning-only changes", async () => {
    const root = await createTempRoot();
    const session = createSession(root, "manager");
    const emitModelChangeNotice = vi.fn();
    const service = createService({
      rootDir: root,
      sessions: [session],
      emitModelChangeNotice,
    });

    await service.updateManagerModel(session.agentId, "pi-codex", "high");

    expect(emitModelChangeNotice).toHaveBeenCalledTimes(1);
    expect(emitModelChangeNotice).toHaveBeenCalledWith(
      session.agentId,
      resolveModelDescriptorFromPreset("pi-codex"),
      { ...resolveModelDescriptorFromPreset("pi-codex"), thinkingLevel: "high" },
    );

    await service.updateManagerModel(session.agentId, "pi-codex", "high");
    expect(emitModelChangeNotice).toHaveBeenCalledTimes(1);
  });

  it("marks only effectively changed inherited sessions during a profile-default cascade", async () => {
    const root = await createTempRoot();
    const inheritedChanged = createSession(root, "manager--changed");
    const inheritedNoop = createSession(root, "manager--noop", resolveModelDescriptorFromPreset("pi-5.6"));
    const overridden = createSession(root, "manager--override", resolveModelDescriptorFromPreset("pi-codex"), "session_override");
    const emitModelChangeNotice = vi.fn();
    const service = createService({
      rootDir: root,
      sessions: [inheritedChanged, inheritedNoop, overridden],
      emitModelChangeNotice,
    });

    await service.updateProfileDefaultModel("manager", "pi-5.6");

    expect(emitModelChangeNotice).toHaveBeenCalledTimes(1);
    expect(emitModelChangeNotice).toHaveBeenCalledWith(
      inheritedChanged.agentId,
      resolveModelDescriptorFromPreset("pi-codex"),
      resolveModelDescriptorFromPreset("pi-5.6"),
    );
    expect(inheritedNoop.model).toEqual(resolveModelDescriptorFromPreset("pi-5.6"));
    expect(overridden.model).toEqual(resolveModelDescriptorFromPreset("pi-codex"));
  });

  it("marks an effective session override-to-inherit change but not metadata-only changes", async () => {
    const root = await createTempRoot();
    const overridden = createSession(root, "manager--override", resolveModelDescriptorFromPreset("pi-opus"), "session_override");
    const sameAsDefault = createSession(root, "manager--same", resolveModelDescriptorFromPreset("pi-codex"));
    const emitModelChangeNotice = vi.fn();
    const service = createService({
      rootDir: root,
      sessions: [overridden, sameAsDefault],
      emitModelChangeNotice,
    });

    await service.updateSessionModel(overridden.agentId, "inherit");
    await service.updateSessionModel(sameAsDefault.agentId, "override", "pi-codex");

    expect(emitModelChangeNotice).toHaveBeenCalledTimes(1);
    expect(emitModelChangeNotice).toHaveBeenCalledWith(
      overridden.agentId,
      resolveModelDescriptorFromPreset("pi-opus"),
      resolveModelDescriptorFromPreset("pi-codex"),
    );
  });

  it("emits the accepted-change notice before a deferred or failed recycle", async () => {
    const root = await createTempRoot();
    const deferred = createSession(root, "manager--deferred");
    const failed = createSession(root, "manager--failed");
    const order: string[] = [];
    const emitModelChangeNotice = vi.fn(() => order.push("notice"));
    const saveStore = vi.fn(async () => order.push("save"));
    const applyManagerRuntimeRecyclePolicy = vi.fn(async (agentId: string) => {
      order.push(`recycle:${agentId}`);
      if (agentId === failed.agentId) {
        throw new Error("recycle failed");
      }
      return "deferred" as const;
    });
    const service = createService({
      rootDir: root,
      sessions: [deferred, failed],
      emitModelChangeNotice,
      saveStore,
      applyManagerRuntimeRecyclePolicy,
    });

    await service.updateManagerModel("manager", "pi-5.6");

    expect(emitModelChangeNotice).toHaveBeenCalledTimes(2);
    expect(order[0]).toBe("save");
    const firstRecycleIndex = order.findIndex((entry) => entry.startsWith("recycle:"));
    expect(order.slice(1, firstRecycleIndex)).toEqual(["notice", "notice"]);
    expect(order).toContain(`recycle:${deferred.agentId}`);
    expect(order).toContain(`recycle:${failed.agentId}`);
    expect(deferred.model).toEqual(resolveModelDescriptorFromPreset("pi-5.6"));
    expect(failed.model).toEqual(resolveModelDescriptorFromPreset("pi-5.6"));
  });

  it("does not emit a notice when descriptor persistence fails", async () => {
    const root = await createTempRoot();
    const session = createSession(root, "manager");
    const emitModelChangeNotice = vi.fn();
    const applyManagerRuntimeRecyclePolicy = vi.fn(async () => "recycled" as const);
    const service = createService({
      rootDir: root,
      sessions: [session],
      emitModelChangeNotice,
      saveStore: vi.fn(async () => {
        throw new Error("descriptor save failed");
      }),
      applyManagerRuntimeRecyclePolicy,
    });

    await expect(service.updateManagerModel("manager", "pi-5.6")).rejects.toThrow("descriptor save failed");

    expect(emitModelChangeNotice).not.toHaveBeenCalled();
    expect(applyManagerRuntimeRecyclePolicy).not.toHaveBeenCalled();
    expect(session.model).toEqual(resolveModelDescriptorFromPreset("pi-codex"));
  });

  it("legacy session-targeted updateManagerModel creates sticky same-as-default overrides without recycling", async () => {
    const root = await createTempRoot();
    const defaultModel = resolveModelDescriptorFromPreset("pi-5.6");
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

    await service.updateManagerModel(session.agentId, "pi-5.6");

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

    await expect(service.updateManagerModel("manager", "pi-5.6")).rejects.toThrow(/invalid session header/i);

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

    await service.updateManagerModel(secondSession.agentId, "pi-5.6");

    expect(firstSession.model).toEqual(resolveModelDescriptorFromPreset("pi-codex"));
    expect(secondSession.model).toEqual(resolveModelDescriptorFromPreset("pi-5.6"));
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

    await service.updateManagerModel("manager", "pi-5.6");
    expect(session.model).toEqual(resolveModelDescriptorFromPreset("pi-5.6"));

    await service.updateManagerModel("manager", "pi-opus");
    expect(session.model).toEqual(resolveModelDescriptorFromPreset("pi-opus"));

    const state = await loadModelChangeContinuityState(session.sessionFile);
    expect(state.requests).toHaveLength(2);
    expect(state.requests[0]).toMatchObject({
      sessionAgentId: session.agentId,
      sourceModel: resolveModelDescriptorFromPreset("pi-codex"),
      targetModel: resolveModelDescriptorFromPreset("pi-5.6")
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

    await expect(service.updateProfileDefaultModel("manager", "pi-5.6")).rejects.toThrow(/invalid session header/i);

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

    await expect(service.updateSessionModel(session.agentId, "override", "pi-5.6")).rejects.toThrow("save failed");

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

    await expect(service.updateProfileDefaultModel("manager", "pi-5.6")).rejects.toThrow("save failed");

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

    await expect(service.updateSessionModel(session.agentId, "override", "pi-5.6")).resolves.toBeUndefined();

    expect(session.model).toEqual(resolveModelDescriptorFromPreset("pi-5.6"));
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

    await expect(service.updateProfileDefaultModel("manager", "pi-5.6")).resolves.toBeUndefined();

    expect(profiles.get("manager")).toMatchObject({
      defaultModel: resolveModelDescriptorFromPreset("pi-5.6"),
      updatedAt: "2026-01-02T00:00:00.000Z"
    });
    expect(firstSession.model).toEqual(resolveModelDescriptorFromPreset("pi-5.6"));
    expect(secondSession.model).toEqual(resolveModelDescriptorFromPreset("pi-5.6"));
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

    await service.updateProfileDefaultModel("manager", "pi-5.6");

    expect(inheritedRoot.model).toEqual(resolveModelDescriptorFromPreset("pi-5.6"));
    expect(inheritedSession.model).toEqual(resolveModelDescriptorFromPreset("pi-5.6"));
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

    await service.updateProfileDefaultModel("manager", "pi-5.6");

    expect(transactionDescriptors).toHaveBeenCalledTimes(1);
    expect(transactionCalls).toEqual([["manager", "manager--s2"]]);
    expect(profiles.get("manager")).toMatchObject({
      defaultModel: resolveModelDescriptorFromPreset("pi-5.6"),
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
      modelId: "claude-sonnet-5"
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

  it("recycles matching provider managers after direct OAuth credential updates", async () => {
    const root = await createTempRoot();
    const anthropicSession = createSession(root, "manager", {
      provider: "anthropic",
      modelId: "claude-sonnet-5"
    });
    const openAISession = createSession(root, "manager--openai", { provider: "openai-codex", modelId: "gpt-5.5" });
    const secretsEnvService = {
      updateSettingsAuthCredential: vi.fn(async () => undefined)
    };
    const applyManagerRuntimeRecyclePolicy = vi.fn(async () => "recycled");
    const service = createService({
      rootDir: root,
      sessions: [anthropicSession, openAISession],
      applyManagerRuntimeRecyclePolicy,
      secretsEnvService
    });

    await service.updateSettingsAuthCredential("anthropic", { type: "oauth", access: "oauth-token" } as any);

    expect(secretsEnvService.updateSettingsAuthCredential).toHaveBeenCalledWith("anthropic", {
      type: "oauth",
      access: "oauth-token"
    });
    expect(applyManagerRuntimeRecyclePolicy.mock.calls).toEqual([["manager", "auth_source_change"]]);
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
      modelId: "claude-sonnet-5"
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
  it("blocks cwd mutation before the descriptor transaction when secure teardown fails", async () => {
    const root = await createTempRoot();
    const nextCwd = join(root, "workspace");
    const firstSession = createSession(root, "manager");
    const secondSession = createSession(root, "manager--s2");
    const transactionDescriptors = vi.fn(async () => undefined);
    const beginSecureSessionLifecycleFence = vi.fn(async () => "cwd-fence");
    const cancelSecureSessionLifecycleFence = vi.fn(async () => undefined);
    const completeSecureSessionLifecycleFence = vi.fn(async () => undefined);
    const stopSecureSessionForLifecycle = vi.fn(async (agentId: string) => {
      if (agentId === secondSession.agentId) {
        throw new Error("secure teardown failed");
      }
    });
    const service = createService({
      rootDir: root,
      sessions: [firstSession, secondSession],
      transactionDescriptors,
      stopSecureSessionForLifecycle,
      beginSecureSessionLifecycleFence,
      cancelSecureSessionLifecycleFence,
      completeSecureSessionLifecycleFence,
    });

    await expect(service.updateManagerCwd("manager", nextCwd)).rejects.toThrow(
      "secure teardown failed",
    );
    expect(stopSecureSessionForLifecycle.mock.calls).toEqual([
      ["manager"],
      ["manager--s2"],
    ]);
    expect(transactionDescriptors).not.toHaveBeenCalled();
    expect(beginSecureSessionLifecycleFence).toHaveBeenCalledWith(
      "manager",
      ["manager", "manager--s2"],
    );
    expect(cancelSecureSessionLifecycleFence).toHaveBeenCalledWith("cwd-fence");
    expect(completeSecureSessionLifecycleFence).not.toHaveBeenCalled();
    expect(firstSession.cwd).toBe(root);
    expect(secondSession.cwd).toBe(root);
  });

  it("holds the secure lifecycle fence through teardown, mutation, and runtime recycle", async () => {
    const root = await createTempRoot();
    const nextCwd = join(root, "workspace");
    const session = createSession(root, "manager");
    const events: string[] = [];
    let fenceActive = false;
    const beginSecureSessionLifecycleFence = vi.fn(async (
      profileId: string,
      sessionAgentIds: readonly string[],
    ) => {
      expect(profileId).toBe("manager");
      expect(sessionAgentIds).toEqual(["manager"]);
      fenceActive = true;
      events.push("fence:begin");
      return "cwd-fence";
    });
    const stopSecureSessionForLifecycle = vi.fn(async () => {
      expect(fenceActive).toBe(true);
      events.push("secure:stop");
    });
    const transactionDescriptors = vi.fn(async (callback: any) => {
      expect(fenceActive).toBe(true);
      events.push("descriptor:transaction");
      return callback({
        patchDescriptor: (agentId: string, patch: Partial<AgentDescriptor>) => {
          Object.assign(session, patch);
          return session;
        },
        patchProfile: () => {
          throw new Error("unexpected profile patch");
        },
      });
    });
    const applyManagerRuntimeRecyclePolicy = vi.fn(async () => {
      expect(fenceActive).toBe(true);
      events.push("runtime:recycle");
      return "recycled";
    });
    const completeSecureSessionLifecycleFence = vi.fn(async (fenceId: string) => {
      expect(fenceId).toBe("cwd-fence");
      expect(fenceActive).toBe(true);
      events.push("fence:complete");
      fenceActive = false;
    });
    const cancelSecureSessionLifecycleFence = vi.fn(async () => undefined);
    const service = createService({
      rootDir: root,
      sessions: [session],
      beginSecureSessionLifecycleFence,
      stopSecureSessionForLifecycle,
      transactionDescriptors,
      applyManagerRuntimeRecyclePolicy,
      completeSecureSessionLifecycleFence,
      cancelSecureSessionLifecycleFence,
    });

    await expect(service.updateManagerCwd("manager", nextCwd)).resolves.toBe(nextCwd);

    expect(events).toEqual([
      "fence:begin",
      "secure:stop",
      "descriptor:transaction",
      "runtime:recycle",
      "fence:complete",
    ]);
    expect(fenceActive).toBe(false);
    expect(cancelSecureSessionLifecycleFence).not.toHaveBeenCalled();
  });

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
