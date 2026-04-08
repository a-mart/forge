import { createHmac } from "node:crypto";
import type { TerminalCloseReason, TerminalWsClientControlMessage, TerminalWsServerControlMessage } from "@forge/protocol";
import { cloneDescriptor, safeEqual } from "./terminal-service-helpers.js";
import { TerminalServiceError, type AttachedClient, type TerminalRestoreData, type TerminalServiceContext } from "./terminal-service-types.js";
import type { TerminalTransportInboundEvent } from "./terminal-transport.js";

export class TerminalServiceClientController {
  constructor(private readonly context: TerminalServiceContext) {}

  async issueWsTicket(input: {
    terminalId: string;
    sessionAgentId: string;
  }): Promise<import("@forge/protocol").TerminalIssueTicketResponse> {
    this.context.requireRuntime(input.terminalId, input.sessionAgentId);
    if (!this.context.runtimeConfig.enabled || this.context.getShuttingDown()) {
      throw new TerminalServiceError("SERVICE_SHUTTING_DOWN", "Terminal service is shutting down.");
    }
    if (!(await this.context.ptyRuntime.isAvailable())) {
      throw new TerminalServiceError("PTY_UNAVAILABLE", "Integrated terminals require node-pty.");
    }

    const expiresAt = this.context.now().getTime() + this.context.runtimeConfig.wsTicketTtlMs;
    const payload = `${input.terminalId}:${input.sessionAgentId}:${expiresAt}`;
    const signature = createHmac("sha256", this.context.ticketSecret).update(payload).digest("base64url");
    return {
      ticket: `${payload}:${signature}`,
      ticketExpiresAt: new Date(expiresAt).toISOString(),
    };
  }

  validateWsTicket(input: {
    terminalId: string;
    sessionAgentId: string;
    ticket: string;
  }): boolean {
    const parts = input.ticket.split(":");
    if (parts.length !== 4) {
      return false;
    }

    const [terminalId, sessionAgentId, expiresAtRaw, signature] = parts;
    if (terminalId !== input.terminalId || sessionAgentId !== input.sessionAgentId) {
      return false;
    }

    const expiresAt = Number.parseInt(expiresAtRaw, 10);
    if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
      return false;
    }

    const payload = `${terminalId}:${sessionAgentId}:${expiresAt}`;
    const expected = createHmac("sha256", this.context.ticketSecret).update(payload).digest("base64url");

    return safeEqual(signature, expected);
  }

  async getRestoreData(terminalId: string): Promise<TerminalRestoreData> {
    const runtime = this.context.requireRuntimeById(terminalId);
    const state = await this.context.persistence.readReplayData(runtime.meta);
    return {
      terminal: cloneDescriptor(runtime.descriptor),
      replay: state.replay,
    };
  }

  async attachClient(input: {
    terminalId: string;
    sessionAgentId: string;
    onData: (chunk: Buffer) => void;
    onControl: (message: TerminalWsServerControlMessage) => void;
  }): Promise<() => void> {
    const runtime = this.context.requireRuntime(input.terminalId, input.sessionAgentId);
    const client: AttachedClient = {
      onData: input.onData,
      onControl: input.onControl,
    };

    await this.context.withRuntimeLock(runtime, async () => {
      this.context.assertNotClosing(runtime);
      const restore = await this.context.persistence.readReplayData(runtime.meta);

      runtime.attachedClients.add(client);

      try {
        input.onControl({
          channel: "control",
          type: "ready",
          terminalId: runtime.meta.terminalId,
          sessionAgentId: runtime.meta.sessionAgentId,
          cols: runtime.meta.cols,
          rows: runtime.meta.rows,
          state: runtime.meta.state,
          recoveredFromPersistence: runtime.meta.recoveredFromPersistence,
        });

        if (restore.replay.length > 0) {
          input.onData(restore.replay);
        }

        if (runtime.meta.state === "exited" || runtime.meta.state === "restore_failed") {
          input.onControl({
            channel: "control",
            type: "exit",
            exitCode: runtime.meta.exitCode,
            exitSignal: runtime.meta.exitSignal,
          });
        }
      } catch (error) {
        runtime.attachedClients.delete(client);
        throw error;
      }
    });

    return () => {
      runtime.attachedClients.delete(client);
    };
  }

  async handleClientControl(input: {
    terminalId: string;
    sessionAgentId: string;
    message: TerminalWsClientControlMessage;
    reply: (message: TerminalWsServerControlMessage) => void;
  }): Promise<void> {
    if (input.message.type === "ping") {
      input.reply({ channel: "control", type: "pong" });
      return;
    }

    if (input.message.type === "resize") {
      await this.context.resize(input.terminalId, input.sessionAgentId, input.message.cols, input.message.rows);
    }
  }

  async handleTransportEvent(event: TerminalTransportInboundEvent): Promise<void> {
    switch (event.type) {
      case "input": {
        const payload = event.payload as { terminalId: string; sessionAgentId: string; data: Buffer };
        await this.context.handleInput(payload.terminalId, payload.data, payload.sessionAgentId);
        return;
      }
      case "resize": {
        const payload = event.payload as { terminalId: string; sessionAgentId: string; cols: number; rows: number };
        await this.context.resize(payload.terminalId, payload.sessionAgentId, payload.cols, payload.rows);
        return;
      }
      case "close": {
        const payload = event.payload as {
          terminalId: string;
          sessionAgentId: string;
          reason?: TerminalCloseReason;
        };
        await this.context.close(payload.terminalId, payload.sessionAgentId, payload.reason ?? "user_closed");
        return;
      }
      default:
        return;
    }
  }
}
