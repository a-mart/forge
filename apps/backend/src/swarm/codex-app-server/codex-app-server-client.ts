import type { SpawnOptionsWithoutStdio } from "node:child_process";
import {
  StdioJsonRpcClient,
  type JsonRpcNotificationMessage,
  type JsonRpcRequestMessage,
} from "../stdio-jsonrpc-client.js";
import {
  handleCodexAppServerServerRequest,
  isSupportedCodexAppServerServerRequest,
} from "./codex-app-server-request-handlers.js";
import { sanitizeCodexStderrLine } from "./codex-sidecar-ids.js";

import type { CodexAppServerClientHandlers, CodexAppServerClientPort } from "./types.js";

const DEFAULT_PROCESS_LABEL = "Codex app-server";

export function resolveCodexAppServerBinary(): string {
  const fromEnv = process.env.CODEX_BIN?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  return process.platform === "win32" ? "codex.cmd" : "codex";
}

export function createCodexAppServerClient(
  handlers: CodexAppServerClientHandlers,
  options?: {
    command?: string;
    args?: string[];
    spawnOptions?: Omit<SpawnOptionsWithoutStdio, "stdio">;
    processLabel?: string;
  },
): CodexAppServerClientPort {
  const rpc = new StdioJsonRpcClient({
    command: options?.command ?? resolveCodexAppServerBinary(),
    args: options?.args ?? ["app-server", "--listen", "stdio://"],
    processLabel: options?.processLabel ?? DEFAULT_PROCESS_LABEL,
    spawnOptions: options?.spawnOptions,
    onNotification: async (notification: JsonRpcNotificationMessage) => {
      await handlers.onNotification?.(notification.method, notification.params);
    },
    onRequest: async (request: JsonRpcRequestMessage) => {
      if (handlers.onRequest) {
        return handlers.onRequest(request.method, request.params);
      }

      if (isSupportedCodexAppServerServerRequest(request.method)) {
        return handleCodexAppServerServerRequest(request);
      }

      throw new Error(`Unsupported Codex app-server server request: ${request.method}`);
    },
    onExit: handlers.onExit,
    stderrContext: sanitizeCodexStderrLine,
    onStderr: (line) => {
      const sanitized = sanitizeCodexStderrLine(line);
      if (sanitized) {
        handlers.onStderr?.(sanitized);
      }
    },
  });

  return new CodexAppServerClientAdapter(rpc);
}

class CodexAppServerClientAdapter implements CodexAppServerClientPort {
  private connected = false;
  private disposed = false;

  constructor(private readonly rpc: StdioJsonRpcClient) {}

  async connect(): Promise<void> {
    if (this.disposed) {
      throw new Error("Codex app-server client is disposed");
    }

    if (this.connected) {
      return;
    }

    try {
      await this.rpc.request("initialize", {
        clientInfo: {
          name: "forge",
          title: "Forge",
          version: "1.0.0",
        },
        capabilities: {
          experimentalApi: true,
        },
      });

      this.rpc.notify("initialized");
      this.connected = true;
    } catch (error) {
      this.disposed = true;
      this.rpc.dispose();
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    return this.rpc.request<T>(method, params, timeoutMs);
  }

  notify(method: string, params?: unknown): void {
    this.rpc.notify(method, params);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.connected = false;
    this.rpc.dispose();
  }

  isDisposed(): boolean {
    return this.disposed;
  }
}
