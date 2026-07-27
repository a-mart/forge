import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserAutomationRequest, BrowserAutomationResponse, BrowserHostLifecycleRequest, BrowserTabSnapshot } from "@forge/protocol";
import { BrowserAutomationService } from "../browser-automation/browser-automation-service.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function service() {
  const root = await mkdtemp(join(tmpdir(), "forge-automatic-browser-"));
  roots.push(root);
  return new BrowserAutomationService({ dataDir: root, now: () => "2026-07-27T00:00:00.000Z" });
}

function tab(request: BrowserAutomationRequest, tabId: string, affinity: "managed-electron" | "external-chrome" = "managed-electron"): BrowserTabSnapshot {
  return {
    targetAffinity: affinity, tabId, sessionAgentId: request.sessionAgentId, profileId: request.profileId,
    url: affinity === "external-chrome" ? "https://private.invalid/path" : "https://example.test/", title: affinity === "external-chrome" ? "Private" : "Example",
    lifecycle: "ready", loading: false, live: true, canGoBack: false, canGoForward: false, zoomFactor: 1,
    controller: "none", agentCursor: null, recording: null, viewportSetting: { mode: "fill" }, renderedViewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    error: null, createdAt: "2026-07-27T00:00:00.000Z", updatedAt: "2026-07-27T00:00:00.000Z",
  };
}

function routing(request: BrowserAutomationRequest) {
  return {
    requestId: request.requestId, sessionAgentId: request.sessionAgentId, profileId: request.profileId, tabId: request.tabId,
    hostId: request.hostId, hostGeneration: request.hostGeneration, operation: request.operation, elapsedMs: 1,
  };
}

function register(service: BrowserAutomationService, onRequest: (request: BrowserAutomationRequest) => void, onLifecycle?: (request: BrowserHostLifecycleRequest) => void) {
  service.registerHost({
    connectionId: "desktop-socket",
    registration: {
      hostId: "automatic-desktop", clientInstanceId: "desktop", registeredAt: "2026-07-27T00:00:00.000Z",
      capabilities: { protocolVersions: { minimum: 2, maximum: 2 }, supportedOperations: ["status", "open", "navigate", "resize", "snapshot", "click", "type", "press", "scroll", "evaluate", "waitFor", "recordingStart", "recordingStop"], maxResponseBytes: 1_000_000 },
    },
    sendRequest: onRequest,
    sendLifecycleRequest: onLifecycle,
  });
}

function accept(service: BrowserAutomationService, response: BrowserAutomationResponse) {
  expect(service.acceptHostResponse("desktop-socket", response)).toBe("accepted");
}

describe("Automatic Browser Host service", () => {
  it("replaces selectedTab:null -> failed open -> tab-not-found with tabless redispatch and adoption", async () => {
    const instance = await service();
    const requests: BrowserAutomationRequest[] = [];
    register(instance, (request) => requests.push(request));

    const status = instance.invoke("manager-1", "profile-1", "status", {});
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    accept(instance, { ...routing(requests[0]!), ok: true, result: { available: true, host: instance.broker.getConnectionSnapshot(), panelVisible: false, panelRevealRequested: false, physicalTabVisible: false, selectedTab: null } });
    await expect(status).resolves.toMatchObject({ ok: true, result: { selectedTab: null } });

    const opening = instance.invoke("manager-1", "profile-1", "open", { show: false, reuseExistingTab: true });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toMatchObject({ operation: "open", tabId: null });
    accept(instance, { ...routing(requests[1]!), ok: false, error: { code: "target-not-found", message: "old acquisition failed", retryable: true } });
    await expect(opening).resolves.toMatchObject({ ok: false, error: { code: "target-not-found" } });

    const snapshot = instance.invoke("manager-1", "profile-1", "snapshot", {});
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2]).toMatchObject({ operation: "snapshot", tabId: null });
    const adopted = tab(requests[2]!, "logical-tab-1", "external-chrome");
    accept(instance, {
      ...routing(requests[2]!), ok: true, updatedTab: adopted,
      result: { tabId: adopted.tabId, url: "https://private.invalid/path", title: "Private", loading: false, viewportSetting: { mode: "fill" }, viewport: { width: 800, height: 600, deviceScaleFactor: 1 }, visibleText: "secret page", interactiveElements: [], accessibility: {}, consoleEntries: [], networkEntries: [], actionTimeline: [], screenshot: { mimeType: "image/png", data: "AA==", width: 1, height: 1 } },
    });
    await expect(snapshot).resolves.toMatchObject({ ok: true, result: { tabId: "logical-tab-1" } });
    await expect(instance.getSessionSnapshot("profile-1", "manager-1")).resolves.toMatchObject({ schemaVersion: 2, activeTabId: "logical-tab-1", defaultTabId: "logical-tab-1", tabs: [{ tabId: "logical-tab-1", targetAffinity: "external-chrome", url: "", title: "" }] });
  });

  it("dispatches every tabless operation once and adopts the target returned by Desktop", async () => {
    const instance = await service();
    const requests: BrowserAutomationRequest[] = [];
    register(instance, (request) => requests.push(request));
    const navigating = instance.invoke("manager-1", "profile-1", "navigate", { url: "https://example.test", readiness: "load", timeoutMs: 15_000 });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const adopted = tab(requests[0]!, "managed-logical");
    accept(instance, { ...routing(requests[0]!), ok: true, updatedTab: adopted, result: { tab: adopted, readiness: "load" } });
    await expect(navigating).resolves.toMatchObject({ ok: true, result: { tab: { tabId: "managed-logical" } } });
    expect(requests).toHaveLength(1);
  });

  it("fails closed on cross-session logical tab ownership", async () => {
    const instance = await service();
    const requests: BrowserAutomationRequest[] = [];
    register(instance, (request) => requests.push(request));
    const first = instance.invoke("manager-1", "profile-1", "open", { show: false, reuseExistingTab: false });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const owned = tab(requests[0]!, "shared-logical");
    accept(instance, { ...routing(requests[0]!), ok: true, updatedTab: owned, result: { tab: owned, created: true, panelRevealRequested: false } });
    await first;
    await expect(instance.invoke("manager-2", "profile-1", "snapshot", { tabId: "shared-logical" }))
      .resolves.toMatchObject({ ok: false, error: { code: "tab-session-mismatch" } });
    expect(requests).toHaveLength(1);
  });

  it("uses generic correlated turn and release lifecycle requests", async () => {
    const instance = await service();
    const operations: BrowserAutomationRequest[] = [];
    const lifecycle: BrowserHostLifecycleRequest[] = [];
    register(instance, (request) => operations.push(request), (request) => lifecycle.push(request));
    const opening = instance.invoke("manager-1", "profile-1", "open", { show: false, reuseExistingTab: false });
    await vi.waitFor(() => expect(operations).toHaveLength(1));
    const owned = tab(operations[0]!, "logical");
    accept(instance, { ...routing(operations[0]!), ok: true, updatedTab: owned, result: { tab: owned, created: true, panelRevealRequested: false } });
    await opening;

    const turn = instance.endBrowserTurn("profile-1", "manager-1", "turn-7");
    await vi.waitFor(() => expect(lifecycle).toHaveLength(1));
    expect(lifecycle[0]).toMatchObject({ kind: "turn-ended", turnId: "turn-7" });
    expect(instance.acceptHostLifecycleResponse("desktop-socket", { ...lifecycle[0], ok: true })).toBe("accepted");
    await turn;
    const release = instance.releaseSessionForLifecycle("profile-1", "manager-1", "archive");
    await vi.waitFor(() => expect(lifecycle).toHaveLength(2));
    expect(lifecycle[1]).toMatchObject({ kind: "release-session", reason: "archive" });
    expect(instance.acceptHostLifecycleResponse("desktop-socket", { ...lifecycle[1], ok: true })).toBe("accepted");
    await release;
    await expect(instance.getSessionSnapshot("profile-1", "manager-1")).resolves.toMatchObject({ hostCleanup: { kind: "release-session", reason: "archive", phase: "acknowledged" } });
  });
});
