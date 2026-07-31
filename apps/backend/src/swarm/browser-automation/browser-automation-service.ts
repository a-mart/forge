import { isAbsolute, relative, resolve } from "node:path";
import {
  BROWSER_AUTOMATION_MAX_ELIGIBLE_TABS,
  BROWSER_AUTOMATION_MAX_SAFE_ACTIONS,
  BROWSER_AUTOMATION_MAX_URL_LENGTH,
  BROWSER_TARGET_AFFINITIES,
  EXTERNAL_CHROME_MAX_LABEL_LENGTH,
  type BrowserAutomationFailure,
  type BrowserAutomationInputByOperation,
  type BrowserAutomationOperation,
  type BrowserAutomationResponse,
  type BrowserAutomationResultByOperation,
  type BrowserHostConnectionSnapshot,
  type BrowserHostLifecycleReason,
  type BrowserHostLifecycleResponse,
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

export type BrowserLifecycleReleaseReason = Extract<BrowserHostLifecycleReason, "stop" | "archive" | "delete" | "host-replaced">;

export class BrowserLifecycleReleaseError extends Error {
  constructor(readonly failure: BrowserAutomationFailure) {
    super(`Browser lifecycle release failed (${failure.code}).`);
    this.name = "BrowserLifecycleReleaseError";
  }
}

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

/** Canonical logical browser state in front of one target-agnostic Desktop host. */
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
  private readonly sessionGenerations = new Map<string, number>();
  private readonly sessionTombs = new Set<string>();
  private readonly sessionMutationChains = new Map<string, Promise<void>>();
  private readonly sessionInFlight = new Map<string, Set<Promise<unknown>>>();
  private readonly lifecycleChains = new Map<string, Promise<void>>();
  private hostRegistrationChain: Promise<void> = Promise.resolve();

  constructor(options: BrowserAutomationServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.logDebug = options.logDebug ?? (() => undefined);
    this.broker = options.broker ?? new BrowserHostBroker({ ...options.brokerOptions, now: this.now, logDebug: this.logDebug });
    this.store = options.store ?? new BrowserSessionStore({ dataDir: options.dataDir, now: this.now, logDebug: this.logDebug });
    this.onSessionChanged = options.onSessionChanged ?? (() => undefined);
    this.onHostChanged = options.onHostChanged ?? (() => undefined);
  }

  registerHost(options: Parameters<BrowserHostBroker["register"]>[0]): BrowserHostConnectionSnapshot {
    const host = this.broker.register(options);
    this.onHostChanged(host);
    return host;
  }

  async registerHostWithLifecycleRelease(options: Parameters<BrowserHostBroker["register"]>[0] & {
    hydrateSessionsForReplacement?: () => Promise<BrowserSessionSnapshot[]>;
  }): Promise<BrowserHostConnectionSnapshot> {
    let result!: BrowserHostConnectionSnapshot;
    const previous = this.hostRegistrationChain;
    const next = previous.catch(() => undefined).then(async () => {
      await options.hydrateSessionsForReplacement?.();
      if (this.broker.getConnectionSnapshot().connected) {
        for (const snapshot of this.getLoadedSessionSnapshots()) {
          await this.releaseSessionForLifecycle(snapshot.profileId, snapshot.sessionAgentId, "host-replaced");
        }
      }
      result = this.registerHost(options);
    });
    this.hostRegistrationChain = next;
    try { await next; return result; } finally { if (this.hostRegistrationChain === next) this.hostRegistrationChain = Promise.resolve(); }
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

  acceptHostLifecycleResponse(connectionId: string, response: unknown): BrowserHostResponseDisposition {
    return this.broker.acceptLifecycleResponse(connectionId, response);
  }

  async invoke<Operation extends BrowserAutomationOperation>(
    sessionAgentId: string,
    profileId: string,
    operation: Operation,
    input: BrowserAutomationInputByOperation[Operation],
  ): Promise<BrowserAutomationInvocationResult<Operation>> {
    const key = sessionKey(profileId, sessionAgentId);
    const lifecycle = this.lifecycleChains.get(key);
    if (lifecycle) await lifecycle.catch(() => undefined);
    const generation = this.getGeneration(key);
    return this.trackInFlight(key, async () => {
      if (!this.isMutable(key, generation)) return cancelled(operation);
      const snapshot = await this.getSessionSnapshot(profileId, sessionAgentId);
      if (!this.isMutable(key, generation)) return cancelled(operation);
      const requestedTabId = (input as { tabId?: string }).tabId;
      // A tabless open is an explicit selection boundary owned by Desktop.
      // Subsequent operations still resolve the canonical selected tab here.
      const target = requestedTabId
        ? snapshot.tabs.find((tab) => tab.tabId === requestedTabId && tab.lifecycle !== "closed")
        : operation === "open"
          ? undefined
          : selectedTab(snapshot);
      // browser_open may adopt a canonical External Chrome inventory ID that is
      // intentionally not yet part of this Forge session's persisted tab set.
      if (requestedTabId && !target && operation !== "open") {
        const owner = this.tabOwners.get(requestedTabId);
        return { ok: false, operation, error: owner && owner !== sessionAgentId
          ? failure("tab-session-mismatch", "The requested browser tab belongs to another Forge session.", false)
          : failure("tab-not-found", "The requested browser tab does not exist in this Forge session.", false) };
      }

      if (operation === "status" && !this.broker.getConnectionSnapshot().connected) {
        return { ok: true, operation, result: {
          available: false,
          host: this.broker.getConnectionSnapshot(),
          panelVisible: false,
          panelRevealRequested: isPanelRevealPending(snapshot),
          physicalTabVisible: false,
          selectedTab: target ? publicTab(target) : null,
          eligibleTabs: [],
          eligibleTabsTruncated: false,
        } as unknown as BrowserAutomationResultByOperation[Operation] };
      }

      const actionId = crypto.randomUUID();
      const action: BrowserSafeActionSummary = {
        id: actionId, operation, tabId: target?.tabId ?? null, status: "running", startedAt: this.now(),
        ...(target?.targetAffinity !== "external-chrome" && target?.url ? { url: target.url } : {}),
        ...(target?.targetAffinity !== "external-chrome" && target?.title ? { title: target.title } : {}),
      };
      await this.withSessionMutation(key, async () => { if (this.isMutable(key, generation)) await this.recordAction(snapshot, action, generation); });
      if (!this.isMutable(key, generation)) return cancelled(operation);

      let response: BrowserAutomationResponse;
      try {
        response = await this.broker.request({
          sessionAgentId, profileId, tabId: target?.tabId ?? (operation === "open" ? requestedTabId ?? null : null), operation,
          input: input as Record<string, unknown>, timeoutMs: readTimeout(input),
          artifactDirectory: operation === "recordingStop" ? this.store.getArtifactsDirectory(profileId, sessionAgentId) : null,
        });
      } catch (error) {
        const problem = toFailure(error);
        await this.withSessionMutation(key, async () => {
          if (!this.isMutable(key, generation)) return;
          await this.completeAction(snapshot, actionId, problem.code === "control-interrupted" ? "interrupted" : "failed", { errorCode: problem.code });
          await this.persistChanged(snapshot, "automation", generation);
        });
        return { ok: false, operation, error: problem };
      }

      return this.withSessionMutation(key, async () => {
        if (!this.isMutable(key, generation)) return cancelled(operation);
        const returnedTab = response.updatedTab ? normalizeHostTab(response.updatedTab, snapshot) : undefined;
        if (response.updatedTab && (!returnedTab || !this.isTabIdAvailable(snapshot, returnedTab))) {
          return this.failMalformed(snapshot, actionId, operation, generation, response.elapsedMs, "Browser host returned invalid tab metadata.");
        }
        if (!response.ok) {
          await this.completeAction(snapshot, actionId, response.error.code === "control-interrupted" ? "interrupted" : "failed", { errorCode: response.error.code, elapsedMs: response.elapsedMs });
          await this.persistChanged(snapshot, "automation", generation);
          return { ok: false, operation, error: response.error };
        }

        const resultTabId = getResultTabId(response.result);
        const adopted = returnedTab ?? (resultTabId ? snapshot.tabs.find((tab) => tab.tabId === resultTabId) : undefined);
        if (!isValidSuccessResult(operation, response.result, target?.tabId ?? null, adopted)) {
          return this.failMalformed(snapshot, actionId, operation, generation, response.elapsedMs, "Browser host returned a malformed operation result.");
        }
        if (!target && resultNeedsTab(operation) && !adopted) {
          return this.failMalformed(snapshot, actionId, operation, generation, response.elapsedMs, "A tabless browser operation did not return an adopted target.");
        }
        if (operation === "recordingStop") {
          const artifactPath = (response.result as BrowserAutomationResultByOperation["recordingStop"]).path;
          if (!isPathBelow(this.store.getArtifactsDirectory(profileId, sessionAgentId), artifactPath)) {
            const invalid = failure("artifact-path-invalid", "Browser recording artifact is outside the canonical session directory.", false);
            await this.completeAction(snapshot, actionId, "failed", { errorCode: invalid.code, elapsedMs: response.elapsedMs });
            await this.persistChanged(snapshot, "automation", generation);
            return { ok: false, operation, error: invalid };
          }
        }

        this.applySuccessfulResult(snapshot, operation, response.result as BrowserAutomationResultByOperation[BrowserAutomationOperation], adopted);
        if (!target && adopted) {
          snapshot.activeTabId = adopted.tabId;
          snapshot.defaultTabId = adopted.tabId;
        }
        if (operation === "status") {
          const status = response.result as BrowserAutomationResultByOperation["status"];
          status.host = this.broker.getConnectionSnapshot();
          status.available = status.available && status.host.connected;
          status.panelRevealRequested = isPanelRevealPending(snapshot);
          if (status.selectedTab) status.selectedTab = publicTab(normalizeHostTab(status.selectedTab, snapshot) ?? status.selectedTab);
        }
        await this.completeAction(snapshot, actionId, "succeeded", { ...extractSafeCompletionMetadata(response.result, adopted?.targetAffinity), elapsedMs: response.elapsedMs });
        await this.persistChanged(snapshot, "automation", generation);
        if (operation === "open" && (input as BrowserAutomationInputByOperation["open"]).show && adopted) {
          const reveal = snapshot.panelReveal ?? { sequence: 0, acknowledgedSequence: 0, tabId: null };
          if (reveal.sequence >= Number.MAX_SAFE_INTEGER) throw new Error("Browser panel reveal sequence cannot be incremented safely.");
          snapshot.panelVisible = true;
          snapshot.panelReveal = { sequence: reveal.sequence + 1, acknowledgedSequence: reveal.acknowledgedSequence, tabId: adopted.tabId };
          await this.persistChanged(snapshot, "automation", generation);
        }
        return { ok: true, operation, result: response.result as BrowserAutomationResultByOperation[Operation] };
      });
    });
  }

  async getSessionSnapshot(profileId: string, sessionAgentId: string): Promise<BrowserSessionSnapshot> {
    const key = sessionKey(profileId, sessionAgentId);
    if (this.sessionTombs.has(key)) return this.store.createEmpty(profileId, sessionAgentId);
    const cached = this.sessions.get(key);
    if (cached) return cached;
    const pending = this.sessionLoadPromises.get(key);
    if (pending) return pending;
    const generation = this.getGeneration(key);
    const load = this.store.load(profileId, sessionAgentId).then((snapshot) => {
      this.sessionLoadPromises.delete(key);
      if (this.isMutable(key, generation)) { this.sessions.set(key, snapshot); this.indexTabs(snapshot); }
      return snapshot;
    }, (error) => { this.sessionLoadPromises.delete(key); throw error; });
    this.sessionLoadPromises.set(key, load);
    return load;
  }

  getLoadedSessionSnapshots(): BrowserSessionSnapshot[] { return [...this.sessions.values()].map(cloneSnapshot); }
  async getHostHydrationSnapshot(profileId: string, sessionAgentId: string): Promise<BrowserSessionSnapshot> {
    return cloneSnapshot(await this.getSessionSnapshot(profileId, sessionAgentId));
  }

  async reportHostState(connectionId: string, hostId: string, hostGeneration: number, reports: BrowserHostSessionStateReport[]): Promise<BrowserHostStateReportResult> {
    if (!this.broker.isCurrentConnection(connectionId, hostId, hostGeneration)) return { hostId, hostGeneration, status: "stale-host-generation", sessions: [] };
    const sessions: BrowserHostSessionStateReportResult[] = [];
    for (const report of reports) {
      const base = { sessionAgentId: report.sessionAgentId, profileId: report.profileId };
      if (!Number.isInteger(report.baseRevision) || report.baseRevision < 0 || !Array.isArray(report.tabs)) {
        sessions.push({ ...base, status: "rejected", reason: "invalid-report" }); continue;
      }
      const key = sessionKey(report.profileId, report.sessionAgentId);
      if (this.sessionTombs.has(key)) { sessions.push({ ...base, status: "rejected", reason: "session-unavailable" }); continue; }
      const canonical = await this.getSessionSnapshot(report.profileId, report.sessionAgentId);
      if (canonical.hostingState !== "hosted") { sessions.push({ ...base, status: "rejected", reason: "session-unavailable", snapshot: cloneSnapshot(canonical) }); continue; }
      if (canonical.revision !== report.baseRevision) { sessions.push({ ...base, status: "revision-conflict", snapshot: cloneSnapshot(canonical) }); continue; }
      const normalized = report.tabs.map((tab) => normalizeHostTab(tab, canonical));
      if (normalized.some((tab) => !tab || !canonical.tabs.some((existing) => existing.tabId === tab.tabId))) {
        sessions.push({ ...base, status: "rejected", reason: "tab-unavailable", snapshot: cloneSnapshot(canonical) }); continue;
      }
      let changed = false;
      for (const tab of normalized as BrowserTabSnapshot[]) {
        const index = canonical.tabs.findIndex((existing) => existing.tabId === tab.tabId);
        const merged = mergeHostOwnedTabFields(canonical.tabs[index]!, tab);
        if (merged !== canonical.tabs[index]) { canonical.tabs[index] = merged; changed = true; }
      }
      if (changed) await this.persistChanged(canonical, "host-report", this.getGeneration(key));
      sessions.push({ ...base, status: "accepted", snapshot: cloneSnapshot(canonical) });
    }
    return { hostId, hostGeneration, status: "processed", sessions };
  }

  async acknowledgePanelReveal(profileId: string, sessionAgentId: string, tabId: string, sequence: number): Promise<BrowserSessionSnapshot> {
    return this.mutate(profileId, sessionAgentId, async (snapshot, generation) => {
      const reveal = snapshot.panelReveal ?? { sequence: 0, acknowledgedSequence: 0, tabId: null };
      if (sequence <= reveal.acknowledgedSequence) return;
      if (sequence !== reveal.sequence || tabId !== reveal.tabId) throw new Error("Browser panel reveal acknowledgement does not match the pending intent.");
      snapshot.panelReveal = { ...reveal, acknowledgedSequence: sequence };
      await this.persistChanged(snapshot, "host-report", generation);
    });
  }

  async activateTab(profileId: string, sessionAgentId: string, tabId: string): Promise<BrowserSessionSnapshot> {
    return this.mutate(profileId, sessionAgentId, async (snapshot, generation) => {
      if (!snapshot.tabs.some((tab) => tab.tabId === tabId && tab.lifecycle !== "closed")) throw new Error("Browser tab was not found in the selected Forge session.");
      snapshot.activeTabId = tabId; snapshot.defaultTabId = tabId; snapshot.panelVisible = true;
      await this.persistChanged(snapshot, "human-command", generation);
    });
  }

  async closeTab(profileId: string, sessionAgentId: string, tabId: string): Promise<BrowserSessionSnapshot> {
    return this.mutate(profileId, sessionAgentId, async (snapshot, generation) => {
      const existing = snapshot.tabs.find((tab) => tab.tabId === tabId && tab.lifecycle !== "closed");
      if (!existing) throw new Error("Browser tab was not found in the selected Forge session.");
      snapshot.tabs = snapshot.tabs.filter((tab) => tab !== existing); this.tabOwners.delete(tabId);
      if (snapshot.panelReveal?.tabId === tabId) snapshot.panelReveal = { ...snapshot.panelReveal, acknowledgedSequence: snapshot.panelReveal.sequence, tabId: null };
      const fallback = snapshot.tabs.find((tab) => tab.lifecycle !== "closed")?.tabId ?? null;
      if (snapshot.activeTabId === tabId) snapshot.activeTabId = fallback;
      if (snapshot.defaultTabId === tabId) snapshot.defaultTabId = snapshot.activeTabId ?? fallback;
      await this.persistChanged(snapshot, "human-command", generation);
    });
  }

  async setTabSelection(profileId: string, sessionAgentId: string, activeTabId: string | null, defaultTabId: string | null): Promise<BrowserSessionSnapshot> {
    return this.mutate(profileId, sessionAgentId, async (snapshot, generation) => {
      const ids = new Set(snapshot.tabs.filter((tab) => tab.lifecycle !== "closed").map((tab) => tab.tabId));
      if (activeTabId !== null && !ids.has(activeTabId)) throw new Error("Active browser tab is missing");
      if (defaultTabId !== null && !ids.has(defaultTabId)) throw new Error("Default browser tab is missing");
      snapshot.activeTabId = activeTabId; snapshot.defaultTabId = defaultTabId;
      await this.persistChanged(snapshot, "human-command", generation);
    });
  }

  cancelSession(sessionAgentId: string): number { return this.broker.cancelSession(sessionAgentId); }

  async endBrowserTurn(profileId: string, sessionAgentId: string, turnId: string): Promise<void> {
    await this.runLifecycle(profileId, sessionAgentId, { kind: "turn-ended", turnId });
  }

  async releaseSessionForLifecycle(profileId: string, sessionAgentId: string, reason: BrowserLifecycleReleaseReason): Promise<void> {
    this.cancelSession(sessionAgentId);
    await this.runLifecycle(profileId, sessionAgentId, { kind: "release-session", reason });
  }

  async archiveSession(profileId: string, sessionAgentId: string): Promise<BrowserSessionSnapshot> {
    return this.mutate(profileId, sessionAgentId, async (snapshot, generation) => {
      snapshot.hostingState = "unhosted"; snapshot.panelVisible = false; clearPanelReveal(snapshot);
      snapshot.tabs = snapshot.tabs.map((tab) => ({ ...tab, live: false, physicalVisible: false, renderedViewport: null, controller: "none", recording: null, updatedAt: this.now() }));
      await this.persistChanged(snapshot, "lifecycle", generation);
    });
  }

  async restoreSession(profileId: string, sessionAgentId: string): Promise<BrowserSessionSnapshot> {
    return this.mutate(profileId, sessionAgentId, async (snapshot, generation) => {
      snapshot.hostingState = "hosted";
      snapshot.tabs = snapshot.tabs.map((tab) => ({ ...tab, live: false, physicalVisible: false, renderedViewport: null, lifecycle: tab.lifecycle === "closed" ? "closed" : "restoring", controller: "none", updatedAt: this.now() }));
      await this.persistChanged(snapshot, "recovery", generation);
    });
  }

  async deleteSession(profileId: string, sessionAgentId: string): Promise<void> {
    const key = sessionKey(profileId, sessionAgentId);
    this.bumpGeneration(key); this.sessionTombs.add(key); this.broker.cancelSession(sessionAgentId);
    await this.awaitInFlight(key);
    await this.withSessionMutation(key, async () => {
      const snapshot = this.sessions.get(key);
      if (snapshot) for (const tab of snapshot.tabs) this.tabOwners.delete(tab.tabId);
      this.sessions.delete(key); this.sessionLoadPromises.delete(key);
      await this.store.delete(profileId, sessionAgentId);
      this.sessionTombs.delete(key);
    });
  }

  private async runLifecycle(profileId: string, sessionAgentId: string, request: { kind: "turn-ended"; turnId: string } | { kind: "release-session"; reason: BrowserLifecycleReleaseReason }): Promise<void> {
    const key = sessionKey(profileId, sessionAgentId);
    const previous = this.lifecycleChains.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      await this.awaitInFlight(key);
      const generation = this.getGeneration(key);
      const snapshot = await this.getSessionSnapshot(profileId, sessionAgentId);
      this.assertMutable(key, generation);
      // Untouched/ineligible sessions have no Desktop browser authority to release.
      if (snapshot.tabs.length === 0 && snapshot.recentActions.length === 0) return;
      const host = this.broker.getConnectionSnapshot();
      if (!host.connected || !host.hostId || host.hostGeneration === null) {
        if (snapshot.tabs.length === 0) return;
        throw new BrowserLifecycleReleaseError(failure("unavailable-host", "Automatic Browser Host is unavailable for lifecycle cleanup.", true));
      }
      const matching = snapshot.hostCleanup?.kind === request.kind
        && snapshot.hostCleanup.hostId === host.hostId
        && snapshot.hostCleanup.hostGeneration === host.hostGeneration
        && (request.kind === "turn-ended" ? snapshot.hostCleanup.turnId === request.turnId : snapshot.hostCleanup.reason === request.reason);
      if (matching && snapshot.hostCleanup?.phase === "acknowledged") return;
      const transaction = matching ? snapshot.hostCleanup! : {
        requestId: crypto.randomUUID(), ...request, hostId: host.hostId, hostGeneration: host.hostGeneration, phase: "pending" as const,
      };
      if (!matching || snapshot.hostCleanup?.phase !== "pending") {
        snapshot.hostCleanup = transaction;
        await this.persistChanged(snapshot, "lifecycle", generation);
      }
      let response: BrowserHostLifecycleResponse;
      try {
        response = await this.broker.requestLifecycle({ ...request, sessionAgentId, profileId, requestId: transaction.requestId,
          expectedHost: { hostId: transaction.hostId, hostGeneration: transaction.hostGeneration }, timeoutMs: 15_000 });
      } catch (error) {
        throw new BrowserLifecycleReleaseError(toFailure(error));
      }
      if (!response.ok) throw new BrowserLifecycleReleaseError(response.error);
      if (snapshot.hostCleanup?.requestId !== transaction.requestId) throw new BrowserLifecycleReleaseError(failure("malformed-response", "Browser lifecycle authority changed before acknowledgement.", false));
      snapshot.hostCleanup = { ...transaction, phase: "acknowledged" };
      await this.persistChanged(snapshot, "lifecycle", generation);
    });
    this.lifecycleChains.set(key, current);
    try { await current; } finally { if (this.lifecycleChains.get(key) === current) this.lifecycleChains.delete(key); }
  }

  private applySuccessfulResult(snapshot: BrowserSessionSnapshot, operation: BrowserAutomationOperation, result: BrowserAutomationResultByOperation[BrowserAutomationOperation], adopted?: BrowserTabSnapshot): void {
    if (adopted) this.upsertTab(snapshot, adopted);
    if (operation === "open") {
      const tabId = (result as BrowserAutomationResultByOperation["open"]).tab.tabId;
      snapshot.activeTabId = tabId; snapshot.defaultTabId = tabId;
    } else if (operation === "navigate") {
      const tabId = (result as BrowserAutomationResultByOperation["navigate"]).tab.tabId;
      snapshot.activeTabId ??= tabId; snapshot.defaultTabId ??= tabId;
    } else if (operation === "status") {
      const selected = (result as BrowserAutomationResultByOperation["status"]).selectedTab;
      if (selected) { snapshot.activeTabId = selected.tabId; snapshot.defaultTabId ??= selected.tabId; }
    }
  }

  private isTabIdAvailable(snapshot: BrowserSessionSnapshot, tab: BrowserTabSnapshot): boolean {
    if (tab.targetAffinity === "external-chrome") return decodeCanonicalExternalTabId(tab.tabId) !== null;
    const owner = this.tabOwners.get(tab.tabId); return owner === undefined || owner === snapshot.sessionAgentId;
  }
  private upsertTab(snapshot: BrowserSessionSnapshot, tab: BrowserTabSnapshot): void {
    const index = snapshot.tabs.findIndex((candidate) => candidate.tabId === tab.tabId);
    if (index >= 0) snapshot.tabs[index] = publicTab(tab); else snapshot.tabs.push(publicTab(tab));
    if (tab.targetAffinity !== "external-chrome") this.tabOwners.set(tab.tabId, snapshot.sessionAgentId);
  }
  private indexTabs(snapshot: BrowserSessionSnapshot): void {
    for (const tab of snapshot.tabs) if (tab.targetAffinity !== "external-chrome") this.tabOwners.set(tab.tabId, snapshot.sessionAgentId);
  }

  private async failMalformed<Operation extends BrowserAutomationOperation>(snapshot: BrowserSessionSnapshot, actionId: string, operation: Operation, generation: number, elapsedMs: number, message: string): Promise<BrowserAutomationInvocationResult<Operation>> {
    const malformed = failure("malformed-response", message, false);
    await this.completeAction(snapshot, actionId, "failed", { errorCode: malformed.code, elapsedMs });
    await this.persistChanged(snapshot, "automation", generation);
    return { ok: false, operation, error: malformed };
  }

  private async mutate(profileId: string, sessionAgentId: string, work: (snapshot: BrowserSessionSnapshot, generation: number) => Promise<void>): Promise<BrowserSessionSnapshot> {
    const key = sessionKey(profileId, sessionAgentId); const generation = this.getGeneration(key);
    return this.withSessionMutation(key, async () => {
      this.assertMutable(key, generation); const snapshot = await this.getSessionSnapshot(profileId, sessionAgentId); this.assertMutable(key, generation);
      await work(snapshot, generation); return cloneSnapshot(snapshot);
    });
  }
  private async recordAction(snapshot: BrowserSessionSnapshot, action: BrowserSafeActionSummary, generation: number): Promise<void> {
    snapshot.recentActions.push(action); snapshot.recentActions = snapshot.recentActions.slice(-BROWSER_AUTOMATION_MAX_SAFE_ACTIONS); await this.persistChanged(snapshot, "automation", generation);
  }
  private async completeAction(snapshot: BrowserSessionSnapshot, id: string, status: BrowserSafeActionSummary["status"], metadata: Partial<BrowserSafeActionSummary>): Promise<void> {
    const action = snapshot.recentActions.find((candidate) => candidate.id === id); if (action) Object.assign(action, metadata, { status, completedAt: this.now() });
  }
  private async persistChanged(snapshot: BrowserSessionSnapshot, reason: Parameters<NonNullable<BrowserAutomationServiceOptions["onSessionChanged"]>>[1], generation: number): Promise<void> {
    const key = sessionKey(snapshot.profileId, snapshot.sessionAgentId); this.assertMutable(key, generation);
    snapshot.revision += 1; snapshot.updatedAt = this.now(); await this.store.save(snapshot); this.assertMutable(key, generation); this.onSessionChanged(cloneSnapshot(snapshot), reason);
  }
  private async withSessionMutation<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.sessionMutationChains.get(key) ?? Promise.resolve(); let release!: () => void;
    const barrier = new Promise<void>((resolveBarrier) => { release = resolveBarrier; });
    const chain = previous.catch(() => undefined).then(() => barrier);
    this.sessionMutationChains.set(key, chain);
    await previous.catch(() => undefined); try { return await work(); } finally { release(); if (this.sessionMutationChains.get(key) === chain) this.sessionMutationChains.delete(key); }
  }
  private trackInFlight<T>(key: string, work: () => Promise<T>): Promise<T> {
    const promise = work(); const set = this.sessionInFlight.get(key) ?? new Set(); set.add(promise); this.sessionInFlight.set(key, set);
    void promise.finally(() => { set.delete(promise); if (set.size === 0) this.sessionInFlight.delete(key); }).catch(() => undefined); return promise;
  }
  private async awaitInFlight(key: string): Promise<void> { const set = this.sessionInFlight.get(key); if (set) await Promise.allSettled([...set]); }
  private getGeneration(key: string): number { return this.sessionGenerations.get(key) ?? 0; }
  private bumpGeneration(key: string): void { this.sessionGenerations.set(key, this.getGeneration(key) + 1); }
  private isMutable(key: string, generation: number): boolean { return this.getGeneration(key) === generation && !this.sessionTombs.has(key); }
  private assertMutable(key: string, generation: number): void { if (!this.isMutable(key, generation)) throw new Error("Browser session is unavailable."); }
}

function normalizeHostTab(tab: BrowserTabSnapshot, snapshot: BrowserSessionSnapshot): BrowserTabSnapshot | undefined {
  if (tab.sessionAgentId !== snapshot.sessionAgentId || tab.profileId !== snapshot.profileId) return undefined;
  if (!(BROWSER_TARGET_AFFINITIES as readonly unknown[]).includes(tab.targetAffinity)) return undefined;
  return tab.targetAffinity === "external-chrome" ? { ...tab, url: "", title: "", error: null } : { ...tab };
}
function publicTab(tab: BrowserTabSnapshot): BrowserTabSnapshot { return { ...tab }; }
function selectedTab(snapshot: BrowserSessionSnapshot): BrowserTabSnapshot | undefined {
  const id = snapshot.defaultTabId ?? snapshot.activeTabId; return id ? snapshot.tabs.find((tab) => tab.tabId === id && tab.lifecycle !== "closed") : undefined;
}
function resultNeedsTab(operation: BrowserAutomationOperation): boolean { return operation !== "status"; }
function getResultTabId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.tabId === "string") return value.tabId;
  if (isRecord(value.tab) && typeof value.tab.tabId === "string") return value.tab.tabId;
  if (isRecord(value.selectedTab) && typeof value.selectedTab.tabId === "string") return value.selectedTab.tabId;
  return null;
}
function isValidSuccessResult(operation: BrowserAutomationOperation, value: unknown, expectedTabId: string | null, adopted?: BrowserTabSnapshot): boolean {
  if (!isRecord(value)) return false;
  const id = getResultTabId(value);
  if (operation === "status") return typeof value.available === "boolean" && (value.selectedTab === null || id !== null)
    && (!id || adopted?.tabId === id) && validEligibleInventory(value);
  if (operation === "open" || operation === "navigate") return isRecord(value.tab) && typeof value.tab.tabId === "string" && adopted?.tabId === value.tab.tabId;
  if (id === null) return false;
  return (expectedTabId === null || id === expectedTabId || adopted?.tabId === id) && !!adopted;
}
function validEligibleInventory(value: Record<string, unknown>): boolean {
  if (!Array.isArray(value.eligibleTabs) || value.eligibleTabs.length > BROWSER_AUTOMATION_MAX_ELIGIBLE_TABS
    || typeof value.eligibleTabsTruncated !== "boolean") return false;
  const ids = new Set<string>();
  for (const candidate of value.eligibleTabs) {
    if (!isRecord(candidate) || candidate.targetAffinity !== "external-chrome"
      || typeof candidate.tabId !== "string" || candidate.tabId.length < 1 || candidate.tabId.length > 128
      || typeof candidate.browserProfileId !== "string" || candidate.browserProfileId.length < 1 || candidate.browserProfileId.length > 128
      || typeof candidate.windowId !== "string" || candidate.windowId.length < 1 || candidate.windowId.length > 128
      || typeof candidate.title !== "string" || candidate.title.length > EXTERNAL_CHROME_MAX_LABEL_LENGTH
      || typeof candidate.url !== "string" || candidate.url.length < 1 || candidate.url.length > BROWSER_AUTOMATION_MAX_URL_LENGTH
      || typeof candidate.active !== "boolean" || typeof candidate.windowFocused !== "boolean"
      || typeof candidate.lastAccessedAt !== "string" || !isCanonicalTimestamp(candidate.lastAccessedAt)
      || ids.has(candidate.tabId)) return false;
    const canonical = decodeCanonicalExternalTabId(candidate.tabId);
    const windowMatch = /^ext-window\.([A-Za-z0-9_-]{1,64})\.([0-9]+)$/u.exec(candidate.windowId);
    if (!canonical || candidate.browserProfileId !== `ext-profile.${canonical.extensionInstanceId}`
      || !windowMatch || windowMatch[1] !== canonical.extensionInstanceId
      || !Number.isSafeInteger(Number(windowMatch[2]))) return false;
    ids.add(candidate.tabId);
  }
  return true;
}
function isCanonicalTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
function decodeCanonicalExternalTabId(value: string): { extensionInstanceId: string; tabId: number } | null {
  const match = /^ext\.([A-Za-z0-9_-]{1,64})\.([0-9]+)$/u.exec(value);
  if (!match) return null;
  const tabId = Number(match[2]);
  return Number.isSafeInteger(tabId) ? { extensionInstanceId: match[1]!, tabId } : null;
}
function extractSafeCompletionMetadata(result: unknown, affinity?: BrowserTabSnapshot["targetAffinity"]): Partial<BrowserSafeActionSummary> {
  if (!isRecord(result)) return {};
  const resultTab = isRecord(result.tab) ? result.tab : undefined;
  const persistIdentity = affinity !== "external-chrome";
  return {
    ...(persistIdentity && typeof result.url === "string" ? { url: result.url } : {}),
    ...(persistIdentity && typeof result.title === "string" ? { title: result.title } : {}),
    ...(persistIdentity && resultTab && typeof resultTab.url === "string" ? { url: resultTab.url } : {}),
    ...(persistIdentity && resultTab && typeof resultTab.title === "string" ? { title: resultTab.title } : {}),
    ...(typeof result.path === "string" ? { artifactPath: result.path } : {}),
    ...(isRecord(result.viewport) && typeof result.viewport.width === "number" && typeof result.viewport.height === "number" ? { dimensions: { width: result.viewport.width, height: result.viewport.height } } : {}),
  };
}
function mergeHostOwnedTabFields(canonical: BrowserTabSnapshot, reported: BrowserTabSnapshot): BrowserTabSnapshot {
  const merged = { ...canonical, lifecycle: reported.lifecycle, loading: reported.loading, live: reported.live, canGoBack: reported.canGoBack,
    canGoForward: reported.canGoForward, zoomFactor: reported.zoomFactor, controller: reported.controller, agentCursor: reported.agentCursor,
    recording: reported.recording, viewportSetting: reported.viewportSetting, renderedViewport: reported.renderedViewport,
    physicalVisible: reported.physicalVisible, error: reported.targetAffinity === "external-chrome" ? null : reported.error,
    url: reported.targetAffinity === "external-chrome" ? "" : reported.url, title: reported.targetAffinity === "external-chrome" ? "" : reported.title, updatedAt: reported.updatedAt };
  return JSON.stringify(merged) === JSON.stringify(canonical) ? canonical : merged;
}
function isPanelRevealPending(snapshot: BrowserSessionSnapshot): boolean { return !!snapshot.panelReveal && snapshot.panelReveal.sequence > snapshot.panelReveal.acknowledgedSequence; }
function clearPanelReveal(snapshot: BrowserSessionSnapshot): void { if (snapshot.panelReveal) snapshot.panelReveal = { ...snapshot.panelReveal, acknowledgedSequence: snapshot.panelReveal.sequence, tabId: null }; }
function sessionKey(profileId: string, sessionAgentId: string): string { return `${profileId}\u0000${sessionAgentId}`; }
function readTimeout(input: unknown): number | undefined { return isRecord(input) && typeof input.timeoutMs === "number" ? input.timeoutMs : undefined; }
function failure(code: BrowserAutomationFailure["code"], message: string, retryable: boolean): BrowserAutomationFailure { return { code, message, retryable }; }
function toFailure(error: unknown): BrowserAutomationFailure { return error instanceof BrowserAutomationBrokerError ? error.failure : failure("execution-failed", error instanceof Error ? error.message : String(error), false); }
function cancelled<Operation extends BrowserAutomationOperation>(operation: Operation): BrowserAutomationInvocationResult<Operation> { return { ok: false, operation, error: failure("request-cancelled", "Browser session was deleted.", true) }; }
function cloneSnapshot(snapshot: BrowserSessionSnapshot): BrowserSessionSnapshot { return JSON.parse(JSON.stringify(snapshot)) as BrowserSessionSnapshot; }
function isPathBelow(parent: string, candidate: string): boolean { if (!isAbsolute(candidate)) return false; const rel = relative(resolve(parent), resolve(candidate)); return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel); }
function isRecord(value: unknown): value is Record<string, any> { return !!value && typeof value === "object" && !Array.isArray(value); }
