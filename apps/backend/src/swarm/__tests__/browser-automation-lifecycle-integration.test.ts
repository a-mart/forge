import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserAutomationRequest, BrowserSessionSnapshot, BrowserTabSnapshot } from "@forge/protocol";
import { BrowserAutomationService } from "../browser-automation/browser-automation-service.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function tab(): BrowserTabSnapshot {
  return {
    targetAffinity: "managed-electron", tabId: "logical", sessionAgentId: "manager", profileId: "profile",
    url: "https://example.test", title: "Example", lifecycle: "ready", loading: false, live: true,
    canGoBack: false, canGoForward: false, zoomFactor: 1, controller: "agent", agentCursor: null, recording: null,
    viewportSetting: { mode: "fill" }, renderedViewport: null, error: null,
    createdAt: "2026-07-27T00:00:00.000Z", updatedAt: "2026-07-27T00:00:00.000Z",
  };
}

describe("browser automation production session lifecycle", () => {
  it("cancels in-flight work, projects lifecycle state live, restores, and deletes durably", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-browser-lifecycle-v2-")); roots.push(root);
    const changes: Array<{ reason: string; snapshot: BrowserSessionSnapshot }> = [];
    const service = new BrowserAutomationService({ dataDir: root, onSessionChanged: (snapshot, reason) => changes.push({ snapshot, reason }) });
    const state = await service.getSessionSnapshot("profile", "manager");
    state.tabs = [tab()]; state.activeTabId = "logical"; state.defaultTabId = "logical"; await service.store.save(state);
    const requests: BrowserAutomationRequest[] = [];
    service.registerHost({
      connectionId: "desktop", registration: {
        hostId: "automatic", clientInstanceId: "desktop", registeredAt: "2026-07-27T00:00:00.000Z",
        capabilities: { protocolVersions: { minimum: 2, maximum: 2 }, supportedOperations: ["evaluate"], maxResponseBytes: 1_000_000 },
      }, sendRequest: (request) => requests.push(request),
    });

    const pending = service.invoke("manager", "profile", "evaluate", { expression: "1", awaitPromise: true, returnByValue: true });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(service.cancelSession("manager")).toBe(1);
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "request-cancelled" } });

    const archived = await service.archiveSession("profile", "manager");
    expect(archived).toMatchObject({ schemaVersion: 2, hostingState: "unhosted", tabs: [{ live: false, controller: "none" }] });
    expect(changes.at(-1)).toMatchObject({ reason: "lifecycle", snapshot: archived });
    const restored = await service.restoreSession("profile", "manager");
    expect(restored).toMatchObject({ hostingState: "hosted", tabs: [{ lifecycle: "restoring" }] });
    expect(changes.at(-1)).toMatchObject({ reason: "recovery", snapshot: restored });

    await service.deleteSession("profile", "manager");
    await expect(service.store.load("profile", "manager")).resolves.toMatchObject({ schemaVersion: 2, tabs: [], revision: 0 });
  });
});
