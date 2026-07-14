import { describe, expect, it } from "vitest";
import {
  TestSwarmManager,
  bootWithDefaultManager,
  makeTempConfig,
} from "../../test-support/index.js";

describe("SwarmManager runtime creation override", () => {
  it("dispatches manager and worker runtime creation through the protected override", async () => {
    const config = await makeTempConfig({
      prefix: "swarm-manager-runtime-override-",
      omitSharedAuthFile: true,
      omitSharedSecretsFile: true,
      skipRepoMemorySkillPlaceholder: true,
    });
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);
    manager.createdRuntimeIds.length = 0;

    const createdManager = await manager.createManager("manager", {
      name: "Override Manager",
      cwd: config.defaultCwd,
    });
    const createdWorker = await manager.spawnAgent("manager", {
      agentId: "Override Worker",
    });

    expect(manager.createdRuntimeIds).toEqual([
      createdManager.agentId,
      createdWorker.agentId,
    ]);
    expect(manager.runtimeByAgentId.get(createdManager.agentId)).toBeDefined();
    expect(manager.runtimeByAgentId.get(createdWorker.agentId)).toBeDefined();
  });
});
