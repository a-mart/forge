import { describe, expect, it } from "vitest";
import {
  createLiveCompactionRuntimeSettingsProvider,
} from "../compaction-runtime-settings-provider.js";
import { CompactionSettingsService } from "../compaction-settings-service.js";

describe("compaction runtime settings provider", () => {
  it("reads live timeout from compaction settings service after attach", async () => {
    const provider = createLiveCompactionRuntimeSettingsProvider();
    const service = new CompactionSettingsService({
      dataDir: "/tmp/compaction-provider-test",
      getProviderAvailability: async () => new Map(),
    });
    await service.load();
    await service.update({ timeoutMs: 240_000 });
    provider.attachSettingsService(service);

    expect(provider.getCompactionRuntimeSettings().timeoutMs).toBe(240_000);
    expect(provider.getCompactionRuntimeSettings().model.modelId).toBe("gpt-5.5");
  });
});
