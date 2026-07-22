import { describe, expect, it, vi } from "vitest";
import type {
  BrowserAutomationRequest,
  BrowserSessionSnapshot,
  BrowserTabSnapshot,
  ServerEvent,
} from "@forge/protocol";
import type { WebSocket } from "ws";
import { makeTempConfig, TestSwarmManager, bootWithDefaultManager } from "../../test-support/index.js";
import type { SidebarPerfRecorder } from "../../stats/sidebar-perf-types.js";
import { sendSubscriptionBootstrap } from "../../ws/ws-bootstrap.js";
import { BrowserAutomationService } from "../browser-automation/browser-automation-service.js";

const NOW = "2026-07-22T16:00:00.000Z";

function makeTab(profileId: string, sessionAgentId: string): BrowserTabSnapshot {
  return {
    tabId: "tab-lifecycle",
    sessionAgentId,
    profileId,
    url: "https://example.com/",
    title: "Lifecycle",
    lifecycle: "ready",
    loading: false,
    live: true,
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1,
    controller: "agent",
    agentCursor: null,
    recording: null,
    viewportSetting: { mode: "fill" },
    renderedViewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function perf(): SidebarPerfRecorder {
  return {
    recordDuration: vi.fn(),
    increment: vi.fn(),
    readSummary: vi.fn(() => ({ histograms: {}, counters: {} })),
    readRecentSlowEvents: vi.fn(() => []),
  };
}

async function waitForPendingRequest(service: BrowserAutomationService): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (service.broker.getPendingCount() > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Browser request did not become pending");
}

describe("browser automation production session lifecycle", () => {
  it("cancels stop/archive work, rehydrates through events and bootstrap, then deletes state", async () => {
    const config = await makeTempConfig({
      prefix: "browser-lifecycle-integration-",
      port: 8898,
      omitSharedAuthFile: true,
      omitSharedSecretsFile: true,
      skipRepoMemorySkillPlaceholder: true,
    });
    const changes: Array<{ reason: string; snapshot: BrowserSessionSnapshot }> = [];
    const service = new BrowserAutomationService({
      dataDir: config.paths.dataDir,
      now: () => NOW,
      onSessionChanged: (snapshot, reason) => changes.push({ reason, snapshot }),
    });
    const manager = new TestSwarmManager(config, { browserAutomationService: service });
    await bootWithDefaultManager(manager, config);
    const created = await manager.createSession("manager", { label: "Browser lifecycle" });
    const { agentId } = created.sessionAgent;
    const profileId = created.sessionAgent.profileId!;
    const state = await service.getSessionSnapshot(profileId, agentId);
    state.tabs = [makeTab(profileId, agentId)];
    state.activeTabId = "tab-lifecycle";
    state.defaultTabId = "tab-lifecycle";
    state.panelVisible = true;
    await service.store.save(state);

    const requests: BrowserAutomationRequest[] = [];
    service.registerHost({
      connectionId: "socket-lifecycle",
      registration: {
        hostId: "host-lifecycle",
        clientInstanceId: "client-lifecycle",
        registeredAt: NOW,
        capabilities: {
          supportedOperations: ["evaluate"],
          electronVersion: "37.10.3",
          chromiumVersion: "138",
          playwrightVersion: "1.60.0",
          maxResponseBytes: 1_000_000,
          supportsSandboxedWebviews: true,
          supportsCapturePage: true,
          supportsRecording: true,
        },
      },
      sendRequest: (request) => {
        requests.push(request);
      },
    });

    const stoppedRequest = service.invoke(agentId, profileId, "evaluate", {
      expression: "1",
      awaitPromise: true,
      returnByValue: true,
    });
    await waitForPendingRequest(service);
    await manager.stopSession(agentId);
    await expect(stoppedRequest).resolves.toMatchObject({
      ok: false,
      error: { code: "request-cancelled" },
    });
    expect(service.broker.getPendingCount()).toBe(0);
    expect((await service.getSessionSnapshot(profileId, agentId)).tabs).toEqual([
      expect.objectContaining({ tabId: "tab-lifecycle", live: true, controller: "agent" }),
    ]);

    const archivedRequest = service.invoke(agentId, profileId, "evaluate", {
      expression: "2",
      awaitPromise: true,
      returnByValue: true,
    });
    await waitForPendingRequest(service);
    await manager.archiveSession(agentId);
    await expect(archivedRequest).resolves.toMatchObject({
      ok: false,
      error: { code: "request-cancelled" },
    });
    const archived = await service.getSessionSnapshot(profileId, agentId);
    expect(archived).toMatchObject({
      hostingState: "unhosted",
      panelVisible: false,
      tabs: [{ tabId: "tab-lifecycle", live: false, controller: "none", recording: null }],
    });
    expect(changes.at(-1)).toMatchObject({ reason: "lifecycle" });

    await manager.restoreSession(agentId);
    const restored = await service.getSessionSnapshot(profileId, agentId);
    expect(restored.tabs).toEqual([
      expect.objectContaining({ tabId: "tab-lifecycle", live: false, lifecycle: "restoring" }),
    ]);
    expect(restored.hostingState).toBe("hosted");
    expect(changes.at(-1)).toMatchObject({
      reason: "recovery",
      snapshot: { sessionAgentId: agentId, profileId, hostingState: "hosted" },
    });

    const events: ServerEvent[] = [];
    await sendSubscriptionBootstrap({
      socket: {} as WebSocket,
      targetAgentId: agentId,
      swarmManager: manager,
      browserAutomationService: service,
      terminalService: null,
      unreadTracker: null,
      perf: perf(),
      send: (_socket, event) => {
        events.push(event);
        return 1;
      },
      resolveTerminalScopeAgentId: () => undefined,
      resolvePlanSnapshotSessionAgentId: () => agentId,
      resolveBrowserSessionAgentId: () => agentId,
    });
    expect(events.find((event) => event.type === "browser_session_snapshot")).toEqual({
      type: "browser_session_snapshot",
      snapshot: restored,
    });

    expect(requests).toHaveLength(2);
    await manager.deleteSession(agentId);
    expect(service.getLoadedSessionSnapshots().some((snapshot) => snapshot.sessionAgentId === agentId)).toBe(false);
    await expect(service.store.load(profileId, agentId)).resolves.toMatchObject({
      tabs: [],
      recentActions: [],
      revision: 0,
    });
  });
});
