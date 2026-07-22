import { isAbsolute, relative, resolve } from "node:path";
import {
  BROWSER_AUTOMATION_MAX_SAFE_ACTIONS,
  type BrowserAutomationFailure,
  type BrowserAutomationInputByOperation,
  type BrowserAutomationOperation,
  type BrowserAutomationRequest,
  type BrowserAutomationResponse,
  type BrowserAutomationResultByOperation,
  type BrowserHostConnectionSnapshot,
  type BrowserHostRegistration,
  type BrowserSafeActionSummary,
  type BrowserSessionSnapshot,
  type BrowserTabSnapshot,
} from "@forge/protocol";
import {
  BrowserAutomationBrokerError,
  BrowserHostBroker,
  type BrowserHostBrokerOptions,
  type BrowserHostResponseDisposition,
} from "./browser-host-broker.js";
import { BrowserSessionStore } from "./browser-session-store.js";

export type BrowserAutomationInvocationResult<Operation extends BrowserAutomationOperation = BrowserAutomationOperation> =
  | { ok: true; operation: Operation; result: BrowserAutomationResultByOperation[Operation] }
  | { ok: false; operation: Operation; error: BrowserAutomationFailure };

export interface BrowserAutomationServiceOptions {
  dataDir: string;
  now?: () => string;
  broker?: BrowserHostBroker;
  brokerOptions?: BrowserHostBrokerOptions;
  store?: BrowserSessionStore;
  onSessionChanged?: (snapshot: BrowserSessionSnapshot, reason: "host-report" | "automation" | "human-command" | "lifecycle" | "recovery") => void;
  onPanelRevealRequested?: (snapshot: BrowserSessionSnapshot, tabId: string, hostGeneration: number) => void;
  onHostChanged?: (host: BrowserHostConnectionSnapshot) => void;
  logDebug?: (message: string, details?: unknown) => void;
}

export class BrowserAutomationService {
  readonly broker: BrowserHostBroker;
  readonly store: BrowserSessionStore;
  private readonly now: () => string;
  private readonly onSessionChanged: NonNullable<BrowserAutomationServiceOptions["onSessionChanged"]>;
  private readonly onPanelRevealRequested: NonNullable<BrowserAutomationServiceOptions["onPanelRevealRequested"]>;
  private readonly onHostChanged: NonNullable<BrowserAutomationServiceOptions["onHostChanged"]>;
  private readonly logDebug: (message: string, details?: unknown) => void;
  private readonly sessions = new Map<string, BrowserSessionSnapshot>();
  private readonly sessionLoadPromises = new Map<string, Promise<BrowserSessionSnapshot>>();
  private readonly tabOwners = new Map<string, string>();

  constructor(options: BrowserAutomationServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.logDebug = options.logDebug ?? (() => undefined);
    this.broker = options.broker ?? new BrowserHostBroker({
      ...options.brokerOptions,
      now: this.now,
      logDebug: this.logDebug,
    });
    this.store = options.store ?? new BrowserSessionStore({
      dataDir: options.dataDir,
      now: this.now,
      logDebug: this.logDebug,
    });
    this.onSessionChanged = options.onSessionChanged ?? (() => undefined);
    this.onPanelRevealRequested = options.onPanelRevealRequested ?? (() => undefined);
    this.onHostChanged = options.onHostChanged ?? (() => undefined);
  }

  registerHost(options: {
    connectionId: string;
    registration: BrowserHostRegistration;
    sendRequest: (request: BrowserAutomationRequest) => void | Promise<void>;
  }): BrowserHostConnectionSnapshot {
    const host = this.broker.register(options);
    this.onHostChanged(host);
    return host;
  }

  unregisterHost(connectionId: string, hostId?: string, hostGeneration?: number): boolean {
    const removed = this.broker.unregister(connectionId, hostId, hostGeneration);
    if (removed) this.onHostChanged(this.broker.getConnectionSnapshot());
    return removed;
  }

  setHostFocused(connectionId: string, hostId: string, hostGeneration: number, focused: boolean): boolean {
    const changed = this.broker.setFocused(connectionId, hostId, hostGeneration, focused);
    if (changed) this.onHostChanged(this.broker.getConnectionSnapshot());
    return changed;
  }

  acceptHostResponse(connectionId: string, response: unknown, encodedBytes?: number): BrowserHostResponseDisposition {
    return this.broker.acceptResponse(connectionId, response, encodedBytes);
  }

  async invoke<Operation extends BrowserAutomationOperation>(
    sessionAgentId: string,
    profileId: string,
    operation: Operation,
    input: BrowserAutomationInputByOperation[Operation],
  ): Promise<BrowserAutomationInvocationResult<Operation>> {
    const snapshot = await this.getSessionSnapshot(profileId, sessionAgentId);
    const target = this.resolveTarget(snapshot, operation, input as { tabId?: string; reuseExistingTab?: boolean });

    if (operation === "status" && !this.broker.getConnectionSnapshot().connected) {
      return {
        ok: true,
        operation,
        result: {
          available: false,
          host: this.broker.getConnectionSnapshot(),
          panelVisible: snapshot.panelVisible,
          selectedTab: target.tab ?? null,
        } as BrowserAutomationResultByOperation[Operation],
      };
    }

    if (target.failure) return { ok: false, operation, error: target.failure };

    const startedAt = this.now();
    const actionId = crypto.randomUUID();
    const action: BrowserSafeActionSummary = {
      id: actionId,
      operation,
      tabId: target.tab?.tabId ?? null,
      status: "running",
      ...(target.tab?.url ? { url: target.tab.url } : {}),
      ...(target.tab?.title ? { title: target.tab.title } : {}),
      startedAt,
    };
    await this.recordAction(snapshot, action);

    let response: BrowserAutomationResponse;
    try {
      response = await this.broker.request({
        sessionAgentId,
        profileId,
        tabId: target.tab?.tabId ?? null,
        operation,
        input: input as Record<string, unknown>,
        timeoutMs: readTimeout(input),
        artifactDirectory: operation === "recordingStop"
          ? this.store.getArtifactsDirectory(profileId, sessionAgentId)
          : null,
      });
    } catch (error) {
      const failure = toFailure(error);
      await this.completeAction(snapshot, actionId, failure.code === "control-interrupted" ? "interrupted" : "failed", {
        errorCode: failure.code,
      });
      await this.persistChanged(snapshot, "automation");
      return { ok: false, operation, error: failure };
    }

    if (response.updatedTab && (
      !isValidTabForSession(response.updatedTab, snapshot)
      || !this.isTabIdAvailable(snapshot, response.updatedTab.tabId)
    )) {
      const malformed = failure("malformed-response", "Browser host returned invalid tab metadata.", false);
      await this.completeAction(snapshot, actionId, "failed", { errorCode: malformed.code, elapsedMs: response.elapsedMs });
      await this.persistChanged(snapshot, "automation");
      return { ok: false, operation, error: malformed };
    }
    if (response.updatedTab) this.upsertTab(snapshot, response.updatedTab);
    if (!response.ok) {
      await this.completeAction(snapshot, actionId, response.error.code === "control-interrupted" ? "interrupted" : "failed", {
        errorCode: response.error.code,
        elapsedMs: response.elapsedMs,
      });
      await this.persistChanged(snapshot, "automation");
      return { ok: false, operation, error: response.error };
    }

    const resultTabId = getResultTabId(response.result);
    if (
      !isValidSuccessResult(operation, response.result, snapshot, target.tab?.tabId ?? null)
      || (resultTabId !== null && !this.isTabIdAvailable(snapshot, resultTabId))
    ) {
      const malformed = failure("malformed-response", "Browser host returned a malformed operation result.", false);
      await this.completeAction(snapshot, actionId, "failed", { errorCode: malformed.code, elapsedMs: response.elapsedMs });
      await this.persistChanged(snapshot, "automation");
      return { ok: false, operation, error: malformed };
    }
    if (operation === "recordingStop") {
      const artifactPath = (response.result as BrowserAutomationResultByOperation["recordingStop"]).path;
      const artifactDirectory = this.store.getArtifactsDirectory(profileId, sessionAgentId);
      if (!isPathBelow(artifactDirectory, artifactPath)) {
        const invalidPath = failure("artifact-path-invalid", "Browser recording artifact is outside the canonical session directory.", false);
        await this.completeAction(snapshot, actionId, "failed", { errorCode: invalidPath.code, elapsedMs: response.elapsedMs });
        await this.persistChanged(snapshot, "automation");
        return { ok: false, operation, error: invalidPath };
      }
    }

    this.applySuccessfulResult(snapshot, operation, response.result as BrowserAutomationResultByOperation[BrowserAutomationOperation]);
    const completedMetadata = extractSafeCompletionMetadata(response.result);
    await this.completeAction(snapshot, actionId, "succeeded", {
      ...completedMetadata,
      elapsedMs: response.elapsedMs,
    });
    await this.persistChanged(snapshot, "automation");

    if (operation === "open" && (input as BrowserAutomationInputByOperation["open"]).show) {
      const openedTab = (response.result as BrowserAutomationResultByOperation["open"]).tab;
      snapshot.panelVisible = true;
      await this.persistChanged(snapshot, "automation");
      const generation = this.broker.getConnectionSnapshot().hostGeneration;
      if (generation !== null) this.onPanelRevealRequested(cloneSnapshot(snapshot), openedTab.tabId, generation);
    }

    return { ok: true, operation, result: response.result as BrowserAutomationResultByOperation[Operation] };
  }

  async getSessionSnapshot(profileId: string, sessionAgentId: string): Promise<BrowserSessionSnapshot> {
    const key = sessionKey(profileId, sessionAgentId);
    const cached = this.sessions.get(key);
    if (cached) return cached;
    const pending = this.sessionLoadPromises.get(key);
    if (pending) return pending;
    const load = this.store.load(profileId, sessionAgentId).then((snapshot) => {
      this.sessions.set(key, snapshot);
      this.indexTabs(snapshot);
      this.sessionLoadPromises.delete(key);
      return snapshot;
    }, (error) => {
      this.sessionLoadPromises.delete(key);
      throw error;
    });
    this.sessionLoadPromises.set(key, load);
    return load;
  }

  getLoadedSessionSnapshots(): BrowserSessionSnapshot[] {
    return [...this.sessions.values()].map(cloneSnapshot);
  }

  async reportHostState(
    connectionId: string,
    hostId: string,
    hostGeneration: number,
    reportedSessions: BrowserSessionSnapshot[],
  ): Promise<boolean> {
    if (!this.broker.isCurrentConnection(connectionId, hostId, hostGeneration)) return false;
    for (const reported of reportedSessions) {
      let normalized: BrowserSessionSnapshot;
      try {
        normalized = this.store.normalize(reported);
      } catch (error) {
        this.logDebug("browser-automation:invalid-host-state-report", {
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
      if (normalized.tabs.some((tab) => {
        const owner = this.tabOwners.get(tab.tabId);
        return owner !== undefined && owner !== normalized.sessionAgentId;
      })) return false;
      const canonical = await this.getSessionSnapshot(normalized.profileId, normalized.sessionAgentId);
      for (const tab of canonical.tabs) {
        if (this.tabOwners.get(tab.tabId) === canonical.sessionAgentId) this.tabOwners.delete(tab.tabId);
      }
      canonical.tabs = normalized.tabs.map((tab) => ({ ...tab }));
      canonical.activeTabId = normalized.activeTabId;
      canonical.defaultTabId = normalized.defaultTabId;
      canonical.panelVisible = normalized.panelVisible;
      this.indexTabs(canonical);
      await this.persistChanged(canonical, "host-report");
    }
    return true;
  }

  cancelSession(sessionAgentId: string): number {
    return this.broker.cancelSession(sessionAgentId);
  }

  async archiveSession(profileId: string, sessionAgentId: string): Promise<BrowserSessionSnapshot> {
    this.broker.cancelSession(sessionAgentId, "request-cancelled", "Browser session was archived.");
    const snapshot = await this.getSessionSnapshot(profileId, sessionAgentId);
    snapshot.panelVisible = false;
    snapshot.tabs = snapshot.tabs.map((tab) => ({
      ...tab,
      live: false,
      controller: "none",
      recording: null,
      updatedAt: this.now(),
    }));
    await this.persistChanged(snapshot, "lifecycle");
    return cloneSnapshot(snapshot);
  }

  async restoreSession(profileId: string, sessionAgentId: string): Promise<BrowserSessionSnapshot> {
    const snapshot = await this.getSessionSnapshot(profileId, sessionAgentId);
    snapshot.tabs = snapshot.tabs.map((tab) => ({
      ...tab,
      live: false,
      lifecycle: tab.lifecycle === "closed" ? "closed" : "restoring",
      controller: "none",
      updatedAt: this.now(),
    }));
    await this.persistChanged(snapshot, "recovery");
    return cloneSnapshot(snapshot);
  }

  async deleteSession(profileId: string, sessionAgentId: string): Promise<void> {
    this.broker.cancelSession(sessionAgentId, "request-cancelled", "Browser session was deleted.");
    const key = sessionKey(profileId, sessionAgentId);
    const snapshot = this.sessions.get(key);
    if (snapshot) {
      for (const tab of snapshot.tabs) this.tabOwners.delete(tab.tabId);
    }
    this.sessions.delete(key);
    this.sessionLoadPromises.delete(key);
    await this.store.delete(profileId, sessionAgentId);
  }

  private resolveTarget(
    snapshot: BrowserSessionSnapshot,
    operation: BrowserAutomationOperation,
    input: { tabId?: string; reuseExistingTab?: boolean },
  ): { tab?: BrowserTabSnapshot; failure?: BrowserAutomationFailure } {
    if (input.tabId) {
      const tab = snapshot.tabs.find((candidate) => candidate.tabId === input.tabId);
      if (tab) return { tab };
      const owner = this.tabOwners.get(input.tabId);
      return {
        failure: owner && owner !== snapshot.sessionAgentId
          ? failure("tab-session-mismatch", "The requested browser tab belongs to another Forge session.", false)
          : failure("tab-not-found", "The requested browser tab does not exist in this Forge session.", false),
      };
    }

    const defaultId = snapshot.defaultTabId ?? snapshot.activeTabId;
    const defaultTab = defaultId ? snapshot.tabs.find((tab) => tab.tabId === defaultId) : undefined;
    if (operation === "status") return { tab: defaultTab };
    if (operation === "open") {
      return input.reuseExistingTab === false ? {} : { tab: defaultTab };
    }
    if (!defaultTab) return { failure: failure("tab-not-found", "Open a browser tab before using this operation.", false) };
    return { tab: defaultTab };
  }

  private applySuccessfulResult(
    snapshot: BrowserSessionSnapshot,
    operation: BrowserAutomationOperation,
    result: BrowserAutomationResultByOperation[BrowserAutomationOperation],
  ): void {
    if (operation === "open") {
      const tab = (result as BrowserAutomationResultByOperation["open"]).tab;
      this.upsertTab(snapshot, tab);
      snapshot.activeTabId = tab.tabId;
      snapshot.defaultTabId = tab.tabId;
      return;
    }
    if (operation === "navigate") this.upsertTab(snapshot, (result as BrowserAutomationResultByOperation["navigate"]).tab);
    if (operation === "status") {
      const selectedTab = (result as BrowserAutomationResultByOperation["status"]).selectedTab;
      if (selectedTab) this.upsertTab(snapshot, selectedTab);
    }
  }

  private isTabIdAvailable(snapshot: BrowserSessionSnapshot, tabId: string): boolean {
    const owner = this.tabOwners.get(tabId);
    return owner === undefined || owner === snapshot.sessionAgentId;
  }

  private upsertTab(snapshot: BrowserSessionSnapshot, tab: BrowserTabSnapshot): void {
    if (tab.sessionAgentId !== snapshot.sessionAgentId || tab.profileId !== snapshot.profileId) {
      this.logDebug("browser-automation:ignored-cross-session-tab", {
        sessionAgentId: snapshot.sessionAgentId,
        tabId: tab.tabId,
      });
      return;
    }
    const existing = snapshot.tabs.findIndex((candidate) => candidate.tabId === tab.tabId);
    if (existing >= 0) snapshot.tabs[existing] = { ...tab };
    else snapshot.tabs.push({ ...tab });
    this.tabOwners.set(tab.tabId, snapshot.sessionAgentId);
    snapshot.defaultTabId ??= tab.tabId;
    snapshot.activeTabId ??= tab.tabId;
  }

  private indexTabs(snapshot: BrowserSessionSnapshot): void {
    for (const tab of snapshot.tabs) this.tabOwners.set(tab.tabId, snapshot.sessionAgentId);
  }

  private async recordAction(snapshot: BrowserSessionSnapshot, action: BrowserSafeActionSummary): Promise<void> {
    snapshot.recentActions.push(action);
    snapshot.recentActions = snapshot.recentActions.slice(-BROWSER_AUTOMATION_MAX_SAFE_ACTIONS);
    await this.persistChanged(snapshot, "automation");
  }

  private async completeAction(
    snapshot: BrowserSessionSnapshot,
    actionId: string,
    status: BrowserSafeActionSummary["status"],
    metadata: Partial<Pick<BrowserSafeActionSummary, "artifactPath" | "dimensions" | "elapsedMs" | "errorCode" | "url" | "title">>,
  ): Promise<void> {
    const action = snapshot.recentActions.find((candidate) => candidate.id === actionId);
    if (!action) return;
    Object.assign(action, metadata, { status, completedAt: this.now() });
  }

  private async persistChanged(
    snapshot: BrowserSessionSnapshot,
    reason: "host-report" | "automation" | "human-command" | "lifecycle" | "recovery",
  ): Promise<void> {
    snapshot.revision += 1;
    snapshot.updatedAt = this.now();
    await this.store.save(snapshot);
    this.onSessionChanged(cloneSnapshot(snapshot), reason);
  }
}

function getResultTabId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.tabId === "string") return value.tabId;
  if (isRecord(value.tab) && typeof value.tab.tabId === "string") return value.tab.tabId;
  return isRecord(value.selectedTab) && typeof value.selectedTab.tabId === "string" ? value.selectedTab.tabId : null;
}

function isValidSuccessResult(
  operation: BrowserAutomationOperation,
  value: unknown,
  snapshot: BrowserSessionSnapshot,
  expectedTabId: string | null,
): boolean {
  if (!isRecord(value)) return false;
  const directTabId = typeof value.tabId === "string" ? value.tabId : null;
  const nestedTabId = isRecord(value.tab) && typeof value.tab.tabId === "string" ? value.tab.tabId : null;
  if (operation !== "open" && operation !== "status" && (directTabId ?? nestedTabId) !== expectedTabId) return false;
  if (operation === "open" && expectedTabId !== null && nestedTabId !== expectedTabId) return false;
  switch (operation) {
    case "status":
      return typeof value.available === "boolean"
        && typeof value.panelVisible === "boolean"
        && (value.selectedTab === null || (
          isValidTabForSession(value.selectedTab, snapshot)
          && (expectedTabId === null || value.selectedTab.tabId === expectedTabId)
        ));
    case "open":
      return typeof value.created === "boolean"
        && typeof value.panelRevealRequested === "boolean"
        && isValidTabForSession(value.tab, snapshot);
    case "navigate":
      return isValidTabForSession(value.tab, snapshot)
        && (value.readiness === "load" || value.readiness === "domContentLoaded" || value.readiness === "none");
    case "resize":
      return typeof value.tabId === "string" && isRecord(value.setting) && isRenderedViewport(value.viewport);
    case "snapshot":
      return typeof value.tabId === "string"
        && typeof value.url === "string"
        && typeof value.title === "string"
        && isRenderedViewport(value.viewport)
        && typeof value.visibleText === "string"
        && Array.isArray(value.interactiveElements)
        && Array.isArray(value.consoleEntries)
        && Array.isArray(value.networkEntries)
        && Array.isArray(value.actionTimeline)
        && isRecord(value.screenshot)
        && value.screenshot.mimeType === "image/png"
        && typeof value.screenshot.data === "string"
        && typeof value.screenshot.width === "number"
        && typeof value.screenshot.height === "number";
    case "click":
      return typeof value.tabId === "string" && isRecord(value.point)
        && typeof value.point.x === "number" && typeof value.point.y === "number";
    case "type":
      return typeof value.tabId === "string" && typeof value.characters === "number" && typeof value.cleared === "boolean";
    case "press":
      return typeof value.tabId === "string" && typeof value.key === "string" && Array.isArray(value.modifiers);
    case "scroll":
      return typeof value.tabId === "string" && ["deltaX", "deltaY", "scrollX", "scrollY"].every((key) => typeof value[key] === "number");
    case "evaluate":
      return typeof value.tabId === "string" && typeof value.serializedBytes === "number";
    case "waitFor":
      return typeof value.tabId === "string" && value.matched === true && typeof value.elapsedMs === "number";
    case "recordingStart":
      return typeof value.recordingId === "string" && typeof value.tabId === "string" && value.recording === true
        && typeof value.startedAt === "string" && typeof value.mimeType === "string"
        && typeof value.width === "number" && typeof value.height === "number";
    case "recordingStop":
      return typeof value.recordingId === "string" && typeof value.tabId === "string" && typeof value.path === "string"
        && typeof value.mimeType === "string" && typeof value.extension === "string" && typeof value.sizeBytes === "number"
        && typeof value.width === "number" && typeof value.height === "number" && typeof value.createdAt === "string";
  }
}

function isValidTabForSession(value: unknown, snapshot: BrowserSessionSnapshot): value is BrowserTabSnapshot {
  if (!isRecord(value)) return false;
  return typeof value.tabId === "string"
    && value.sessionAgentId === snapshot.sessionAgentId
    && value.profileId === snapshot.profileId
    && typeof value.url === "string"
    && typeof value.title === "string"
    && typeof value.live === "boolean"
    && typeof value.loading === "boolean"
    && isRecord(value.viewportSetting);
}

function isRenderedViewport(value: unknown): boolean {
  return isRecord(value)
    && typeof value.width === "number"
    && typeof value.height === "number"
    && typeof value.deviceScaleFactor === "number";
}

function isPathBelow(directory: string, candidate: string): boolean {
  if (!isAbsolute(candidate)) return false;
  const relativePath = relative(resolve(directory), resolve(candidate));
  return relativePath.length > 0 && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readTimeout(input: unknown): number | undefined {
  return input && typeof input === "object" && typeof (input as { timeoutMs?: unknown }).timeoutMs === "number"
    ? (input as { timeoutMs: number }).timeoutMs
    : undefined;
}

function toFailure(error: unknown): BrowserAutomationFailure {
  if (error instanceof BrowserAutomationBrokerError) return error.failure;
  return failure("execution-failed", error instanceof Error ? error.message : String(error), false);
}

function failure(code: BrowserAutomationFailure["code"], message: string, retryable: boolean): BrowserAutomationFailure {
  return { code, message, retryable };
}

function extractSafeCompletionMetadata(result: unknown): Partial<BrowserSafeActionSummary> {
  if (!result || typeof result !== "object") return {};
  const value = result as Record<string, unknown>;
  const tab = value.tab && typeof value.tab === "object" ? value.tab as Record<string, unknown> : undefined;
  const viewport = value.viewport && typeof value.viewport === "object" ? value.viewport as Record<string, unknown> : undefined;
  return {
    ...(typeof value.path === "string" ? { artifactPath: value.path } : {}),
    ...(typeof value.url === "string" ? { url: value.url } : typeof tab?.url === "string" ? { url: tab.url } : {}),
    ...(typeof value.title === "string" ? { title: value.title } : typeof tab?.title === "string" ? { title: tab.title } : {}),
    ...(typeof value.width === "number" && typeof value.height === "number"
      ? { dimensions: { width: value.width, height: value.height } }
      : typeof viewport?.width === "number" && typeof viewport?.height === "number"
        ? { dimensions: { width: viewport.width, height: viewport.height } }
        : {}),
  };
}

function sessionKey(profileId: string, sessionAgentId: string): string {
  return `${profileId}\u0000${sessionAgentId}`;
}

function cloneSnapshot(snapshot: BrowserSessionSnapshot): BrowserSessionSnapshot {
  return structuredClone(snapshot);
}
