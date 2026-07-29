import { describe, expect, it } from "vitest";
import { BROWSER_AUTOMATION_OPERATIONS, EXTERNAL_CHROME_M4_SUPPORTED_OPERATIONS, type BrowserAutomationRequest, type BrowserAutomationResponse, type BrowserTabSnapshot } from "@forge/protocol";
import { AutomaticBrowserHost } from "../../../../electron/src/browser/automatic-browser-host.js";
import type { AutomaticExternalBrowserAdapter, BrowserTargetAdapter } from "../../../../electron/src/browser/browser-target-adapter.js";
import { BrowserHostBroker } from "../browser-automation/browser-host-broker.js";

class ManagedBoundaryAdapter implements BrowserTargetAdapter {
  readonly targetAffinity = "managed-electron" as const;
  readonly capabilities = { supportedOperations: BROWSER_AUTOMATION_OPERATIONS, physicalViewport: true, recording: true, reveal: false } as const;
  execute(request: BrowserAutomationRequest): Promise<BrowserAutomationResponse> {
    return Promise.resolve(failure(request));
  }
}

class ExternalBoundaryAdapter implements AutomaticExternalBrowserAdapter {
  readonly targetAffinity = "external-chrome" as const;
  readonly capabilities = { supportedOperations: EXTERNAL_CHROME_M4_SUPPORTED_OPERATIONS, physicalViewport: false, recording: false, reveal: true } as const;
  executedTabIds: Array<string | null> = [];
  listEligibleTabs() { return Promise.resolve({ tabs: [], truncated: false }); }
  acquireTarget(input: Parameters<AutomaticExternalBrowserAdapter["acquireTarget"]>[0]) {
    return Promise.resolve({ ok: true as const, authority: { ownerEpoch: input.ownerEpoch, tabId: "external-tab-7" } });
  }
  executeWithAuthority(input: Parameters<AutomaticExternalBrowserAdapter["executeWithAuthority"]>[0]) {
    this.executedTabIds.push(input.request.tabId);
    return Promise.resolve({ response: opened(input.request) });
  }
  execute(request: BrowserAutomationRequest): Promise<BrowserAutomationResponse> { return Promise.resolve(opened(request)); }
  releaseAuthority(): Promise<void> { return Promise.resolve(); }
  revealTarget(_session: { sessionAgentId: string; profileId: string }, tabId: string) { return Promise.resolve({ revealed: true as const, tabId }); }
}

describe("BrowserHostBroker -> real AutomaticBrowserHost correlation boundary", () => {
  it("keeps a first tabless acquisition correlated while returning target identity in the operation result", async () => {
    const external = new ExternalBoundaryAdapter();
    const host = new AutomaticBrowserHost({ managedAdapter: new ManagedBoundaryAdapter(), externalAdapter: external });
    const broker = new BrowserHostBroker({ requestId: () => "boundary-request" });
    broker.register({
      connectionId: "desktop-connection",
      registration: { hostId: "automatic-host", hostKind: "electron", capabilities: host.capabilities },
      sendRequest: async (request) => {
        const response = await host.perform(request);
        expect(broker.acceptResponse("desktop-connection", response)).toBe("accepted");
      },
    });

    const response = await broker.request({
      requestId: "tabless-open",
      sessionAgentId: "session-1",
      profileId: "profile-1",
      tabId: null,
      operation: "open",
      input: { show: false, reuseExistingTab: true },
      timeoutMs: 1_000,
    });

    expect(response).toMatchObject({
      ok: true,
      requestId: "tabless-open",
      tabId: null,
      updatedTab: { tabId: "external-tab-7", targetAffinity: "external-chrome" },
      result: { tab: { tabId: "external-tab-7" } },
    });
    expect(external.executedTabIds).toEqual(["external-tab-7"]);
    await host.destroy();
  });
});

function tab(request: BrowserAutomationRequest): BrowserTabSnapshot {
  const now = new Date(0).toISOString();
  return {
    targetAffinity: "external-chrome", tabId: request.tabId ?? "external-tab-7", sessionAgentId: request.sessionAgentId, profileId: request.profileId,
    url: "https://example.test/", title: "Example", lifecycle: "ready", loading: false, live: true,
    canGoBack: false, canGoForward: false, zoomFactor: 1, controller: "none", agentCursor: null, recording: null,
    viewportSetting: { mode: "fill" }, renderedViewport: null, physicalVisible: false, error: null, createdAt: now, updatedAt: now,
  };
}

function opened(request: BrowserAutomationRequest): BrowserAutomationResponse {
  const updatedTab = tab(request);
  return {
    requestId: request.requestId, sessionAgentId: request.sessionAgentId, profileId: request.profileId, tabId: request.tabId,
    hostId: request.hostId, hostGeneration: request.hostGeneration, operation: "open", ok: true,
    result: { tab: updatedTab, created: true, panelRevealRequested: false }, updatedTab, elapsedMs: 1,
  };
}

function failure(request: BrowserAutomationRequest): BrowserAutomationResponse {
  return {
    requestId: request.requestId, sessionAgentId: request.sessionAgentId, profileId: request.profileId, tabId: request.tabId,
    hostId: request.hostId, hostGeneration: request.hostGeneration, operation: request.operation, ok: false,
    error: { code: "unavailable-host", message: "managed fallback must not run", retryable: false }, elapsedMs: 1,
  } as BrowserAutomationResponse;
}
