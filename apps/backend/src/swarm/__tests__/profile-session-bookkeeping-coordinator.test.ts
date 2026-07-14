import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentDirectory } from "../agent-directory.js";
import type { DescriptorStoreAdapter } from "../agents/descriptor-store/live-map-adapter.js";
import { getSessionDir } from "../data-paths.js";
import { ProfileSessionBookkeepingCoordinator } from "../profile-session-bookkeeping-coordinator.js";
import type { AgentDescriptor, ManagerProfile } from "../types.js";

const MODEL = {
  provider: "openai-codex",
  modelId: "gpt-5.5",
  thinkingLevel: "medium" as const,
};

function profile(
  profileId: string,
  overrides: Partial<ManagerProfile> = {},
): ManagerProfile {
  return {
    profileId,
    displayName: profileId,
    defaultSessionAgentId: `${profileId}-session`,
    defaultModel: { ...MODEL },
    createdAt: `2026-01-0${profileId === "alpha" ? "1" : "2"}T00:00:00.000Z`,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function manager(
  agentId: string,
  profileId: string,
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    agentId,
    displayName: agentId,
    role: "manager",
    managerId: agentId,
    profileId,
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/project",
    model: { ...MODEL },
    sessionFile: `/tmp/${agentId}.jsonl`,
    ...overrides,
  };
}

function createHarness(options?: {
  dataDir?: string;
  descriptors?: AgentDescriptor[];
  profiles?: ManagerProfile[];
}) {
  const descriptors = new Map(
    (options?.descriptors ?? [manager("alpha-session", "alpha")]).map((item) => [
      item.agentId,
      item,
    ]),
  );
  const profiles = new Map(
    (options?.profiles ?? [profile("alpha")]).map((item) => [item.profileId, item]),
  );
  const directory = new AgentDirectory({
    descriptors,
    profiles,
    getPendingChoiceCount: () => 0,
  });
  const saveStore = vi.fn(async () => {});
  const patchProfile = vi.fn(async (
    profileId: string,
    patch: Partial<ManagerProfile> | ((current: ManagerProfile) => ManagerProfile),
  ) => {
    const current = profiles.get(profileId);
    if (!current) throw new Error(`Unknown profile: ${profileId}`);
    const next = typeof patch === "function"
      ? patch({ ...current, defaultModel: { ...current.defaultModel } })
      : { ...current, ...patch, profileId };
    profiles.set(profileId, next);
    return next;
  });
  const upsertProfileInLiveMaps = vi.fn((item: ManagerProfile) => {
    profiles.set(item.profileId, { ...item, defaultModel: { ...item.defaultModel } });
  });
  const notifySharedTargetsChanged = vi.fn(async () => {});
  const emitAgentsSnapshot = vi.fn();
  const emitProfilesSnapshot = vi.fn();
  const coordinator = new ProfileSessionBookkeepingCoordinator({
    dataDir: options?.dataDir ?? "/tmp/forge-bookkeeping",
    descriptors,
    profiles,
    directory,
    persistence: {
      patchProfile,
      saveStore,
      upsertProfileInLiveMaps,
    } satisfies Pick<
      DescriptorStoreAdapter,
      "patchProfile" | "saveStore" | "upsertProfileInLiveMaps"
    >,
    now: () => "2026-07-14T12:00:00.000Z",
    notifySharedTargetsChanged,
    emitAgentsSnapshot,
    emitProfilesSnapshot,
  });

  return {
    coordinator,
    profiles,
    patchProfile,
    saveStore,
    upsertProfileInLiveMaps,
    notifySharedTargetsChanged,
    emitAgentsSnapshot,
    emitProfilesSnapshot,
  };
}

describe("ProfileSessionBookkeepingCoordinator", () => {
  it("normalizes a profile rename, persists it, refreshes shared targets, then emits snapshots", async () => {
    const shared = manager("shared-agent", "alpha", {
      projectAgent: {
        handle: "shared",
        whenToUse: "Use for shared work.",
        systemPrompt: "Shared prompt.",
      },
    });
    const harness = createHarness({
      descriptors: [manager("alpha-session", "alpha"), shared],
    });

    await harness.coordinator.renameProfile("alpha", "  Renamed Profile  ");

    expect(harness.patchProfile).toHaveBeenCalledWith("alpha", {
      displayName: "Renamed Profile",
      updatedAt: "2026-07-14T12:00:00.000Z",
    });
    expect(harness.notifySharedTargetsChanged).toHaveBeenCalledWith("shared-agent");
    expect(harness.emitProfilesSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.emitAgentsSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.profiles.get("alpha")?.displayName).toBe("Renamed Profile");
  });

  it("preserves validation gates before mutating a profile", async () => {
    const harness = createHarness({
      profiles: [profile("alpha", { archivedAt: "2026-07-01T00:00:00.000Z" })],
    });

    await expect(harness.coordinator.renameProfile("alpha", "Renamed")).rejects.toThrow(
      "Archived projects can’t be used until restored.",
    );
    await expect(harness.coordinator.renameProfile("missing", "Renamed")).rejects.toThrow(
      "Profile not found: missing",
    );
    expect(harness.patchProfile).not.toHaveBeenCalled();
  });

  it("materializes legacy sort orders and persists an explicit reorder at one save boundary", async () => {
    const harness = createHarness({
      profiles: [profile("alpha"), profile("beta")],
      descriptors: [manager("alpha-session", "alpha"), manager("beta-session", "beta")],
    });

    harness.coordinator.materializeProfileSortOrder();
    expect(harness.profiles.get("alpha")?.sortOrder).toBe(0);
    expect(harness.profiles.get("beta")?.sortOrder).toBe(1);
    expect(harness.saveStore).not.toHaveBeenCalled();

    await harness.coordinator.reorderProfiles(["beta", "alpha"]);

    expect(harness.profiles.get("beta")?.sortOrder).toBe(0);
    expect(harness.profiles.get("alpha")?.sortOrder).toBe(1);
    expect(harness.saveStore).toHaveBeenCalledTimes(1);
    expect(harness.emitProfilesSnapshot).toHaveBeenCalledTimes(1);
  });

  it("appends valid rename history while discarding malformed legacy entries", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-bookkeeping-"));
    const descriptor = manager("alpha-session", "alpha") as AgentDescriptor & {
      role: "manager";
      profileId: string;
    };
    const sessionDir = getSessionDir(dataDir, "alpha", "alpha-session");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "rename-history.json"),
      JSON.stringify([
        { from: "Original", to: "First", renamedAt: "2026-07-01T00:00:00.000Z" },
        { from: "invalid", to: 42 },
      ]),
      "utf8",
    );
    const harness = createHarness({ dataDir, descriptors: [descriptor] });

    await harness.coordinator.appendSessionRenameHistoryEntry(descriptor, {
      from: "First",
      to: "Second",
      renamedAt: "2026-07-14T12:00:00.000Z",
    });

    const persisted = JSON.parse(
      await readFile(join(sessionDir, "rename-history.json"), "utf8"),
    ) as unknown[];
    expect(persisted).toEqual([
      { from: "Original", to: "First", renamedAt: "2026-07-01T00:00:00.000Z" },
      { from: "First", to: "Second", renamedAt: "2026-07-14T12:00:00.000Z" },
    ]);
  });

  it("rejects a non-array non-empty rename history instead of overwriting it", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-bookkeeping-"));
    const descriptor = manager("alpha-session", "alpha") as AgentDescriptor & {
      role: "manager";
      profileId: string;
    };
    const sessionDir = getSessionDir(dataDir, "alpha", "alpha-session");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "rename-history.json"), '{"unexpected":true}', "utf8");
    const harness = createHarness({ dataDir, descriptors: [descriptor] });

    await expect(
      harness.coordinator.appendSessionRenameHistoryEntry(descriptor, {
        from: "First",
        to: "Second",
        renamedAt: "2026-07-14T12:00:00.000Z",
      }),
    ).rejects.toThrow("Invalid rename history format for session alpha-session");
  });
});
