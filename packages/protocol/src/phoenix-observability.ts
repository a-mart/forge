export const PHOENIX_OBSERVABILITY_CONTENT_MODES = ["rich", "metadata_only"] as const;
export type PhoenixObservabilityContentMode = (typeof PHOENIX_OBSERVABILITY_CONTENT_MODES)[number];

export const PHOENIX_OBSERVABILITY_IDENTIFIER_MODES = ["raw", "stable_hash"] as const;
export type PhoenixObservabilityIdentifierMode = (typeof PHOENIX_OBSERVABILITY_IDENTIFIER_MODES)[number];

export const PHOENIX_OBSERVABILITY_PATH_MODES = ["basename_and_hash", "redacted", "raw"] as const;
export type PhoenixObservabilityPathMode = (typeof PHOENIX_OBSERVABILITY_PATH_MODES)[number];

export interface PhoenixObservabilityCaptureSettings {
  prompts: boolean;
  modelInputs: boolean;
  modelOutputs: boolean;
  toolInputs: boolean;
  toolResults: boolean;
  feedbackComments: boolean;
  imageData: boolean;
}

export interface PhoenixObservabilityPrivacySettings {
  redactionEnabled: boolean;
  includeDisplayNames: boolean;
  identifierMode: PhoenixObservabilityIdentifierMode;
  pathMode: PhoenixObservabilityPathMode;
  maxContentChars: number;
  maxAttributeChars: number;
  maxSpanContentChars: number;
  extraRedactionPatterns: string[];
}

export interface PhoenixObservabilityExportSettings {
  batchMaxQueueSize: number;
  batchMaxExportBatchSize: number;
  scheduledDelayMs: number;
  exportTimeoutMs: number;
  concurrencyLimit: number;
}

export interface PhoenixObservabilitySettings {
  enabled: boolean;
  endpoint: string;
  projectName?: string;
  contentMode: PhoenixObservabilityContentMode;
  capture: PhoenixObservabilityCaptureSettings;
  privacy: PhoenixObservabilityPrivacySettings;
  export: PhoenixObservabilityExportSettings;
  updatedAt: string | null;
}

export type PhoenixObservabilitySettingsPatch = Partial<
  Omit<PhoenixObservabilitySettings, "capture" | "privacy" | "export" | "updatedAt">
> & {
  capture?: Partial<PhoenixObservabilityCaptureSettings>;
  privacy?: Partial<PhoenixObservabilityPrivacySettings>;
  export?: Partial<PhoenixObservabilityExportSettings>;
};

export interface PhoenixObservabilityCounters {
  spansStarted: number;
  spansEnded: number;
  accepted: number;
  droppedQueueFull: number;
  exportSucceeded: number;
  exportFailed: number;
  contentTruncations: number;
  redactionMatches: number;
  correlationMisses: number;
  correlationEvictions: number;
}

export interface PhoenixObservabilityExporterStatus {
  configured: boolean;
  active: boolean;
  endpoint: string;
  projectName: string;
  lastSuccessfulExportAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
}

export interface PhoenixObservabilityStatus {
  enabled: boolean;
  runtimeTarget: "builder" | "collaboration-server";
  contentMode: PhoenixObservabilityContentMode;
  exporter: PhoenixObservabilityExporterStatus;
  counters: PhoenixObservabilityCounters;
}

export interface PhoenixObservabilitySettingsResponse {
  settings: PhoenixObservabilitySettings;
  status: PhoenixObservabilityStatus;
}

export interface PhoenixObservabilityTestRequest {
  settings?: PhoenixObservabilitySettingsPatch;
}

export interface PhoenixObservabilityTestResponse {
  ok: boolean;
  status: PhoenixObservabilityStatus;
  error?: string;
}
