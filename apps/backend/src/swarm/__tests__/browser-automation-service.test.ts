import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserAutomationRequest, BrowserAutomationResponse, BrowserHostLifecycleRequest, BrowserHostRegistration, BrowserTabSnapshot } from "@forge/protocol";
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
  it("re-registers the same renderer immediately after sleep without lifecycle cleanup", async () => {
    const instance = await service();
    const lifecycle = vi.fn();
    const host: BrowserHostRegistration = {
      hostId: "automatic-desktop", clientInstanceId: "desktop", registeredAt: "2026-07-27T00:00:00.000Z",
      capabilities: { protocolVersions: { minimum: 2, maximum: 2 }, supportedOperations: ["status"], maxResponseBytes: 1_000_000 },
    };
    instance.registerHost({ connectionId: "before-sleep", registration: host, sendRequest: () => undefined, sendLifecycleRequest: lifecycle });
    const hydrateSessionsForReplacement = vi.fn(async () => []);

    const recovered = await instance.registerHostWithLifecycleRelease({
      connectionId: "after-wake", registration: host, sendRequest: () => undefined, sendLifecycleRequest: lifecycle,
      hydrateSessionsForReplacement,
    });

    expect(recovered).toMatchObject({ connected: true, hostId: host.hostId, hostGeneration: 2 });
    expect(instance.broker.isCurrentConnection("after-wake", host.hostId, 2)).toBe(true);
    expect(hydrateSessionsForReplacement).not.toHaveBeenCalled();
    expect(lifecycle).not.toHaveBeenCalled();
  });

  it("rejects an incompatible same-socket registration before dedupe preserves the current generation", async () => {
    const instance = await service();
    const current: BrowserHostRegistration = {
      hostId: "automatic-desktop", clientInstanceId: "desktop", registeredAt: "2026-07-27T00:00:00.000Z",
      capabilities: { protocolVersions: { minimum: 2, maximum: 2 }, supportedOperations: ["status"], maxResponseBytes: 1_000_000 },
    };
    instance.registerHost({ connectionId: "desktop-socket", registration: current, sendRequest: () => undefined });
    const before = instance.broker.getConnectionSnapshot();
    const hydrateSessionsForReplacement = vi.fn(async () => []);
    const incompatible = {
      ...current,
      capabilities: { ...current.capabilities, protocolVersions: { minimum: 1, maximum: 1 } },
    };

    await expect(instance.registerHostWithLifecycleRelease({
      connectionId: "desktop-socket", registration: incompatible, sendRequest: () => undefined,
      hydrateSessionsForReplacement,
    })).rejects.toThrow("Desktop update required");

    expect(hydrateSessionsForReplacement).not.toHaveBeenCalled();
    expect(instance.broker.getConnectionSnapshot()).toEqual(before);
    expect(instance.broker.isCurrentConnection("desktop-socket", current.hostId, 1)).toBe(true);
  });

  it("deduplicates same-connection registration and prevents stale replacement cleanup from committing", async () => {
    const instance = await service();
    const original: BrowserHostRegistration = {
      hostId: "automatic-desktop", clientInstanceId: "desktop", registeredAt: "2026-07-27T00:00:00.000Z",
      capabilities: { protocolVersions: { minimum: 2, maximum: 2 }, supportedOperations: ["status"], maxResponseBytes: 1_000_000 },
    };
    instance.registerHost({ connectionId: "old-socket", registration: original, sendRequest: () => undefined });
    let releaseHydration!: () => void;
    let markHydrationStarted!: () => void;
    const hydrationStarted = new Promise<void>((resolve) => { markHydrationStarted = resolve; });
    const staleReplacement = instance.registerHostWithLifecycleRelease({
      connectionId: "stale-socket",
      registration: { ...original, hostId: "replacement-host", clientInstanceId: "replacement-renderer" },
      sendRequest: () => undefined,
      hydrateSessionsForReplacement: async () => {
        markHydrationStarted();
        await new Promise<void>((resolve) => { releaseHydration = resolve; });
        return [];
      },
    });
    await hydrationStarted;

    const afterWake = instance.registerHostWithLifecycleRelease({
      connectionId: "resumed-socket", registration: original, sendRequest: () => undefined,
    });
    const duplicateAfterWake = instance.registerHostWithLifecycleRelease({
      connectionId: "resumed-socket", registration: { ...original, registeredAt: "2026-07-27T00:00:01.000Z" }, sendRequest: () => undefined,
    });
    await expect(Promise.all([afterWake, duplicateAfterWake])).resolves.toEqual([
      expect.objectContaining({ hostGeneration: 2 }),
      expect.objectContaining({ hostGeneration: 2 }),
    ]);
    releaseHydration();
    await expect(staleReplacement).rejects.toThrow("superseded");
    expect(instance.broker.isCurrentConnection("resumed-socket", original.hostId, 2)).toBe(true);
  });

  it("replaces selectedTab:null -> failed open -> tab-not-found with tabless redispatch and adoption", async () => {
    const instance = await service();
    const requests: BrowserAutomationRequest[] = [];
    register(instance, (request) => requests.push(request));

    const status = instance.invoke("manager-1", "profile-1", "status", {});
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    accept(instance, { ...routing(requests[0]!), ok: true, result: { available: true, host: instance.broker.getConnectionSnapshot(), panelVisible: false, panelRevealRequested: false, physicalTabVisible: false, selectedTab: null, eligibleTabs: [], eligibleTabsTruncated: false } });
    await expect(status).resolves.toMatchObject({ ok: true, result: { selectedTab: null } });

    const opening = instance.invoke("manager-1", "profile-1", "open", { show: false, reuseExistingTab: true });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toMatchObject({ operation: "open", tabId: null });
    accept(instance, { ...routing(requests[1]!), ok: false, error: { code: "target-not-found", message: "old acquisition failed", retryable: true } });
    await expect(opening).resolves.toMatchObject({ ok: false, error: { code: "target-not-found" } });

    const snapshot = instance.invoke("manager-1", "profile-1", "snapshot", {});
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2]).toMatchObject({ operation: "snapshot", tabId: null });
    const adopted = tab(requests[2]!, "ext.instance_profile_a.8", "external-chrome");
    accept(instance, {
      ...routing(requests[2]!), ok: true, updatedTab: adopted,
      result: { tabId: adopted.tabId, url: "https://private.invalid/path", title: "Private", loading: false, viewportSetting: { mode: "fill" }, viewport: { width: 800, height: 600, deviceScaleFactor: 1 }, visibleText: "secret page", interactiveElements: [], accessibility: {}, consoleEntries: [], networkEntries: [], actionTimeline: [], screenshot: { mimeType: "image/png", data: "AA==", width: 1, height: 1 } },
    });
    await expect(snapshot).resolves.toMatchObject({ ok: true, result: { tabId: "ext.instance_profile_a.8" } });
    await expect(instance.getSessionSnapshot("profile-1", "manager-1")).resolves.toMatchObject({ schemaVersion: 2, activeTabId: "ext.instance_profile_a.8", defaultTabId: "ext.instance_profile_a.8", tabs: [{ tabId: "ext.instance_profile_a.8", targetAffinity: "external-chrome", url: "", title: "" }] });
  });

  it("returns live inventory and adopts an explicit inventory tab ID without persisting inventory metadata", async () => {
    const instance = await service();
    const requests: BrowserAutomationRequest[] = [];
    register(instance, (request) => requests.push(request));
    const inventoryTab = {
      targetAffinity: "external-chrome" as const,
      tabId: "ext.instance_profile_a.7",
      browserProfileId: "ext-profile.instance_profile_a",
      windowId: "ext-window.instance_profile_a.1",
      title: "Private candidate",
      url: "https://private.invalid/candidate",
      active: true,
      windowFocused: false,
      lastAccessedAt: "2026-07-27T00:00:00.000Z",
    };

    const status = instance.invoke("manager-1", "profile-1", "status", {});
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    accept(instance, {
      ...routing(requests[0]!), ok: true,
      result: {
        available: true, host: instance.broker.getConnectionSnapshot(), panelVisible: false,
        panelRevealRequested: false, physicalTabVisible: false, selectedTab: null,
        eligibleTabs: [inventoryTab], eligibleTabsTruncated: false,
      },
    });
    await expect(status).resolves.toMatchObject({ ok: true, result: { eligibleTabs: [inventoryTab] } });
    await expect(instance.getSessionSnapshot("profile-1", "manager-1")).resolves.not.toHaveProperty("eligibleTabs");

    const opening = instance.invoke("manager-1", "profile-1", "open", {
      tabId: inventoryTab.tabId, show: false, reuseExistingTab: true,
    });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toMatchObject({ operation: "open", tabId: inventoryTab.tabId });
    const adopted = tab(requests[1]!, inventoryTab.tabId, "external-chrome");
    accept(instance, {
      ...routing(requests[1]!), ok: true, updatedTab: adopted,
      result: { tab: adopted, created: false, panelRevealRequested: false },
    });
    await expect(opening).resolves.toMatchObject({ ok: true, result: { tab: { tabId: inventoryTab.tabId } } });
    await expect(instance.getSessionSnapshot("profile-1", "manager-1")).resolves.toMatchObject({
      activeTabId: inventoryTab.tabId,
      tabs: [{ tabId: inventoryTab.tabId, targetAffinity: "external-chrome", url: "", title: "" }],
    });
  });

  it("rejects noncanonical External Chrome inventory identity relationships", async () => {
    const instance = await service();
    const requests: BrowserAutomationRequest[] = [];
    register(instance, (request) => requests.push(request));

    const status = instance.invoke("manager-1", "profile-1", "status", {});
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    accept(instance, {
      ...routing(requests[0]!), ok: true,
      result: {
        available: true, host: instance.broker.getConnectionSnapshot(), panelVisible: false,
        panelRevealRequested: false, physicalTabVisible: false, selectedTab: null,
        eligibleTabs: [{
          targetAffinity: "external-chrome", tabId: "ext.profile_a.7", browserProfileId: "ext-profile.profile_b",
          windowId: "ext-window.profile_a.1", title: "Mismatch", url: "https://private.invalid/",
          active: true, windowFocused: false, lastAccessedAt: "2026-07-27T00:00:00.000Z",
        }],
        eligibleTabsTruncated: false,
      },
    });
    await expect(status).resolves.toMatchObject({ ok: false, error: { code: "malformed-response" } });
  });

  it("creates and selects a distinct tab when open disables selected-tab reuse", async () => {
    const instance = await service();
    const requests: BrowserAutomationRequest[] = [];
    register(instance, (request) => requests.push(request));

    const first = instance.invoke("manager-1", "profile-1", "open", { show: false, reuseExistingTab: false });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const firstTab = tab(requests[0]!, "logical-tab-1");
    accept(instance, { ...routing(requests[0]!), ok: true, updatedTab: firstTab, result: { tab: firstTab, created: true, panelRevealRequested: false } });
    await first;

    const second = instance.invoke("manager-1", "profile-1", "open", { show: false, reuseExistingTab: false });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toMatchObject({ operation: "open", tabId: null, input: { reuseExistingTab: false } });
    const secondTab = tab(requests[1]!, "logical-tab-2");
    accept(instance, { ...routing(requests[1]!), ok: true, updatedTab: secondTab, result: { tab: secondTab, created: true, panelRevealRequested: false } });
    await second;

    await expect(instance.getSessionSnapshot("profile-1", "manager-1")).resolves.toMatchObject({
      activeTabId: "logical-tab-2",
      defaultTabId: "logical-tab-2",
      tabs: [{ tabId: "logical-tab-1" }, { tabId: "logical-tab-2" }],
    });
  });

  it("lets tabless open reselect External Chrome from a managed fallback while later operations stay sticky", async () => {
    const instance = await service();
    const requests: BrowserAutomationRequest[] = [];
    register(instance, (request) => requests.push(request));

    const initial = instance.invoke("manager-1", "profile-1", "open", { show: false, reuseExistingTab: true });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const neutral = tab(requests[0]!, "managed-neutral", "managed-electron");
    neutral.url = "about:blank";
    accept(instance, { ...routing(requests[0]!), ok: true, updatedTab: neutral, result: { tab: neutral, created: true, panelRevealRequested: false } });
    await initial;

    const reselect = instance.invoke("manager-1", "profile-1", "open", { show: false, reuseExistingTab: true });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toMatchObject({ operation: "open", tabId: null, input: { reuseExistingTab: true } });
    const focused = tab(requests[1]!, "ext.instance_profile_a.9", "external-chrome");
    accept(instance, { ...routing(requests[1]!), ok: true, updatedTab: focused, result: { tab: focused, created: false, panelRevealRequested: false } });
    await reselect;

    const snapshot = instance.invoke("manager-1", "profile-1", "snapshot", {});
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2]).toMatchObject({ operation: "snapshot", tabId: "ext.instance_profile_a.9" });
    accept(instance, {
      ...routing(requests[2]!), ok: true, updatedTab: focused,
      result: { tabId: "ext.instance_profile_a.9", url: "https://private.invalid/path", title: "Private", loading: false, viewportSetting: { mode: "fill" }, viewport: { width: 800, height: 600, deviceScaleFactor: 1 }, visibleText: "focused page", interactiveElements: [], accessibility: {}, consoleEntries: [], networkEntries: [], actionTimeline: [], screenshot: { mimeType: "image/png", data: "AA==", width: 1, height: 1 } },
    });
    await expect(snapshot).resolves.toMatchObject({ ok: true, result: { tabId: "ext.instance_profile_a.9" } });
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

  it("retains a failed lifecycle receipt and retries the exact request before acknowledging cleanup", async () => {
    const instance = await service();
    const operations: BrowserAutomationRequest[] = [];
    const lifecycle: BrowserHostLifecycleRequest[] = [];
    register(instance, (request) => operations.push(request), (request) => lifecycle.push(request));
    const opening = instance.invoke("manager-1", "profile-1", "open", { show: false, reuseExistingTab: false });
    await vi.waitFor(() => expect(operations).toHaveLength(1));
    const owned = tab(operations[0]!, "logical-retry");
    accept(instance, { ...routing(operations[0]!), ok: true, updatedTab: owned, result: { tab: owned, created: true, panelRevealRequested: false } });
    await opening;

    const first = instance.releaseSessionForLifecycle("profile-1", "manager-1", "archive");
    await vi.waitFor(() => expect(lifecycle).toHaveLength(1));
    expect(instance.acceptHostLifecycleResponse("desktop-socket", {
      requestId: lifecycle[0]!.requestId, sessionAgentId: lifecycle[0]!.sessionAgentId, profileId: lifecycle[0]!.profileId,
      hostId: lifecycle[0]!.hostId, hostGeneration: lifecycle[0]!.hostGeneration, kind: "release-session", ok: false,
      error: { code: "host-disconnected", message: "ack lost", retryable: true },
    })).toBe("accepted");
    await expect(first).rejects.toMatchObject({ failure: { code: "host-disconnected" } });
    await expect(instance.getSessionSnapshot("profile-1", "manager-1")).resolves.toMatchObject({ hostCleanup: { phase: "pending" } });

    const retry = instance.releaseSessionForLifecycle("profile-1", "manager-1", "archive");
    await vi.waitFor(() => expect(lifecycle).toHaveLength(2));
    expect(lifecycle[1]!.requestId).toBe(lifecycle[0]!.requestId);
    expect(instance.acceptHostLifecycleResponse("desktop-socket", { ...lifecycle[1], ok: true })).toBe("accepted");
    await retry;
    await expect(instance.getSessionSnapshot("profile-1", "manager-1")).resolves.toMatchObject({ hostCleanup: { phase: "acknowledged" } });
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
