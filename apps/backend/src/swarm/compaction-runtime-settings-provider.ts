import type { ManagerExactModelSelection, ManagerReasoningLevel } from "@forge/protocol";
import type { CompactionSettingsService } from "./compaction-settings-service.js";
import {
  createDefaultCompactionSettings,
  DEFAULT_COMPACTION_TIMEOUT_MS,
} from "./compaction-settings-service.js";

export interface CompactionRuntimeSettingsSnapshot {
  timeoutMs: number;
  model: ManagerExactModelSelection;
  reasoningLevel: ManagerReasoningLevel;
}

export interface CompactionRuntimeSettingsProvider {
  getCompactionRuntimeSettings(): CompactionRuntimeSettingsSnapshot;
}

function snapshotFromCompactionSettings(
  settings: Pick<
    ReturnType<CompactionSettingsService["getSettings"]>,
    "timeoutMs" | "model" | "reasoningLevel"
  >,
): CompactionRuntimeSettingsSnapshot {
  return {
    timeoutMs: settings.timeoutMs,
    model: { ...settings.model },
    reasoningLevel: settings.reasoningLevel,
  };
}

/**
 * Stable provider object for runtime construction. Runtimes keep this reference;
 * attach the loaded settings service before or after boot without replacing it.
 */
export class LiveCompactionRuntimeSettingsProvider implements CompactionRuntimeSettingsProvider {
  private settingsService: Pick<CompactionSettingsService, "getSettings"> | null = null;
  private fallbackSnapshot: CompactionRuntimeSettingsSnapshot = snapshotFromCompactionSettings(
    createDefaultCompactionSettings(),
  );

  attachSettingsService(service: Pick<CompactionSettingsService, "getSettings">): void {
    this.settingsService = service;
  }

  setFallbackSnapshot(snapshot: CompactionRuntimeSettingsSnapshot): void {
    this.fallbackSnapshot = snapshot;
  }

  getCompactionRuntimeSettings(): CompactionRuntimeSettingsSnapshot {
    if (this.settingsService) {
      return snapshotFromCompactionSettings(this.settingsService.getSettings());
    }

    return {
      timeoutMs: this.fallbackSnapshot.timeoutMs,
      model: { ...this.fallbackSnapshot.model },
      reasoningLevel: this.fallbackSnapshot.reasoningLevel,
    };
  }
}

export function createLiveCompactionRuntimeSettingsProvider(): LiveCompactionRuntimeSettingsProvider {
  return new LiveCompactionRuntimeSettingsProvider();
}

export function createStaticCompactionRuntimeSettingsProvider(
  snapshot: Partial<CompactionRuntimeSettingsSnapshot> & Pick<CompactionRuntimeSettingsSnapshot, "timeoutMs">,
): CompactionRuntimeSettingsProvider {
  const defaults = snapshotFromCompactionSettings(createDefaultCompactionSettings());
  const resolved: CompactionRuntimeSettingsSnapshot = {
    timeoutMs: snapshot.timeoutMs,
    model: snapshot.model ?? defaults.model,
    reasoningLevel: snapshot.reasoningLevel ?? defaults.reasoningLevel,
  };

  return {
    getCompactionRuntimeSettings: () => ({
      timeoutMs: resolved.timeoutMs,
      model: { ...resolved.model },
      reasoningLevel: resolved.reasoningLevel,
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
