import { access, readFile, rename, rm } from "node:fs/promises";
import {
  BROWSER_AUTOMATION_MAX_SAFE_ACTIONS,
  BROWSER_VIEWPORT_PRESETS,
  isBrowserAutomationOperation,
  type BrowserSafeActionSummary,
  type BrowserSessionSnapshot,
  type BrowserTabSnapshot,
  type BrowserViewportSetting,
} from "@forge/protocol";
import {
  getSessionBrowserArtifactsDir,
  getSessionBrowserStatePath,
  getSessionDir,
} from "../storage/data-paths.js";
import { writeJsonFileAtomic } from "../../utils/atomic-files.js";

const MAX_TABS = 100;

export interface BrowserSessionStoreOptions {
  dataDir: string;
  now?: () => string;
  logDebug?: (message: string, details?: unknown) => void;
}

export class BrowserSessionStore {
  private readonly dataDir: string;
  private readonly now: () => string;
  private readonly logDebug: (message: string, details?: unknown) => void;
  private readonly writeChains = new Map<string, Promise<void>>();

  constructor(options: BrowserSessionStoreOptions) {
    this.dataDir = options.dataDir;
    this.now = options.now ?? (() => new Date().toISOString());
    this.logDebug = options.logDebug ?? (() => undefined);
  }

  getStatePath(profileId: string, sessionAgentId: string): string {
    return getSessionBrowserStatePath(this.dataDir, profileId, sessionAgentId);
  }

  getArtifactsDirectory(profileId: string, sessionAgentId: string): string {
    return getSessionBrowserArtifactsDir(this.dataDir, profileId, sessionAgentId);
  }

  createEmpty(profileId: string, sessionAgentId: string): BrowserSessionSnapshot {
    const timestamp = this.now();
    return {
      schemaVersion: 1,
      sessionAgentId,
      profileId,
      tabs: [],
      activeTabId: null,
      defaultTabId: null,
      panelVisible: false,
      recentActions: [],
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  async load(profileId: string, sessionAgentId: string): Promise<BrowserSessionSnapshot> {
    const path = this.getStatePath(profileId, sessionAgentId);
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return this.createEmpty(profileId, sessionAgentId);
      throw error;
    }

    try {
      const parsed: unknown = JSON.parse(source);
      const snapshot = normalizeSnapshot(parsed, profileId, sessionAgentId);
      snapshot.tabs = snapshot.tabs.map((tab) => ({
        ...tab,
        live: false,
        controller: "none",
        recording: null,
        lifecycle: tab.lifecycle === "closed" ? "closed" : "restoring",
      }));
      return snapshot;
    } catch (error) {
      this.logDebug("browser-session-store:corrupt-state", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.preserveCorruptState(path);
      return this.createEmpty(profileId, sessionAgentId);
    }
  }

  normalize(snapshot: BrowserSessionSnapshot): BrowserSessionSnapshot {
    return normalizeSnapshot(snapshot, snapshot.profileId, snapshot.sessionAgentId);
  }

  async save(snapshot: BrowserSessionSnapshot): Promise<void> {
    const normalized = this.normalize(snapshot);
    const path = this.getStatePath(normalized.profileId, normalized.sessionAgentId);
    const previous = this.writeChains.get(path) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => writeJsonFileAtomic(path, normalized));
    this.writeChains.set(path, current);
    try {
      await current;
    } finally {
      if (this.writeChains.get(path) === current) this.writeChains.delete(path);
    }
  }

  async delete(profileId: string, sessionAgentId: string): Promise<void> {
    const sessionDir = getSessionDir(this.dataDir, profileId, sessionAgentId);
    await Promise.all([
      rm(this.getStatePath(profileId, sessionAgentId), { force: true }),
      rm(this.getArtifactsDirectory(profileId, sessionAgentId), { recursive: true, force: true }),
    ]);
    this.logDebug("browser-session-store:deleted", { sessionDir, profileId, sessionAgentId });
  }

  private async preserveCorruptState(path: string): Promise<void> {
    const suffix = this.now().replace(/[^0-9A-Za-z.-]/g, "-");
    let target = `${path}.corrupt-${suffix}`;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await access(target);
        target = `${path}.corrupt-${suffix}-${attempt + 1}`;
        continue;
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) return;
      }
      try {
        // eslint-disable-next-line no-restricted-syntax -- This moves corrupt input aside; it is not a hand-rolled atomic write.
        await rename(path, target);
        return;
      } catch (error) {
        if (isNodeError(error, "ENOENT")) return;
        this.logDebug("browser-session-store:preserve-corrupt-failed", {
          path,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
  }
}

function normalizeSnapshot(value: unknown, profileId: string, sessionAgentId: string): BrowserSessionSnapshot {
  const record = requiredRecord(value, "browser session");
  if (record.schemaVersion !== 1) throw new Error("Unsupported browser session schema version");
  if (record.profileId !== profileId || record.sessionAgentId !== sessionAgentId) {
    throw new Error("Browser session identity does not match its canonical path");
  }
  if (!Array.isArray(record.tabs) || record.tabs.length > MAX_TABS) throw new Error("Invalid browser tabs");

  const tabs = record.tabs.map((tab) => normalizeTab(tab, profileId, sessionAgentId));
  const tabIds = new Set<string>();
  for (const tab of tabs) {
    if (tabIds.has(tab.tabId)) throw new Error("Duplicate browser tab id");
    tabIds.add(tab.tabId);
  }

  const activeTabId = nullableId(record.activeTabId, "activeTabId");
  const defaultTabId = nullableId(record.defaultTabId, "defaultTabId");
  if (activeTabId !== null && !tabIds.has(activeTabId)) throw new Error("Active browser tab is missing");
  if (defaultTabId !== null && !tabIds.has(defaultTabId)) throw new Error("Default browser tab is missing");
  if (!Array.isArray(record.recentActions)) throw new Error("Invalid recent browser actions");

  return {
    schemaVersion: 1,
    profileId,
    sessionAgentId,
    tabs,
    activeTabId,
    defaultTabId,
    panelVisible: requiredBoolean(record.panelVisible, "panelVisible"),
    recentActions: record.recentActions
      .slice(-BROWSER_AUTOMATION_MAX_SAFE_ACTIONS)
      .map(normalizeSafeAction),
    revision: nonNegativeInteger(record.revision, "revision"),
    createdAt: requiredString(record.createdAt, "createdAt", 128),
    updatedAt: requiredString(record.updatedAt, "updatedAt", 128),
  };
}

function normalizeTab(value: unknown, profileId: string, sessionAgentId: string): BrowserTabSnapshot {
  const tab = requiredRecord(value, "browser tab");
  if (tab.profileId !== profileId || tab.sessionAgentId !== sessionAgentId) {
    throw new Error("Browser tab identity does not match its session");
  }
  const lifecycle = tab.lifecycle;
  if (lifecycle !== "restoring" && lifecycle !== "loading" && lifecycle !== "ready" && lifecycle !== "failed" && lifecycle !== "closed") {
    throw new Error("Invalid browser tab lifecycle");
  }
  const controller = tab.controller;
  if (controller !== "human" && controller !== "agent" && controller !== "none") throw new Error("Invalid browser controller");

  return {
    tabId: requiredId(tab.tabId, "tabId"),
    sessionAgentId,
    profileId,
    url: requiredString(tab.url, "url", 2_048, true),
    title: requiredString(tab.title, "title", 4_096, true),
    lifecycle,
    loading: requiredBoolean(tab.loading, "loading"),
    live: requiredBoolean(tab.live, "live"),
    canGoBack: requiredBoolean(tab.canGoBack, "canGoBack"),
    canGoForward: requiredBoolean(tab.canGoForward, "canGoForward"),
    zoomFactor: finiteNumber(tab.zoomFactor, "zoomFactor"),
    controller,
    agentCursor: normalizeCursor(tab.agentCursor),
    recording: normalizeRecording(tab.recording),
    viewportSetting: normalizeViewport(tab.viewportSetting),
    renderedViewport: normalizeRenderedViewport(tab.renderedViewport),
    error: normalizeTabError(tab.error),
    createdAt: requiredString(tab.createdAt, "createdAt", 128),
    updatedAt: requiredString(tab.updatedAt, "updatedAt", 128),
  };
}

function normalizeViewport(value: unknown): BrowserViewportSetting {
  const viewport = requiredRecord(value, "viewport setting");
  if (viewport.mode === "fill") return { mode: "fill" };
  if (viewport.mode === "freeform") {
    return { mode: "freeform", width: positiveInteger(viewport.width, "width"), height: positiveInteger(viewport.height, "height") };
  }
  if (viewport.mode === "preset") {
    if (viewport.orientation !== "portrait" && viewport.orientation !== "landscape") throw new Error("Invalid viewport orientation");
    const presetId = requiredString(viewport.presetId, "presetId", 128);
    if (!(presetId in BROWSER_VIEWPORT_PRESETS)) throw new Error("Invalid viewport preset");
    return {
      mode: "preset",
      presetId: presetId as keyof typeof BROWSER_VIEWPORT_PRESETS,
      orientation: viewport.orientation,
      width: positiveInteger(viewport.width, "width"),
      height: positiveInteger(viewport.height, "height"),
    };
  }
  throw new Error("Invalid viewport mode");
}

function normalizeRenderedViewport(value: unknown): BrowserTabSnapshot["renderedViewport"] {
  if (value === null) return null;
  const viewport = requiredRecord(value, "rendered viewport");
  return {
    width: positiveInteger(viewport.width, "width"),
    height: positiveInteger(viewport.height, "height"),
    deviceScaleFactor: finiteNumber(viewport.deviceScaleFactor, "deviceScaleFactor"),
  };
}

function normalizeCursor(value: unknown): BrowserTabSnapshot["agentCursor"] {
  if (value === null) return null;
  const cursor = requiredRecord(value, "agent cursor");
  if (cursor.phase !== "move" && cursor.phase !== "click") throw new Error("Invalid cursor phase");
  return {
    x: finiteNumber(cursor.x, "x"),
    y: finiteNumber(cursor.y, "y"),
    phase: cursor.phase,
    sequence: nonNegativeInteger(cursor.sequence, "sequence"),
    createdAt: requiredString(cursor.createdAt, "createdAt", 128),
  };
}

function normalizeRecording(value: unknown): BrowserTabSnapshot["recording"] {
  if (value === null) return null;
  const recording = requiredRecord(value, "recording");
  return {
    recordingId: requiredId(recording.recordingId, "recordingId"),
    startedAt: requiredString(recording.startedAt, "startedAt", 128),
    mimeType: requiredString(recording.mimeType, "mimeType", 256),
  };
}

function normalizeTabError(value: unknown): BrowserTabSnapshot["error"] {
  if (value === null) return null;
  const error = requiredRecord(value, "tab error");
  return {
    code: requiredString(error.code, "code", 128),
    message: requiredString(error.message, "message", 4_096),
  };
}

function normalizeSafeAction(value: unknown): BrowserSafeActionSummary {
  const action = requiredRecord(value, "safe action");
  const status = action.status;
  if (status !== "running" && status !== "succeeded" && status !== "failed" && status !== "interrupted") throw new Error("Invalid action status");
  const operation = requiredString(action.operation, "operation", 64);
  if (!isBrowserAutomationOperation(operation)) throw new Error("Invalid action operation");
  return {
    id: requiredId(action.id, "id"),
    operation,
    tabId: nullableId(action.tabId, "tabId"),
    status,
    ...(typeof action.url === "string" ? { url: action.url.slice(0, 2_048) } : {}),
    ...(typeof action.title === "string" ? { title: action.title.slice(0, 4_096) } : {}),
    ...(isRecord(action.dimensions)
      ? { dimensions: { width: positiveInteger(action.dimensions.width, "width"), height: positiveInteger(action.dimensions.height, "height") } }
      : {}),
    ...(typeof action.artifactPath === "string" ? { artifactPath: action.artifactPath.slice(0, 8_192) } : {}),
    ...(typeof action.errorCode === "string" ? { errorCode: action.errorCode as BrowserSafeActionSummary["errorCode"] } : {}),
    startedAt: requiredString(action.startedAt, "startedAt", 128),
    ...(typeof action.completedAt === "string" ? { completedAt: action.completedAt.slice(0, 128) } : {}),
    ...(typeof action.elapsedMs === "number" ? { elapsedMs: Math.max(0, Math.round(action.elapsedMs)) } : {}),
  };
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid ${field}`);
  return value;
}

function requiredString(value: unknown, field: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maxLength || (!allowEmpty && value.length === 0)) throw new Error(`Invalid ${field}`);
  return value;
}

function requiredId(value: unknown, field: string): string {
  return requiredString(value, field, 128);
}

function nullableId(value: unknown, field: string): string | null {
  return value === null ? null : requiredId(value, field);
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Invalid ${field}`);
  return value;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid ${field}`);
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`Invalid ${field}`);
  return value as number;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`Invalid ${field}`);
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
