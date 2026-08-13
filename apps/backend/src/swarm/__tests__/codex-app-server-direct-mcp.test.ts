import { describe, expect, it } from "vitest";
import { CodexAppServerService } from "../codex-app-server/codex-app-server-service.js";
import type {
  CodexAppServerClientHandlers,
  CodexAppServerClientPort,
  CodexSidecarHost,
} from "../codex-app-server/types.js";
import { createManagerDescriptor } from "../../test-support/fixtures.js";

class FakeDirectMcpClient implements CodexAppServerClientPort {
  readonly requests: Array<{ method: string; params?: unknown }> = [];

  constructor(readonly handlers: CodexAppServerClientHandlers) {}

  async connect(): Promise<void> {}

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });

    if (method === "plugin/list") {
      return { plugins: [] } as T;
    }

    if (method === "app/list") {
      return { apps: [{ id: "fireflies", name: "Fireflies" }] } as T;
    }

    if (method === "mcpServerStatus/list") {
      return {
        servers: [
          {
            name: "fireflies",
            tools: [
              {
                name: "list_recent",
                readOnly: true,
                annotations: { readOnlyHint: true },
                inputSchema: { type: "object", properties: { limit: { type: "integer" } }, required: ["limit"] },
              },
            ],
          },
        ],
      } as T;
    }

    if (method === "thread/start") {
      expect((params as { ephemeral?: boolean }).ephemeral).toBe(true);
      return { thread: { id: "ephemeral-thread-1" } } as T;
    }

    if (method === "mcpServer/tool/call") {
      return { content: [{ type: "text", text: "ok" }] } as T;
    }

    throw new Error(`Unexpected method: ${method}`);
  }

  notify(): void {}
  dispose(): void {}
  isDisposed(): boolean {
    return false;
  }
}

function createHost(): CodexSidecarHost {
  const upserted: unknown[] = [];
  return {
    now: () => new Date().toISOString(),
    logDebug: () => {},
    getDescriptor: () => undefined,
    upsertDescriptor: (descriptor) => {
      upserted.push(descriptor);
    },
    saveStore: async () => {},
    ensureSessionFileParentDirectory: async () => {},
    appendConversationEntry: () => {},
    emitConversationMessage: () => {},
    emitConversationLog: () => {},
    emitAgentMessage: () => {},
    emitAgentToolCall: () => {},
    emitStatus: () => {},
    reportAttentionStatusTransition: async () => {},
    emitAgentsSnapshot: () => {},
    emitProfilesSnapshot: () => {},
    listWorkersForSession: () => [],
    getUpsertedForTest: () => upserted,
  } as CodexSidecarHost & { getUpsertedForTest: () => unknown[] };
}

describe("CodexAppServerService direct MCP (minimal)", () => {
  it("uses ephemeral threads and does not create sidecar descriptors", async () => {
    const host = createHost();
    const hostWithTest = host as CodexSidecarHost & { getUpsertedForTest: () => unknown[] };
    const service = new CodexAppServerService(host, {
      dataDir: "/tmp/forge-data",
      createClient: (handlers) => new FakeDirectMcpClient(handlers),
    });

    const manager = createManagerDescriptor("/tmp", { agentId: "manager", cwd: "/tmp/project" });
    const result = await service.callCodexMcpTool({
      managerAgentId: manager.agentId,
      cwd: manager.cwd!,
      selector: "fireflies/list_recent",
      args: { limit: 1 },
    });

    expect(result.ok).toBe(true);
    expect(hostWithTest.getUpsertedForTest()).toHaveLength(0);
    const client = service.getSharedClientForTest() as FakeDirectMcpClient;
    expect(client.requests.some((entry) => entry.method === "thread/start")).toBe(true);
    expect(client.requests.find((entry) => entry.method === "thread/resume")).toBeUndefined();
  });

  it("blocks direct MCP while a sidecar turn holds the operation lock", async () => {
    const host = createHost();
    const service = new CodexAppServerService(host, {
      dataDir: "/tmp/forge-data",
      createClient: (handlers) => new FakeDirectMcpClient(handlers),
    });

    service.getOperationLockForTest().acquire({ kind: "sidecar_turn", ownerId: "manager--codex" });

    await expect(
      service.callCodexMcpTool({
        managerAgentId: "manager",
        cwd: "/tmp/project",
        selector: "fireflies/list_recent",
        args: { limit: 1 },
      }),
    ).rejects.toThrow(/busy/i);
  });
});
