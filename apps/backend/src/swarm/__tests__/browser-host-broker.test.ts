import { describe, expect, it, vi } from "vitest";
import type { BrowserAutomationRequest, BrowserAutomationResponse, BrowserHostLifecycleRequest, BrowserHostRegistration } from "@forge/protocol";
import { BrowserHostBroker } from "../browser-automation/browser-host-broker.js";

function registration(version = 2): BrowserHostRegistration {
  return {
    hostId: "desktop", clientInstanceId: "desktop-instance", registeredAt: "2026-07-27T00:00:00.000Z",
    capabilities: {
      protocolVersions: { minimum: version, maximum: version }, supportedOperations: ["status", "open", "snapshot"],
      maxResponseBytes: 100_000,
    },
  };
}

function response(request: BrowserAutomationRequest): BrowserAutomationResponse {
  return {
    requestId: request.requestId, sessionAgentId: request.sessionAgentId, profileId: request.profileId,
    tabId: request.tabId, hostId: request.hostId, hostGeneration: request.hostGeneration,
    operation: request.operation, ok: false, error: { code: "execution-failed", message: "synthetic", retryable: false }, elapsedMs: 1,
  };
}

describe("BrowserHostBroker protocol v2", () => {
  it("owns exactly one Desktop registration and rejects v1", () => {
    const broker = new BrowserHostBroker();
    expect(() => broker.register({ connectionId: "old", registration: registration(1), sendRequest: () => undefined }))
      .toThrow(/Desktop update required/);
    expect(broker.register({ connectionId: "one", registration: registration(), sendRequest: () => undefined })).toMatchObject({ hostGeneration: 1 });
    expect(broker.register({ connectionId: "two", registration: { ...registration(), hostId: "replacement" }, sendRequest: () => undefined })).toMatchObject({ hostGeneration: 2, hostId: "replacement" });
    expect(broker.getConnectionSnapshots()).toHaveLength(1);
  });

  it("dispatches tabless operations and correlates the one host generation", async () => {
    const sent: BrowserAutomationRequest[] = [];
    const broker = new BrowserHostBroker({ requestId: () => "request-1" });
    broker.register({ connectionId: "socket", registration: registration(), sendRequest: (request) => sent.push(request) });
    const pending = broker.request({ sessionAgentId: "manager", profileId: "profile", tabId: null, operation: "snapshot", input: {} });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).not.toHaveProperty("hostKind");
    expect(sent[0]).toMatchObject({ tabId: null, operation: "snapshot", hostGeneration: 1 });
    expect(broker.acceptResponse("wrong", response(sent[0]!))).toBe("wrong-connection");
    expect(broker.acceptResponse("socket", response(sent[0]!))).toBe("accepted");
    await expect(pending).resolves.toMatchObject({ ok: false, tabId: null });
    expect(broker.acceptResponse("socket", response(sent[0]!))).toBe("duplicate");
  });

  it("uses explicit correlated lifecycle requests rather than status tunneling", async () => {
    const sent: BrowserHostLifecycleRequest[] = [];
    const broker = new BrowserHostBroker({ requestId: () => "lifecycle-1" });
    broker.register({ connectionId: "socket", registration: registration(), sendRequest: () => undefined, sendLifecycleRequest: (request) => sent.push(request) });
    const pending = broker.requestLifecycle({ sessionAgentId: "manager", profileId: "profile", kind: "turn-ended", turnId: "turn-1" });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ requestId: "lifecycle-1", sessionAgentId: "manager", profileId: "profile", hostId: "desktop", hostGeneration: 1, kind: "turn-ended", turnId: "turn-1" });
    expect(broker.acceptLifecycleResponse("socket", { ...sent[0], ok: true })).toBe("accepted");
    await expect(pending).resolves.toMatchObject({ ok: true, kind: "turn-ended", turnId: "turn-1" });

    const retry = broker.requestLifecycle({ requestId: "lifecycle-1", sessionAgentId: "manager", profileId: "profile", kind: "turn-ended", turnId: "turn-1" });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(broker.acceptLifecycleResponse("socket", { ...sent[1]!, ok: true })).toBe("accepted");
    await expect(retry).resolves.toMatchObject({ ok: true, requestId: "lifecycle-1" });
  });

  it("rejects unsupported operations and disconnects pending work", async () => {
    const broker = new BrowserHostBroker();
    await expect(broker.request({ sessionAgentId: "manager", profileId: "profile", tabId: null, operation: "status", input: {} }))
      .rejects.toMatchObject({ failure: { code: "unavailable-host" } });
    broker.register({ connectionId: "socket", registration: { ...registration(), capabilities: { ...registration().capabilities, supportedOperations: ["open"] } }, sendRequest: () => undefined });
    await expect(broker.request({ sessionAgentId: "manager", profileId: "profile", tabId: null, operation: "snapshot", input: {} }))
      .rejects.toMatchObject({ failure: { code: "unsupported-operation" } });
  });
});
