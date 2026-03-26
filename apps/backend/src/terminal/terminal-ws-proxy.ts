import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type {
  TerminalWsClientControlMessage,
  TerminalWsServerControlMessage,
} from "@forge/protocol";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { TerminalRuntimeConfig } from "./terminal-config.js";
import { validateTerminalWsOrigin } from "./terminal-access-policy.js";
import { TerminalService, TerminalServiceError } from "./terminal-service.js";

const TERMINAL_WS_PATH_PATTERN = /^\/terminal\/ws\/([^/]+)$/;

export class TerminalWsProxy {
  private readonly terminalService: TerminalService;
  private readonly runtimeConfig: TerminalRuntimeConfig;
  private readonly wss: WebSocketServer;

  constructor(options: {
    terminalService: TerminalService;
    runtimeConfig: TerminalRuntimeConfig;
  }) {
    this.terminalService = options.terminalService;
    this.runtimeConfig = options.runtimeConfig;
    this.wss = new WebSocketServer({ noServer: true });
  }

  canHandleUpgrade(pathname: string): boolean {
    return TERMINAL_WS_PATH_PATTERN.test(pathname);
  }

  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    pathname: string,
  ): boolean {
    const match = pathname.match(TERMINAL_WS_PATH_PATTERN);
    if (!match) {
      return false;
    }

    const originValidation = validateTerminalWsOrigin(request);
    if (!originValidation.ok) {
      writeUpgradeError(socket, 403, originValidation.errorMessage);
      return true;
    }

    const terminalId = decodePathSegment(match[1]);
    if (!terminalId) {
      writeUpgradeError(socket, 400, "Invalid terminal id");
      return true;
    }

    const requestUrl = resolveUpgradeRequestUrl(request);
    const sessionAgentId = requestUrl.searchParams.get("sessionAgentId")?.trim() ?? "";
    const ticket = requestUrl.searchParams.get("ticket")?.trim() ?? "";

    if (!sessionAgentId || !ticket) {
      writeUpgradeError(socket, 400, "Missing sessionAgentId or ticket");
      return true;
    }

    if (!this.terminalService.validateWsTicket({ terminalId, sessionAgentId, ticket })) {
      writeUpgradeError(socket, 403, "Invalid or expired ticket");
      return true;
    }

    const terminal = this.terminalService.getTerminal({ terminalId, sessionAgentId });
    if (!terminal) {
      writeUpgradeError(socket, 404, "Unknown terminal");
      return true;
    }

    this.wss.handleUpgrade(request, socket, head, (client) => {
      void this.handleConnection(client, terminalId, sessionAgentId);
    });
    return true;
  }

  async stop(): Promise<void> {
    for (const client of this.wss.clients) {
      closeSocket(client, 1012, "Terminal proxy shutting down");
    }

    await new Promise<void>((resolve, reject) => {
      this.wss.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async handleConnection(
    client: WebSocket,
    terminalId: string,
    sessionAgentId: string,
  ): Promise<void> {
    let detachClient: (() => void) | null = null;
    let cleanedUp = false;

    const cleanup = (): void => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      detachClient?.();
      detachClient = null;
    };

    const sendControl = (message: TerminalWsServerControlMessage): void => {
      if (!ensureWritable(client, this.runtimeConfig.wsMaxBufferedAmountBytes)) {
        return;
      }

      try {
        client.send(JSON.stringify(message));
      } catch {
        closeSocket(client, 1011, "Failed to send control frame");
      }
    };

    const sendData = (chunk: Buffer): void => {
      if (!ensureWritable(client, this.runtimeConfig.wsMaxBufferedAmountBytes)) {
        return;
      }

      try {
        client.send(chunk, { binary: true });
      } catch {
        closeSocket(client, 1011, "Failed to send terminal output");
      }
    };

    try {
      detachClient = await this.terminalService.attachClient({
        terminalId,
        sessionAgentId,
        onData: (chunk) => {
          sendData(chunk);
        },
        onControl: (message) => {
          sendControl(message);
          if (message.type === "closed") {
            closeSocket(client, 1000, `Terminal closed: ${message.reason}`);
          }
        },
      });
    } catch (error) {
      sendControl(toServerErrorMessage(error));
      const closeCode = resolveCloseCodeForError(error) ?? 1011;
      closeSocket(client, closeCode, resolveCloseReasonForError(error, "Terminal attach failed"));
      cleanup();
      return;
    }

    client.on("message", (data, isBinary) => {
      void this.handleClientMessage({
        client,
        terminalId,
        sessionAgentId,
        data,
        isBinary,
        reply: sendControl,
      });
    });

    client.on("close", () => {
      cleanup();
    });

    client.on("error", (error) => {
      console.warn(`[terminal-ws-proxy] Client error for ${terminalId}: ${toErrorMessage(error)}`);
      cleanup();
    });
  }

  private async handleClientMessage(input: {
    client: WebSocket;
    terminalId: string;
    sessionAgentId: string;
    data: RawData;
    isBinary: boolean;
    reply: (message: TerminalWsServerControlMessage) => void;
  }): Promise<void> {
    try {
      if (input.isBinary) {
        await this.terminalService.handleInput(
          input.terminalId,
          rawDataToBuffer(input.data),
          input.sessionAgentId,
        );
        return;
      }

      const parsed = parseClientControlMessage(input.data);
      if (!parsed.ok) {
        input.reply({
          channel: "control",
          type: "error",
          code: parsed.code,
          message: parsed.message,
        });

        if (parsed.closeCode) {
          closeSocket(input.client, parsed.closeCode, parsed.message);
        }
        return;
      }

      await this.terminalService.handleClientControl({
        terminalId: input.terminalId,
        sessionAgentId: input.sessionAgentId,
        message: parsed.message,
        reply: input.reply,
      });
    } catch (error) {
      input.reply(toServerErrorMessage(error));
      const closeCode = resolveCloseCodeForError(error);
      if (closeCode) {
        closeSocket(input.client, closeCode, resolveCloseReasonForError(error, "Terminal command failed"));
      }
    }
  }
}

function parseClientControlMessage(
  raw: RawData,
):
  | { ok: true; message: TerminalWsClientControlMessage }
  | { ok: false; code: string; message: string; closeCode?: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawDataToBuffer(raw).toString("utf8"));
  } catch {
    return {
      ok: false,
      code: "INVALID_CONTROL_JSON",
      message: "Control frames must be valid JSON.",
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      code: "INVALID_CONTROL_MESSAGE",
      message: "Control message must be an object.",
      closeCode: 1003,
    };
  }

  const record = parsed as Record<string, unknown>;
  if (record.channel !== "control") {
    return {
      ok: false,
      code: "INVALID_CONTROL_CHANNEL",
      message: "Text frames must target the control channel.",
      closeCode: 1003,
    };
  }

  if (record.type === "ping") {
    return {
      ok: true,
      message: { channel: "control", type: "ping" },
    };
  }

  if (record.type === "resize") {
    const cols = record.cols;
    const rows = record.rows;
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
      return {
        ok: false,
        code: "INVALID_RESIZE",
        message: "Resize control requires integer cols and rows.",
      };
    }

    return {
      ok: true,
      message: {
        channel: "control",
        type: "resize",
        cols: cols as number,
        rows: rows as number,
      },
    };
  }

  return {
    ok: false,
    code: "UNSUPPORTED_CONTROL_MESSAGE",
    message: "Unsupported control message type.",
    closeCode: 1003,
  };
}

function ensureWritable(socket: WebSocket, maxBufferedAmountBytes: number): boolean {
  if (socket.readyState !== WebSocket.OPEN) {
    return false;
  }

  if (socket.bufferedAmount > maxBufferedAmountBytes) {
    closeSocket(socket, 1013, "Terminal connection is overloaded");
    return false;
  }

  return true;
}

function toServerErrorMessage(error: unknown): TerminalWsServerControlMessage {
  if (error instanceof TerminalServiceError) {
    return {
      channel: "control",
      type: "error",
      code: error.code,
      message: error.message,
    };
  }

  return {
    channel: "control",
    type: "error",
    code: "INTERNAL_ERROR",
    message: toErrorMessage(error),
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data.map((entry) => rawDataToBuffer(entry)));
  }

  return Buffer.from(data);
}

function resolveUpgradeRequestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
}

function resolveCloseCodeForError(error: unknown): number | undefined {
  if (
    error instanceof TerminalServiceError &&
    (error.code === "SESSION_NOT_FOUND" ||
      error.code === "TERMINAL_NOT_FOUND" ||
      error.code === "TERMINAL_SESSION_MISMATCH" ||
      error.code === "TERMINAL_ALREADY_CLOSING")
  ) {
    return 1008;
  }

  if (error instanceof TerminalServiceError && error.code === "SERVICE_SHUTTING_DOWN") {
    return 1012;
  }

  return undefined;
}

function resolveCloseReasonForError(error: unknown, fallback: string): string {
  if (error instanceof TerminalServiceError) {
    return error.message;
  }

  return fallback;
}

function decodePathSegment(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }

  try {
    const decoded = decodeURIComponent(raw).trim();
    return decoded.length > 0 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
    return;
  }

  socket.close(normalizeCloseCode(code, 1000), truncateCloseReason(reason));
}

function normalizeCloseCode(code: number | undefined, fallback: number): number {
  if (typeof code !== "number") {
    return fallback;
  }

  if (code < 1000 || code > 4999 || code === 1004 || code === 1005 || code === 1006 || code === 1015) {
    return fallback;
  }

  return code;
}

function truncateCloseReason(reason: string): string {
  const trimmed = reason.trim() || "Closing";
  return trimmed.length > 123 ? trimmed.slice(0, 123) : trimmed;
}

function writeUpgradeError(socket: Duplex, statusCode: number, message: string): void {
  socket.write(
    `HTTP/1.1 ${statusCode} ${message}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(message)}\r\n` +
      "\r\n" +
      message,
  );
  socket.destroy();
}
