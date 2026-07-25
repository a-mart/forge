import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    const tabId = request.hostKind === "external-chrome" ? "ext.instance.41" : "tab-1";
    return {
      ...base,
      operation: "open",
      ok: true,
      result: { tab: { ...tab(request.sessionAgentId, request.profileId, tabId), hostKind: request.hostKind }, created: true, panelRevealRequested: true },
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
  if (request.operation === "navigate") {
    return {
      ...base,
      operation: "navigate",
      ok: true,
      result: {
        tab: { ...tab(request.sessionAgentId, request.profileId, request.tabId!), hostKind: request.hostKind },
        readiness: request.input.readiness,
      },
    };
  }
  return {
    ...base,
    operation: "status",
    ok: true,
    result: {
      available: true,
      ...(request.input.externalChromeLifecycleRelease ? { externalChromeLifecycleRelease: {
        phase: request.input.externalChromeLifecycleRelease.phase,
        releaseId: request.input.externalChromeLifecycleRelease.releaseId,
      } } : {}),
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

function externalRegistration(hostId = "external-host"): BrowserHostRegistration {
  return {
    ...registration(),
    hostId,
    capabilities: {
      ...registration().capabilities,
      hostKind: "external-chrome",
      supportedOperations: ["status", "open", "navigate"],
      supportsRecording: false,
    },
  };
}

async function seedExternalSession(service: BrowserAutomationService): Promise<void> {
  const state = service.store.createEmpty("profile-1", "manager-1");
  state.hostKind = "external-chrome";
  state.tabs = [{ ...tab("manager-1", "profile-1", "ext.instance.41"), hostKind: "external-chrome" }];
  state.activeTabId = "ext.instance.41";
  state.defaultTabId = "ext.instance.41";
  await service.store.save(state);
  await service.getSessionSnapshot("profile-1", "manager-1");
}

async function waitForPendingRequest(service: BrowserAutomationService): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (service.broker.getPendingCount() > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Browser request did not become pending");
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

  it("preserves runtime available:false independently from a connected renderer host", async () => {
    const { service } = await createService();
    service.registerHost({
      connectionId: "external-socket",
      registration: externalRegistration(),
      sendRequest(request) {
        const connectedResponse = response(request);
        if (!connectedResponse.ok || connectedResponse.operation !== "status") throw new Error("expected status");
        queueMicrotask(() => service.acceptHostResponse("external-socket", {
          ...connectedResponse,
          result: { ...connectedResponse.result, available: false },
        }));
      },
    });
    await expect(service.invoke("manager-1", "profile-1", "status", { hostKind: "external-chrome" }))
      .resolves.toMatchObject({ ok: true, result: { available: false, host: { connected: true } } });
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
          supportedOperations: ["status", "open", "navigate"],
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
    await expect(service.invoke("manager-1", "profile-1", "navigate", {
      url: "https://example.com/next", readiness: "load", timeoutMs: 15_000,
    })).resolves.toMatchObject({ ok: true });
    expect(requests.map((request) => request.hostKind)).toEqual(["external-chrome", "external-chrome"]);

    const restarted = new BrowserAutomationService({ dataDir, now: () => timestamp });
    await expect(restarted.getSessionSnapshot("profile-1", "manager-1")).resolves.toMatchObject({
      hostKind: "external-chrome",
      tabs: [expect.objectContaining({ hostKind: "external-chrome", url: "", title: "" })],
    });
  });

  it("projects External Chrome responses before state, events, persistence, diagnostics, or tool results", async () => {
    const { dataDir } = await createService();
    const changes: BrowserTabSnapshot[] = [];
    const privateUrl = "https://private.invalid/path?secret=yes";
    const privateTitle = "Private candidate title";
    const privateOrigin = "https://private.invalid";
    const guarded = new BrowserAutomationService({
      dataDir,
      now: () => timestamp,
      onSessionChanged: (snapshot) => {
        changes.push(...snapshot.tabs);
      },
    });
    guarded.registerHost({
      connectionId: "external-private",
      registration: {
        ...registration(),
        hostId: "external-private-host",
        capabilities: {
          ...registration().capabilities,
          hostKind: "external-chrome",
          supportedOperations: ["open", "navigate", "status"],
          supportsRecording: false,
        },
      },
      sendRequest(request) {
        const leasedTab = {
          ...tab(request.sessionAgentId, request.profileId, request.tabId ?? "ext.instance.41"),
          hostKind: "external-chrome" as const,
          url: privateUrl,
          title: privateTitle,
          origin: privateOrigin,
          candidates: [{ title: "Unselected candidate", origin: "https://other.invalid" }],
        };
        const result = request.operation === "open"
          ? { tab: leasedTab, created: true, panelRevealRequested: false, candidates: leasedTab.candidates }
          : request.operation === "navigate"
            ? { tab: leasedTab, readiness: request.input.readiness, origin: privateOrigin }
            : {
                available: true,
                host: guarded.broker.getConnectionSnapshot("external-chrome"),
                panelVisible: false,
                panelRevealRequested: false,
                physicalTabVisible: false,
                selectedTab: leasedTab,
                candidates: leasedTab.candidates,
              };
        queueMicrotask(() => guarded.acceptHostResponse("external-private", {
          requestId: request.requestId,
          hostKind: request.hostKind,
          sessionAgentId: request.sessionAgentId,
          profileId: request.profileId,
          tabId: request.tabId,
          hostId: request.hostId,
          hostGeneration: request.hostGeneration,
          operation: request.operation,
          ok: true,
          result,
          updatedTab: leasedTab,
          elapsedMs: 1,
        }));
      },
    });

    const opened = await guarded.invoke("manager-1", "profile-1", "open", {
      hostKind: "external-chrome", show: false, reuseExistingTab: false,
    });
    expect(opened).toMatchObject({
      ok: true,
      result: { tab: { tabId: "ext.instance.41", url: "", title: "" } },
    });
    expect(JSON.stringify(opened)).not.toMatch(/private|candidate|origin/i);
    expect(JSON.stringify(changes)).not.toMatch(/private|candidate|origin/i);
    expect(JSON.stringify(await guarded.getSessionSnapshot("profile-1", "manager-1"))).not.toMatch(/private|candidate|origin/i);
    expect(await readFile(guarded.store.getStatePath("profile-1", "manager-1"), "utf8")).not.toMatch(/private|candidate|origin/i);
  });

  it("changes host and tab selection atomically so omitted-host calls follow a managed activation", async () => {
    const { service } = await createService();
    const managedRequests: BrowserAutomationRequest[] = [];
    const externalRequests: BrowserAutomationRequest[] = [];
    for (const [hostKind, connectionId, hostId, requests] of [
      ["managed-electron", "managed-socket", "managed-host", managedRequests],
      ["external-chrome", "external-socket", "external-host", externalRequests],
    ] as const) {
      service.registerHost({
        connectionId,
        registration: {
          ...registration(),
          hostId,
          capabilities: { ...registration().capabilities, hostKind },
        },
        sendRequest(request) {
          requests.push(request);
          queueMicrotask(() => service.acceptHostResponse(connectionId, response(request)));
        },
      });
    }

    await service.invoke("manager-1", "profile-1", "open", {
      hostKind: "external-chrome", show: false, reuseExistingTab: false,
    });
    await service.invoke("manager-1", "profile-1", "open", {
      hostKind: "managed-electron", show: false, reuseExistingTab: false,
    });
    await expect(service.activateTab("profile-1", "manager-1", "ext.instance.41", "external-chrome")).resolves.toMatchObject({
      hostKind: "external-chrome", activeTabId: "ext.instance.41", defaultTabId: "ext.instance.41",
    });
    await expect(service.activateTab("profile-1", "manager-1", "tab-1", "managed-electron")).resolves.toMatchObject({
      hostKind: "managed-electron", activeTabId: "tab-1", defaultTabId: "tab-1",
    });

    await expect(service.invoke("manager-1", "profile-1", "evaluate", {
      expression: "1 + 1", awaitPromise: true, returnByValue: true,
    })).resolves.toMatchObject({ ok: true });
    expect(managedRequests.at(-1)).toMatchObject({ operation: "evaluate", hostKind: "managed-electron", tabId: "tab-1" });
    expect(externalRequests).toHaveLength(1);
  });

  it("projects restart hydration independently for managed and External Chrome hosts", async () => {
    const { dataDir, service } = await createService();
    const state = service.store.createEmpty("profile-1", "manager-1");
    state.hostKind = "external-chrome";
    state.tabs = [
      { ...tab("manager-1", "profile-1", "managed-tab"), hostKind: "managed-electron" },
      { ...tab("manager-1", "profile-1", "ext.instance.41"), hostKind: "external-chrome", url: "https://private.invalid/path", title: "Private" },
    ];
    state.activeTabId = "ext.instance.41";
    state.defaultTabId = "ext.instance.41";
    state.panelVisible = true;
    state.panelReveal = { sequence: 1, acknowledgedSequence: 0, tabId: "ext.instance.41" };
    await service.store.save(state);

    const restarted = new BrowserAutomationService({ dataDir, now: () => timestamp });
    await expect(restarted.getHostHydrationSnapshot("profile-1", "manager-1", "external-chrome")).resolves.toMatchObject({
      hostKind: "external-chrome",
      tabs: [{ hostKind: "external-chrome", tabId: "ext.instance.41", url: "", title: "" }],
      activeTabId: "ext.instance.41",
      defaultTabId: "ext.instance.41",
      panelVisible: false,
      panelReveal: { sequence: 0, acknowledgedSequence: 0, tabId: null },
    });
    await expect(restarted.getHostHydrationSnapshot("profile-1", "manager-1", "managed-electron")).resolves.toMatchObject({
      hostKind: "managed-electron",
      tabs: [{ hostKind: "managed-electron", tabId: "managed-tab" }],
      activeTabId: null,
      defaultTabId: null,
      panelVisible: false,
    });
  });

  it("keeps identical tab ids host-scoped when closing and selecting fallbacks", async () => {
    const { service } = await createService();
    const state = service.store.createEmpty("profile-1", "manager-1");
    state.hostKind = "external-chrome";
    state.tabs = [
      { ...tab(), hostKind: "external-chrome" },
      { ...tab(), hostKind: "managed-electron" },
      { ...tab("manager-1", "profile-1", "managed-2"), hostKind: "managed-electron" },
    ];
    state.activeTabId = "tab-1";
    state.defaultTabId = "tab-1";
    await service.store.save(state);

    await expect(service.closeTab("profile-1", "manager-1", "tab-1", "managed-electron")).resolves.toMatchObject({
      hostKind: "external-chrome",
      activeTabId: "tab-1",
      defaultTabId: "tab-1",
      tabs: [
        expect.objectContaining({ hostKind: "external-chrome", tabId: "tab-1" }),
        expect.objectContaining({ hostKind: "managed-electron", tabId: "managed-2" }),
      ],
    });
    await service.activateTab("profile-1", "manager-1", "managed-2", "managed-electron");
    await expect(service.closeTab("profile-1", "manager-1", "managed-2", "managed-electron")).resolves.toMatchObject({
      hostKind: "external-chrome", activeTabId: "tab-1", defaultTabId: "tab-1",
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

  it("acknowledges lifecycle release against the exact External Chrome authority and removes released state", async () => {
    const { service } = await createService();
    await seedExternalSession(service);
    const requests: BrowserAutomationRequest[] = [];
    const host = service.registerHost({
      connectionId: "external-socket",
      registration: externalRegistration(),
      sendRequest(request) {
        requests.push(request);
        queueMicrotask(() => service.acceptHostResponse("external-socket", response(request)));
      },
    });

    await expect(service.releaseSessionForLifecycle("profile-1", "manager-1", "archive")).resolves.toBeUndefined();
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      requestId: expect.stringMatching(/^external-chrome-release:prepare:archive:[A-Za-z0-9._-]{1,80}$/u),
      hostKind: "external-chrome",
      hostId: host.hostId,
      hostGeneration: host.hostGeneration,
      operation: "status",
      tabId: "ext.instance.41",
      input: { hostKind: "external-chrome", tabId: "ext.instance.41", externalChromeLifecycleRelease: {
        phase: "prepare", reason: "archive", originalHostId: host.hostId, originalHostGeneration: host.hostGeneration,
        releaseId: expect.any(String),
      } },
    });
    expect(requests[1]).toMatchObject({
      requestId: expect.stringMatching(/^external-chrome-release:finalize:archive:/u),
      input: { externalChromeLifecycleRelease: {
        phase: "finalize", releaseId: requests[0]!.input.externalChromeLifecycleRelease!.releaseId,
      } },
    });
    await expect(service.getSessionSnapshot("profile-1", "manager-1")).resolves.toMatchObject({
      hostKind: "managed-electron",
      tabs: [],
      activeTabId: null,
      defaultTabId: null,
    });
  });

  it("durably retries a prepare that acknowledges after timeout, then removes canonical state before exact finalize", async () => {
    vi.useFakeTimers();
    try {
      const { dataDir, service } = await createService();
      await seedExternalSession(service);
      const requests: BrowserAutomationRequest[] = [];
      let acknowledge = false;
      service.registerHost({
        connectionId: "external-socket",
        registration: externalRegistration(),
        sendRequest(request) {
          requests.push(request);
          if (acknowledge) queueMicrotask(() => service.acceptHostResponse("external-socket", response(request)));
        },
      });

      const first = service.releaseSessionForLifecycle("profile-1", "manager-1", "delete");
      const firstFailure = first.catch((error: unknown) => error);
      await vi.waitFor(() => expect(service.broker.getPendingCount()).toBe(1));
      const preparedIntent = JSON.parse(await readFile(service.store.getStatePath("profile-1", "manager-1"), "utf8"));
      expect(preparedIntent.externalChromeLifecycleRelease).toMatchObject({ phase: "preparing", reason: "delete" });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(firstFailure).resolves.toMatchObject({ failure: { code: "timeout" } });
      expect(service.acceptHostResponse("external-socket", response(requests[0]!))).toBe("duplicate");

      // Backend restart reloads the same opaque transaction id instead of allocating
      // authority that could no longer match Desktop's late tombstone.
      const restarted = new BrowserAutomationService({ dataDir, now: () => timestamp });
      acknowledge = true;
      restarted.registerHost({
        connectionId: "external-socket-restarted",
        registration: externalRegistration(),
        sendRequest(request) {
          requests.push(request);
          queueMicrotask(() => restarted.acceptHostResponse("external-socket-restarted", response(request)));
        },
      });
      await expect(restarted.releaseSessionForLifecycle("profile-1", "manager-1", "archive")).resolves.toBeUndefined();
      const lifecycle = requests.map((request) => request.input.externalChromeLifecycleRelease).filter(Boolean);
      expect(lifecycle.map((entry) => entry!.releaseId)).toEqual([
        preparedIntent.externalChromeLifecycleRelease.releaseId,
        preparedIntent.externalChromeLifecycleRelease.releaseId,
        preparedIntent.externalChromeLifecycleRelease.releaseId,
      ]);
      expect(lifecycle.map((entry) => entry!.phase)).toEqual(["prepare", "prepare", "finalize"]);
      const completed = await restarted.getSessionSnapshot("profile-1", "manager-1");
      expect(completed.tabs).toEqual([]);
      expect(completed).not.toHaveProperty("externalChromeLifecycleRelease");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes a durably prepared release after backend restart without reattaching or repeating prepare", async () => {
    vi.useFakeTimers();
    try {
      const { dataDir, service } = await createService();
      await seedExternalSession(service);
      const requests: BrowserAutomationRequest[] = [];
      service.registerHost({
        connectionId: "external-socket",
        registration: externalRegistration(),
        sendRequest(request) {
          requests.push(request);
          if (request.input.externalChromeLifecycleRelease?.phase === "prepare") {
            queueMicrotask(() => service.acceptHostResponse("external-socket", response(request)));
          }
        },
      });
      const firstFailure = service.releaseSessionForLifecycle("profile-1", "manager-1", "stop").catch((error: unknown) => error);
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(firstFailure).resolves.toMatchObject({ failure: { code: "timeout" } });
      const persisted = JSON.parse(await readFile(service.store.getStatePath("profile-1", "manager-1"), "utf8"));
      expect(persisted).toMatchObject({ tabs: [], externalChromeLifecycleRelease: { phase: "prepared" } });

      const restarted = new BrowserAutomationService({ dataDir, now: () => timestamp });
      const resumed: BrowserAutomationRequest[] = [];
      restarted.registerHost({
        connectionId: "external-socket-restarted",
        registration: externalRegistration(),
        sendRequest(request) {
          resumed.push(request);
          queueMicrotask(() => restarted.acceptHostResponse("external-socket-restarted", response(request)));
        },
      });
      await restarted.releaseSessionForLifecycle("profile-1", "manager-1", "archive");
      expect(resumed.map((request) => request.input.externalChromeLifecycleRelease?.phase)).toEqual(["finalize"]);
      expect(resumed[0]!.input.externalChromeLifecycleRelease?.releaseId)
        .toBe(persisted.externalChromeLifecycleRelease.releaseId);
      expect(await readFile(restarted.store.getStatePath("profile-1", "manager-1"), "utf8")).not.toContain("externalChromeLifecycleRelease");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails lifecycle release closed on a stale host generation", async () => {
    const { service } = await createService();
    await seedExternalSession(service);
    const requests: BrowserAutomationRequest[] = [];
    service.registerHost({
      connectionId: "external-socket",
      registration: externalRegistration("old-host"),
      sendRequest: (request) => { requests.push(request); },
    });

    const releasing = service.releaseSessionForLifecycle("profile-1", "manager-1", "delete");
    await waitForPendingRequest(service);
    service.registerHost({
      connectionId: "replacement-socket",
      registration: externalRegistration("replacement-host"),
      sendRequest: () => undefined,
    });
    await expect(releasing).rejects.toMatchObject({ failure: { code: "stale-host-generation" } });
    await expect(service.getSessionSnapshot("profile-1", "manager-1")).resolves.toMatchObject({
      tabs: [expect.objectContaining({ tabId: "ext.instance.41" })],
    });
  });

  it("fails lifecycle release closed when the exact host disconnects", async () => {
    const { service } = await createService();
    await seedExternalSession(service);
    service.registerHost({
      connectionId: "external-socket",
      registration: externalRegistration(),
      sendRequest: () => undefined,
    });

    const releasing = service.releaseSessionForLifecycle("profile-1", "manager-1", "archive");
    await waitForPendingRequest(service);
    service.unregisterHost("external-socket", "external-host", 1, "external-chrome");
    await expect(releasing).rejects.toMatchObject({ failure: { code: "host-disconnected" } });
  });

  it("bounds lifecycle release timeout without mutating lease authority", async () => {
    vi.useFakeTimers();
    try {
      const { service } = await createService();
      await seedExternalSession(service);
      service.registerHost({
        connectionId: "external-socket",
        registration: externalRegistration(),
        sendRequest: () => undefined,
      });

      const releasing = service.releaseSessionForLifecycle("profile-1", "manager-1", "delete");
      const timedOut = expect(releasing).rejects.toMatchObject({ failure: { code: "timeout" } });
      await vi.waitFor(() => expect(service.broker.getPendingCount()).toBe(1));
      await vi.advanceTimersByTimeAsync(5_000);
      await timedOut;
      await expect(service.getSessionSnapshot("profile-1", "manager-1")).resolves.toMatchObject({
        tabs: [expect.objectContaining({ tabId: "ext.instance.41" })],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails lifecycle release closed on a negative acknowledgement", async () => {
    const { service } = await createService();
    await seedExternalSession(service);
    service.registerHost({
      connectionId: "external-socket",
      registration: externalRegistration(),
      sendRequest(request) {
        queueMicrotask(() => service.acceptHostResponse("external-socket", {
          requestId: request.requestId,
          hostKind: request.hostKind,
          sessionAgentId: request.sessionAgentId,
          profileId: request.profileId,
          tabId: request.tabId,
          hostId: request.hostId,
          hostGeneration: request.hostGeneration,
          operation: request.operation,
          elapsedMs: 1,
          ok: false,
          error: { code: "lease-lost", message: "private host detail", retryable: false },
        }));
      },
    });

    const releaseError = await service.releaseSessionForLifecycle("profile-1", "manager-1", "archive")
      .catch((error: unknown) => error);
    expect(releaseError).toMatchObject({
      failure: { code: "lease-lost", message: "External Chrome request failed (lease-lost)." },
    });

    const marked = await service.recordFailedLifecycleRelease("profile-1", "manager-1", "stop", releaseError);
    expect(marked.recentActions.at(-1)).toMatchObject({
      id: expect.stringMatching(/^external-chrome-release-failed:stop:/u),
      operation: "status",
      tabId: null,
      status: "failed",
      errorCode: "lease-lost",
    });
    const persisted = await readFile(service.store.getStatePath("profile-1", "manager-1"), "utf8");
    expect(persisted).not.toContain("private host detail");
  });

  it("fails closed when a cancelled External Chrome open may have acquired a lease without returning an opaque tab", async () => {
    const { service } = await createService();
    await service.getSessionSnapshot("profile-1", "manager-1");
    const requests: BrowserAutomationRequest[] = [];
    service.registerHost({
      connectionId: "external-socket",
      registration: externalRegistration(),
      sendRequest: (request) => { requests.push(request); },
    });

    const opening = service.invoke("manager-1", "profile-1", "open", {
      hostKind: "external-chrome",
      show: false,
      reuseExistingTab: false,
    });
    await waitForPendingRequest(service);
    service.cancelSession("manager-1");
    await expect(opening).resolves.toMatchObject({ ok: false, error: { code: "request-cancelled" } });
    await expect(service.releaseSessionForLifecycle("profile-1", "manager-1", "stop"))
      .rejects.toMatchObject({ failure: { code: "malformed-response" } });
    expect(requests).toHaveLength(1);
  });

  it("rejects malformed opaque release state before contacting the host", async () => {
    const { service } = await createService();
    const state = service.store.createEmpty("profile-1", "manager-1");
    state.hostKind = "external-chrome";
    state.tabs = [{ ...tab("manager-1", "profile-1", "private-tab-title"), hostKind: "external-chrome" }];
    state.activeTabId = "private-tab-title";
    state.defaultTabId = "private-tab-title";
    await service.store.save(state);
    await service.getSessionSnapshot("profile-1", "manager-1");
    const sendRequest = vi.fn();
    service.registerHost({
      connectionId: "external-socket",
      registration: externalRegistration(),
      sendRequest,
    });

    await expect(service.releaseSessionForLifecycle("profile-1", "manager-1", "delete"))
      .rejects.toMatchObject({ failure: { code: "malformed-response" } });
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it("releases every loaded External Chrome lease before replacing host authority", async () => {
    const { service } = await createService();
    await seedExternalSession(service);
    const requests: BrowserAutomationRequest[] = [];
    service.registerHost({
      connectionId: "old-socket",
      registration: externalRegistration("old-host"),
      sendRequest(request) {
        requests.push(request);
        queueMicrotask(() => service.acceptHostResponse("old-socket", response(request)));
      },
    });

    const replacement = await service.registerHostWithLifecycleRelease({
      connectionId: "new-socket",
      registration: externalRegistration("new-host"),
      sendRequest: () => undefined,
    });
    expect(requests).toEqual([
      expect.objectContaining({
        requestId: expect.stringMatching(/^external-chrome-release:prepare:host-replaced:/u),
        hostId: "old-host", hostGeneration: 1,
      }),
      expect.objectContaining({
        requestId: expect.stringMatching(/^external-chrome-release:finalize:host-replaced:/u),
        hostId: "old-host", hostGeneration: 1,
      }),
    ]);
    expect(replacement).toMatchObject({ hostId: "new-host", hostGeneration: 2 });
  });

  it("establishes a usable first recovered generation without requesting release from the not-yet-connected client", async () => {
    const { service } = await createService();
    const state = service.store.createEmpty("profile-1", "manager-1");
    state.hostKind = "external-chrome";
    state.tabs = [{ ...tab("manager-1", "profile-1", "ext.instance.41"), hostKind: "external-chrome" }];
    state.activeTabId = "ext.instance.41";
    state.defaultTabId = "ext.instance.41";
    await service.store.save(state);
    expect(service.getLoadedSessionSnapshots()).toEqual([]);
    const requests: BrowserAutomationRequest[] = [];
    const replacement = await service.registerHostWithLifecycleRelease({
      connectionId: "new-socket",
      registration: externalRegistration("new-host"),
      hydrateSessionsForReplacement: async () => [await service.getHostHydrationSnapshot("profile-1", "manager-1", "external-chrome")],
      sendRequest(request) {
        requests.push(request);
        queueMicrotask(() => service.acceptHostResponse("new-socket", response(request)));
      },
    });
    expect(replacement).toMatchObject({ hostId: "new-host", hostGeneration: 1 });
    expect(requests).toEqual([]);
    expect((await service.getSessionSnapshot("profile-1", "manager-1")).tabs).toEqual([
      expect.objectContaining({ tabId: "ext.instance.41", hostKind: "external-chrome" }),
    ]);
  });

  it("keeps replacement behind a hydration barrier during a recovery race", async () => {
    const { service } = await createService();
    const state = service.store.createEmpty("profile-1", "manager-1");
    state.hostKind = "external-chrome";
    state.tabs = [{ ...tab("manager-1", "profile-1", "ext.instance.41"), hostKind: "external-chrome" }];
    state.activeTabId = "ext.instance.41";
    state.defaultTabId = "ext.instance.41";
    await service.store.save(state);
    let finishHydration!: () => void;
    const hydrationGate = new Promise<void>((resolve) => { finishHydration = resolve; });
    const requests: BrowserAutomationRequest[] = [];
    service.registerHost({
      connectionId: "old-socket",
      registration: externalRegistration("old-host"),
      sendRequest(request) {
        requests.push(request);
        queueMicrotask(() => service.acceptHostResponse("old-socket", response(request)));
      },
    });
    const registering = service.registerHostWithLifecycleRelease({
      connectionId: "new-socket",
      registration: externalRegistration("new-host"),
      hydrateSessionsForReplacement: async () => {
        await hydrationGate;
        return [await service.getHostHydrationSnapshot("profile-1", "manager-1", "external-chrome")];
      },
      sendRequest(request) {
        requests.push(request);
        queueMicrotask(() => service.acceptHostResponse("new-socket", response(request)));
      },
    });
    await Promise.resolve();
    expect(service.broker.getConnectionSnapshot("external-chrome")).toMatchObject({ connected: true, hostId: "old-host", hostGeneration: 1 });
    finishHydration();
    await expect(registering).resolves.toMatchObject({ hostId: "new-host", hostGeneration: 2 });
    expect(requests).toEqual([
      expect.objectContaining({ hostId: "old-host", hostGeneration: 1 }),
      expect.objectContaining({ hostId: "old-host", hostGeneration: 1 }),
    ]);
  });

  it("persists session-scoped host selection and removes the external snapshot after acknowledged local detach", async () => {
    const { service } = await createService();
    await seedExternalSession(service);
    await expect(service.selectHost("profile-1", "manager-1", "managed-electron"))
      .resolves.toMatchObject({ hostKind: "managed-electron", activeTabId: null });
    await expect(service.selectHost("profile-1", "manager-1", "external-chrome"))
      .resolves.toMatchObject({ hostKind: "external-chrome", activeTabId: "ext.instance.41" });
    service.registerHost({
      connectionId: "external-socket",
      registration: externalRegistration(),
      sendRequest(request) { queueMicrotask(() => service.acceptHostResponse("external-socket", response(request))); },
    });
    await service.releaseSessionForLifecycle("profile-1", "manager-1", "detach");
    await expect(service.getSessionSnapshot("profile-1", "manager-1"))
      .resolves.toMatchObject({ hostKind: "managed-electron", tabs: [] });
    await service.deleteSession("profile-1", "manager-1");
  });

  it("does not replace External Chrome authority after a failed release acknowledgement", async () => {
    const { service } = await createService();
    await seedExternalSession(service);
    service.registerHost({
      connectionId: "old-socket",
      registration: externalRegistration("old-host"),
      sendRequest(request) {
        queueMicrotask(() => service.acceptHostResponse("old-socket", {
          requestId: request.requestId,
          hostKind: request.hostKind,
          sessionAgentId: request.sessionAgentId,
          profileId: request.profileId,
          tabId: request.tabId,
          hostId: request.hostId,
          hostGeneration: request.hostGeneration,
          operation: request.operation,
          elapsedMs: 1,
          ok: false,
          error: { code: "lease-lost", message: "private detail", retryable: false },
        }));
      },
    });

    await expect(service.registerHostWithLifecycleRelease({
      connectionId: "new-socket",
      registration: externalRegistration("new-host"),
      sendRequest: () => undefined,
    })).rejects.toMatchObject({ failure: { code: "lease-lost" } });
    expect(service.broker.getConnectionSnapshot("external-chrome")).toMatchObject({
      hostId: "old-host",
      hostGeneration: 1,
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
