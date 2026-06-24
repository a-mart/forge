import type { CompactionSettingsService } from "./compaction-settings-service.js";
import { DEFAULT_COMPACTION_TIMEOUT_MS } from "./compaction-settings-service.js";

export interface CompactionRuntimeSettingsSnapshot {
  timeoutMs: number;
}

export interface CompactionRuntimeSettingsProvider {
  getCompactionRuntimeSettings(): CompactionRuntimeSettingsSnapshot;
}

export function createStaticCompactionRuntimeSettingsProvider(
  snapshot: CompactionRuntimeSettingsSnapshot,
): CompactionRuntimeSettingsProvider {
  return {
    getCompactionRuntimeSettings: () => ({
      timeoutMs: snapshot.timeoutMs,
    }),
  };
}

export function createDefaultCompactionRuntimeSettingsProvider(): CompactionRuntimeSettingsProvider {
  return createStaticCompactionRuntimeSettingsProvider({
    timeoutMs: DEFAULT_COMPACTION_TIMEOUT_MS,
  });
}

export function createCompactionRuntimeSettingsProviderFromService(
  service: Pick<CompactionSettingsService, "getSettings">,
): CompactionRuntimeSettingsProvider {
  return {
    getCompactionRuntimeSettings: () => ({
      timeoutMs: service.getSettings().timeoutMs,
    }),
  };
}
