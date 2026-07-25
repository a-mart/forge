import {
  BROWSER_AUTOMATION_OPERATIONS,
  BROWSER_HOST_PROTOCOL_VERSION,
  DEFAULT_BROWSER_HOST_KIND,
  EXTERNAL_CHROME_M3_SUPPORTED_OPERATIONS,
  isBrowserHostKind,
  BROWSER_VIEWPORT_MAX_AREA,
  BROWSER_VIEWPORT_MAX_DIMENSION,
  BROWSER_VIEWPORT_MIN_DIMENSION,
  BROWSER_VIEWPORT_PRESETS,
  type BrowserAutomationResponse,
  type BrowserHostCapabilities,
  type BrowserHostStateReportCommand,
  type BrowserViewportSetting,
} from "@forge/protocol";
import type { ClientCommandCandidate, ParsedClientCommand } from "./command-parse-helpers.js";
import { fail, ok } from "./command-parse-helpers.js";

const TYPES = new Set([
  "browser_host_register",
  "browser_host_hydrate",
  "browser_host_focus",
  "browser_host_response",
  "browser_host_state_report",
  "browser_panel_reveal_acknowledge",
  "browser_tab_open",
  "browser_tab_activate",
  "browser_tab_close",
  "browser_tab_resize",
  "browser_recording_start",
  "browser_recording_stop",
]);

export function parseBrowserCommand(command: ClientCommandCandidate): ParsedClientCommand | undefined {
  if (typeof command.type !== "string" || !TYPES.has(command.type)) return undefined;
  const value = command as Record<string, unknown>;
  try {
    switch (command.type) {
      case "browser_host_register": {
        const registration = record(value.registration, "registration");
        const capabilities = parseCapabilities(registration.capabilities);
        return ok({
          type: command.type,
          requestId: identifier(value.requestId, "requestId"),
          registration: {
            hostId: identifier(registration.hostId, "registration.hostId"),
            clientInstanceId: identifier(registration.clientInstanceId, "registration.clientInstanceId"),
            registeredAt: isoDate(registration.registeredAt, "registration.registeredAt"),
            capabilities,
          },
        });
      }
      case "browser_host_hydrate":
        return ok({
          type: command.type,
          requestId: identifier(value.requestId, "requestId"),
          hostKind: hostKind(value.hostKind),
          hostId: identifier(value.hostId, "hostId"),
          hostGeneration: generation(value.hostGeneration),
        });
      case "browser_host_focus":
        return ok({
          type: command.type,
          hostKind: hostKind(value.hostKind),
          hostId: identifier(value.hostId, "hostId"),
          hostGeneration: generation(value.hostGeneration),
          focused: boolean(value.focused, "focused"),
        });
      case "browser_host_response":
        return ok({ type: command.type, response: parseResponseEnvelope(value.response) });
      case "browser_host_state_report": {
        const sessions = array(value.sessions, "sessions", 500);
        const parsed = sessions.map((entry, index) => {
          const session = record(entry, `sessions[${index}]`);
          const tabs = array(session.tabs, `sessions[${index}].tabs`, 100);
          tabs.forEach((tab, tabIndex) => record(tab, `sessions[${index}].tabs[${tabIndex}]`));
          return {
            hostKind: hostKind(session.hostKind ?? value.hostKind),
            sessionAgentId: identifier(session.sessionAgentId, `sessions[${index}].sessionAgentId`),
            profileId: identifier(session.profileId, `sessions[${index}].profileId`),
            baseRevision: integer(session.baseRevision, `sessions[${index}].baseRevision`, 0, Number.MAX_SAFE_INTEGER),
            tabs: tabs as BrowserHostStateReportCommand["sessions"][number]["tabs"],
          };
        });
        return ok({
          type: command.type,
          requestId: identifier(value.requestId, "requestId"),
          hostKind: hostKind(value.hostKind),
          hostId: identifier(value.hostId, "hostId"),
          hostGeneration: generation(value.hostGeneration),
          sessions: parsed,
        });
      }
      case "browser_panel_reveal_acknowledge":
        return ok({
          type: command.type,
          requestId: identifier(value.requestId, "requestId"),
          hostKind: hostKind(value.hostKind),
          hostId: identifier(value.hostId, "hostId"),
          hostGeneration: generation(value.hostGeneration),
          sessionAgentId: identifier(value.sessionAgentId, "sessionAgentId"),
          profileId: identifier(value.profileId, "profileId"),
          tabId: identifier(value.tabId, "tabId"),
          sequence: integer(value.sequence, "sequence", 1, Number.MAX_SAFE_INTEGER),
        });
      case "browser_tab_open": {
        const url = optionalString(value.url, "url", 2_048);
        const activate = value.activate === undefined ? undefined : boolean(value.activate, "activate");
        return ok({
          type: command.type,
          requestId: identifier(value.requestId, "requestId"),
          sessionAgentId: identifier(value.sessionAgentId, "sessionAgentId"),
          profileId: identifier(value.profileId, "profileId"),
          ...(url === undefined ? {} : { url }),
          ...(activate === undefined ? {} : { activate }),
        });
      }
      case "browser_tab_activate":
      case "browser_tab_close":
      case "browser_recording_start":
        return ok({
          type: command.type,
          requestId: identifier(value.requestId, "requestId"),
          sessionAgentId: identifier(value.sessionAgentId, "sessionAgentId"),
          tabId: identifier(value.tabId, "tabId"),
        });
      case "browser_recording_stop":
        return ok({
          type: command.type,
          requestId: identifier(value.requestId, "requestId"),
          sessionAgentId: identifier(value.sessionAgentId, "sessionAgentId"),
          tabId: identifier(value.tabId, "tabId"),
          recordingId: identifier(value.recordingId, "recordingId"),
        });
      case "browser_tab_resize":
        return ok({
          type: command.type,
          requestId: identifier(value.requestId, "requestId"),
          sessionAgentId: identifier(value.sessionAgentId, "sessionAgentId"),
          tabId: identifier(value.tabId, "tabId"),
          viewport: parseViewport(value.viewport),
        });
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

function parseCapabilities(value: unknown): BrowserHostCapabilities {
  const capabilities = record(value, "registration.capabilities");
  const resolvedHostKind = hostKind(capabilities.hostKind);
  const operations = array(capabilities.supportedOperations, "registration.capabilities.supportedOperations", BROWSER_AUTOMATION_OPERATIONS.length);
  if (operations.length === 0 || operations.some((operation) => !(BROWSER_AUTOMATION_OPERATIONS as readonly unknown[]).includes(operation))) {
    throw new Error("registration.capabilities.supportedOperations contains an unsupported operation");
  }
  const maxResponseBytes = integer(capabilities.maxResponseBytes, "registration.capabilities.maxResponseBytes", 1_024, 8 * 1_024 * 1_024);
  const versions = capabilities.protocolVersions === undefined
    ? { minimum: BROWSER_HOST_PROTOCOL_VERSION, maximum: BROWSER_HOST_PROTOCOL_VERSION }
    : parseProtocolVersions(capabilities.protocolVersions);
  const legacyCapture = capabilities.supportsCapturePage === undefined ? false : boolean(capabilities.supportsCapturePage, "registration.capabilities.supportsCapturePage");
  const legacyRecording = capabilities.supportsRecording === undefined ? false : boolean(capabilities.supportsRecording, "registration.capabilities.supportsRecording");
  const features = capabilities.features === undefined
    ? {
        resize: operations.includes("resize"), recording: legacyRecording, capturePage: legacyCapture,
        downloadEvents: false, downloadArtifacts: false, downloadOpen: false,
      }
    : parseFeatures(capabilities.features);
  const runtimeVersions = capabilities.runtimeVersions === undefined
    ? {
        ...(typeof capabilities.electronVersion === "string" ? { electron: boundedString(capabilities.electronVersion, "registration.capabilities.electronVersion", 64) } : {}),
        ...(typeof capabilities.chromiumVersion === "string" ? { chromium: boundedString(capabilities.chromiumVersion, "registration.capabilities.chromiumVersion", 64) } : {}),
        ...(typeof capabilities.playwrightVersion === "string" ? { playwright: boundedString(capabilities.playwrightVersion, "registration.capabilities.playwrightVersion", 64) } : {}),
      }
    : parseRuntimeVersions(capabilities.runtimeVersions);
  if (resolvedHostKind === "external-chrome") {
    const qualified = EXTERNAL_CHROME_M3_SUPPORTED_OPERATIONS as readonly unknown[];
    if (operations.some((operation) => !qualified.includes(operation))) {
      throw new Error("External Chrome may advertise only M3-qualified operations");
    }
    if (features.resize || features.recording || features.capturePage || features.downloadEvents
      || features.downloadArtifacts || features.downloadOpen) {
      throw new Error("External Chrome may not advertise unqualified M3 features");
    }
  }
  return {
    hostKind: resolvedHostKind,
    protocolVersions: versions,
    supportedOperations: [...new Set(operations)] as BrowserHostCapabilities["supportedOperations"],
    maxResponseBytes,
    features,
    runtimeVersions,
    ...(typeof capabilities.electronVersion === "string" ? { electronVersion: capabilities.electronVersion } : {}),
    ...(typeof capabilities.chromiumVersion === "string" ? { chromiumVersion: capabilities.chromiumVersion } : {}),
    ...(typeof capabilities.playwrightVersion === "string" ? { playwrightVersion: capabilities.playwrightVersion } : {}),
    ...(capabilities.supportsSandboxedWebviews === undefined ? {} : { supportsSandboxedWebviews: boolean(capabilities.supportsSandboxedWebviews, "registration.capabilities.supportsSandboxedWebviews") }),
    ...(capabilities.supportsCapturePage === undefined ? {} : { supportsCapturePage: legacyCapture }),
    ...(capabilities.supportsRecording === undefined ? {} : { supportsRecording: legacyRecording }),
  };
}

function parseProtocolVersions(value: unknown): { minimum: number; maximum: number } {
  const versions = record(value, "registration.capabilities.protocolVersions");
  const minimum = integer(versions.minimum, "registration.capabilities.protocolVersions.minimum", 1, BROWSER_HOST_PROTOCOL_VERSION);
  const maximum = integer(versions.maximum, "registration.capabilities.protocolVersions.maximum", minimum, BROWSER_HOST_PROTOCOL_VERSION);
  return { minimum, maximum };
}

function parseFeatures(value: unknown): NonNullable<BrowserHostCapabilities["features"]> {
  const features = record(value, "registration.capabilities.features");
  return {
    resize: boolean(features.resize, "registration.capabilities.features.resize"),
    recording: boolean(features.recording, "registration.capabilities.features.recording"),
    capturePage: boolean(features.capturePage, "registration.capabilities.features.capturePage"),
    downloadEvents: boolean(features.downloadEvents, "registration.capabilities.features.downloadEvents"),
    downloadArtifacts: boolean(features.downloadArtifacts, "registration.capabilities.features.downloadArtifacts"),
    downloadOpen: boolean(features.downloadOpen, "registration.capabilities.features.downloadOpen"),
  };
}

function parseRuntimeVersions(value: unknown): NonNullable<BrowserHostCapabilities["runtimeVersions"]> {
  const versions = record(value, "registration.capabilities.runtimeVersions");
  const result: NonNullable<BrowserHostCapabilities["runtimeVersions"]> = {};
  for (const field of ["electron", "chromium", "playwright", "chrome", "extension"] as const) {
    if (versions[field] !== undefined) result[field] = boundedString(versions[field], `registration.capabilities.runtimeVersions.${field}`, 64);
  }
  return result;
}

function parseResponseEnvelope(value: unknown): BrowserAutomationResponse {
  const response = record(value, "response");
  identifier(response.requestId, "response.requestId");
  response.hostKind = hostKind(response.hostKind);
  identifier(response.sessionAgentId, "response.sessionAgentId");
  identifier(response.profileId, "response.profileId");
  if (response.tabId !== null) identifier(response.tabId, "response.tabId");
  identifier(response.hostId, "response.hostId");
  generation(response.hostGeneration);
  if (!(BROWSER_AUTOMATION_OPERATIONS as readonly unknown[]).includes(response.operation)) throw new Error("response.operation is invalid");
  if (typeof response.ok !== "boolean") throw new Error("response.ok must be boolean");
  if (typeof response.elapsedMs !== "number" || !Number.isFinite(response.elapsedMs) || response.elapsedMs < 0) throw new Error("response.elapsedMs must be a non-negative finite number");
  if (response.ok) {
    record(response.result, "response.result");
  } else {
    const error = record(response.error, "response.error");
    boundedString(error.code, "response.error.code", 128);
    boundedString(error.message, "response.error.message", 4_096);
    boolean(error.retryable, "response.error.retryable");
  }
  if (response.updatedTab !== undefined) record(response.updatedTab, "response.updatedTab");
  return response as unknown as BrowserAutomationResponse;
}

function parseViewport(value: unknown): BrowserViewportSetting {
  const viewport = record(value, "viewport");
  if (viewport.mode === "fill") return { mode: "fill" };
  if (viewport.mode === "freeform") {
    const width = integer(viewport.width, "viewport.width", BROWSER_VIEWPORT_MIN_DIMENSION, BROWSER_VIEWPORT_MAX_DIMENSION);
    const height = integer(viewport.height, "viewport.height", BROWSER_VIEWPORT_MIN_DIMENSION, BROWSER_VIEWPORT_MAX_DIMENSION);
    if (width * height > BROWSER_VIEWPORT_MAX_AREA) throw new Error("viewport area is too large");
    return { mode: "freeform", width, height };
  }
  if (viewport.mode === "preset") {
    if (typeof viewport.presetId !== "string" || !(viewport.presetId in BROWSER_VIEWPORT_PRESETS)) throw new Error("viewport.presetId is invalid");
    if (viewport.orientation !== "portrait" && viewport.orientation !== "landscape") throw new Error("viewport.orientation is invalid");
    const width = integer(viewport.width, "viewport.width", BROWSER_VIEWPORT_MIN_DIMENSION, BROWSER_VIEWPORT_MAX_DIMENSION);
    const height = integer(viewport.height, "viewport.height", BROWSER_VIEWPORT_MIN_DIMENSION, BROWSER_VIEWPORT_MAX_DIMENSION);
    return { mode: "preset", presetId: viewport.presetId as keyof typeof BROWSER_VIEWPORT_PRESETS, orientation: viewport.orientation, width, height };
  }
  throw new Error("viewport.mode is invalid");
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}
function array(value: unknown, field: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${field} must be an array with at most ${maximum} entries`);
  return value;
}
function identifier(value: unknown, field: string): string {
  return boundedString(value, field, 256);
}
function optionalString(value: unknown, field: string, maximum: number): string | undefined {
  return value === undefined ? undefined : boundedString(value, field, maximum);
}
function boundedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) throw new Error(`${field} must be a non-empty string of at most ${maximum} characters`);
  return value;
}
function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean`);
  return value;
}
function hostKind(value: unknown) {
  if (value === undefined || value === null) return DEFAULT_BROWSER_HOST_KIND;
  if (!isBrowserHostKind(value)) throw new Error("hostKind must be managed-electron or external-chrome");
  return value;
}
function generation(value: unknown): number {
  return integer(value, "hostGeneration", 1, Number.MAX_SAFE_INTEGER);
}
function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${field} must be an integer from ${minimum} to ${maximum}`);
  return value as number;
}
function isoDate(value: unknown, field: string): string {
  const text = boundedString(value, field, 64);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${field} must be an ISO date`);
  return text;
}
