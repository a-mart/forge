import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeTempConfig } from "../../test-support/index.js";
import { AgentDescriptorStore } from "../agents/agent-descriptor-store.js";
import { createDescriptorStoreAdapter } from "../agents/descriptor-store/live-map-adapter.js";
import type { AgentDescriptor, ManagerProfile, SwarmConfig } from "../types.js";

function descriptor(config: SwarmConfig): AgentDescriptor {
  return {
    agentId: "manager",
    displayName: "Manager",
    role: "manager",
    managerId: "manager",
    profileId: "profile",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: config.defaultCwd,
    model: config.defaultModel,
    sessionFile: join(config.paths.sessionsDir, "manager.jsonl"),
  };
}

function profile(config: SwarmConfig): ManagerProfile {
  return {
    profileId: "profile",
    displayName: "Profile",
    defaultSessionAgentId: "manager",
    defaultModel: { ...config.defaultModel },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function createHarness(config: SwarmConfig, storeFilePath = config.paths.agentsStoreFile) {
  const descriptors = new Map([["manager", descriptor(config)]]);
  const profiles = new Map([["profile", profile(config)]]);
  const logDebug = vi.fn();
  const store = new AgentDescriptorStore({
    dataDir: config.paths.dataDir,
    storeFilePath,
    configuredManagerId: config.managerId,
    logDebug,
  });
  const adapter = createDescriptorStoreAdapter({
    store,
    descriptors,
    profiles,
    logDebug,
  });
  return { adapter, descriptors, profiles, logDebug };
}

describe("createDescriptorStoreAdapter", () => {
  it("persists transactional patches and restores both live maps when a later transaction fails", async () => {
    const config = await makeTempConfig();
    const harness = createHarness(config);

    await harness.adapter.patchDescriptor("manager", { displayName: "Renamed" });
    expect(harness.descriptors.get("manager")?.displayName).toBe("Renamed");
    expect(await readFile(config.paths.agentsStoreFile, "utf8")).toContain('"displayName": "Renamed"');

    await expect(
      harness.adapter.transactionDescriptors((store) => {
        store.patchDescriptor("manager", { displayName: "Should Roll Back" });
        store.patchProfile("profile", { displayName: "Should Also Roll Back" });
        throw new Error("transaction failed");
      }),
    ).rejects.toThrow("transaction failed");

    expect(harness.descriptors.get("manager")?.displayName).toBe("Renamed");
    expect(harness.profiles.get("profile")?.displayName).toBe("Profile");
  });

  it("keeps live-map-only profile upserts isolated from caller mutation", async () => {
    const config = await makeTempConfig();
    const harness = createHarness(config);
    const nextProfile = profile(config);

    harness.adapter.upsertProfileInLiveMaps(nextProfile);
    nextProfile.displayName = "Caller Changed";
    nextProfile.defaultModel.modelId = "caller-mutated-model";

    expect(harness.profiles.get("profile")?.displayName).toBe("Profile");
    expect(harness.profiles.get("profile")?.defaultModel.modelId).toBe(
      config.defaultModel.modelId,
    );
  });

  it("retains live state and reports storage errors for explicit best-effort persistence", async () => {
    const config = await makeTempConfig();
    const blockedParent = join(config.paths.dataDir, "blocked-parent");
    await writeFile(blockedParent, "not a directory", "utf8");
    const harness = createHarness(config, join(blockedParent, "agents.json"));

    harness.adapter.upsertDescriptorInLiveMaps({
      ...harness.descriptors.get("manager")!,
      displayName: "Still Live",
    });

    await expect(harness.adapter.persistBestEffort()).resolves.toBeUndefined();
    expect(harness.descriptors.get("manager")?.displayName).toBe("Still Live");
    expect(harness.logDebug).toHaveBeenCalledWith(
      "descriptor-store:best-effort-save-failed",
      { error: expect.anything() },
    );
  });

  it("passes best-effort transaction policy through without rolling back live mutations", async () => {
    const config = await makeTempConfig();
    const blockedParent = join(config.paths.dataDir, "blocked-transaction-parent");
    await writeFile(blockedParent, "not a directory", "utf8");
    const harness = createHarness(config, join(blockedParent, "agents.json"));
    const onSaveError = vi.fn();

    await expect(
      harness.adapter.transactionDescriptors(
        (store) => store.patchDescriptor("manager", { displayName: "Best Effort" }),
        { saveMode: "best-effort", onSaveError },
      ),
    ).resolves.toMatchObject({ displayName: "Best Effort" });

    expect(onSaveError).toHaveBeenCalledTimes(1);
    expect(harness.descriptors.get("manager")?.displayName).toBe("Best Effort");
  });
});
