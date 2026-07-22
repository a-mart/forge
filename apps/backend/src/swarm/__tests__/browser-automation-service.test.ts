import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      result: { tab: tab(request.sessionAgentId, request.profileId), created: true, panelRevealRequested: true },
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
      recentActions: expect.arrayContaining([expect.objectContaining({ operation: "evaluate", status: "succeeded" })]),
    });
    const persisted = await readFile(restarted.store.getStatePath("profile-1", "manager-1"), "utf8");
    expect(persisted).not.toContain("document.title");
    expect(persisted).not.toContain("SECRET_RESULT");
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
    const { service } = await createService();
    const state = service.store.createEmpty("profile-1", "manager-1");
    state.tabs = [tab()];
    state.defaultTabId = "tab-1";
    state.activeTabId = "tab-1";
    await service.store.save(state);

    await expect(service.archiveSession("profile-1", "manager-1")).resolves.toMatchObject({
      panelVisible: false,
      tabs: [{ live: false, controller: "none" }],
    });
    await expect(service.restoreSession("profile-1", "manager-1")).resolves.toMatchObject({
      tabs: [{ live: false, lifecycle: "restoring" }],
    });
    await service.deleteSession("profile-1", "manager-1");
    await expect(service.store.load("profile-1", "manager-1")).resolves.toMatchObject({ tabs: [], revision: 0 });
  });
});
