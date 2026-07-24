import { isAbsolute, relative, resolve } from "node:path";
import {
  BROWSER_AUTOMATION_MAX_SAFE_ACTIONS,
  DEFAULT_BROWSER_HOST_KIND,
  resolveBrowserHostKind,
  type BrowserAutomationFailure,
  type BrowserAutomationInputByOperation,
  type BrowserAutomationOperation,
  type BrowserAutomationRequest,
  type BrowserAutomationResponse,
  type BrowserAutomationResultByOperation,
  type BrowserHostConnectionSnapshot,
  type BrowserHostKind,
  type BrowserHostRegistration,
  type BrowserHostSessionStateReport,
  type BrowserHostSessionStateReportResult,
  type BrowserHostStateReportResult,
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
  onHostChanged?: (host: BrowserHostConnectionSnapshot) => void;
  logDebug?: (message: string, details?: unknown) => void;
}

export class BrowserAutomationService {
  readonly broker: BrowserHostBroker;
  readonly store: BrowserSessionStore;
  private readonly now: () => string;
  private readonly onSessionChanged: NonNullable<BrowserAutomationServiceOptions["onSessionChanged"]>;
  private readonly onHostChanged: NonNullable<BrowserAutomationServiceOptions["onHostChanged"]>;
  private readonly logDebug: (message: string, details?: unknown) => void;
  private readonly sessions = new Map<string, BrowserSessionSnapshot>();
  private readonly sessionLoadPromises = new Map<string, Promise<BrowserSessionSnapshot>>();
  private readonly tabOwners = new Map<string, string>();
  /** Bumped on delete so in-flight ops cannot persist or emit after removal. */
  private readonly sessionGenerations = new Map<string, number>();
  /** Active while deleteSession runs; blocks cache loads and mutations. */
  private readonly sessionTombs = new Set<string>();
  /** Serializes per-session mutation/delete barriers after broker settlement. */
  private readonly sessionMutationChains = new Map<string, Promise<void>>();
  /** In-flight invoke/load work deleteSession awaits before clearing storage. */
  private readonly sessionInFlight = new Map<string, Set<Promise<unknown>>>();

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

  unregisterHost(connectionId: string, hostId?: string, hostGeneration?: number, hostKind?: BrowserHostKind): boolean {
    const removed = this.broker.unregister(connectionId, hostId, hostGeneration, hostKind);
    if (removed) {
      if (hostKind) this.onHostChanged(this.broker.getConnectionSnapshot(hostKind));
      else for (const snapshot of this.broker.getConnectionSnapshots()) this.onHostChanged(snapshot);
    }
    return removed;
  }

  setHostFocused(connectionId: string, hostId: string, hostGeneration: number, focused: boolean, hostKind: BrowserHostKind = DEFAULT_BROWSER_HOST_KIND): boolean {
    const changed = this.broker.setFocused(connectionId, hostId, hostGeneration, focused, hostKind);
    if (changed) this.onHostChanged(this.broker.getConnectionSnapshot(hostKind));
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
    const key = sessionKey(profileId, sessionAgentId);
    const generation = this.getGeneration(key);
    return this.trackInFlight(key, async () => {
      if (!this.isGenerationCurrent(key, generation)) {
        return {
          ok: false,
          operation,
          error: failure("request-cancelled", "Browser session was deleted.", true),
        };
      }

      const snapshot = await this.getSessionSnapshot(profileId, sessionAgentId);
      if (!this.isGenerationCurrent(key, generation)) {
        return {
          ok: false,
          operation,
          error: failure("request-cancelled", "Browser session was deleted.", true),
        };
      }
      const requestedHostKind = (input as { hostKind?: BrowserHostKind }).hostKind;
      const hostKind = resolveBrowserHostKind(requestedHostKind ?? snapshot.hostKind);
      const target = this.resolveTarget(snapshot, operation, input as { tabId?: string; reuseExistingTab?: boolean }, hostKind);

      if (operation === "status" && !this.broker.getConnectionSnapshot(hostKind).connected) {
        return {
          ok: true,
          operation,
          result: {
            available: false,
            host: this.broker.getConnectionSnapshot(hostKind),
            panelVisible: false,
            panelRevealRequested: isPanelRevealPending(snapshot),
            physicalTabVisible: false,
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
      await this.withSessionMutation(key, async () => {
        if (!this.isGenerationCurrent(key, generation)) return;
        await this.recordAction(snapshot, action, generation);
      });
      if (!this.isGenerationCurrent(key, generation)) {
        return {
          ok: false,
          operation,
          error: failure("request-cancelled", "Browser session was deleted.", true),
        };
      }

      let response: BrowserAutomationResponse;
      try {
        response = await this.broker.request({
          hostKind,
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
        const failureResult = toFailure(error);
        await this.withSessionMutation(key, async () => {
          if (!this.isGenerationCurrent(key, generation)) return;
          await this.completeAction(snapshot, actionId, failureResult.code === "control-interrupted" ? "interrupted" : "failed", {
            errorCode: failureResult.code,
          });
          await this.persistChanged(snapshot, "automation", generation);
        });
        return { ok: false, operation, error: failureResult };
      }

      return await this.withSessionMutation(key, async () => {
        if (!this.isGenerationCurrent(key, generation)) {
          return {
            ok: false,
            operation,
            error: failure("request-cancelled", "Browser session was deleted.", true),
          };
        }

        if (response.updatedTab && (
          !isValidTabForSession(response.updatedTab, snapshot, hostKind)
          || !this.isTabIdAvailable(snapshot, response.updatedTab.tabId, hostKind)
        )) {
          const malformed = failure("malformed-response", "Browser host returned invalid tab metadata.", false);
          await this.completeAction(snapshot, actionId, "failed", { errorCode: malformed.code, elapsedMs: response.elapsedMs });
          await this.persistChanged(snapshot, "automation", generation);
          return { ok: false, operation, error: malformed };
        }
        if (response.updatedTab) this.upsertTab(snapshot, response.updatedTab);
        if (!response.ok) {
          await this.completeAction(snapshot, actionId, response.error.code === "control-interrupted" ? "interrupted" : "failed", {
            errorCode: response.error.code,
            elapsedMs: response.elapsedMs,
          });
          await this.persistChanged(snapshot, "automation", generation);
          return { ok: false, operation, error: response.error };
        }

        const resultTabId = getResultTabId(response.result);
        if (
          !isValidSuccessResult(operation, response.result, snapshot, target.tab?.tabId ?? null, hostKind)
          || (resultTabId !== null && !this.isTabIdAvailable(snapshot, resultTabId, hostKind))
        ) {
          const malformed = failure("malformed-response", "Browser host returned a malformed operation result.", false);
          await this.completeAction(snapshot, actionId, "failed", { errorCode: malformed.code, elapsedMs: response.elapsedMs });
          await this.persistChanged(snapshot, "automation", generation);
          return { ok: false, operation, error: malformed };
        }
        if (operation === "recordingStop") {
          const artifactPath = (response.result as BrowserAutomationResultByOperation["recordingStop"]).path;
          const artifactDirectory = this.store.getArtifactsDirectory(profileId, sessionAgentId);
          if (!isPathBelow(artifactDirectory, artifactPath)) {
            const invalidPath = failure("artifact-path-invalid", "Browser recording artifact is outside the canonical session directory.", false);
            await this.completeAction(snapshot, actionId, "failed", { errorCode: invalidPath.code, elapsedMs: response.elapsedMs });
            await this.persistChanged(snapshot, "automation", generation);
            return { ok: false, operation, error: invalidPath };
          }
        }

        snapshot.hostKind = hostKind;
        this.applySuccessfulResult(snapshot, operation, response.result as BrowserAutomationResultByOperation[BrowserAutomationOperation], hostKind);
        if (operation === "status" && response.ok) {
          const statusResult = response.result as BrowserAutomationResultByOperation["status"];
          statusResult.host = this.broker.getConnectionSnapshot(hostKind);
          statusResult.available = statusResult.host.connected;
          // Electron owns physical visibility; durable reveal intent remains backend-owned.
          statusResult.panelRevealRequested = isPanelRevealPending(snapshot);
        }
        const completedMetadata = extractSafeCompletionMetadata(response.result);
        await this.completeAction(snapshot, actionId, "succeeded", {
          ...completedMetadata,
          elapsedMs: response.elapsedMs,
        });
        await this.persistChanged(snapshot, "automation", generation);

        if (operation === "open" && (input as BrowserAutomationInputByOperation["open"]).show) {
          const openedTab = (response.result as BrowserAutomationResultByOperation["open"]).tab;
          const reveal = snapshot.panelReveal ?? { sequence: 0, acknowledgedSequence: 0, tabId: null };
          if (reveal.sequence >= Number.MAX_SAFE_INTEGER) {
            throw new Error("Browser panel reveal sequence cannot be incremented safely.");
          }
          snapshot.panelVisible = true;
          snapshot.panelReveal = {
            sequence: reveal.sequence + 1,
            acknowledgedSequence: reveal.acknowledgedSequence,
            tabId: openedTab.tabId,
          };
          await this.persistChanged(snapshot, "automation", generation);
        }

        return { ok: true, operation, result: response.result as BrowserAutomationResultByOperation[Operation] };
      });
    });
  }

  async getSessionSnapshot(profileId: string, sessionAgentId: string): Promise<BrowserSessionSnapshot> {
    const key = sessionKey(profileId, sessionAgentId);
    if (this.sessionTombs.has(key)) {
      return this.store.createEmpty(profileId, sessionAgentId);
    }
    const cached = this.sessions.get(key);
    if (cached) return cached;
    const pending = this.sessionLoadPromises.get(key);
    if (pending) return pending;
    const generation = this.getGeneration(key);
    const load = this.store.load(profileId, sessionAgentId).then((snapshot) => {
      this.sessionLoadPromises.delete(key);
      if (!this.isGenerationCurrent(key, generation) || this.sessionTombs.has(key)) {
        return snapshot;
      }
      this.sessions.set(key, snapshot);
      this.indexTabs(snapshot);
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
    reportedSessions: BrowserHostSessionStateReport[],
    hostKind: BrowserHostKind = DEFAULT_BROWSER_HOST_KIND,
  ): Promise<BrowserHostStateReportResult> {
    if (!this.broker.isCurrentConnection(connectionId, hostId, hostGeneration, hostKind)) {
      return { hostKind, hostId, hostGeneration, status: "stale-host-generation", sessions: [] };
    }

    const results: BrowserHostSessionStateReportResult[] = [];
    for (const reported of reportedSessions) {
      const resultBase = {
        sessionAgentId: reported.sessionAgentId,
        profileId: reported.profileId,
      };
      if (
        typeof reported.sessionAgentId !== "string"
        || typeof reported.profileId !== "string"
        || resolveBrowserHostKind(reported.hostKind) !== hostKind
        || !Number.isInteger(reported.baseRevision)
        || reported.baseRevision < 0
        || !Array.isArray(reported.tabs)
      ) {
        results.push({ ...resultBase, status: "rejected", reason: "invalid-report" });
        continue;
      }

      const reportKey = sessionKey(reported.profileId, reported.sessionAgentId);
      if (this.sessionTombs.has(reportKey)) {
        results.push({ ...resultBase, status: "rejected", reason: "session-unavailable" });
        continue;
      }

      let normalizedTabs: BrowserTabSnapshot[];
      try {
        const envelope = this.store.normalize({
          ...this.store.createEmpty(reported.profileId, reported.sessionAgentId),
          tabs: reported.tabs,
          revision: reported.baseRevision,
        });
        normalizedTabs = envelope.tabs;
        if (normalizedTabs.some((tab) => resolveBrowserHostKind(tab.hostKind) !== hostKind)) {
          throw new Error("Host report contains a tab for another browser host kind");
        }
      } catch (error) {
        this.logDebug("browser-automation:invalid-host-state-report", {
          error: error instanceof Error ? error.message : String(error),
        });
        results.push({ ...resultBase, status: "rejected", reason: "invalid-report" });
        continue;
      }
      if (normalizedTabs.some((tab) => {
        const owner = this.tabOwners.get(hostTabKey(hostKind, tab.tabId));
        return owner !== undefined && owner !== reported.sessionAgentId;
      })) {
        results.push({ ...resultBase, status: "rejected", reason: "invalid-report" });
        continue;
      }

      const generation = this.getGeneration(reportKey);
      let canonical: BrowserSessionSnapshot;
      try {
        canonical = await this.getSessionSnapshot(reported.profileId, reported.sessionAgentId);
      } catch {
        results.push({ ...resultBase, status: "rejected", reason: "session-unavailable" });
        continue;
      }
      if (
        !this.isGenerationCurrent(reportKey, generation)
        || this.sessionTombs.has(reportKey)
        || canonical.hostingState !== "hosted"
      ) {
        results.push({
          ...resultBase,
          status: "rejected",
          reason: "session-unavailable",
          snapshot: cloneSnapshot(canonical),
        });
        continue;
      }
      if (reported.baseRevision !== canonical.revision) {
        this.logDebug("browser-automation:stale-host-state-report", {
          sessionAgentId: reported.sessionAgentId,
          baseRevision: reported.baseRevision,
          revision: canonical.revision,
        });
        results.push({
          ...resultBase,
          status: "revision-conflict",
          snapshot: cloneSnapshot(canonical),
        });
        continue;
      }
      if (normalizedTabs.some((reportedTab) => !canonical.tabs.some((tab) => tab.tabId === reportedTab.tabId && resolveBrowserHostKind(tab.hostKind) === hostKind))) {
        results.push({
          ...resultBase,
          status: "rejected",
          reason: "tab-unavailable",
          snapshot: cloneSnapshot(canonical),
        });
        continue;
      }

      let changed = false;
      for (const reportedTab of normalizedTabs) {
        const index = canonical.tabs.findIndex((tab) => tab.tabId === reportedTab.tabId && resolveBrowserHostKind(tab.hostKind) === hostKind);
        const merged = mergeHostOwnedTabFields(canonical.tabs[index]!, reportedTab);
        if (merged !== canonical.tabs[index]) {
          canonical.tabs[index] = merged;
          changed = true;
        }
      }
      let accepted = !changed;
      if (changed) {
        await this.withSessionMutation(reportKey, async () => {
          if (!this.isGenerationCurrent(reportKey, generation)) return;
          await this.persistChanged(canonical, "host-report", generation);
          accepted = true;
        });
      }
      if (!accepted || !this.isGenerationCurrent(reportKey, generation) || this.sessionTombs.has(reportKey)) {
        results.push({ ...resultBase, status: "rejected", reason: "session-unavailable" });
        continue;
      }
      results.push({
        ...resultBase,
        status: "accepted",
        snapshot: cloneSnapshot(canonical),
      });
    }
    return { hostKind, hostId, hostGeneration, status: "processed", sessions: results };
  }

  async acknowledgePanelReveal(
    profileId: string,
    sessionAgentId: string,
    tabId: string,
    sequence: number,
  ): Promise<BrowserSessionSnapshot> {
    const key = sessionKey(profileId, sessionAgentId);
    const generation = this.getGeneration(key);
    return this.withSessionMutation(key, async () => {
      this.assertMutable(key, generation);
      const snapshot = await this.getSessionSnapshot(profileId, sessionAgentId);
      this.assertMutable(key, generation);
      const reveal = snapshot.panelReveal ?? { sequence: 0, acknowledgedSequence: 0, tabId: null };
      if (sequence <= reveal.acknowledgedSequence) return cloneSnapshot(snapshot);
      if (sequence !== reveal.sequence || tabId !== reveal.tabId) {
        throw new Error("Browser panel reveal acknowledgement does not match the pending intent.");
      }
      snapshot.panelReveal = { ...reveal, acknowledgedSequence: sequence };
      await this.persistChanged(snapshot, "host-report", generation);
      return cloneSnapshot(snapshot);
    });
  }

  async activateTab(profileId: string, sessionAgentId: string, tabId: string, hostKind: BrowserHostKind = DEFAULT_BROWSER_HOST_KIND): Promise<BrowserSessionSnapshot> {
    const key = sessionKey(profileId, sessionAgentId);
    const generation = this.getGeneration(key);
    return this.withSessionMutation(key, async () => {
      this.assertMutable(key, generation);
      const snapshot = await this.getSessionSnapshot(profileId, sessionAgentId);
      this.assertMutable(key, generation);
      const tab = snapshot.tabs.find((candidate) => candidate.tabId === tabId && resolveBrowserHostKind(candidate.hostKind) === hostKind && candidate.lifecycle !== "closed");
      if (!tab) throw new Error("Browser tab was not found in the selected Forge session.");
      snapshot.activeTabId = tabId;
      snapshot.defaultTabId = tabId;
      snapshot.panelVisible = true;
      await this.persistChanged(snapshot, "human-command", generation);
      return cloneSnapshot(snapshot);
    });
  }

  async closeTab(profileId: string, sessionAgentId: string, tabId: string, hostKind: BrowserHostKind = DEFAULT_BROWSER_HOST_KIND): Promise<BrowserSessionSnapshot> {
    const key = sessionKey(profileId, sessionAgentId);
    const generation = this.getGeneration(key);
    return this.withSessionMutation(key, async () => {
      this.assertMutable(key, generation);
      const snapshot = await this.getSessionSnapshot(profileId, sessionAgentId);
      this.assertMutable(key, generation);
      const existing = snapshot.tabs.find((candidate) => candidate.tabId === tabId && resolveBrowserHostKind(candidate.hostKind) === hostKind);
      if (!existing || existing.lifecycle === "closed") throw new Error("Browser tab was not found in the selected Forge session.");
      snapshot.tabs = snapshot.tabs.filter((candidate) => candidate !== existing);
      this.tabOwners.delete(hostTabKey(resolveBrowserHostKind(existing.hostKind), tabId));
      if (snapshot.panelReveal?.tabId === tabId) {
        snapshot.panelReveal = {
          ...snapshot.panelReveal,
          acknowledgedSequence: snapshot.panelReveal.sequence,
          tabId: null,
        };
      }
      if (snapshot.activeTabId === tabId) snapshot.activeTabId = snapshot.tabs[0]?.tabId ?? null;
      if (snapshot.defaultTabId === tabId) snapshot.defaultTabId = snapshot.activeTabId;
      await this.persistChanged(snapshot, "human-command", generation);
      return cloneSnapshot(snapshot);
    });
  }

  async setTabSelection(
    profileId: string,
    sessionAgentId: string,
    activeTabId: string | null,
    defaultTabId: string | null,
  ): Promise<BrowserSessionSnapshot> {
    const key = sessionKey(profileId, sessionAgentId);
    const generation = this.getGeneration(key);
    return this.withSessionMutation(key, async () => {
      this.assertMutable(key, generation);
      const snapshot = await this.getSessionSnapshot(profileId, sessionAgentId);
      this.assertMutable(key, generation);
      const tabIds = new Set(snapshot.tabs.map((tab) => tab.tabId));
      if (activeTabId !== null && !tabIds.has(activeTabId)) throw new Error("Active browser tab is missing");
      if (defaultTabId !== null && !tabIds.has(defaultTabId)) throw new Error("Default browser tab is missing");
      snapshot.activeTabId = activeTabId;
      snapshot.defaultTabId = defaultTabId;
      await this.persistChanged(snapshot, "human-command", generation);
      return cloneSnapshot(snapshot);
    });
  }

  cancelSession(sessionAgentId: string): number {
    return this.broker.cancelSession(sessionAgentId);
  }

  async archiveSession(profileId: string, sessionAgentId: string): Promise<BrowserSessionSnapshot> {
    this.broker.cancelSession(sessionAgentId, "request-cancelled", "Browser session was archived.");
    const key = sessionKey(profileId, sessionAgentId);
    const generation = this.getGeneration(key);
    return this.withSessionMutation(key, async () => {
      this.assertMutable(key, generation);
      const snapshot = await this.getSessionSnapshot(profileId, sessionAgentId);
      this.assertMutable(key, generation);
      snapshot.hostingState = "unhosted";
      snapshot.panelVisible = false;
      if (snapshot.panelReveal) {
        snapshot.panelReveal = {
          ...snapshot.panelReveal,
          acknowledgedSequence: snapshot.panelReveal.sequence,
          tabId: null,
        };
      }
      snapshot.tabs = snapshot.tabs.map((tab) => ({
        ...tab,
        live: false,
        physicalVisible: false,
        renderedViewport: null,
        controller: "none",
        recording: null,
        updatedAt: this.now(),
      }));
      await this.persistChanged(snapshot, "lifecycle", generation);
      return cloneSnapshot(snapshot);
    });
  }

  async restoreSession(profileId: string, sessionAgentId: string): Promise<BrowserSessionSnapshot> {
    const key = sessionKey(profileId, sessionAgentId);
    const generation = this.getGeneration(key);
    return this.withSessionMutation(key, async () => {
      this.assertMutable(key, generation);
      const snapshot = await this.getSessionSnapshot(profileId, sessionAgentId);
      this.assertMutable(key, generation);
      snapshot.hostingState = "hosted";
      snapshot.tabs = snapshot.tabs.map((tab) => ({
        ...tab,
        live: false,
        physicalVisible: false,
        renderedViewport: null,
        lifecycle: tab.lifecycle === "closed" ? "closed" : "restoring",
        controller: "none",
        updatedAt: this.now(),
      }));
      await this.persistChanged(snapshot, "recovery", generation);
      return cloneSnapshot(snapshot);
    });
  }

  async deleteSession(profileId: string, sessionAgentId: string): Promise<void> {
    const key = sessionKey(profileId, sessionAgentId);
    this.bumpGeneration(key);
    this.sessionTombs.add(key);
    this.broker.cancelSession(sessionAgentId, "request-cancelled", "Browser session was deleted.");

    const pendingLoad = this.sessionLoadPromises.get(key);
    this.sessionLoadPromises.delete(key);
    await this.awaitInFlight(key);
    // Ignore a racing load result; generation/tomb checks prevent caching after delete.
    void pendingLoad?.then(() => undefined, () => undefined);
    await this.withSessionMutation(key, async () => {
      let snapshot = this.sessions.get(key);
      if (!snapshot) {
        try {
          snapshot = await this.store.load(profileId, sessionAgentId);
        } catch {
          snapshot = undefined;
        }
      }
      if (snapshot) {
        for (const tab of snapshot.tabs) this.tabOwners.delete(hostTabKey(resolveBrowserHostKind(tab.hostKind), tab.tabId));
        const hadState = snapshot.tabs.length > 0 || snapshot.revision > 0 || snapshot.recentActions.length > 0;
        if (hadState) {
          snapshot.hostingState = "removed";
          snapshot.panelVisible = false;
          if (snapshot.panelReveal) {
            snapshot.panelReveal = {
              ...snapshot.panelReveal,
              acknowledgedSequence: snapshot.panelReveal.sequence,
              tabId: null,
            };
          }
          snapshot.tabs = snapshot.tabs.map((tab) => ({
            ...tab,
            live: false,
            physicalVisible: false,
            renderedViewport: null,
            lifecycle: "closed" as const,
            controller: "none" as const,
            recording: null,
            updatedAt: this.now(),
          }));
          snapshot.revision += 1;
          snapshot.updatedAt = this.now();
          this.onSessionChanged(cloneSnapshot(snapshot), "lifecycle");
        }
      }
      this.sessions.delete(key);
      this.sessionLoadPromises.delete(key);
      await this.store.delete(profileId, sessionAgentId);
      this.sessionTombs.delete(key);
    });
  }

  private resolveTarget(
    snapshot: BrowserSessionSnapshot,
    operation: BrowserAutomationOperation,
    input: { tabId?: string; reuseExistingTab?: boolean },
    hostKind: BrowserHostKind,
  ): { tab?: BrowserTabSnapshot; failure?: BrowserAutomationFailure } {
    if (input.tabId) {
      const tab = snapshot.tabs.find((candidate) => candidate.tabId === input.tabId && resolveBrowserHostKind(candidate.hostKind) === hostKind);
      if (tab) return { tab };
      const owner = this.tabOwners.get(hostTabKey(hostKind, input.tabId));
      return {
        failure: owner && owner !== snapshot.sessionAgentId
          ? failure("tab-session-mismatch", "The requested browser tab belongs to another Forge session.", false)
          : failure("tab-not-found", "The requested browser tab does not exist in this Forge session.", false),
      };
    }

    const defaultId = snapshot.defaultTabId ?? snapshot.activeTabId;
    const defaultTab = defaultId ? snapshot.tabs.find((tab) => tab.tabId === defaultId && resolveBrowserHostKind(tab.hostKind) === hostKind) : undefined;
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
    hostKind: BrowserHostKind,
    options: { activate?: boolean } = {},
  ): void {
    if (operation === "open") {
      const tab = (result as BrowserAutomationResultByOperation["open"]).tab;
      this.upsertTab(snapshot, { ...tab, hostKind });
      if (options.activate !== false) {
        snapshot.activeTabId = tab.tabId;
        snapshot.defaultTabId = tab.tabId;
      } else {
        snapshot.defaultTabId ??= tab.tabId;
        snapshot.activeTabId ??= tab.tabId;
      }
      return;
    }
    if (operation === "navigate") this.upsertTab(snapshot, { ...(result as BrowserAutomationResultByOperation["navigate"]).tab, hostKind });
    if (operation === "status") {
      const selectedTab = (result as BrowserAutomationResultByOperation["status"]).selectedTab;
      if (selectedTab) this.upsertTab(snapshot, { ...selectedTab, hostKind });
    }
  }

  private isTabIdAvailable(snapshot: BrowserSessionSnapshot, tabId: string, hostKind: BrowserHostKind): boolean {
    const owner = this.tabOwners.get(hostTabKey(hostKind, tabId));
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
    const existing = snapshot.tabs.findIndex((candidate) => candidate.tabId === tab.tabId && resolveBrowserHostKind(candidate.hostKind) === resolveBrowserHostKind(tab.hostKind));
    if (existing >= 0) snapshot.tabs[existing] = { ...tab };
    else snapshot.tabs.push({ ...tab });
    this.tabOwners.set(hostTabKey(resolveBrowserHostKind(tab.hostKind), tab.tabId), snapshot.sessionAgentId);
    snapshot.defaultTabId ??= tab.tabId;
    snapshot.activeTabId ??= tab.tabId;
  }

  private indexTabs(snapshot: BrowserSessionSnapshot): void {
    for (const tab of snapshot.tabs) this.tabOwners.set(hostTabKey(resolveBrowserHostKind(tab.hostKind), tab.tabId), snapshot.sessionAgentId);
  }

  private async recordAction(
    snapshot: BrowserSessionSnapshot,
    action: BrowserSafeActionSummary,
    generation: number,
  ): Promise<void> {
    snapshot.recentActions.push(action);
    snapshot.recentActions = snapshot.recentActions.slice(-BROWSER_AUTOMATION_MAX_SAFE_ACTIONS);
    await this.persistChanged(snapshot, "automation", generation);
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
    generation: number,
  ): Promise<void> {
    const key = sessionKey(snapshot.profileId, snapshot.sessionAgentId);
    if (!this.isGenerationCurrent(key, generation) || this.sessionTombs.has(key)) {
      this.logDebug("browser-automation:suppressed-persist-after-delete", {
        sessionAgentId: snapshot.sessionAgentId,
        profileId: snapshot.profileId,
        reason,
      });
      return;
    }
    snapshot.revision += 1;
    snapshot.updatedAt = this.now();
    await this.store.save(snapshot);
    if (!this.isGenerationCurrent(key, generation) || this.sessionTombs.has(key)) {
      // Delete owns the final store.delete after draining this mutation chain.
      this.logDebug("browser-automation:suppressed-event-after-delete", {
        sessionAgentId: snapshot.sessionAgentId,
        profileId: snapshot.profileId,
        reason,
      });
      return;
    }
    this.onSessionChanged(cloneSnapshot(snapshot), reason);
  }

  private getGeneration(key: string): number {
    return this.sessionGenerations.get(key) ?? 0;
  }

  private bumpGeneration(key: string): number {
    const next = this.getGeneration(key) + 1;
    this.sessionGenerations.set(key, next);
    return next;
  }

  private isGenerationCurrent(key: string, generation: number): boolean {
    return this.getGeneration(key) === generation && !this.sessionTombs.has(key);
  }

  private assertMutable(key: string, generation: number): void {
    if (!this.isGenerationCurrent(key, generation)) {
      throw new Error("Browser session was deleted.");
    }
  }

  private trackInFlight<T>(key: string, work: () => Promise<T>): Promise<T> {
    const pending = work();
    let bucket = this.sessionInFlight.get(key);
    if (!bucket) {
      bucket = new Set();
      this.sessionInFlight.set(key, bucket);
    }
    bucket.add(pending);
    void pending.finally(() => {
      const current = this.sessionInFlight.get(key);
      if (!current) return;
      current.delete(pending);
      if (current.size === 0) this.sessionInFlight.delete(key);
    });
    return pending;
  }

  private async awaitInFlight(key: string): Promise<void> {
    for (;;) {
      const bucket = this.sessionInFlight.get(key);
      if (!bucket || bucket.size === 0) return;
      await Promise.allSettled([...bucket]);
    }
  }

  private async withSessionMutation<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.sessionMutationChains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.catch(() => undefined).then(() => gate);
    this.sessionMutationChains.set(key, chained);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.sessionMutationChains.get(key) === chained) {
        this.sessionMutationChains.delete(key);
      }
    }
  }
}

function isPanelRevealPending(snapshot: BrowserSessionSnapshot): boolean {
  const reveal = snapshot.panelReveal;
  return Boolean(reveal && reveal.tabId !== null && reveal.sequence > reveal.acknowledgedSequence);
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
  hostKind: BrowserHostKind,
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
        && typeof value.panelRevealRequested === "boolean"
        && typeof value.physicalTabVisible === "boolean"
        && value.panelVisible === value.physicalTabVisible
        && (value.selectedTab === null || (
          isValidTabForSession(value.selectedTab, snapshot, hostKind)
          && (expectedTabId === null || value.selectedTab.tabId === expectedTabId)
        ));
    case "open":
      return typeof value.created === "boolean"
        && typeof value.panelRevealRequested === "boolean"
        && isValidTabForSession(value.tab, snapshot, hostKind);
    case "navigate":
      return isValidTabForSession(value.tab, snapshot, hostKind)
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

function isValidTabForSession(value: unknown, snapshot: BrowserSessionSnapshot, hostKind: BrowserHostKind): value is BrowserTabSnapshot {
  if (!isRecord(value)) return false;
  return typeof value.tabId === "string"
    && resolveBrowserHostKind(value.hostKind as BrowserHostKind | undefined) === hostKind
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

function hostTabKey(hostKind: BrowserHostKind, tabId: string): string {
  return `${hostKind}\u0000${tabId}`;
}

function cloneSnapshot(snapshot: BrowserSessionSnapshot): BrowserSessionSnapshot {
  return structuredClone(snapshot);
}

/** Host-owned physical runtime fields only; identity/membership stay backend-owned. */
function mergeHostOwnedTabFields(canonical: BrowserTabSnapshot, reported: BrowserTabSnapshot): BrowserTabSnapshot {
  if (
    reported.tabId !== canonical.tabId
    || resolveBrowserHostKind(reported.hostKind) !== resolveBrowserHostKind(canonical.hostKind)
    || reported.sessionAgentId !== canonical.sessionAgentId
    || reported.profileId !== canonical.profileId
  ) {
    return canonical;
  }
  const merged: BrowserTabSnapshot = {
    ...canonical,
    url: reported.url,
    title: reported.title,
    lifecycle: reported.lifecycle,
    loading: reported.loading,
    live: reported.live,
    canGoBack: reported.canGoBack,
    canGoForward: reported.canGoForward,
    zoomFactor: reported.zoomFactor,
    controller: reported.controller,
    agentCursor: reported.agentCursor,
    recording: reported.recording,
    viewportSetting: reported.viewportSetting,
    renderedViewport: reported.renderedViewport,
    physicalVisible: reported.physicalVisible ?? false,
    error: reported.error,
    updatedAt: reported.updatedAt,
  };
  return JSON.stringify(merged) === JSON.stringify(canonical) ? canonical : merged;
}
