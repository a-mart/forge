import { describe, expect, it } from "vitest";
import { CodexOperationLock } from "../codex-app-server/codex-operation-lock.js";
import { CodexSidecarBusyError } from "../codex-app-server/types.js";

describe("CodexOperationLock", () => {
  it("serializes sidecar turns and direct MCP calls", () => {
    const lock = new CodexOperationLock();
    lock.acquire({ kind: "sidecar_turn", ownerId: "manager--codex" });

    expect(() =>
      lock.assertAvailable({ kind: "direct_mcp_call", ownerId: "manager" }),
    ).toThrow(CodexSidecarBusyError);

    lock.release({ kind: "sidecar_turn", ownerId: "manager--codex" });
    lock.acquire({ kind: "direct_mcp_call", ownerId: "manager" });
    expect(lock.getActiveLease()?.kind).toBe("direct_mcp_call");
  });
});
