import type {
  FeedbackSubmitEvent,
  PhoenixObservabilitySettings,
  PhoenixObservabilitySettingsPatch,
  PhoenixObservabilityStatus,
  PhoenixObservabilityTestResponse,
} from "@forge/protocol";

export interface ObservabilityFacade {
  initialize(): Promise<void>;
  getSettings(): Promise<PhoenixObservabilitySettings>;
  updateSettings(patch: PhoenixObservabilitySettingsPatch): Promise<PhoenixObservabilitySettings>;
  getStatus(): PhoenixObservabilityStatus;
  testConnection(patch?: PhoenixObservabilitySettingsPatch): Promise<PhoenixObservabilityTestResponse>;
  recordFeedback(event: FeedbackSubmitEvent): void;
  shutdown(options?: { timeoutMs?: number }): Promise<void>;
}

export interface ObservabilityRecordFeedbackInput {
  event: FeedbackSubmitEvent;
}

export type ObservabilityRuntimeTarget = PhoenixObservabilityStatus["runtimeTarget"];
