import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";

export type JsonRpcRequestId = string | number;

export interface JsonRpcRequestMessage {
  id: JsonRpcRequestId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotificationMessage {
  method: string;
  params?: unknown;
}

interface JsonRpcResponseMessage {
  id: JsonRpcRequestId;
  result: unknown;
}

interface JsonRpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcErrorMessage {
  id: JsonRpcRequestId;
  error: JsonRpcErrorPayload;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | undefined;
}

interface CodexJsonRpcClientOptions {
  command: string;
  args: string[];
  processLabel?: string;
  spawnOptions?: Omit<SpawnOptionsWithoutStdio, "stdio">;
  onNotification?: (notification: JsonRpcNotificationMessage) => void | Promise<void>;
  onRequest?: (request: JsonRpcRequestMessage) => Promise<unknown>;
  onExit?: (error: Error) => void;
  onStderr?: (line: string) => void;
}

export class CodexJsonRpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly stdoutReader: ReadLineInterface;
  private readonly stderrReader: ReadLineInterface;
  private readonly options: CodexJsonRpcClientOptions;

  private disposed = false;
  private nextRequestId = 0;
  private readonly pendingById = new Map<string, PendingRequest>();

  constructor(options: CodexJsonRpcClientOptions) {
    this.options = options;

    this.child = spawn(options.command, options.args, {
      ...options.spawnOptions,
      stdio: "pipe"
    });

    this.stdoutReader = createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity
    });

    this.stderrReader = createInterface({
      input: this.child.stderr,
      crlfDelay: Infinity
    });

    this.stdoutReader.on("line", (line) => {
      void this.handleStdoutLine(line);
    });

    this.stderrReader.on("line", (line) => {
      this.options.onStderr?.(line);
    });

    this.child.on("error", (error) => {
      this.handleProcessExit(error instanceof Error ? error : new Error(String(error)));
    });

    this.child.on("exit", (code, signal) => {
      if (this.disposed) {
        return;
      }

      const processLabel = this.options.processLabel ?? "Codex app-server";
      const error = new Error(`${processLabel} exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
      this.handleProcessExit(error);
    });
  }

  async request<T>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    this.ensureReady();

    const id = ++this.nextRequestId;
    const message: JsonRpcRequestMessage = {
      id,
      method,
      params
    };

    const key = toRequestKey(id);

    return await new Promise<T>((resolve, reject) => {
      const timeout =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pendingById.delete(key);
              reject(new Error(`JSON-RPC request timed out: ${method}`));
            }, timeoutMs)
          : undefined;

      this.pendingById.set(key, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout
      });

      try {
        this.writeMessage(message);
      } catch (error) {
        this.clearPending(key);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.ensureReady();

    const message: JsonRpcNotificationMessage = {
      method,
      params
    };

    this.writeMessage(message);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;

    this.stdoutReader.close();
    this.stderrReader.close();

    this.child.stdin.end();
    if (!this.child.killed) {
      this.child.kill();
    }

    this.rejectAllPending(new Error("JSON-RPC client disposed"));
  }

  private ensureReady(): void {
    if (this.disposed) {
      throw new Error("JSON-RPC client is disposed");
    }

    if (!this.child.stdin.writable) {
      throw new Error("JSON-RPC stdin is not writable");
    }
  }

  private writeMessage(message: unknown): void {
    const payload = `${JSON.stringify(message)}\n`;
    this.child.stdin.write(payload, "utf8");
  }

  private async handleStdoutLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      return;
    }

    if (isJsonRpcResponseMessage(parsed)) {
      this.resolvePending(parsed.id, parsed.result);
      return;
    }

    if (isJsonRpcErrorMessage(parsed)) {
      this.rejectPendingWithPayload(parsed.id, parsed.error);
      return;
    }

    if (isJsonRpcRequestMessage(parsed)) {
      await this.handleServerRequest(parsed);
      return;
    }

    if (isJsonRpcNotificationMessage(parsed)) {
      await this.options.onNotification?.(parsed);
    }
  }

  private async handleServerRequest(request: JsonRpcRequestMessage): Promise<void> {
    if (!this.options.onRequest) {
      const error: JsonRpcErrorMessage = {
        id: request.id,
        error: {
          code: -32601,
          message: `Unsupported server request: ${request.method}`
        }
      };

      this.writeMessage(error);
      return;
    }

    try {
      const result = await this.options.onRequest(request);
      const response: JsonRpcResponseMessage = {
        id: request.id,
        result: result ?? {}
      };
      this.writeMessage(response);
    } catch (error) {
      const payload: JsonRpcErrorMessage = {
        id: request.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error)
        }
      };

      this.writeMessage(payload);
    }
  }

  private resolvePending(id: JsonRpcRequestId, result: unknown): void {
    const key = toRequestKey(id);
    const pending = this.clearPending(key);
    if (!pending) {
      return;
    }

    pending.resolve(result);
  }

  private rejectPendingWithPayload(id: JsonRpcRequestId, payload: JsonRpcErrorPayload): void {
    const key = toRequestKey(id);
    const pending = this.clearPending(key);
    if (!pending) {
      return;
    }

    const error = new Error(payload.message);
    (error as Error & { code?: number; data?: unknown }).code = payload.code;
    (error as Error & { code?: number; data?: unknown }).data = payload.data;
    pending.reject(error);
  }

  private clearPending(key: string): PendingRequest | undefined {
    const pending = this.pendingById.get(key);
    if (!pending) {
      return undefined;
    }

    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }

    this.pendingById.delete(key);
    return pending;
  }

  private rejectAllPending(error: Error): void {
    for (const [key, pending] of this.pendingById.entries()) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
      this.pendingById.delete(key);
      pending.reject(error);
    }
  }

  private handleProcessExit(error: Error): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.rejectAllPending(error);
    this.options.onExit?.(error);
  }
}

function toRequestKey(id: JsonRpcRequestId): string {
  return typeof id === "number" ? `n:${id}` : `s:${id}`;
}

function isJsonRpcRequestMessage(value: unknown): value is JsonRpcRequestMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as {
    id?: unknown;
    method?: unknown;
  };

  return (typeof maybe.id === "string" || typeof maybe.id === "number") && typeof maybe.method === "string";
}

function isJsonRpcNotificationMessage(value: unknown): value is JsonRpcNotificationMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as {
    id?: unknown;
    method?: unknown;
  };

  return maybe.id === undefined && typeof maybe.method === "string";
}

function isJsonRpcResponseMessage(value: unknown): value is JsonRpcResponseMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as {
    id?: unknown;
    result?: unknown;
  };

  return (typeof maybe.id === "string" || typeof maybe.id === "number") && "result" in maybe;
}

function isJsonRpcErrorMessage(value: unknown): value is JsonRpcErrorMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as {
    id?: unknown;
    error?: unknown;
  };

  if (typeof maybe.id !== "string" && typeof maybe.id !== "number") {
    return false;
  }

  if (!maybe.error || typeof maybe.error !== "object") {
    return false;
  }

  const payload = maybe.error as { code?: unknown; message?: unknown };
  return typeof payload.code === "number" && typeof payload.message === "string";
}
