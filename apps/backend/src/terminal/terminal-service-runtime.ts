import type { ActiveTerminalRuntime, TerminalExitEvent, TerminalOutputEvent, TerminalServiceContext } from "./terminal-service-types.js";
import { TerminalServiceError } from "./terminal-service-types.js";
import { toErrorMessage } from "./terminal-service-helpers.js";

export class TerminalServiceRuntimeController {
  constructor(private readonly context: TerminalServiceContext) {}

  async handleInput(terminalId: string, data: Buffer | string, sessionAgentId?: string): Promise<void> {
    const runtime = sessionAgentId
      ? this.context.requireRuntime(terminalId, sessionAgentId)
      : this.context.requireRuntimeById(terminalId);

    await this.context.withRuntimeLock(runtime, async () => {
      this.context.assertNotClosing(runtime);
      if (!runtime.pty) {
        throw new TerminalServiceError("RESTORE_FAILED", `Terminal ${terminalId} is not running.`);
      }
      runtime.pty.write(data);
    });
  }

  async handlePtyOutput(terminalId: string, chunk: Buffer): Promise<void> {
    const runtime = this.context.terminals.get(terminalId);
    if (!runtime || runtime.closed) {
      return;
    }

    await this.context.withRuntimeLock(runtime, async () => {
      if (runtime.closed) {
        return;
      }

      const seq = runtime.meta.nextSeq;
      runtime.meta.nextSeq += 1;
      runtime.meta.updatedAt = runtime.descriptor.updatedAt = this.context.timestamp();
      await this.context.persistence.writeToMirror(runtime.meta.terminalId, chunk);
      const bytesWritten = await this.context.persistence.appendJournal(runtime.meta, seq, chunk);
      runtime.journalBytes += bytesWritten;

      const event: TerminalOutputEvent = {
        terminalId: runtime.meta.terminalId,
        sessionAgentId: runtime.meta.sessionAgentId,
        profileId: runtime.meta.profileId,
        seq,
        chunk,
      };

      for (const client of runtime.attachedClients) {
        client.onData(chunk);
      }

      this.context.emit("terminal_output", event);
      this.context.transport?.publish({
        type: "terminal_output",
        terminalId: runtime.meta.terminalId,
        sessionAgentId: runtime.meta.sessionAgentId,
        seq,
        chunk,
      });

      if (runtime.journalBytes >= this.context.runtimeConfig.journalMaxBytes) {
        await this.snapshotRuntime(runtime);
      }
    });
  }

  async handlePtyExit(
    terminalId: string,
    exitCode: number | null,
    exitSignal: number | null,
  ): Promise<void> {
    const runtime = this.context.terminals.get(terminalId);
    if (!runtime || runtime.closed) {
      return;
    }

    await this.context.withRuntimeLock(runtime, async () => {
      if (runtime.closed) {
        return;
      }

      runtime.pty = null;
      runtime.meta.exitCode = exitCode;
      runtime.meta.exitSignal = exitSignal;
      runtime.meta.pid = null;
      runtime.meta.state = "exited";
      runtime.meta.updatedAt = this.context.timestamp();
      runtime.descriptor = this.context.transitionDescriptorState(
        {
          ...runtime.descriptor,
          exitCode,
          exitSignal,
          pid: null,
          updatedAt: runtime.meta.updatedAt,
        },
        "exited",
      );
      runtime.meta.updatedAt = runtime.descriptor.updatedAt;

      if (runtime.snapshotInterval) {
        clearInterval(runtime.snapshotInterval);
        runtime.snapshotInterval = null;
      }

      await this.snapshotRuntime(runtime);
      await this.context.persistence.saveMeta(runtime.meta);

      const event: TerminalExitEvent = {
        terminalId: runtime.meta.terminalId,
        sessionAgentId: runtime.meta.sessionAgentId,
        profileId: runtime.meta.profileId,
        exitCode,
        exitSignal,
      };

      for (const client of runtime.attachedClients) {
        try {
          client.onControl({ channel: "control", type: "exit", exitCode, exitSignal });
        } catch (error) {
          console.warn(
            `[terminal-service] Failed to notify terminal client about exit ${runtime.meta.terminalId}: ${toErrorMessage(error)}`,
          );
        }
      }

      this.context.emit("terminal_exit", event);
      this.context.transport?.publish({
        type: "terminal_exit",
        terminalId: runtime.meta.terminalId,
        sessionAgentId: runtime.meta.sessionAgentId,
        exitCode,
        exitSignal,
      });
      this.context.emitTerminalUpdated(runtime.descriptor);
    });
  }

  async snapshotRuntime(runtime: ActiveTerminalRuntime): Promise<void> {
    await this.context.persistence.writeSnapshot(runtime.meta);
    runtime.meta.checkpointSeq = runtime.meta.nextSeq - 1;
    runtime.journalBytes = 0;
    await this.context.persistence.truncateJournal(runtime.meta);
    await this.context.persistence.saveMeta(runtime.meta);
  }

  startSnapshotInterval(runtime: ActiveTerminalRuntime): void {
    if (runtime.snapshotInterval) {
      clearInterval(runtime.snapshotInterval);
    }

    runtime.snapshotInterval = setInterval(() => {
      void this.context.withRuntimeLock(runtime, async () => {
        if (runtime.closed) {
          return;
        }

        try {
          await this.snapshotRuntime(runtime);
        } catch (error) {
          console.warn(`[terminal-service] Snapshot failed for ${runtime.meta.terminalId}: ${toErrorMessage(error)}`);
        }
      });
    }, this.context.runtimeConfig.snapshotIntervalMs);
    runtime.snapshotInterval.unref?.();
  }

  async snapshotRuntimeWithTimeout(runtime: ActiveTerminalRuntime, label: string): Promise<void> {
    const timeoutMs = this.context.runtimeConfig.shutdownSnapshotTimeoutMs;
    let timer: NodeJS.Timeout | null = null;

    try {
      await Promise.race([
        this.snapshotRuntime(runtime),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Timed out after ${timeoutMs}ms while snapshotting ${label}`));
          }, timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}
