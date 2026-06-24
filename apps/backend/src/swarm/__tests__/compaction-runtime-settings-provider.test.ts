import { describe, expect, it } from "vitest";
import {
  createCompactionRuntimeSettingsProviderFromService,
  createDefaultCompactionRuntimeSettingsProvider,
  createStaticCompactionRuntimeSettingsProvider,
} from "../compaction-runtime-settings-provider.js";
import { CompactionSettingsService, DEFAULT_COMPACTION_TIMEOUT_MS } from "../compaction-settings-service.js";

describe("compaction runtime settings provider", () => {
  it("returns configured timeout from static provider", () => {
    const provider = createStaticCompactionRuntimeSettingsProvider({ timeoutMs: 420_000 });
    expect(provider.getCompactionRuntimeSettings().timeoutMs).toBe(420_000);
  });

  it("defaults to persisted compaction timeout", () => {
    const provider = createDefaultCompactionRuntimeSettingsProvider();
    expect(provider.getCompactionRuntimeSettings().timeoutMs).toBe(DEFAULT_COMPACTION_TIMEOUT_MS);
  });

  it("reads live timeout from compaction settings service", async () => {
    const service = new CompactionSettingsService({
      dataDir: "/tmp/compaction-provider-test",
      getProviderAvailability: async () => new Map(),
    });
    await service.load();
    await service.update({ timeoutMs: 240_000 });

    const provider = createCompactionRuntimeSettingsProviderFromService(service);
    expect(provider.getCompactionRuntimeSettings().timeoutMs).toBe(240_000);
  });
});
