import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { getSessionMetaPath } from "../data-paths.js";
import type { AgentDescriptor } from "../types.js";
import { TestSwarmManager, bootWithDefaultManager, makeTempConfig } from "../../test-support/index.js";

describe("worker compaction accounting", () => {
  it("persists the worker descriptor count without writing manager session meta under the worker id", async () => {
    const config = await makeTempConfig();
    const firstBoot = new TestSwarmManager(config);
    await bootWithDefaultManager(firstBoot, config);
    const worker = await firstBoot.spawnAgent("manager", { agentId: "compacting-worker" });

    await firstBoot.handleRuntimeError(worker.agentId, {
      phase: "compaction",
      message: "Automatic worker compaction completed",
      details: { recoveryStage: "auto_compaction_succeeded" }
    });

    expect(firstBoot.getAgent(worker.agentId)?.compactionCount).toBe(1);
    await expect(
      readFile(getSessionMetaPath(config.paths.dataDir, "manager", worker.agentId), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });

    const stored = JSON.parse(await readFile(config.paths.agentsStoreFile, "utf8")) as {
      agents: AgentDescriptor[];
    };
    expect(stored.agents.find((descriptor) => descriptor.agentId === worker.agentId)?.compactionCount).toBe(1);

    const secondBoot = new TestSwarmManager(config);
    await bootWithDefaultManager(secondBoot, config);

    expect(
      secondBoot.listWorkersForSession("manager").find((descriptor) => descriptor.agentId === worker.agentId)
        ?.compactionCount
    ).toBe(1);
  });
});
