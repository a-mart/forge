import { randomUUID } from "node:crypto";
import type {
  TerminalCloseReason,
  TerminalCreateRequest,
  TerminalCreateResponse,
  TerminalDescriptor,
  TerminalMeta,
  TerminalRenameRequest,
  TerminalResizeRequest,
} from "@forge/protocol";
import type { TerminalPtyHandle } from "./terminal-pty-runtime.js";
import { cloneDescriptor, createInactiveRuntime, sanitizeDimension, toError, toErrorMessage } from "./terminal-service-helpers.js";
import {
  TerminalServiceError,
  type TerminalServiceContext,
  type TerminalServiceInitializeResult,
} from "./terminal-service-types.js";

export class TerminalServiceLifecycleController {
  constructor(private readonly context: TerminalServiceContext) {}

  async initialize(): Promise<TerminalServiceInitializeResult> {
    if (this.context.getInitialized()) {
      return {
        restoredRunning: 0,
        restoredExited: 0,
        restoreFailed: 0,
        cleanedOrphans: 0,
        skipped: 0,
      };
    }

    this.context.setInitialized(true);

    if (this.context.transport) {
      this.context.setTransportUnsubscribe(
        this.context.transport.subscribe((event) => {
          void this.context.handleTransportEvent(event);
        }),
      );
    }

    const result: TerminalServiceInitializeResult = {
      restoredRunning: 0,
      restoredExited: 0,
      restoreFailed: 0,
      cleanedOrphans: 0,
      skipped: 0,
    };

    const persisted = await this.context.persistence.listPersistedMeta();
    const orphanPids: number[] = [];
    const restoreConcurrency = Math.max(1, this.context.runtimeConfig.restoreStartupConcurrency);
    let nextIndex = 0;

    await Promise.all(
      Array.from({ length: Math.min(restoreConcurrency, persisted.length || 1) }, async () => {
        while (true) {
          const index = nextIndex;
          nextIndex += 1;
          const storedMeta = persisted[index];
          if (!storedMeta) {
            return;
          }

          const session = this.context.sessionResolver.resolveSession(storedMeta.sessionAgentId);
          if (!session) {
            if (storedMeta.state === "running" && typeof storedMeta.pid === "number") {
              orphanPids.push(storedMeta.pid);
            }
            await this.context.persistence.deleteTerminal(storedMeta);
            result.cleanedOrphans += 1;
            continue;
          }

          try {
            if (storedMeta.sessionAgentId !== session.sessionAgentId) {
              await this.context.persistence.moveTerminalScope(storedMeta, session.sessionAgentId);
            }

            const meta: TerminalMeta = {
              ...storedMeta,
              sessionAgentId: session.sessionAgentId,
              profileId: session.profileId,
              recoveredFromPersistence: true,
            };

            const runtime = createInactiveRuntime(meta, session);
            const restored = await this.context.persistence.restoreMirror(meta);
            runtime.journalBytes = await this.context.persistence.getJournalSize(meta);
            runtime.meta.nextSeq = Math.max(runtime.meta.nextSeq, restored.lastSeq + 1);

            if (storedMeta.state === "running") {
              runtime.descriptor = this.context.transitionDescriptorState(runtime.descriptor, "restoring");
              runtime.meta.state = "restoring";
              runtime.meta.updatedAt = runtime.descriptor.updatedAt;

              let restoredHandle: TerminalPtyHandle | null = null;
              try {
                restoredHandle = await this.context.ptyRuntime.spawnPty({
                  shell: runtime.meta.shell || undefined,
                  shellArgs: runtime.meta.shellArgs,
                  cwd: runtime.meta.cwd,
                  cols: runtime.meta.cols,
                  rows: runtime.meta.rows,
                  onData: async (chunk) => {
                    await this.context.handlePtyOutput(runtime.meta.terminalId, chunk);
                  },
                  onExit: async (event) => {
                    await this.context.handlePtyExit(runtime.meta.terminalId, event.exitCode, event.exitSignal);
                  },
                });

                runtime.pty = restoredHandle;
                runtime.meta.pid = restoredHandle.pid;
                runtime.descriptor.pid = restoredHandle.pid;
                runtime.meta.shell = restoredHandle.shell;
                runtime.meta.shellArgs = [...restoredHandle.shellArgs];
                runtime.descriptor.shell = restoredHandle.shell;
                runtime.meta.exitCode = null;
                runtime.meta.exitSignal = null;
                runtime.descriptor.exitCode = null;
                runtime.descriptor.exitSignal = null;

                runtime.descriptor = this.context.transitionDescriptorState(runtime.descriptor, "running");
                runtime.meta.state = "running";
                runtime.meta.updatedAt = runtime.descriptor.updatedAt;
                await this.context.persistence.saveMeta(runtime.meta);
                this.context.startSnapshotInterval(runtime);
                result.restoredRunning += 1;
              } catch (restoreError) {
                runtime.pty = null;
                if (restoredHandle) {
                  try {
                    await this.context.ptyRuntime.killPty(restoredHandle);
                  } catch (cleanupError) {
                    console.warn(
                      `[terminal-service] Failed to cleanup restored PTY ${runtime.meta.terminalId}: ${toErrorMessage(cleanupError)}`,
                    );
                  }
                }

                runtime.descriptor = this.context.transitionDescriptorState(runtime.descriptor, "restore_failed");
                runtime.meta.state = "restore_failed";
                runtime.meta.pid = null;
                runtime.descriptor.pid = null;
                runtime.meta.updatedAt = runtime.descriptor.updatedAt;
                await this.context.persistence.saveMeta(runtime.meta);
                result.restoreFailed += 1;

                console.warn(
                  `[terminal-service] Failed to restore running terminal ${runtime.meta.terminalId}: ${toErrorMessage(restoreError)}`,
                );
              }
            } else if (storedMeta.state === "restore_failed") {
              await this.context.persistence.saveMeta(runtime.meta);
              result.restoreFailed += 1;
            } else {
              runtime.descriptor = this.context.transitionDescriptorState(runtime.descriptor, "exited");
              runtime.meta.state = "exited";
              runtime.meta.pid = null;
              runtime.descriptor.pid = null;
              runtime.meta.updatedAt = runtime.descriptor.updatedAt;
              await this.context.persistence.saveMeta(runtime.meta);
              result.restoredExited += 1;
            }

            this.context.terminals.set(runtime.meta.terminalId, runtime);
          } catch (error) {
            console.warn(`[terminal-service] Failed to restore terminal ${storedMeta.terminalId}: ${toErrorMessage(error)}`);
            result.skipped += 1;
          }
        }
      }),
    );

    if (orphanPids.length > 0) {
      await this.context.ptyRuntime.cleanupOrphanedProcesses(orphanPids);
    }

    return result;
  }

  async shutdown(): Promise<void> {
    if (this.context.getShuttingDown()) {
      return;
    }

    this.context.setShuttingDown(true);
    this.context.getTransportUnsubscribe()?.();
    this.context.setTransportUnsubscribe(null);

    const runtimes = Array.from(this.context.terminals.values());
    for (const runtime of runtimes) {
      if (runtime.snapshotInterval) {
        clearInterval(runtime.snapshotInterval);
        runtime.snapshotInterval = null;
      }
    }

    await Promise.allSettled(
      runtimes.map(async (runtime) => {
        let ptyToKill: TerminalPtyHandle | null = null;

        await this.context.withRuntimeLock(runtime, async () => {
          runtime.closing = true;
          try {
            await this.context.snapshotRuntimeWithTimeout(runtime, `shutdown ${runtime.meta.terminalId}`);
          } catch (error) {
            console.warn(`[terminal-service] Shutdown snapshot failed for ${runtime.meta.terminalId}: ${toErrorMessage(error)}`);
          }

          ptyToKill = runtime.pty;
          runtime.pty = null;
        });

        if (ptyToKill) {
          await this.context.ptyRuntime.killPty(ptyToKill);
        }

        await this.context.withRuntimeLock(runtime, async () => {
          if (runtime.descriptor.state === "running" || runtime.descriptor.state === "restoring") {
            runtime.descriptor = this.context.transitionDescriptorState(runtime.descriptor, "exited");
            runtime.meta.state = "exited";
          }
          runtime.descriptor.pid = null;
          runtime.meta.pid = null;
          runtime.meta.updatedAt = runtime.descriptor.updatedAt = this.context.timestamp();
          await this.context.persistence.saveMeta(runtime.meta);
        });
      }),
    );

    await this.context.transport?.shutdown();
  }

  async create(request: TerminalCreateRequest): Promise<TerminalCreateResponse> {
    const session = this.context.requireSession(request.sessionAgentId);
    this.context.assertServiceReady();

    if (!(await this.context.ptyRuntime.isAvailable())) {
      throw new TerminalServiceError("PTY_UNAVAILABLE", "Integrated terminals require node-pty.");
    }

    return this.context.withSessionCreateLock(session.sessionAgentId, async () => {
      this.context.assertServiceReady();
      this.context.assertTerminalLimit(session.sessionAgentId);

      const cols = sanitizeDimension(request.cols ?? this.context.runtimeConfig.defaultCols, 20, "cols");
      const rows = sanitizeDimension(request.rows ?? this.context.runtimeConfig.defaultRows, 5, "rows");
      const cwd = await this.context.resolveCwd(session, request.cwd);
      const createdAt = this.context.timestamp();
      const terminalId = randomUUID();
      const name = this.context.createDefaultName(session.sessionAgentId, request.name);
      const runtime = createInactiveRuntime(
        {
          version: 1,
          terminalId,
          sessionAgentId: session.sessionAgentId,
          profileId: session.profileId,
          name,
          shell: request.shell?.trim() || "",
          shellArgs: request.shellArgs ? [...request.shellArgs] : [],
          cwd,
          cols,
          rows,
          state: "running",
          pid: null,
          exitCode: null,
          exitSignal: null,
          checkpointSeq: 0,
          nextSeq: 1,
          recoveredFromPersistence: false,
          createdAt,
          updatedAt: createdAt,
        },
        session,
      );

      let createdHandle: TerminalPtyHandle | null = null;
      this.context.persistence.createMirror(runtime.meta);
      this.context.assertTerminalLimit(session.sessionAgentId);
      this.context.terminals.set(terminalId, runtime);

      try {
        createdHandle = await this.context.ptyRuntime.spawnPty({
          shell: request.shell,
          shellArgs: request.shellArgs,
          cwd,
          cols,
          rows,
          onData: async (chunk) => {
            await this.context.handlePtyOutput(runtime.meta.terminalId, chunk);
          },
          onExit: async (event) => {
            await this.context.handlePtyExit(runtime.meta.terminalId, event.exitCode, event.exitSignal);
          },
        });

        runtime.pty = createdHandle;
        runtime.meta.pid = createdHandle.pid;
        runtime.descriptor.pid = createdHandle.pid;
        runtime.meta.shell = createdHandle.shell;
        runtime.meta.shellArgs = [...createdHandle.shellArgs];
        runtime.descriptor.shell = createdHandle.shell;

        if (this.context.getShuttingDown()) {
          throw new TerminalServiceError(
            "SERVICE_SHUTTING_DOWN",
            "Terminal service started shutting down while creating a terminal.",
          );
        }

        await this.context.persistence.saveMeta(runtime.meta);
        this.context.startSnapshotInterval(runtime);
        this.context.emitTerminalCreated(runtime.descriptor);

        const ticket = await this.context.issueWsTicket({
          terminalId: runtime.meta.terminalId,
          sessionAgentId: runtime.meta.sessionAgentId,
        });
        return {
          terminal: cloneDescriptor(runtime.descriptor),
          ...ticket,
        };
      } catch (error) {
        runtime.closing = true;
        runtime.closed = true;

        if (runtime.snapshotInterval) {
          clearInterval(runtime.snapshotInterval);
          runtime.snapshotInterval = null;
        }

        runtime.pty = null;
        if (createdHandle) {
          try {
            await this.context.ptyRuntime.killPty(createdHandle);
          } catch (cleanupError) {
            console.warn(
              `[terminal-service] Failed to kill PTY for aborted create ${terminalId}: ${toErrorMessage(cleanupError)}`,
            );
          }
        }

        this.context.terminals.delete(terminalId);
        try {
          await this.context.persistence.deleteTerminal(runtime.meta);
        } catch (cleanupError) {
          console.warn(
            `[terminal-service] Failed to cleanup aborted terminal ${terminalId}: ${toErrorMessage(cleanupError)}`,
          );
          this.context.persistence.disposeMirror(terminalId);
        }

        throw this.context.mapCreateError(error);
      }
    });
  }

  listTerminals(sessionAgentId: string): TerminalDescriptor[] {
    const scopeSessionAgentId = this.context.resolveScopeSessionAgentId(sessionAgentId);
    return Array.from(this.context.terminals.values())
      .filter((runtime) => runtime.meta.sessionAgentId === scopeSessionAgentId && !runtime.closed)
      .map((runtime) => cloneDescriptor(runtime.descriptor))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getTerminal(input: string | { terminalId: string; sessionAgentId: string }): TerminalDescriptor | undefined {
    const terminalId = typeof input === "string" ? input : input.terminalId;
    const runtime = this.context.terminals.get(terminalId);
    if (!runtime || runtime.closed) {
      return undefined;
    }

    if (
      typeof input !== "string" &&
      runtime.meta.sessionAgentId !== this.context.resolveScopeSessionAgentId(input.sessionAgentId)
    ) {
      return undefined;
    }

    return cloneDescriptor(runtime.descriptor);
  }

  async renameTerminal(input: {
    terminalId: string;
    request: TerminalRenameRequest;
  }): Promise<TerminalDescriptor> {
    const runtime = this.context.requireRuntime(input.terminalId, input.request.sessionAgentId);
    const trimmed = input.request.name.trim();
    if (!trimmed) {
      throw new TerminalServiceError("INVALID_REQUEST", "Terminal name must be non-empty.");
    }

    return this.context.withRuntimeLock(runtime, async () => {
      runtime.meta.name = trimmed;
      runtime.meta.updatedAt = this.context.timestamp();
      runtime.descriptor = {
        ...runtime.descriptor,
        name: trimmed,
        updatedAt: runtime.meta.updatedAt,
      };
      await this.context.persistence.saveMeta(runtime.meta);
      this.context.emitTerminalUpdated(runtime.descriptor);
      return cloneDescriptor(runtime.descriptor);
    });
  }

  async resizeTerminal(input: {
    terminalId: string;
    request: TerminalResizeRequest;
  }): Promise<TerminalDescriptor> {
    const runtime = this.context.requireRuntime(input.terminalId, input.request.sessionAgentId);
    const cols = sanitizeDimension(input.request.cols, 20, "cols");
    const rows = sanitizeDimension(input.request.rows, 5, "rows");

    return this.context.withRuntimeLock(runtime, async () => {
      this.context.assertNotClosing(runtime);
      if (runtime.pty) {
        await this.context.ptyRuntime.resizePty(runtime.pty, cols, rows);
      }
      this.context.persistence.resizeMirror(runtime.meta.terminalId, cols, rows);
      runtime.meta.cols = cols;
      runtime.meta.rows = rows;
      runtime.meta.updatedAt = this.context.timestamp();
      runtime.descriptor = {
        ...runtime.descriptor,
        cols,
        rows,
        updatedAt: runtime.meta.updatedAt,
      };
      await this.context.persistence.saveMeta(runtime.meta);
      this.context.emitTerminalUpdated(runtime.descriptor);
      return cloneDescriptor(runtime.descriptor);
    });
  }

  async closeTerminal(input: {
    terminalId: string;
    sessionAgentId: string;
    reason: TerminalCloseReason;
  }): Promise<void> {
    const runtime = this.context.requireRuntime(input.terminalId, input.sessionAgentId);
    if (runtime.finalizePromise) {
      await runtime.finalizePromise;
      return;
    }

    runtime.finalizePromise = (async () => {
      let firstError: Error | null = null;
      const clients = Array.from(runtime.attachedClients);
      let ptyToKill: TerminalPtyHandle | null = null;

      await this.context.withRuntimeLock(runtime, async () => {
        runtime.closing = true;
        if (runtime.snapshotInterval) {
          clearInterval(runtime.snapshotInterval);
          runtime.snapshotInterval = null;
        }
        ptyToKill = runtime.pty;
        runtime.pty = null;
      });

      if (ptyToKill) {
        try {
          await this.context.ptyRuntime.killPty(ptyToKill);
        } catch (error) {
          firstError = toError(error);
          console.warn(`[terminal-service] Failed to kill terminal ${runtime.meta.terminalId}: ${firstError.message}`);
        }
      }

      await this.context.withRuntimeLock(runtime, async () => {
        try {
          await this.context.snapshotRuntime(runtime);
        } catch (error) {
          if (!firstError) {
            firstError = toError(error);
          }
          console.warn(`[terminal-service] Failed to snapshot terminal ${runtime.meta.terminalId} before close: ${toErrorMessage(error)}`);
        }

        runtime.closed = true;
        runtime.attachedClients.clear();
        this.context.terminals.delete(runtime.meta.terminalId);

        try {
          await this.context.persistence.deleteTerminal(runtime.meta);
        } catch (error) {
          if (!firstError) {
            firstError = toError(error);
          }
          console.warn(`[terminal-service] Failed to delete terminal ${runtime.meta.terminalId}: ${toErrorMessage(error)}`);
        }
      });

      for (const client of clients) {
        try {
          client.onControl({ channel: "control", type: "closed", reason: input.reason });
        } catch (error) {
          console.warn(
            `[terminal-service] Failed to notify terminal client about close ${runtime.meta.terminalId}: ${toErrorMessage(error)}`,
          );
        }
      }

      try {
        this.context.emit("terminal_closed", {
          type: "terminal_closed",
          sessionAgentId: runtime.meta.sessionAgentId,
          terminalId: runtime.meta.terminalId,
          reason: input.reason,
        });
      } catch (error) {
        console.warn(`[terminal-service] Failed to emit terminal_closed for ${runtime.meta.terminalId}: ${toErrorMessage(error)}`);
      }

      if (firstError) {
        throw firstError;
      }
    })();

    try {
      await runtime.finalizePromise;
    } finally {
      runtime.finalizePromise = null;
    }
  }

  async cleanupSession(
    sessionAgentId: string,
    reason: Extract<TerminalCloseReason, "session_deleted" | "manager_deleted" | "orphan_cleanup">,
  ): Promise<number> {
    const targetScopeIds = new Set<string>([sessionAgentId]);
    if (reason === "manager_deleted") {
      const resolvedScope = this.context.sessionResolver.resolveSession(sessionAgentId)?.sessionAgentId;
      if (resolvedScope) {
        targetScopeIds.add(resolvedScope);
      }
    }

    const stale = Array.from(this.context.terminals.values()).filter((runtime) =>
      targetScopeIds.has(runtime.meta.sessionAgentId),
    );

    for (const runtime of stale) {
      await this.closeTerminal({
        terminalId: runtime.meta.terminalId,
        sessionAgentId: runtime.meta.sessionAgentId,
        reason,
      });
    }

    return stale.length;
  }

  async reconcileSessions(): Promise<{ removed: number }> {
    const validSessions = new Set(this.context.sessionResolver.listSessions().map((session) => session.sessionAgentId));
    const stale = Array.from(this.context.terminals.values())
      .filter((runtime) => !validSessions.has(runtime.meta.sessionAgentId))
      .map((runtime) => ({ terminalId: runtime.meta.terminalId, sessionAgentId: runtime.meta.sessionAgentId }));

    for (const runtime of stale) {
      await this.closeTerminal({
        terminalId: runtime.terminalId,
        sessionAgentId: runtime.sessionAgentId,
        reason: "orphan_cleanup",
      });
    }

    return { removed: stale.length };
  }

  async snapshotNow(input?: { sessionAgentId?: string; terminalId?: string }): Promise<number> {
    const scopeSessionAgentId = input?.sessionAgentId
      ? this.context.resolveScopeSessionAgentId(input.sessionAgentId)
      : undefined;
    const runtimes = Array.from(this.context.terminals.values()).filter((runtime) => {
      if (input?.terminalId && runtime.meta.terminalId !== input.terminalId) {
        return false;
      }
      if (scopeSessionAgentId && runtime.meta.sessionAgentId !== scopeSessionAgentId) {
        return false;
      }
      return !runtime.closed;
    });

    for (const runtime of runtimes) {
      await this.context.withRuntimeLock(runtime, async () => {
        await this.context.snapshotRuntime(runtime);
      });
    }

    return runtimes.length;
  }
}
