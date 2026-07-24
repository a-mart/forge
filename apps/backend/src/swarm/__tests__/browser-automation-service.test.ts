import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BrowserAutomationRequest,
  BrowserAutomationResponse,
  BrowserHostRegistration,
  BrowserTabSnapshot,
} from "@forge/protocol";
import { BrowserAutomationService } from "../browser-automation/browser-automation-service.js";

const roots: string[] = [];
const timestamp = "2026-07-22T12:00:00.000Z";

async function createService(): Promise<{ dataDir: string; service: BrowserAutomationService }> {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-browser-service-"));
  roots.push(dataDir);
  return { dataDir, service: new BrowserAutomationService({ dataDir, now: () => timestamp }) };
}

function registration(): BrowserHostRegistration {
  return {
    hostId: "host-1",
    clientInstanceId: "client-1",
    registeredAt: timestamp,
    capabilities: {
      supportedOperations: ["status", "open", "evaluate", "recordingStop"],
      electronVersion: "37.10.3",
      chromiumVersion: "138",
      playwrightVersion: "1.60.0",
      maxResponseBytes: 1_000_000,
      supportsSandboxedWebviews: true,
      supportsCapturePage: true,
      supportsRecording: true,
    },
  };
}

function tab(sessionAgentId = "manager-1", profileId = "profile-1", tabId = "tab-1"): BrowserTabSnapshot {
  return {
    tabId,
    sessionAgentId,
    profileId,
    url: "https://example.com/",
    title: "Example",
    lifecycle: "ready",
    loading: false,
    live: true,
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1,
    controller: "none",
    agentCursor: null,
    recording: null,
    viewportSetting: { mode: "fill" },
    renderedViewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function response(request: BrowserAutomationRequest): BrowserAutomationResponse {
  const base = {
    requestId: request.requestId,
    hostKind: request.hostKind,
    sessionAgentId: request.sessionAgentId,
    profileId: request.profileId,
    tabId: request.tabId,
    hostId: request.hostId,
    hostGeneration: request.hostGeneration,
    elapsedMs: 5,
  };
  if (request.operation === "open") {
    return {
      ...base,
      operation: "open",
      ok: true,
      result: { tab: { ...tab(request.sessionAgentId, request.profileId), hostKind: request.hostKind }, created: true, panelRevealRequested: true },
    };
  }
  if (request.operation === "evaluate") {
    return {
      ...base,
      operation: "evaluate",
      ok: true,
      result: { tabId: request.tabId!, value: "SECRET_RESULT", serializedBytes: 13 },
    };
  }
  return {
    ...base,
    operation: "status",
    ok: true,
    result: {
      available: true,
      host: {
        connected: true,
        hostId: request.hostId,
        hostGeneration: request.hostGeneration,
        focused: false,
        capabilities: registration().capabilities,
        connectedAt: timestamp,
      },
      panelVisible: false,
      panelRevealRequested: false,
      physicalTabVisible: false,
      selectedTab: null,
    },
  };
}

function connect(service: BrowserAutomationService, requests: BrowserAutomationRequest[]): void {
  service.registerHost({
    connectionId: "socket-1",
    registration: registration(),
    sendRequest(request) {
      requests.push(request);
      queueMicrotask(() => service.acceptHostResponse("socket-1", response(request)));
    },
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("BrowserAutomationService", () => {
  it("returns unavailable status, then owns default-tab affinity across calls and restart", async () => {
    const { dataDir, service } = await createService();
    await expect(service.invoke("manager-1", "profile-1", "status", {})).resolves.toMatchObject({
      ok: true,
      result: { available: false, selectedTab: null },
    });

    const requests: BrowserAutomationRequest[] = [];
    connect(service, requests);
    await expect(service.invoke("manager-1", "profile-1", "open", {
      show: true,
      reuseExistingTab: true,
    })).resolves.toMatchObject({ ok: true, result: { tab: { tabId: "tab-1" } } });
    await expect(service.invoke("manager-1", "profile-1", "evaluate", {
      expression: "document.title",
      awaitPromise: true,
      returnByValue: true,
    })).resolves.toMatchObject({ ok: true, result: { value: "SECRET_RESULT" } });
    expect(requests[1]).toMatchObject({ tabId: "tab-1", operation: "evaluate" });

    const restarted = new BrowserAutomationService({ dataDir, now: () => timestamp });
    await expect(restarted.getSessionSnapshot("profile-1", "manager-1")).resolves.toMatchObject({
      defaultTabId: "tab-1",
      activeTabId: "tab-1",
      panelReveal: { sequence: 1, acknowledgedSequence: 0, tabId: "tab-1" },
      recentActions: expect.arrayContaining([expect.objectContaining({ operation: "evaluate", status: "succeeded" })]),
    });
    await expect(restarted.acknowledgePanelReveal("profile-1", "manager-1", "tab-1", 1)).resolves.toMatchObject({
      panelReveal: { sequence: 1, acknowledgedSequence: 1, tabId: "tab-1" },
    });
    const afterAcknowledgement = new BrowserAutomationService({ dataDir, now: () => timestamp });
    await expect(afterAcknowledgement.getSessionSnapshot("profile-1", "manager-1")).resolves.toMatchObject({
      panelReveal: { sequence: 1, acknowledgedSequence: 1 },
    });
    const persisted = await readFile(restarted.store.getStatePath("profile-1", "manager-1"), "utf8");
    expect(persisted).not.toContain("document.title");
    expect(persisted).not.toContain("SECRET_RESULT");
  });

  it("persists an explicit External Chrome selection and uses it as the session default", async () => {
    const { dataDir, service } = await createService();
    const requests: BrowserAutomationRequest[] = [];
    service.registerHost({
      connectionId: "external-socket",
      registration: {
        ...registration(),
        hostId: "external-host",
        capabilities: {
          ...registration().capabilities,
          hostKind: "external-chrome",
          supportedOperations: ["status", "open", "evaluate"],
          supportsRecording: false,
        },
      },
      sendRequest(request) {
        requests.push(request);
        queueMicrotask(() => service.acceptHostResponse("external-socket", response(request)));
      },
    });

    await expect(service.invoke("manager-1", "profile-1", "open", {
      hostKind: "external-chrome", show: false, reuseExistingTab: false,
    })).resolves.toMatchObject({ ok: true });
    await expect(service.invoke("manager-1", "profile-1", "evaluate", {
      expression: "1 + 1", awaitPromise: true, returnByValue: true,
    })).resolves.toMatchObject({ ok: true });
    expect(requests.map((request) => request.hostKind)).toEqual(["external-chrome", "external-chrome"]);

    const restarted = new BrowserAutomationService({ dataDir, now: () => timestamp });
    await expect(restarted.getSessionSnapshot("profile-1", "manager-1")).resolves.toMatchObject({
      hostKind: "external-chrome",
      tabs: [expect.objectContaining({ hostKind: "external-chrome" })],
    });
  });

  it("enforces explicit tab ownership across loaded sessions", async () => {
    const { service } = await createService();
    const first = service.store.createEmpty("profile-1", "manager-1");
    first.tabs = [tab()];
    first.defaultTabId = "tab-1";
    first.activeTabId = "tab-1";
    await service.store.save(first);
    const second = service.store.createEmpty("profile-1", "manager-2");
    await service.store.save(second);
    await service.getSessionSnapshot("profile-1", "manager-1");
    await service.getSessionSnapshot("profile-1", "manager-2");

    await expect(service.invoke("manager-2", "profile-1", "evaluate", {
      tabId: "tab-1",
      expression: "1",
      awaitPromise: true,
      returnByValue: true,
    })).resolves.toMatchObject({ ok: false, error: { code: "tab-session-mismatch" } });
  });

  it("persists and publishes a terminal action when the broker rejects a request", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-browser-service-"));
    roots.push(dataDir);
    const changes: Array<{ reason: string; status: string | undefined }> = [];
    const service = new BrowserAutomationService({
      dataDir,
      now: () => timestamp,
      onSessionChanged: (snapshot, reason) => {
        changes.push({ reason, status: snapshot.recentActions.at(-1)?.status });
      },
    });
    const state = service.store.createEmpty("profile-1", "manager-1");
    state.tabs = [tab()];
    state.defaultTabId = "tab-1";
    state.activeTabId = "tab-1";
    await service.store.save(state);

    await expect(service.invoke("manager-1", "profile-1", "evaluate", {
      expression: "document.title",
      awaitPromise: true,
      returnByValue: true,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "unavailable-host" },
    });

    expect(changes).toEqual([
      { reason: "automation", status: "running" },
      { reason: "automation", status: "failed" },
    ]);
    const restarted = new BrowserAutomationService({ dataDir, now: () => timestamp });
    await expect(restarted.getSessionSnapshot("profile-1", "manager-1")).resolves.toMatchObject({
      recentActions: [expect.objectContaining({
        operation: "evaluate",
        status: "failed",
        errorCode: "unavailable-host",
        completedAt: timestamp,
      })],
    });
  });

  it("keeps backend action history authoritative when the host reports physical tab state", async () => {
    const { service } = await createService();
    const state = service.store.createEmpty("profile-1", "manager-1");
    state.tabs = [tab()];
    state.defaultTabId = "tab-1";
    state.activeTabId = "tab-1";
    state.revision = 3;
    state.recentActions = [{
      id: "action-1",
      operation: "evaluate",
      tabId: "tab-1",
      status: "succeeded",
      startedAt: timestamp,
      completedAt: timestamp,
    }];
    await service.store.save(state);
    service.registerHost({
      connectionId: "socket-1",
      registration: registration(),
      sendRequest: () => undefined,
    });
    const reportedTab = { ...tab(), title: "Renderer title", loading: true };

    await expect(service.reportHostState("socket-1", "host-1", 1, [{
      sessionAgentId: "manager-1",
      profileId: "profile-1",
      baseRevision: 3,
      tabs: [reportedTab],
    }])).resolves.toMatchObject({
      status: "processed",
      sessions: [{ status: "accepted", snapshot: { revision: 4 } }],
    });
    await expect(service.getSessionSnapshot("profile-1", "manager-1")).resolves.toMatchObject({
      activeTabId: "tab-1",
      defaultTabId: "tab-1",
      panelVisible: false,
      tabs: [expect.objectContaining({ title: "Renderer title", loading: true })],
      recentActions: [expect.objectContaining({ id: "action-1", status: "succeeded" })],
    });
  });

  it("rejects stale host reports and ignores backend-owned membership and selection fields", async () => {
    const { service } = await createService();
    const state = service.store.createEmpty("profile-1", "manager-1");
    state.tabs = [tab()];
    state.defaultTabId = "tab-1";
    state.activeTabId = "tab-1";
    state.panelVisible = true;
    state.revision = 5;
    await service.store.save(state);
    service.registerHost({
      connectionId: "socket-1",
      registration: registration(),
      sendRequest: () => undefined,
    });

    await expect(service.reportHostState("socket-1", "host-1", 1, [{
      sessionAgentId: "manager-1",
      profileId: "profile-1",
      baseRevision: 4,
      tabs: [{ ...tab(), title: "stale" }],
    }])).resolves.toMatchObject({
      status: "processed",
      sessions: [{ status: "revision-conflict", snapshot: { revision: 5, panelVisible: true } }],
    });

    await expect(service.reportHostState("socket-1", "host-1", 1, [{
      sessionAgentId: "manager-1",
      profileId: "profile-1",
      baseRevision: 5,
      tabs: [
        { ...tab(), title: "runtime" },
        { ...tab("manager-1", "profile-1", "tab-2"), title: "ghost" },
      ],
    }])).resolves.toMatchObject({
      status: "processed",
      sessions: [{ status: "rejected", reason: "tab-unavailable", snapshot: { revision: 5 } }],
    });

    await expect(service.reportHostState("socket-1", "host-1", 1, [{
      sessionAgentId: "manager-1",
      profileId: "profile-1",
      baseRevision: 5,
      tabs: [{ ...tab(), title: "runtime" }],
    }])).resolves.toMatchObject({
      status: "processed",
      sessions: [{ status: "accepted", snapshot: { revision: 6 } }],
    });

    const snapshot = await service.getSessionSnapshot("profile-1", "manager-1");
    expect(snapshot).toMatchObject({
      activeTabId: "tab-1",
      defaultTabId: "tab-1",
      panelVisible: true,
      tabs: [expect.objectContaining({ tabId: "tab-1", title: "runtime" })],
    });
    expect(snapshot.tabs).toHaveLength(1);
  });

  it("keeps canonical reveal intent separate from Electron-authoritative physical visibility", async () => {
    const { service } = await createService();
    const state = service.store.createEmpty("profile-1", "manager-1");
    state.tabs = [tab()];
    state.activeTabId = "tab-1";
    state.defaultTabId = "tab-1";
    state.panelVisible = true;
    state.panelReveal = { sequence: 1, acknowledgedSequence: 0, tabId: "tab-1" };
    await service.store.save(state);
    const requests: BrowserAutomationRequest[] = [];
    connect(service, requests);

    await expect(service.invoke("manager-1", "profile-1", "status", {})).resolves.toMatchObject({
      ok: true,
      result: {
        panelRevealRequested: true,
        physicalTabVisible: false,
        panelVisible: false,
      },
    });
  });

  it("uses broker host connection fields for status results", async () => {
    const { service } = await createService();
    const requests: BrowserAutomationRequest[] = [];
    connect(service, requests);
    service.setHostFocused("socket-1", "host-1", 1, true);
    const outcome = await service.invoke("manager-1", "profile-1", "status", {});
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        available: true,
        host: {
          connected: true,
          hostId: "host-1",
          hostGeneration: 1,
          focused: true,
          capabilities: registration().capabilities,
        },
      },
    });
  });

  it("converts malformed results and escaped recording artifacts to typed failures", async () => {
    const { service } = await createService();
    const state = service.store.createEmpty("profile-1", "manager-1");
    state.tabs = [tab()];
    state.defaultTabId = "tab-1";
    state.activeTabId = "tab-1";
    await service.store.save(state);
    let mode: "malformed" | "escaped" = "malformed";
    service.registerHost({
      connectionId: "socket-1",
      registration: registration(),
      sendRequest(request) {
        const base = {
          requestId: request.requestId,
          hostKind: request.hostKind,
          sessionAgentId: request.sessionAgentId,
          profileId: request.profileId,
          tabId: request.tabId,
          hostId: request.hostId,
          hostGeneration: request.hostGeneration,
          elapsedMs: 1,
          ok: true as const,
        };
        const result = mode === "malformed"
          ? { ...base, operation: "open" as const, result: {} }
          : {
              ...base,
              operation: "recordingStop" as const,
              result: {
                recordingId: "recording-1",
                tabId: "tab-1",
                path: join(tmpdir(), "escaped.webm"),
                mimeType: "video/webm",
                extension: ".webm",
                sizeBytes: 100,
                width: 800,
                height: 600,
                createdAt: timestamp,
              },
            };
        queueMicrotask(() => service.acceptHostResponse("socket-1", result));
      },
    });
    await expect(service.invoke("manager-1", "profile-1", "open", { show: false, reuseExistingTab: true })).resolves.toMatchObject({
      ok: false,
      error: { code: "malformed-response" },
    });
    mode = "escaped";
    await expect(service.invoke("manager-1", "profile-1", "recordingStop", {})).resolves.toMatchObject({
      ok: false,
      error: { code: "artifact-path-invalid" },
    });
  });

  it("archives, restores, and deletes state and artifacts explicitly", async () => {
    const changes: Array<{ reason: string; hostingState: string; revision: number }> = [];
    const dataDir = await mkdtemp(join(tmpdir(), "forge-browser-service-"));
    roots.push(dataDir);
    const service = new BrowserAutomationService({
      dataDir,
      now: () => timestamp,
      onSessionChanged: (snapshot, reason) => changes.push({
        reason,
        hostingState: snapshot.hostingState,
        revision: snapshot.revision,
      }),
    });
    const state = service.store.createEmpty("profile-1", "manager-1");
    state.tabs = [tab()];
    state.defaultTabId = "tab-1";
    state.activeTabId = "tab-1";
    await service.store.save(state);
    await service.getSessionSnapshot("profile-1", "manager-1");

    await expect(service.archiveSession("profile-1", "manager-1")).resolves.toMatchObject({
      hostingState: "unhosted",
      panelVisible: false,
      tabs: [{ live: false, controller: "none" }],
    });
    await expect(service.restoreSession("profile-1", "manager-1")).resolves.toMatchObject({
      hostingState: "hosted",
      tabs: [{ live: false, lifecycle: "restoring" }],
    });
    await service.deleteSession("profile-1", "manager-1");
    expect(changes.at(-1)).toMatchObject({ reason: "lifecycle", hostingState: "removed" });
    await expect(service.store.load("profile-1", "manager-1")).resolves.toMatchObject({ tabs: [], revision: 0 });
  });

  it("does not resurrect browser-state.json when delete races a pending evaluate", async () => {
    const changes: Array<{ reason: string; hostingState: string }> = [];
    const dataDir = await mkdtemp(join(tmpdir(), "forge-browser-service-"));
    roots.push(dataDir);
    const service = new BrowserAutomationService({
      dataDir,
      now: () => timestamp,
      onSessionChanged: (snapshot, reason) => {
        changes.push({ reason, hostingState: snapshot.hostingState });
      },
    });
    const state = service.store.createEmpty("profile-1", "manager-1");
    state.tabs = [tab()];
    state.defaultTabId = "tab-1";
    state.activeTabId = "tab-1";
    await service.store.save(state);
    await service.getSessionSnapshot("profile-1", "manager-1");

    const requests: BrowserAutomationRequest[] = [];
    service.registerHost({
      connectionId: "socket-1",
      registration: registration(),
      sendRequest(request) {
        requests.push(request);
      },
    });

    const pending = service.invoke("manager-1", "profile-1", "evaluate", {
      expression: "1",
      awaitPromise: true,
      returnByValue: true,
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (service.broker.getPendingCount() > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(service.broker.getPendingCount()).toBe(1);
    expect(requests).toHaveLength(1);

    const changeCountBeforeDelete = changes.length;
    await service.deleteSession("profile-1", "manager-1");
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "request-cancelled" },
    });

    const statePath = service.store.getStatePath("profile-1", "manager-1");
    await expect(access(statePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(service.getLoadedSessionSnapshots()).toEqual([]);
    expect(changes.slice(changeCountBeforeDelete)).toEqual([
      { reason: "lifecycle", hostingState: "removed" },
    ]);

    // Intentional recreation after delete must still persist.
    const recreateRequests: BrowserAutomationRequest[] = [];
    service.unregisterHost("socket-1", "host-1", 1);
    connect(service, recreateRequests);
    await expect(service.invoke("manager-1", "profile-1", "open", {
      show: false,
      reuseExistingTab: true,
    })).resolves.toMatchObject({ ok: true });
    await expect(access(statePath)).resolves.toBeUndefined();
    await expect(service.getSessionSnapshot("profile-1", "manager-1")).resolves.toMatchObject({
      tabs: [expect.objectContaining({ tabId: "tab-1" })],
      hostingState: "hosted",
    });
  });

  it("suppresses completion persistence for cancelled and successful broker races after delete", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-browser-service-"));
    roots.push(dataDir);
    const changes: string[] = [];
    const service = new BrowserAutomationService({
      dataDir,
      now: () => timestamp,
      onSessionChanged: (_snapshot, reason) => changes.push(reason),
    });
    const state = service.store.createEmpty("profile-1", "manager-1");
    state.tabs = [tab()];
    state.defaultTabId = "tab-1";
    state.activeTabId = "tab-1";
    await service.store.save(state);

    let pendingRequest: BrowserAutomationRequest | undefined;
    service.registerHost({
      connectionId: "socket-1",
      registration: registration(),
      sendRequest(request) {
        pendingRequest = request;
      },
    });

    const pending = service.invoke("manager-1", "profile-1", "evaluate", {
      expression: "1",
      awaitPromise: true,
      returnByValue: true,
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (pendingRequest) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(pendingRequest).toBeDefined();

    // Delete first, then deliver a late success response against the cancelled request id.
    const deletePromise = service.deleteSession("profile-1", "manager-1");
    service.acceptHostResponse("socket-1", {
      requestId: pendingRequest!.requestId,
      hostKind: "managed-electron",
      sessionAgentId: "manager-1",
      profileId: "profile-1",
      tabId: "tab-1",
      hostId: "host-1",
      hostGeneration: 1,
      operation: "evaluate",
      ok: true,
      elapsedMs: 1,
      result: { tabId: "tab-1", value: 1, serializedBytes: 1 },
    });
    await deletePromise;
    await pending;

    await expect(access(service.store.getStatePath("profile-1", "manager-1"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(changes.filter((reason) => reason === "automation").length).toBeGreaterThanOrEqual(1);
    expect(changes.at(-1)).toBe("lifecycle");
    const lifecycleIndex = changes.lastIndexOf("lifecycle");
    expect(changes.slice(lifecycleIndex + 1)).toEqual([]);
  });

  it("does not cache loads that finish after a concurrent delete", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-browser-service-"));
    roots.push(dataDir);
    const service = new BrowserAutomationService({ dataDir, now: () => timestamp });
    const state = service.store.createEmpty("profile-1", "manager-1");
    state.tabs = [tab()];
    state.defaultTabId = "tab-1";
    state.activeTabId = "tab-1";
    state.revision = 4;
    const statePath = service.store.getStatePath("profile-1", "manager-1");
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify(state), "utf8");

    let releaseLoad!: () => void;
    const loadBarrier = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const originalLoad = service.store.load.bind(service.store);
    let loadCalls = 0;
    service.store.load = async (profileId, sessionAgentId) => {
      loadCalls += 1;
      if (loadCalls === 1) await loadBarrier;
      return originalLoad(profileId, sessionAgentId);
    };

    const loading = service.getSessionSnapshot("profile-1", "manager-1");
    await service.deleteSession("profile-1", "manager-1");
    releaseLoad();
    await loading;

    expect(service.getLoadedSessionSnapshots()).toEqual([]);
    await expect(access(statePath)).rejects.toMatchObject({ code: "ENOENT" });

    // A later intentional load may recreate empty canonical state without resurrecting tabs.
    service.store.load = originalLoad;
    await expect(service.getSessionSnapshot("profile-1", "manager-1")).resolves.toMatchObject({
      tabs: [],
      revision: 0,
      hostingState: "hosted",
    });
  });
});
