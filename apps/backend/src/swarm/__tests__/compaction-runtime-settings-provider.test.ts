import { describe, expect, it } from "vitest";
import {
  createLiveCompactionRuntimeSettingsProvider,
  createStaticCompactionRuntimeSettingsProvider,
  createCompactionRuntimeSettingsProviderFromService,
  LiveCompactionRuntimeSettingsProvider,
} from "../compaction-runtime-settings-provider.js";
import { CompactionSettingsService, DEFAULT_COMPACTION_TIMEOUT_MS } from "../compaction-settings-service.js";

describe("compaction runtime settings provider", () => {
  it("returns configured timeout from static provider", () => {
    const provider = createStaticCompactionRuntimeSettingsProvider({ timeoutMs: 420_000 });
    expect(provider.getCompactionRuntimeSettings().timeoutMs).toBe(420_000);
  });

  it("defaults to persisted compaction timeout", () => {
    const provider = createLiveCompactionRuntimeSettingsProvider();
    expect(provider.getCompactionRuntimeSettings().timeoutMs).toBe(DEFAULT_COMPACTION_TIMEOUT_MS);
  });

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
  });

  it("service-backed factory returns a live provider", async () => {
    const service = new CompactionSettingsService({
      dataDir: "/tmp/compaction-provider-factory-test",
      getProviderAvailability: async () => new Map(),
    });
    await service.load();
    await service.update({ timeoutMs: 360_000 });

    const provider = createCompactionRuntimeSettingsProviderFromService(service);
    expect(provider).toBeInstanceOf(LiveCompactionRuntimeSettingsProvider);
    expect(provider.getCompactionRuntimeSettings().timeoutMs).toBe(360_000);
  });
});
