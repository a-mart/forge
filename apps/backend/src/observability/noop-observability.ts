import type {
  FeedbackSubmitEvent,
  PhoenixObservabilitySettings,
  PhoenixObservabilitySettingsPatch,
  PhoenixObservabilityStatus,
  PhoenixObservabilityTestResponse,
} from "@forge/protocol";
import type {
  ObservabilityFacade,
  ObservabilityPromptResolvedInput,
  ObservabilityRuntimeCreatedInput,
  ObservabilityRuntimeInputCompletion,
  ObservabilityRuntimeInputHandle,
  ObservabilityRuntimeInputInput,
  ObservabilityRuntimeSessionEventInput,
  ObservabilityRuntimeTarget,
  ObservabilityToolSideEffectInput,
  ObservabilityAgentDeliveryInput,
} from "./observability-types.js";
import { createDefaultPhoenixObservabilitySettings } from "./observability-settings.js";

export function createNoopObservabilityFacade(runtimeTarget: ObservabilityRuntimeTarget = "builder"): ObservabilityFacade {
  const settings = createDefaultPhoenixObservabilitySettings();
  const status = createNoopStatus(runtimeTarget, settings);

  return {
    async initialize(): Promise<void> {},
    async getSettings(): Promise<PhoenixObservabilitySettings> {
      return cloneSettings(settings);
    },
    async updateSettings(_patch: PhoenixObservabilitySettingsPatch): Promise<PhoenixObservabilitySettings> {
      throw new Error("Phoenix observability is not available in this runtime.");
    },
    getStatus(): PhoenixObservabilityStatus {
      return cloneStatus(status);
    },
    async testConnection(_patch?: PhoenixObservabilitySettingsPatch): Promise<PhoenixObservabilityTestResponse> {
      return {
        ok: false,
        status: cloneStatus(status),
        error: "Phoenix observability is not available in this runtime.",
      };
    },
    recordPromptResolved(_input: ObservabilityPromptResolvedInput): void {},
    recordRuntimeCreated(_input: ObservabilityRuntimeCreatedInput): void {},
    beginRuntimeInput(_input: ObservabilityRuntimeInputInput): ObservabilityRuntimeInputHandle | undefined { return undefined; },
    completeRuntimeInput(_handle: ObservabilityRuntimeInputHandle | undefined, _patch: ObservabilityRuntimeInputCompletion): void {},
    cancelRuntimeInput(_handle: ObservabilityRuntimeInputHandle | undefined, _reason: string): void {},
    recordRuntimeInput(_input: ObservabilityRuntimeInputInput): string | undefined { return undefined; },
    recordRuntimeSessionEvent(_input: ObservabilityRuntimeSessionEventInput): void {},
    recordToolSideEffect(_input: ObservabilityToolSideEffectInput): void {},
    recordAgentDelivery(_input: ObservabilityAgentDeliveryInput): void {},
    recordFeedback(_event: FeedbackSubmitEvent): void {},
    async shutdown(): Promise<void> {},
  };
}

function createNoopStatus(
  runtimeTarget: ObservabilityRuntimeTarget,
  settings: PhoenixObservabilitySettings,
): PhoenixObservabilityStatus {
  return {
    enabled: false,
    runtimeTarget,
    contentMode: settings.contentMode,
    exporter: {
      configured: false,
      active: false,
      endpoint: settings.endpoint,
      projectName: settings.projectName ?? "default",
      lastSuccessfulExportAt: null,
      lastErrorAt: null,
      lastErrorMessage: null,
    },
    counters: {
      spansStarted: 0,
      spansEnded: 0,
      accepted: 0,
      droppedQueueFull: 0,
      exportSucceeded: 0,
      exportFailed: 0,
      contentTruncations: 0,
      redactionMatches: 0,
      correlationMisses: 0,
      correlationEvictions: 0,
    },
  };
}

function cloneSettings(settings: PhoenixObservabilitySettings): PhoenixObservabilitySettings {
  return JSON.parse(JSON.stringify(settings)) as PhoenixObservabilitySettings;
}

function cloneStatus(status: PhoenixObservabilityStatus): PhoenixObservabilityStatus {
  return JSON.parse(JSON.stringify(status)) as PhoenixObservabilityStatus;
}
