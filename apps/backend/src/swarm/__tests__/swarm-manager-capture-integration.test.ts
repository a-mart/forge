import { describe, expect, it, vi } from "vitest";
import { TestSwarmManager, bootWithDefaultManager, createTempConfig } from "../../test-support/index.js";
import type { KnowledgeV2SettingsService } from "../knowledge-v2-settings-service.js";

describe("SwarmManager capture integration", () => {
  it("runs feedback capture in a temporary restricted session and deletes it", async () => {
    const handle = await createTempConfig({ prefix: "swarm-manager-capture-integration-" });
    const { config } = handle;
    const knowledgeV2SettingsService = {
      getSettings: () => ({
        enabled: true,
        legacyCleanupConfirmed: false,
        indexCaps: { global: 1_500, profile: 800 },
        updatedAt: null,
      }),
    } as KnowledgeV2SettingsService;
    try {
      const manager = new TestSwarmManager(config, { knowledgeV2SettingsService });
      await bootWithDefaultManager(manager, config);

      const forkSession = vi.spyOn(manager, "forkSession");
      const sendMessage = vi.spyOn(manager, "sendMessage");
      const deleteSession = vi.spyOn(manager, "deleteSession");

      await manager.handleCaptureFeedbackSignal("manager", "manager");

      expect(forkSession).toHaveBeenCalledOnce();
      expect(forkSession).toHaveBeenCalledWith("manager", {
        label: "Capture check",
        fromMessageId: undefined,
        sessionPurpose: "capture_check",
      });

      const fork = await forkSession.mock.results[0]!.value;
      const forkedAgentId = fork.sessionAgent.agentId;
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(sendMessage).toHaveBeenCalledWith(
        forkedAgentId,
        forkedAgentId,
        expect.stringContaining("Judge hint: user feedback signal"),
        "auto",
        {
          origin: "internal",
          internalDeliveryKind: "bootstrap",
          skipTurnLedger: true,
        },
      );
      expect(deleteSession).toHaveBeenCalledOnce();
      expect(deleteSession).toHaveBeenCalledWith(forkedAgentId);
      expect(manager.getAgent(forkedAgentId)).toBeUndefined();
    } finally {
      await handle.cleanup();
    }
  });
});
