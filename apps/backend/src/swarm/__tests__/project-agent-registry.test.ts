import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersistedProjectAgentConfig } from "@forge/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectAgentMirrorReconciler } from "../agents/descriptor-store/project-agent-mirror-reconciler.js";
import { ProjectAgentRegistry } from "../agents/project-agent-registry.js";
import { ProjectAgentSettingsSnapshotReader } from "../agents/project-agent-settings-snapshot.js";
import { findProjectAgentByHandle, listProjectAgents } from "../project-agents.js";
import { getProjectAgentDir } from "../data-paths.js";
import { writeProjectAgentReferenceDoc } from "../reference-docs.js";
import { reconcileProjectAgentStorage, writeProjectAgentRecord } from "../project-agent-storage.js";
import type { AgentDescriptor, ManagerProfile } from "../types.js";

const tempRoots: string[] = [];

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createTempDataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "project-agent-registry-"));
  tempRoots.push(root);
  return root;
}

function makeConfig(
  overrides: Partial<PersistedProjectAgentConfig> & Pick<PersistedProjectAgentConfig, "agentId" | "handle" | "whenToUse">
): PersistedProjectAgentConfig {
  return {
    version: 1,
    agentId: overrides.agentId,
    handle: overrides.handle,
    whenToUse: overrides.whenToUse,
    promotedAt: overrides.promotedAt ?? "2026-04-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-02T00:00:00.000Z",
    ...(overrides.creatorSessionId !== undefined ? { creatorSessionId: overrides.creatorSessionId } : {}),
    ...(overrides.capabilities !== undefined ? { capabilities: overrides.capabilities } : {})
  };
}

async function writeScannedRecordWithConfigHandle(
  dataDir: string,
  profileId: string,
  dirHandle: string,
  config: PersistedProjectAgentConfig
): Promise<void> {
  const dirPath = getProjectAgentDir(dataDir, profileId, dirHandle);
  await mkdir(dirPath, { recursive: true });
  await writeFile(join(dirPath, "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function makeDescriptor(overrides: Partial<AgentDescriptor> & Pick<AgentDescriptor, "agentId">): AgentDescriptor {
  return {
    agentId: overrides.agentId,
    displayName: overrides.displayName ?? overrides.agentId,
    role: overrides.role ?? "manager",
    managerId: overrides.managerId ?? overrides.agentId,
    status: overrides.status ?? "idle",
    createdAt: overrides.createdAt ?? "2026-04-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-02T00:00:00.000Z",
    cwd: overrides.cwd ?? "/tmp/project",
    model: overrides.model ?? {
      provider: "openai-codex",
      modelId: "gpt-5.3-codex",
      thinkingLevel: "medium"
    },
    sessionFile: overrides.sessionFile ?? join("/tmp", `${overrides.agentId}.jsonl`),
    profileId: overrides.profileId ?? "profile-a",
    sessionLabel: overrides.sessionLabel,
    projectAgent: overrides.projectAgent
  };
}

function makeProfile(profileId = "profile-a"): ManagerProfile {
  return {
    profileId,
    displayName: profileId,
    defaultSessionAgentId: profileId,
    defaultModel: {
      provider: "openai-codex",
      modelId: "gpt-5.3-codex",
      thinkingLevel: "medium"
    },
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-02T00:00:00.000Z"
  };
}

describe("ProjectAgentRegistry", () => {
  it("finds handles case-insensitively within a profile and ignores other profiles", async () => {
    const dataDir = await createTempDataDir();
    const agent = makeDescriptor({
      agentId: "agent-1",
      displayName: "Docs Agent",
      projectAgent: { handle: "docs", whenToUse: "Maintain docs", systemPrompt: "secret" }
    });
    const otherProfileAgent = makeDescriptor({
      agentId: "agent-2",
      profileId: "profile-b",
      projectAgent: { handle: "docs", whenToUse: "Other docs" }
    });
    const registry = new ProjectAgentRegistry({
      dataDir,
      descriptors: new Map([
        [agent.agentId, agent],
        [otherProfileAgent.agentId, otherProfileAgent]
      ])
    });

    expect(registry.findByHandle("profile-a", " Docs ")?.agentId).toBe("agent-1");
    expect(registry.findByHandle("profile-b", "docs")?.agentId).toBe("agent-2");
    expect(registry.findByHandle("profile-a", "missing")).toBeUndefined();
    expect(registry.listDirectoryEntries("profile-a")).toEqual([
      {
        agentId: "agent-1",
        displayName: "Docs Agent",
        handle: "docs",
        whenToUse: "Maintain docs"
      }
    ]);
  });

  it("routes compatibility list/find helpers through the registry authority", async () => {
    const dataDir = await createTempDataDir();
    const docsAgent = makeDescriptor({
      agentId: "agent-1",
      displayName: "Docs Agent",
      projectAgent: { handle: "Docs Agent", whenToUse: "Maintain docs" }
    });
    const qaAgent = makeDescriptor({
      agentId: "agent-2",
      displayName: "QA Agent",
      projectAgent: { handle: "qa", whenToUse: "Test changes" }
    });
    const descriptors = [qaAgent, docsAgent];
    const registry = ProjectAgentRegistry.fromIterable({ dataDir, descriptors });
    const fromIterable = vi.spyOn(ProjectAgentRegistry, "fromIterable");

    expect(listProjectAgents(descriptors, "profile-a").map((descriptor) => descriptor.agentId)).toEqual(
      registry.list("profile-a").map((descriptor) => descriptor.agentId)
    );
    expect(findProjectAgentByHandle(descriptors, "profile-a", "@docs agent")?.agentId).toBe("agent-1");
    expect(fromIterable).toHaveBeenCalledTimes(2);
  });

  it("detects on-disk handle collisions while allowing the owning agent", async () => {
    const dataDir = await createTempDataDir();
    await writeProjectAgentRecord(
      dataDir,
      "profile-a",
      makeConfig({ agentId: "agent-1", handle: "docs", whenToUse: "Maintain docs" }),
      "Prompt"
    );
    const registry = new ProjectAgentRegistry({ dataDir, descriptors: new Map() });

    await expect(registry.hasOnDiskCollision("profile-a", "docs")).resolves.toBe(true);
    await expect(registry.hasOnDiskCollision("profile-a", "docs", "agent-1")).resolves.toBe(false);
    await expect(registry.hasOnDiskCollision("profile-a", "missing")).resolves.toBe(false);
  });

  it("builds settings snapshots from disk and includes project-agent references", async () => {
    const dataDir = await createTempDataDir();
    const descriptor = makeDescriptor({
      agentId: "agent-1",
      projectAgent: { handle: "docs", whenToUse: "Descriptor docs", systemPrompt: "Descriptor prompt" }
    });
    await writeProjectAgentRecord(
      dataDir,
      "profile-a",
      makeConfig({ agentId: "agent-1", handle: "docs", whenToUse: "Disk docs", capabilities: ["create_session"] }),
      "Disk prompt"
    );
    await writeProjectAgentReferenceDoc(dataDir, "profile-a", "docs", "overview.md", "# Overview");
    const registry = new ProjectAgentRegistry({ dataDir, descriptors: new Map([[descriptor.agentId, descriptor]]) });
    const reader = new ProjectAgentSettingsSnapshotReader({ dataDir, registry });

    await expect(reader.read("agent-1")).resolves.toEqual({
      config: makeConfig({ agentId: "agent-1", handle: "docs", whenToUse: "Disk docs", capabilities: ["create_session"] }),
      systemPrompt: "Disk prompt",
      references: ["overview.md"]
    });
  });

  it("falls back to the descriptor when the settings mirror record is missing", async () => {
    const dataDir = await createTempDataDir();
    const descriptor = makeDescriptor({
      agentId: "agent-1",
      createdAt: "2026-04-01T00:00:00.000Z",
      projectAgent: {
        handle: "qa",
        whenToUse: "Reproduce issues",
        systemPrompt: "Descriptor prompt",
        creatorSessionId: "creator-1",
        capabilities: ["create_session"]
      }
    });
    const registry = new ProjectAgentRegistry({ dataDir, descriptors: new Map([[descriptor.agentId, descriptor]]) });
    const reader = new ProjectAgentSettingsSnapshotReader({
      dataDir,
      registry,
      now: () => "2026-04-03T00:00:00.000Z"
    });

    await expect(reader.read("agent-1")).resolves.toEqual({
      config: {
        version: 1,
        agentId: "agent-1",
        handle: "qa",
        whenToUse: "Reproduce issues",
        creatorSessionId: "creator-1",
        capabilities: ["create_session"],
        promotedAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-03T00:00:00.000Z"
      },
      systemPrompt: "Descriptor prompt",
      references: []
    });
  });

  it("validates project-agent reference scope before reading reference paths", async () => {
    const dataDir = await createTempDataDir();
    const invalid = makeDescriptor({
      agentId: "agent-1",
      projectAgent: { handle: "../escape", whenToUse: "Escape" }
    });
    const nonProjectAgent = makeDescriptor({ agentId: "agent-2" });
    const registry = new ProjectAgentRegistry({
      dataDir,
      descriptors: new Map([
        [invalid.agentId, invalid],
        [nonProjectAgent.agentId, nonProjectAgent]
      ])
    });

    expect(() => registry.assertReferenceScope("agent-1")).toThrow(/invalid handle/i);
    expect(() => registry.assertReferenceScope("agent-2")).toThrow("Agent agent-2 is not a project agent");
  });

  it("normalizes a single drifted directory to the config handle and preserves settings references", async () => {
    const dataDir = await createTempDataDir();
    const config = makeConfig({
      agentId: "agent-1",
      handle: "new-handle",
      whenToUse: "Disk guidance",
      capabilities: ["create_session"]
    });
    const descriptor = makeDescriptor({
      agentId: "agent-1",
      projectAgent: { handle: "old-descriptor", whenToUse: "Descriptor guidance", systemPrompt: "Descriptor prompt" }
    });
    await writeScannedRecordWithConfigHandle(dataDir, "profile-a", "old-handle", config);
    await writeFile(join(getProjectAgentDir(dataDir, "profile-a", "old-handle"), "prompt.md"), "Disk prompt", "utf8");
    await mkdir(join(getProjectAgentDir(dataDir, "profile-a", "old-handle"), "reference"), { recursive: true });
    await writeFile(
      join(getProjectAgentDir(dataDir, "profile-a", "old-handle"), "reference", "guide.md"),
      "# Guide",
      "utf8"
    );
    const registry = new ProjectAgentRegistry({ dataDir, descriptors: new Map([[descriptor.agentId, descriptor]]) });

    await expect(registry.reconcileProfile("profile-a")).resolves.toEqual({
      hydrated: ["agent-1"],
      materialized: [],
      orphansRemoved: []
    });
    await expect(access(getProjectAgentDir(dataDir, "profile-a", "old-handle"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(getProjectAgentDir(dataDir, "profile-a", "new-handle"))).resolves.toBeUndefined();
    expect(descriptor.projectAgent).toEqual({
      handle: "new-handle",
      whenToUse: "Disk guidance",
      systemPrompt: "Disk prompt",
      capabilities: ["create_session"]
    });

    const reader = new ProjectAgentSettingsSnapshotReader({ dataDir, registry });
    await expect(reader.read("agent-1")).resolves.toEqual({
      config,
      systemPrompt: "Disk prompt",
      references: ["guide.md"]
    });
  });

  it("does not hydrate a drifted project agent directory onto another agent's occupied canonical handle", async () => {
    const dataDir = await createTempDataDir();
    const agentA = makeDescriptor({
      agentId: "agent-a",
      projectAgent: { handle: "old-handle", whenToUse: "Agent A descriptor", systemPrompt: "Agent A descriptor prompt" }
    });
    const agentB = makeDescriptor({
      agentId: "agent-b",
      projectAgent: { handle: "new-handle", whenToUse: "Agent B descriptor" }
    });
    const driftedAgentAConfig = makeConfig({
      agentId: "agent-a",
      handle: "new-handle",
      whenToUse: "Agent A drifted disk data"
    });
    const canonicalAgentBConfig = makeConfig({
      agentId: "agent-b",
      handle: "new-handle",
      whenToUse: "Agent B canonical disk data"
    });
    await writeScannedRecordWithConfigHandle(dataDir, "profile-a", "old-handle", driftedAgentAConfig);
    await writeFile(join(getProjectAgentDir(dataDir, "profile-a", "old-handle"), "prompt.md"), "Agent A drifted prompt", "utf8");
    await mkdir(join(getProjectAgentDir(dataDir, "profile-a", "old-handle"), "reference"), { recursive: true });
    await writeFile(
      join(getProjectAgentDir(dataDir, "profile-a", "old-handle"), "reference", "agent-a-drifted.md"),
      "# Agent A drifted reference",
      "utf8"
    );
    await writeProjectAgentRecord(dataDir, "profile-a", canonicalAgentBConfig, "Agent B prompt");
    await writeProjectAgentReferenceDoc(dataDir, "profile-a", "new-handle", "agent-b.md", "# Agent B");
    const registry = new ProjectAgentRegistry({
      dataDir,
      descriptors: new Map([
        [agentA.agentId, agentA],
        [agentB.agentId, agentB]
      ])
    });

    await expect(registry.reconcileProfile("profile-a")).resolves.toEqual({
      hydrated: ["agent-b"],
      materialized: ["agent-a"],
      orphansRemoved: []
    });
    await expect(access(getProjectAgentDir(dataDir, "profile-a", "old-handle"))).resolves.toBeUndefined();
    expect(agentA.projectAgent).toEqual({
      handle: "old-handle",
      whenToUse: "Agent A descriptor",
      systemPrompt: "Agent A descriptor prompt"
    });
    expect(agentB.projectAgent).toEqual({
      handle: "new-handle",
      whenToUse: "Agent B canonical disk data",
      systemPrompt: "Agent B prompt"
    });

    const reader = new ProjectAgentSettingsSnapshotReader({ dataDir, registry });
    await expect(reader.read("agent-a")).resolves.toEqual({
      config: expect.objectContaining({
        version: 1,
        agentId: "agent-a",
        handle: "old-handle",
        whenToUse: "Agent A descriptor",
        promotedAt: "2026-04-01T00:00:00.000Z",
        updatedAt: expect.any(String)
      }),
      systemPrompt: "Agent A descriptor prompt",
      references: []
    });
    await expect(reader.read("agent-b")).resolves.toEqual({
      config: canonicalAgentBConfig,
      systemPrompt: "Agent B prompt",
      references: ["agent-b.md"]
    });
  });

  it("repairs an already-corrupted duplicate descriptor handle before deleting a colliding drift record", async () => {
    const dataDir = await createTempDataDir();
    const agentA = makeDescriptor({
      agentId: "agent-a",
      projectAgent: { handle: "new-handle", whenToUse: "Agent A descriptor", systemPrompt: "Agent A descriptor prompt" }
    });
    const agentB = makeDescriptor({
      agentId: "agent-b",
      projectAgent: { handle: "new-handle", whenToUse: "Agent B descriptor" }
    });
    await writeScannedRecordWithConfigHandle(
      dataDir,
      "profile-a",
      "old-handle",
      makeConfig({
        agentId: "agent-a",
        handle: "new-handle",
        whenToUse: "Agent A corrupted drift data"
      })
    );
    await writeFile(join(getProjectAgentDir(dataDir, "profile-a", "old-handle"), "prompt.md"), "Agent A drift prompt", "utf8");
    await writeProjectAgentRecord(
      dataDir,
      "profile-a",
      makeConfig({ agentId: "agent-b", handle: "new-handle", whenToUse: "Agent B canonical disk data" }),
      "Agent B prompt"
    );
    await writeProjectAgentReferenceDoc(dataDir, "profile-a", "new-handle", "agent-b.md", "# Agent B");
    const registry = new ProjectAgentRegistry({
      dataDir,
      descriptors: new Map([
        [agentA.agentId, agentA],
        [agentB.agentId, agentB]
      ])
    });

    await expect(registry.reconcileProfile("profile-a")).resolves.toEqual({
      hydrated: ["agent-b"],
      materialized: ["agent-a"],
      orphansRemoved: []
    });
    await expect(access(getProjectAgentDir(dataDir, "profile-a", "old-handle"))).resolves.toBeUndefined();
    expect(agentA.projectAgent?.handle).toBe("old-handle");
    expect(agentA.projectAgent?.systemPrompt).toBe("Agent A descriptor prompt");
    expect(agentB.projectAgent).toEqual({
      handle: "new-handle",
      whenToUse: "Agent B canonical disk data",
      systemPrompt: "Agent B prompt"
    });

    const reader = new ProjectAgentSettingsSnapshotReader({ dataDir, registry });
    await expect(reader.read("agent-a")).resolves.toEqual({
      config: expect.objectContaining({
        agentId: "agent-a",
        handle: "old-handle",
        whenToUse: "Agent A descriptor"
      }),
      systemPrompt: "Agent A descriptor prompt",
      references: []
    });
    await expect(reader.read("agent-b")).resolves.toEqual({
      config: expect.objectContaining({
        agentId: "agent-b",
        handle: "new-handle",
        whenToUse: "Agent B canonical disk data"
      }),
      systemPrompt: "Agent B prompt",
      references: ["agent-b.md"]
    });
  });

  it("preserves a valid duplicate when a newer same-agent drift collides with another canonical owner", async () => {
    const dataDir = await createTempDataDir();
    const agentA = makeDescriptor({
      agentId: "agent-a",
      projectAgent: { handle: "agent-a", whenToUse: "Agent A descriptor", systemPrompt: "Agent A descriptor prompt" }
    });
    const agentB = makeDescriptor({
      agentId: "agent-b",
      projectAgent: { handle: "agent-b", whenToUse: "Agent B descriptor" }
    });
    const canonicalAgentAConfig = makeConfig({
      agentId: "agent-a",
      handle: "agent-a",
      whenToUse: "Agent A canonical disk data",
      updatedAt: "2026-04-02T00:00:00.000Z"
    });
    const newerCollidingAgentAConfig = makeConfig({
      agentId: "agent-a",
      handle: "agent-b",
      whenToUse: "Agent A colliding drift data",
      updatedAt: "2026-04-04T00:00:00.000Z"
    });
    const canonicalAgentBConfig = makeConfig({
      agentId: "agent-b",
      handle: "agent-b",
      whenToUse: "Agent B canonical disk data",
      updatedAt: "2026-04-03T00:00:00.000Z"
    });
    await writeProjectAgentRecord(dataDir, "profile-a", canonicalAgentAConfig, "Agent A canonical prompt");
    await writeProjectAgentReferenceDoc(dataDir, "profile-a", "agent-a", "agent-a.md", "# Agent A");
    await writeScannedRecordWithConfigHandle(dataDir, "profile-a", "agent-a-drift", newerCollidingAgentAConfig);
    await writeFile(join(getProjectAgentDir(dataDir, "profile-a", "agent-a-drift"), "prompt.md"), "Agent A drift prompt", "utf8");
    await mkdir(join(getProjectAgentDir(dataDir, "profile-a", "agent-a-drift"), "reference"), { recursive: true });
    await writeFile(
      join(getProjectAgentDir(dataDir, "profile-a", "agent-a-drift"), "reference", "drift.md"),
      "# Drift",
      "utf8"
    );
    await writeProjectAgentRecord(dataDir, "profile-a", canonicalAgentBConfig, "Agent B canonical prompt");
    await writeProjectAgentReferenceDoc(dataDir, "profile-a", "agent-b", "agent-b.md", "# Agent B");
    const registry = new ProjectAgentRegistry({
      dataDir,
      descriptors: new Map([
        [agentA.agentId, agentA],
        [agentB.agentId, agentB]
      ])
    });

    await expect(registry.reconcileProfile("profile-a")).resolves.toEqual({
      hydrated: ["agent-a", "agent-b"],
      materialized: [],
      orphansRemoved: []
    });
    await expect(access(getProjectAgentDir(dataDir, "profile-a", "agent-a-drift"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(getProjectAgentDir(dataDir, "profile-a", "agent-a"))).resolves.toBeUndefined();
    await expect(access(getProjectAgentDir(dataDir, "profile-a", "agent-b"))).resolves.toBeUndefined();
    expect(agentA.projectAgent).toEqual({
      handle: "agent-a",
      whenToUse: "Agent A canonical disk data",
      systemPrompt: "Agent A canonical prompt"
    });
    expect(agentB.projectAgent).toEqual({
      handle: "agent-b",
      whenToUse: "Agent B canonical disk data",
      systemPrompt: "Agent B canonical prompt"
    });

    const reader = new ProjectAgentSettingsSnapshotReader({ dataDir, registry });
    await expect(reader.read("agent-a")).resolves.toEqual({
      config: canonicalAgentAConfig,
      systemPrompt: "Agent A canonical prompt",
      references: ["agent-a.md"]
    });
    await expect(reader.read("agent-b")).resolves.toEqual({
      config: canonicalAgentBConfig,
      systemPrompt: "Agent B canonical prompt",
      references: ["agent-b.md"]
    });
  });

  it("removes orphaned scanned directories when dirname and config handle drift", async () => {
    const dataDir = await createTempDataDir();
    await writeScannedRecordWithConfigHandle(
      dataDir,
      "profile-a",
      "old-handle",
      makeConfig({ agentId: "orphan-agent", handle: "new-handle", whenToUse: "Stale orphan" })
    );
    const registry = new ProjectAgentRegistry({ dataDir, descriptors: new Map() });

    await expect(registry.reconcileProfile("profile-a")).resolves.toEqual({
      hydrated: [],
      materialized: [],
      orphansRemoved: ["new-handle"]
    });
    await expect(access(getProjectAgentDir(dataDir, "profile-a", "old-handle"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes duplicate scanned directories when dirname and config handle drift", async () => {
    const dataDir = await createTempDataDir();
    const descriptor = makeDescriptor({ agentId: "agent-1" });
    await writeProjectAgentRecord(
      dataDir,
      "profile-a",
      makeConfig({
        agentId: "agent-1",
        handle: "current-handle",
        whenToUse: "Current data",
        updatedAt: "2026-04-03T00:00:00.000Z"
      }),
      "Current prompt"
    );
    await writeScannedRecordWithConfigHandle(
      dataDir,
      "profile-a",
      "stale-dir",
      makeConfig({
        agentId: "agent-1",
        handle: "stale-config-handle",
        whenToUse: "Stale duplicate",
        updatedAt: "2026-04-01T00:00:00.000Z"
      })
    );
    const registry = new ProjectAgentRegistry({ dataDir, descriptors: new Map([[descriptor.agentId, descriptor]]) });

    await expect(registry.reconcileProfile("profile-a")).resolves.toEqual({
      hydrated: ["agent-1"],
      materialized: [],
      orphansRemoved: []
    });
    await expect(access(getProjectAgentDir(dataDir, "profile-a", "stale-dir"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(getProjectAgentDir(dataDir, "profile-a", "current-handle"))).resolves.toBeUndefined();
    expect(descriptor.projectAgent).toEqual({
      handle: "current-handle",
      whenToUse: "Current data",
      systemPrompt: "Current prompt"
    });
  });

  it("keeps storage reconciliation as a compatibility wrapper for registry-owned policy", async () => {
    const dataDir = await createTempDataDir();
    const descriptor = makeDescriptor({
      agentId: "agent-1",
      projectAgent: { handle: "docs", whenToUse: "Descriptor docs", systemPrompt: "Descriptor prompt" }
    });
    const descriptors = new Map([[descriptor.agentId, descriptor]]);

    await expect(reconcileProjectAgentStorage(dataDir, "profile-a", descriptors)).resolves.toEqual({
      hydrated: [],
      materialized: ["agent-1"],
      orphansRemoved: []
    });
    await expect(access(getProjectAgentDir(dataDir, "profile-a", "docs"))).resolves.toBeUndefined();
  });

  it("keeps mirror reconciliation behind the registry wrapper", async () => {
    const dataDir = await createTempDataDir();
    await writeProjectAgentRecord(
      dataDir,
      "profile-a",
      makeConfig({ agentId: "agent-1", handle: "docs", whenToUse: "Hydrate docs" }),
      "Disk prompt"
    );
    const descriptor = makeDescriptor({ agentId: "agent-1" });
    const info = vi.fn();
    const reconciler = new ProjectAgentMirrorReconciler({
      dataDir,
      descriptors: new Map([[descriptor.agentId, descriptor]]),
      profiles: new Map([["profile-a", makeProfile("profile-a")]]),
      info
    });

    await expect(reconciler.reconcileAllProfiles()).resolves.toEqual({
      hydrated: ["agent-1"],
      materialized: [],
      orphansRemoved: []
    });
    expect(descriptor.projectAgent).toEqual({
      handle: "docs",
      whenToUse: "Hydrate docs",
      systemPrompt: "Disk prompt"
    });
    await expect(access(getProjectAgentDir(dataDir, "profile-a", "docs"))).resolves.toBeUndefined();
    expect(info).toHaveBeenCalledWith(expect.stringContaining("Hydrated 1 project agent descriptor"));
  });
});
