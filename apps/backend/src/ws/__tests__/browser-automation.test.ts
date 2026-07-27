import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserAutomationRequest, BrowserHostRegistration, BrowserTabSnapshot, ServerEvent } from "@forge/protocol";
import type { WebSocket } from "ws";
import { BrowserAutomationService } from "../../swarm/browser-automation/browser-automation-service.js";
import { BUILDER_COMMAND_ACCESS } from "../builder-command-access.js";
import { handleBrowserCommand } from "../commands/browser-command-handler.js";
import { parseClientCommand } from "../ws-command-parser.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function registration(version = 2): BrowserHostRegistration {
  return {
    hostId: "automatic-desktop", clientInstanceId: "desktop", registeredAt: "2026-07-27T00:00:00.000Z",
    capabilities: {
      protocolVersions: { minimum: version, maximum: version }, supportedOperations: ["status", "open", "snapshot"], maxResponseBytes: 1_000_000,
      features: { resize: true, recording: true, capturePage: true, downloadEvents: true, downloadArtifacts: true, downloadOpen: true },
    },
  };
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "forge-browser-ws-v2-")); roots.push(root);
  const service = new BrowserAutomationService({ dataDir: root });
  const sent: ServerEvent[] = [];
  const common = {
    socket: {} as WebSocket, connectionId: "desktop-connection", subscribedAgentId: "manager-1", browserAutomationService: service,
    resolveManagerContextAgentId: () => "manager-1", resolveProfileIdForAgent: () => "profile-1", isEligibleLocalBuilderManager: () => true,
    send: (_socket: WebSocket, event: ServerEvent) => sent.push(event),
    sendCritical: async (_socket: WebSocket, event: ServerEvent) => { sent.push(event); return Buffer.byteLength(JSON.stringify(event)); },
    broadcastToSession: () => undefined, hydrateHostSessions: async () => [await service.getHostHydrationSnapshot("profile-1", "manager-1")],
  };
  return { service, sent, common };
}

function tab(request: BrowserAutomationRequest): BrowserTabSnapshot {
  return {
    targetAffinity: "managed-electron", tabId: "logical-1", sessionAgentId: request.sessionAgentId, profileId: request.profileId,
    url: "about:blank", title: "", lifecycle: "ready", loading: false, live: true, canGoBack: false, canGoForward: false,
    zoomFactor: 1, controller: "none", agentCursor: null, recording: null, viewportSetting: { mode: "fill" }, renderedViewport: null,
    error: null, createdAt: "2026-07-27T00:00:00.000Z", updatedAt: "2026-07-27T00:00:00.000Z",
  };
}

async function nextRequest(sent: ServerEvent[]): Promise<BrowserAutomationRequest> {
  await vi.waitFor(() => expect(sent.some((event) => event.type === "browser_automation_request")).toBe(true));
  return (sent.find((event): event is Extract<ServerEvent, { type: "browser_automation_request" }> => event.type === "browser_automation_request"))!.request;
}

describe("browser websocket protocol v2", () => {
  it("keeps automatic host commands admin-only", () => {
    for (const type of ["browser_host_register", "browser_host_hydrate", "browser_host_response", "browser_host_lifecycle_response", "browser_host_state_report", "browser_tab_open"] as const) {
      expect(BUILDER_COMMAND_ACCESS[type]).toBe("admin");
    }
  });

  it("parses only target-agnostic v2 registration and rejects unknown capability fields", () => {
    expect(parseClientCommand(Buffer.from(JSON.stringify({ type: "browser_host_register", requestId: "v2", registration: registration() }))))
      .toMatchObject({ ok: true, command: { registration: { capabilities: { protocolVersions: { minimum: 2, maximum: 2 } } } } });
    const selected = registration(); (selected.capabilities as any).unexpectedSelector = "external-chrome";
    expect(parseClientCommand(Buffer.from(JSON.stringify({ type: "browser_host_register", requestId: "selected", registration: selected }))))
      .toEqual({ ok: false, error: "registration.capabilities contains an unsupported field" });
  });

  it("registers one host, hydrates the same v2 projection, and routes a tabless open", async () => {
    const { service, sent, common } = await harness();
    await handleBrowserCommand({ ...common, command: { type: "browser_host_register", requestId: "register", registration: registration() } });
    expect(sent[0]).toMatchObject({ type: "browser_host_connected", host: { hostGeneration: 1 } });
    await handleBrowserCommand({ ...common, command: { type: "browser_host_hydrate", requestId: "hydrate", hostId: "automatic-desktop", hostGeneration: 1 } });
    const hydration = sent.find((event): event is Extract<ServerEvent, { type: "browser_host_hydration_chunk" }> => event.type === "browser_host_hydration_chunk")!;
    expect(JSON.parse(Buffer.from(hydration.payloadBase64, "base64").toString("utf8"))[0]).toMatchObject({ schemaVersion: 2 });

    sent.length = 0;
    const opening = handleBrowserCommand({ ...common, command: { type: "browser_tab_open", requestId: "open", sessionAgentId: "manager-1", profileId: "profile-1" } });
    const request = await nextRequest(sent);
    expect(request).toMatchObject({ operation: "open", tabId: null });
    const opened = tab(request);
    await handleBrowserCommand({ ...common, command: { type: "browser_host_response", response: {
      requestId: request.requestId, sessionAgentId: request.sessionAgentId, profileId: request.profileId, tabId: null,
      hostId: request.hostId, hostGeneration: request.hostGeneration, operation: "open", ok: true, elapsedMs: 1,
      updatedTab: opened, result: { tab: opened, created: true, panelRevealRequested: false },
    } } });
    await opening;
    expect(sent.find((event) => event.type === "browser_tab_command_succeeded")).toMatchObject({ snapshot: { schemaVersion: 2, activeTabId: "logical-1" } });
    expect(service.broker.getConnectionSnapshots()).toHaveLength(1);
  });

  it("routes explicit lifecycle acknowledgements separately from automation responses", async () => {
    const parsed = parseClientCommand(Buffer.from(JSON.stringify({ type: "browser_host_lifecycle_response", response: {
      requestId: "life", sessionAgentId: "manager-1", profileId: "profile-1", hostId: "automatic-desktop", hostGeneration: 1,
      kind: "release-session", reason: "archive", ok: true,
    } })));
    expect(parsed).toMatchObject({ ok: true, command: { type: "browser_host_lifecycle_response", response: { kind: "release-session", reason: "archive" } } });
  });
});
