import { describe, expect, it, vi } from "vitest";
import { CodexElicitationBroker } from "../codex-app-server/codex-elicitation-broker.js";

describe("CodexElicitationBroker", () => {
  const active = { managerAgentId: "manager", sidecarAgentId: "manager--codex", threadId: "thread", turnId: "turn" };
  const params = { threadId: "thread", turnId: "turn", message: "Authorize sign in", requestedSchema: { type: "object", required: ["token"], properties: { token: { type: "string", format: "password", default: "must-not-leak" } } }, _meta: { persist: ["session", "always", "global"] } };

  it("only emits a correlated direct request and never exposes meta or defaults", async () => {
    const emit = vi.fn();
    const broker = new CodexElicitationBroker({ emit, dismiss: vi.fn(), logDebug: vi.fn() });
    const pending = broker.request({ params, active });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ managerAgentId: "manager", persistScopes: ["session", "always"], fields: [expect.objectContaining({ key: "token", sensitive: true })] }));
    expect(JSON.stringify(emit.mock.calls[0]?.[0])).not.toContain("must-not-leak");
    const id = emit.mock.calls[0]?.[0].elicitationId as string;
    expect(broker.respond({ elicitationId: id, managerAgentId: "manager", decision: "allow", values: { token: "secret" }, persistScope: "session" })).toBe(true);
    await expect(pending).resolves.toEqual({ action: "accept", content: { token: "secret" }, _meta: { persist: "session" } });
  });

  it("fails closed for stale requests and rejects unavailable persistence", async () => {
    const emit = vi.fn();
    const broker = new CodexElicitationBroker({ emit, dismiss: vi.fn(), logDebug: vi.fn() });
    await expect(broker.request({ params: { ...params, turnId: "old" }, active })).resolves.toEqual({ action: "decline" });
    const pending = broker.request({ params: { ...params, _meta: {} }, active });
    const id = emit.mock.calls[0]?.[0].elicitationId as string;
    expect(broker.respond({ elicitationId: id, managerAgentId: "manager", decision: "allow", values: { token: "secret" }, persistScope: "always" })).toBe(false);
    broker.cancelForSidecar("manager--codex");
    await expect(pending).resolves.toEqual({ action: "cancel" });
  });
});
