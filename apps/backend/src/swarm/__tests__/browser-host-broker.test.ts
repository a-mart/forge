import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserAutomationRequest, BrowserAutomationResponse, BrowserHostRegistration } from "@forge/protocol";
import { BrowserAutomationBrokerError, BrowserHostBroker } from "../browser-automation/browser-host-broker.js";

function registration(operations: BrowserHostRegistration["capabilities"]["supportedOperations"] = ["status"]): BrowserHostRegistration {
  return {
    hostId: "host-1",
    clientInstanceId: "client-1",
    registeredAt: "2026-07-22T00:00:00.000Z",
    capabilities: {
      supportedOperations: operations,
      electronVersion: "37.10.3",
      chromiumVersion: "138",
      playwrightVersion: "1.60.0",
      maxResponseBytes: 10_000,
      supportsSandboxedWebviews: true,
      supportsCapturePage: true,
      supportsRecording: true,
    },
  };
}

function success(request: BrowserAutomationRequest): BrowserAutomationResponse {
  return {
    requestId: request.requestId,
    sessionAgentId: request.sessionAgentId,
    profileId: request.profileId,
    tabId: request.tabId,
    hostId: request.hostId,
    hostGeneration: request.hostGeneration,
    operation: "status",
    ok: true,
    elapsedMs: 2,
    result: {
      available: true,
      host: {
        connected: true,
        hostId: request.hostId,
        hostGeneration: request.hostGeneration,
        focused: false,
        capabilities: registration().capabilities,
        connectedAt: "2026-07-22T00:00:00.000Z",
      },
      panelVisible: false,
      selectedTab: null,
    },
  };
}

function requestStatus(broker: BrowserHostBroker, timeoutMs = 1_000) {
  return broker.request({
    sessionAgentId: "manager-1",
    profileId: "profile-1",
    tabId: null,
    operation: "status",
    input: {},
    timeoutMs,
  });
}

function expectBrokerCode(promise: Promise<unknown>, code: string) {
  return expect(promise).rejects.toMatchObject({
    name: "BrowserAutomationBrokerError",
    failure: { code },
  });
}

afterEach(() => vi.useRealTimers());

describe("BrowserHostBroker", () => {
  it("correlates a response and ignores duplicate, malformed, and wrong-connection replies", async () => {
    const sent: BrowserAutomationRequest[] = [];
    const broker = new BrowserHostBroker({ requestId: () => "request-1" });
    const host = broker.register({ connectionId: "socket-1", registration: registration(), sendRequest: (request) => sent.push(request) });
    expect(host.hostGeneration).toBe(1);

    const pending = requestStatus(broker);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(broker.acceptResponse("socket-1", { requestId: "request-1" })).toBe("mismatched-response");
    expect(broker.acceptResponse("socket-2", success(sent[0]!))).toBe("wrong-connection");
    expect(broker.acceptResponse("socket-1", success(sent[0]!))).toBe("accepted");
    await expect(pending).resolves.toMatchObject({ ok: true, operation: "status" });
    expect(broker.acceptResponse("socket-1", success(sent[0]!))).toBe("duplicate");
  });

  it("rejects unavailable and unsupported operations deterministically", async () => {
    const broker = new BrowserHostBroker();
    await expectBrokerCode(requestStatus(broker), "unavailable-host");
    broker.register({ connectionId: "socket-1", registration: registration(["open"]), sendRequest: () => undefined });
    await expectBrokerCode(requestStatus(broker), "unsupported-operation");
  });

  it("rejects pending calls when a registration supersedes or disconnects the host", async () => {
    const broker = new BrowserHostBroker();
    broker.register({ connectionId: "socket-1", registration: registration(), sendRequest: () => undefined });
    const superseded = requestStatus(broker);
    broker.register({ connectionId: "socket-2", registration: { ...registration(), hostId: "host-2" }, sendRequest: () => undefined });
    await expectBrokerCode(superseded, "stale-host-generation");

    const disconnected = requestStatus(broker);
    expect(broker.unregister("socket-1")).toBe(false);
    expect(broker.unregister("socket-2", "host-2", 2)).toBe(true);
    await expectBrokerCode(disconnected, "host-disconnected");
  });

  it("times out and rejects oversized responses without allowing late replies to resolve", async () => {
    vi.useFakeTimers();
    const sent: BrowserAutomationRequest[] = [];
    const broker = new BrowserHostBroker({ requestId: () => sent.length === 0 ? "timeout" : "oversize" });
    broker.register({ connectionId: "socket-1", registration: registration(), sendRequest: (request) => sent.push(request) });

    const timedOut = requestStatus(broker, 25);
    const timeoutAssertion = expectBrokerCode(timedOut, "timeout");
    await vi.advanceTimersByTimeAsync(25);
    await timeoutAssertion;
    expect(broker.acceptResponse("socket-1", success(sent[0]!))).toBe("duplicate");

    const oversized = requestStatus(broker);
    await vi.advanceTimersByTimeAsync(0);
    expect(broker.acceptResponse("socket-1", success(sent[1]!), 20_000)).toBe("accepted");
    await expectBrokerCode(oversized, "response-too-large");
  });

  it("uses typed broker errors", () => {
    const error = new BrowserAutomationBrokerError("request-cancelled", "cancelled");
    expect(error.failure).toEqual({ code: "request-cancelled", message: "cancelled", retryable: false });
  });
});
