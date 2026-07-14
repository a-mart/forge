import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProjectAgentCoordinator,
  type ProjectAgentCoordinatorOptions,
  type ProjectAgentSessionDescriptor,
} from "../project-agent-coordinator.js";
import type { RepoProjectAgentSourceResolution } from "../agents/repo-project-agent-source.js";
import type { ProjectWorkspaceResolution } from "../project-workspace-resolver.js";
import type { Api, Model } from "../pi/pi-ai-compat.js";
import type { AgentDescriptor, ManagerProfile, SwarmConfig } from "../types.js";

const NOW = "2026-07-13T12:00:00.000Z";
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("ProjectAgentCoordinator", () => {
  it("separates prompt-only edits from shared directory changes", async () => {
    const harness = new CoordinatorHarness();
    const source = harness.addSession("source", "source-profile", {
      projectAgent: {
        handle: "docs",
        whenToUse: "Use for docs",
        systemPrompt: "Old prompt",
      },
    });
    harness.addSession("target", "target-profile");
    harness.grants = [{ targetProfileId: "target-profile" }];
    harness.setProjectAgentImplementation = async (_agentId, next) => {
      source.projectAgent = next
        ? {
            handle: next.handle ?? source.projectAgent?.handle ?? "source",
            whenToUse: next.whenToUse,
            systemPrompt: next.systemPrompt,
            capabilities: next.capabilities,
          }
        : undefined;
      return { profileId: source.profileId, projectAgent: source.projectAgent ?? null };
    };
    const coordinator = harness.createCoordinator();

    await coordinator.setSessionProjectAgent("source", {
      handle: "docs",
      whenToUse: "Use for docs",
      systemPrompt: "New prompt",
    });
    expect(harness.recycles).toEqual([
      { agentId: "source", reason: "prompt_mode_change" },
    ]);

    harness.recycles.length = 0;
    await coordinator.setSessionProjectAgent("source", {
      handle: "release-docs",
      whenToUse: "Use for release docs",
      systemPrompt: "New prompt",
    });
    expect(harness.sessionProjectAgentUpdates).toEqual([
      expect.objectContaining({ agentId: "source", profileId: "source-profile" }),
    ]);
    expect(harness.recycles).toEqual([
      { agentId: "target", reason: "project_agent_directory_change" },
    ]);
  });

  it("scans and activates a repository definition through the project-agent service", async () => {
    const root = await makeTempDir("forge-project-agent-coordinator-");
    const definitionsDir = join(root, "project-agents");
    const definitionDir = join(definitionsDir, "docs");
    await mkdir(definitionDir, { recursive: true });
    await writeFile(
      join(definitionDir, "config.json"),
      JSON.stringify({
        version: 1,
        handle: "docs",
        whenToUse: "Use for repository docs",
        capabilities: ["create_session"],
      }),
      "utf8",
    );
    await writeFile(join(definitionDir, "prompt.md"), "Maintain repository docs.", "utf8");

    const harness = new CoordinatorHarness(root);
    harness.addSession("source", "profile-a", { cwd: root });
    harness.workspaceResolution = makeWorkspaceResolution({
      root,
      profileId: "profile-a",
      sessionAgentId: "source",
      definitionsDir,
    });
    harness.activateRepoImplementation = async (input) => ({
      profileId: input.profileId,
      agentId: "activated",
      projectAgent: {
        handle: input.definition.config.handle,
        whenToUse: input.definition.config.whenToUse,
        source: input.source,
      },
    });
    const coordinator = harness.createCoordinator();

    const result = await coordinator.activateRepoProjectAgent({
      profileId: "profile-a",
      sessionAgentId: "source",
      definitionId: "docs",
      mode: "create",
      applyRecommendedModel: false,
      approvedCapabilities: ["create_session"],
      explicitBindToSourceWorkspace: false,
    });

    expect(result).toMatchObject({
      profileId: "profile-a",
      agentId: "activated",
      projectAgent: {
        handle: "docs",
      },
    });
    expect(harness.activateRepoCalls).toHaveLength(1);
    expect(harness.activateRepoCalls[0]?.source).toMatchObject({
      type: "repo",
      workspaceKey: "workspace-profile-a",
      forgeDirRealpath: root,
      definitionId: "docs",
      activatedAt: NOW,
    });
    expect(harness.activateRepoCalls[0]?.definition.prompt).toBe(
      "Maintain repository docs.",
    );
  });

  it("runs recommendation analysis with the unpromoted prompt and transcript context", async () => {
    const harness = new CoordinatorHarness();
    harness.addSession("source", "profile-a", {
      displayName: "Docs session",
      sessionLabel: "Docs",
    });
    const model = { provider: "test", id: "analysis" } as unknown as Model<Api>;
    const analyze = vi.fn(async () => ({
      whenToUse: "Use for docs",
      systemPrompt: "Maintain docs",
    }));
    const coordinator = harness.createCoordinator({
      resolveAnalysisModel: async () => ({
        model,
        apiKey: "test-key",
        headers: { "x-test": "yes" },
        modelLabel: "test/analysis",
      }),
      analyzeSession: analyze,
    });

    await expect(coordinator.requestRecommendations("source")).resolves.toEqual({
      whenToUse: "Use for docs",
      systemPrompt: "Maintain docs",
    });
    expect(harness.promptBuilds).toEqual([
      { agentId: "source", ignoreProjectAgentSystemPrompt: true },
    ]);
    expect(analyze).toHaveBeenCalledWith(
      model,
      expect.objectContaining({
        conversationHistory: harness.conversationHistory,
        currentSystemPrompt: "resolved prompt for source",
        sessionAgentId: "source",
        sessionLabel: "Docs",
        profileId: "profile-a",
        apiKey: "test-key",
        headers: { "x-test": "yes" },
      }),
    );
  });

  it("refreshes changed repository metadata before runtime use and fans out directory updates", async () => {
    const harness = new CoordinatorHarness();
    const source = harness.addRepoProjectAgent("source", "source-profile", {
      signature: "old-signature",
      whenToUse: "Old routing",
    });
    harness.addSession("source-sibling", "source-profile");
    harness.addSession("target", "target-profile");
    harness.grants = [{ targetProfileId: "target-profile" }];
    harness.repoSourceResolution = validRepoSourceResolution({
      descriptor: source,
      signature: "new-signature",
      whenToUse: "New routing",
    });
    const coordinator = harness.createCoordinator();

    await coordinator.preflightRuntime(source);

    expect(source.projectAgent?.whenToUse).toBe("New routing");
    expect(source.projectAgent?.source).toMatchObject({ signature: "new-signature" });
    expect(harness.upserts).toEqual(["source"]);
    expect(harness.saveCount).toBe(1);
    expect(harness.snapshotCount).toBe(1);
    expect(harness.recycles).toEqual(expect.arrayContaining([
      { agentId: "source", reason: "project_agent_directory_change" },
      { agentId: "source-sibling", reason: "project_agent_directory_change" },
      { agentId: "target", reason: "project_agent_directory_change" },
    ]));
  });

  it("fails closed on an unavailable shared repository source and excludes it from the directory", async () => {
    const harness = new CoordinatorHarness();
    const source = harness.addRepoProjectAgent("source", "source-profile");
    harness.addSession("target", "target-profile");
    harness.grants = [{ targetProfileId: "target-profile" }];
    harness.externalDirectoryEntries = [
      {
        agentId: "source",
        handle: "source/docs",
        displayName: "Docs",
        whenToUse: "Use for docs",
        sourceProjectName: "Source",
        origin: "external",
      },
      {
        agentId: "local",
        handle: "local",
        displayName: "Local",
        whenToUse: "Use locally",
        sourceProjectName: "Other",
        origin: "external",
      },
    ];
    harness.repoSourceResolution = unavailableRepoSourceResolution(source);
    const coordinator = harness.createCoordinator();

    await expect(coordinator.getExternalDirectory("target-profile")).resolves.toEqual([
      expect.objectContaining({ agentId: "local" }),
    ]);
    await expect(
      coordinator.assertRepoSourceAvailableForExternalDelivery(source),
    ).rejects.toThrow(
      "Shared project agent @docs is unavailable because its repository source is missing.",
    );
    expect(harness.recycles).toEqual(expect.arrayContaining([
      { agentId: "target", reason: "project_agent_directory_change" },
    ]));
    expect(harness.logs).toContainEqual(expect.objectContaining({
      message: "project_agent:external_directory:exclude_unavailable_repo_source",
      details: expect.objectContaining({ sourceAgentId: "source" }),
    }));
  });

  it("does not commit source changes while an active runtime cannot be recycled", async () => {
    const harness = new CoordinatorHarness();
    const source = harness.addRepoProjectAgent("source", "source-profile", {
      signature: "old-signature",
    });
    harness.activeRuntimeIds.add("source");
    harness.recycleDisposition = "deferred";
    harness.repoSourceResolution = validRepoSourceResolution({
      descriptor: source,
      signature: "new-signature",
      whenToUse: "New routing",
    });
    const coordinator = harness.createCoordinator();

    await expect(coordinator.preflightRuntime(source)).rejects.toThrow(
      "changed while source has an active runtime",
    );
    expect(source.projectAgent?.source).toMatchObject({ signature: "old-signature" });
    expect(harness.saveCount).toBe(0);
  });
});

class CoordinatorHarness {
  readonly descriptors = new Map<string, AgentDescriptor>();
  readonly profiles = new Map<string, ManagerProfile>();
  readonly recycles: Array<{ agentId: string; reason: string }> = [];
  readonly upserts: string[] = [];
  readonly sessionProjectAgentUpdates: Array<{
    agentId: string;
    profileId: string;
    projectAgent: AgentDescriptor["projectAgent"] | null;
  }> = [];
  readonly logs: Array<{ message: string; details?: Record<string, unknown> }> = [];
  readonly promptBuilds: Array<{
    agentId: string;
    ignoreProjectAgentSystemPrompt: boolean;
  }> = [];
  readonly activateRepoCalls: Array<Record<string, any>> = [];
  readonly activeRuntimeIds = new Set<string>();
  readonly conversationHistory = [
    { type: "conversation_message", role: "user", content: "Review the docs" },
  ] as unknown as ProjectAgentCoordinatorOptions["prompt"] extends {
    getConversationHistory(agentId: string): infer T;
  }
    ? T
    : never;
  workspaceResolution?: ProjectWorkspaceResolution;
  repoSourceResolution?: RepoProjectAgentSourceResolution;
  grants: Array<{ targetProfileId: string }> = [];
  externalDirectoryEntries: ProjectAgentCoordinatorOptions["sharing"] extends {
    getExternalDirectoryEntries(profileId: string): infer T;
  }
    ? T
    : never = [];
  recycleDisposition: "recycled" | "deferred" | "none" = "recycled";
  saveCount = 0;
  snapshotCount = 0;
  setProjectAgentImplementation: (
    agentId: string,
    projectAgent: Parameters<
      ProjectAgentCoordinatorOptions["projectAgents"]["setSessionProjectAgent"]
    >[1],
  ) => ReturnType<
    ProjectAgentCoordinatorOptions["projectAgents"]["setSessionProjectAgent"]
  > = async () => ({ profileId: "unused", projectAgent: null });
  activateRepoImplementation: (
    input: Parameters<
      ProjectAgentCoordinatorOptions["projectAgents"]["activateRepoProjectAgent"]
    >[0],
  ) => ReturnType<
    ProjectAgentCoordinatorOptions["projectAgents"]["activateRepoProjectAgent"]
  > = async () => {
    throw new Error("activateRepoProjectAgent was not configured");
  };

  constructor(readonly dataDir = "/data") {}

  createCoordinator(
    overrides: Pick<
      ProjectAgentCoordinatorOptions,
      "resolveAnalysisModel" | "analyzeSession"
    > = {},
  ): ProjectAgentCoordinator {
    const projectAgents = {
      createAndPromoteProjectAgent: vi.fn(),
      activateRepoProjectAgent: vi.fn((input) => {
        this.activateRepoCalls.push(input);
        return this.activateRepoImplementation(input);
      }),
      setSessionProjectAgent: vi.fn((agentId, projectAgent) =>
        this.setProjectAgentImplementation(agentId, projectAgent)),
      getProjectAgentConfig: vi.fn(),
      listProjectAgentReferences: vi.fn(async () => []),
      getProjectAgentReference: vi.fn(async () => "reference"),
      setProjectAgentReference: vi.fn(async () => ({
        directoryChanged: false,
        promptChanged: false,
        referenceChanged: true,
      })),
      deleteProjectAgentReference: vi.fn(async () => ({
        directoryChanged: false,
        promptChanged: false,
        referenceChanged: true,
      })),
    } as unknown as ProjectAgentCoordinatorOptions["projectAgents"];
    const sharing = {
      reconcile: vi.fn(async () => false),
      getSharingSnapshot: vi.fn(),
      replaceSharingTargets: vi.fn(),
      getExternalDirectoryEntries: vi.fn(() => this.externalDirectoryEntries),
      listGrantsForSourceAgent: vi.fn(() => this.grants),
    } as unknown as ProjectAgentCoordinatorOptions["sharing"];

    return new ProjectAgentCoordinator({
      config: { paths: { dataDir: this.dataDir } } as SwarmConfig,
      descriptors: this.descriptors,
      profiles: this.profiles,
      projectAgents,
      sharing,
      access: {
        getRequiredBuilderSession: (agentId) => {
          const descriptor = this.descriptors.get(agentId);
          if (!descriptor || descriptor.role !== "manager" || !descriptor.profileId) {
            throw new Error(`Session not found: ${agentId}`);
          }
          return descriptor as ProjectAgentSessionDescriptor;
        },
        assertDescriptorNotEffectivelyArchived: (descriptor) => {
          if (descriptor.archivedAt) throw new Error("archived");
        },
        assertSessionSupportsProjectAgent: () => undefined,
      },
      prompt: {
        getConversationHistory: () => this.conversationHistory,
        buildResolvedManagerPrompt: async (descriptor, options) => {
          this.promptBuilds.push({
            agentId: descriptor.agentId,
            ignoreProjectAgentSystemPrompt: options.ignoreProjectAgentSystemPrompt,
          });
          return `resolved prompt for ${descriptor.agentId}`;
        },
        resolveLiveSystemPrompt: async (descriptor) => `live ${descriptor.agentId}`,
        readPersistedSystemPrompt: async (descriptor) => `persisted ${descriptor.agentId}`,
      },
      runtime: {
        hasRuntime: (agentId) => this.activeRuntimeIds.has(agentId),
        recycleManager: async (agentId, reason) => {
          this.recycles.push({ agentId, reason });
          return this.recycleDisposition;
        },
      },
      persistence: {
        upsertDescriptorInLiveMaps: (descriptor) => {
          this.upserts.push(descriptor.agentId);
          this.descriptors.set(descriptor.agentId, descriptor);
        },
        saveStore: async () => {
          this.saveCount += 1;
        },
      },
      events: {
        emitAgentsSnapshot: () => {
          this.snapshotCount += 1;
        },
        emitSessionProjectAgentUpdated: (agentId, profileId, projectAgent) => {
          this.sessionProjectAgentUpdates.push({ agentId, profileId, projectAgent });
        },
      },
      listSessionsForProfile: (profileId) =>
        Array.from(this.descriptors.values()).filter(
          (descriptor): descriptor is ProjectAgentSessionDescriptor =>
            descriptor.role === "manager" && descriptor.profileId === profileId,
        ),
      getPiModelsJsonPath: () => "/models.json",
      now: () => NOW,
      logDebug: (message, details) => this.logs.push({ message, details }),
      createWorkspaceResolver: () => ({
        resolve: async () => {
          if (!this.workspaceResolution) throw new Error("workspace resolution missing");
          return this.workspaceResolution;
        },
      }),
      resolveRepoSource: async () => {
        if (!this.repoSourceResolution) throw new Error("source resolution missing");
        return this.repoSourceResolution;
      },
      ...overrides,
    });
  }

  addSession(
    agentId: string,
    profileId: string,
    overrides: Partial<AgentDescriptor> = {},
  ): ProjectAgentSessionDescriptor {
    this.ensureProfile(profileId);
    const descriptor: ProjectAgentSessionDescriptor = {
      agentId,
      displayName: agentId,
      role: "manager",
      managerId: agentId,
      profileId,
      status: "idle",
      createdAt: NOW,
      updatedAt: NOW,
      cwd: `/workspace/${profileId}`,
      model: { provider: "openai", modelId: "gpt-5" },
      sessionFile: `/data/${agentId}.jsonl`,
      ...overrides,
    };
    this.descriptors.set(agentId, descriptor);
    return descriptor;
  }

  addRepoProjectAgent(
    agentId: string,
    profileId: string,
    overrides: { signature?: string; whenToUse?: string } = {},
  ) {
    return this.addSession(agentId, profileId, {
      projectAgent: {
        handle: "docs",
        whenToUse: overrides.whenToUse ?? "Use for docs",
        source: {
          type: "repo",
          workspaceKey: `workspace-${profileId}`,
          forgeDirRealpath: `/workspace/${profileId}/.forge`,
          definitionId: "docs",
          activatedAt: NOW,
          signature: overrides.signature ?? "signature",
        },
      },
    }) as ProjectAgentSessionDescriptor & {
      projectAgent: NonNullable<AgentDescriptor["projectAgent"]> & {
        source: { type: "repo"; workspaceKey: string; forgeDirRealpath: string; definitionId: string; activatedAt: string; signature: string };
      };
    };
  }

  private ensureProfile(profileId: string): void {
    if (this.profiles.has(profileId)) return;
    this.profiles.set(profileId, {
      profileId,
      displayName: profileId,
      defaultSessionAgentId: profileId,
      defaultModel: { provider: "openai", modelId: "gpt-5" },
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeWorkspaceResolution(options: {
  root: string;
  profileId: string;
  sessionAgentId: string;
  definitionsDir: string;
}): ProjectWorkspaceResolution {
  return {
    profileId: options.profileId,
    sessionAgentId: options.sessionAgentId,
    cwdRealpath: options.root,
    workspaceKey: `workspace-${options.profileId}`,
    source: "git-root",
    defaultForgeDir: options.root,
    effectiveForgeDir: options.root,
    effectiveForgeDirRealpath: options.root,
    repoRootResources: { projectAgentsDir: options.definitionsDir },
    trust: { state: "trusted", key: options.root },
    legacyExecutableSurfaces: [],
    signature: "workspace-signature",
  } as ProjectWorkspaceResolution;
}

function validRepoSourceResolution(options: {
  descriptor: ProjectAgentSessionDescriptor & {
    projectAgent: NonNullable<AgentDescriptor["projectAgent"]>;
  };
  signature: string;
  whenToUse: string;
}): RepoProjectAgentSourceResolution {
  const source = options.descriptor.projectAgent.source;
  if (!source || source.type !== "repo") throw new Error("expected repository source");
  return {
    definition: {
      definitionId: source.definitionId,
      dirPath: source.forgeDirRealpath,
      config: {
        version: 1,
        handle: options.descriptor.projectAgent.handle,
        whenToUse: options.whenToUse,
      },
      prompt: "Prompt",
      referenceDocs: [],
      signature: options.signature,
    },
    source: {
      ...source,
      status: "valid",
      problems: [],
      signature: options.signature,
    },
  };
}

function unavailableRepoSourceResolution(
  descriptor: ProjectAgentSessionDescriptor & {
    projectAgent: NonNullable<AgentDescriptor["projectAgent"]>;
  },
): RepoProjectAgentSourceResolution {
  const source = descriptor.projectAgent.source;
  if (!source || source.type !== "repo") throw new Error("expected repository source");
  return {
    source: {
      ...source,
      status: "missing",
      problems: [{
        code: "repo_project_agent_definition_missing",
        message: "Definition missing",
      }],
    },
  };
}
