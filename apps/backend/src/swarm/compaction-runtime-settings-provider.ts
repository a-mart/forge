import type { CompactionSettingsService } from "./compaction-settings-service.js";
import { DEFAULT_COMPACTION_TIMEOUT_MS } from "./compaction-settings-service.js";

export interface CompactionRuntimeSettingsSnapshot {
  timeoutMs: number;
}

export interface CompactionRuntimeSettingsProvider {
  getCompactionRuntimeSettings(): CompactionRuntimeSettingsSnapshot;
}

/**
 * Stable provider object for runtime construction. Runtimes keep this reference;
 * attach the loaded settings service before or after boot without replacing it.
 */
export class LiveCompactionRuntimeSettingsProvider implements CompactionRuntimeSettingsProvider {
  private settingsService: Pick<CompactionSettingsService, "getSettings"> | null = null;
  private fallbackTimeoutMs: number = DEFAULT_COMPACTION_TIMEOUT_MS;

  attachSettingsService(service: Pick<CompactionSettingsService, "getSettings">): void {
    this.settingsService = service;
  }

  setFallbackTimeoutMs(timeoutMs: number): void {
    this.fallbackTimeoutMs = timeoutMs;
  }

  getCompactionRuntimeSettings(): CompactionRuntimeSettingsSnapshot {
    if (this.settingsService) {
      return {
        timeoutMs: this.settingsService.getSettings().timeoutMs,
      };
    }

    return {
      timeoutMs: this.fallbackTimeoutMs,
    };
  }
}

export function createLiveCompactionRuntimeSettingsProvider(): LiveCompactionRuntimeSettingsProvider {
  return new LiveCompactionRuntimeSettingsProvider();
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
  const provider = createLiveCompactionRuntimeSettingsProvider();
  provider.attachSettingsService(service);
  return provider;
}
