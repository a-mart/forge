import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import type {
  TerminalCloseReason,
  TerminalCreateRequest,
  TerminalCreateResponse,
  TerminalCreatedEvent,
  TerminalDescriptor,
  TerminalIssueTicketResponse,
  TerminalLifecycleState,
  TerminalMeta,
  TerminalRenameRequest,
  TerminalResizeRequest,
  TerminalUpdatedEvent,
  TerminalClosedEvent,
  TerminalWsClientControlMessage,
  TerminalWsServerControlMessage,
} from "@forge/protocol";
import { validateDirectoryPath } from "../swarm/cwd-policy.js";
import type { TerminalRuntimeConfig } from "./terminal-config.js";
import { TerminalPersistence } from "./terminal-persistence.js";
import type { TerminalPtyHandle, TerminalPtyRuntime } from "./terminal-pty-runtime.js";
import type { ResolvedTerminalSession, TerminalSessionResolver } from "./terminal-session-resolver.js";
import type { TerminalTransport, TerminalTransportInboundEvent } from "./terminal-transport.js";

export interface TerminalServiceOptions {
  dataDir: string;
  runtimeConfig: TerminalRuntimeConfig;
  sessionResolver: TerminalSessionResolver;
  ptyRuntime: TerminalPtyRuntime;
  persistence: TerminalPersistence;
  cwdPolicy: {
    rootDir: string;
    allowlistRoots: string[];
  };
  transport?: TerminalTransport;
  now?: () => Date;
}

export interface TerminalServiceInitializeResult {
  restoredRunning: number;
  restoredExited: number;
  restoreFailed: number;
  cleanedOrphans: number;
  skipped: number;
}

export interface TerminalStateChangedEvent {
  terminal: TerminalDescriptor;
  previousState: TerminalLifecycleState;
  nextState: TerminalLifecycleState;
}

export interface TerminalOutputEvent {
  terminalId: string;
  sessionAgentId: string;
  profileId: string;
  seq: number;
  chunk: Buffer;
}

export interface TerminalExitEvent {
  terminalId: string;
  sessionAgentId: string;
  profileId: string;
  exitCode: number | null;
  exitSignal: number | null;
}

export interface TerminalRestoreData {
  terminal: TerminalDescriptor;
  replay: Buffer;
}

interface AttachedClient {
  onData: (chunk: Buffer) => void;
  onControl: (message: TerminalWsServerControlMessage) => void;
}

interface ActiveTerminalRuntime {
  meta: TerminalMeta;
  descriptor: TerminalDescriptor;
  session: ResolvedTerminalSession;
  pty: TerminalPtyHandle | null;
  closing: boolean;
  closed: boolean;
  finalizePromise: Promise<void> | null;
  snapshotInterval: NodeJS.Timeout | null;
  lock: Promise<void>;
  attachedClients: Set<AttachedClient>;
  journalBytes: number;
}

export type TerminalServiceEventMap = {
  terminal_created: (event: TerminalCreatedEvent) => void;
  terminal_updated: (event: TerminalUpdatedEvent) => void;
  terminal_closed: (event: TerminalClosedEvent) => void;
  terminal_state_changed: (event: TerminalStateChangedEvent) => void;
  terminal_output: (event: TerminalOutputEvent) => void;
  terminal_exit: (event: TerminalExitEvent) => void;
};

export class TerminalServiceError extends Error {
  readonly code:
    | "SESSION_NOT_FOUND"
    | "SESSION_PROFILE_MISMATCH"
    | "TERMINAL_NOT_FOUND"
    | "TERMINAL_SESSION_MISMATCH"
    | "TERMINAL_LIMIT_REACHED"
    | "PTY_UNAVAILABLE"
    | "INVALID_CWD"
    | "INVALID_SHELL"
    | "INVALID_REQUEST"
    | "INVALID_DIMENSIONS"
    | "SERVICE_SHUTTING_DOWN"
    | "TERMINAL_ALREADY_CLOSING"
    | "RESTORE_FAILED"
    | "INVALID_TICKET";

  constructor(code: TerminalServiceError["code"], message: string) {
    super(message);
    this.name = "TerminalServiceError";
    this.code = code;
  }
}

export class TerminalService extends EventEmitter {
  private readonly dataDir: string;
  private readonly runtimeConfig: TerminalRuntimeConfig;
  private readonly sessionResolver: TerminalSessionResolver;
  private readonly ptyRuntime: TerminalPtyRuntime;
  private readonly persistence: TerminalPersistence;
  private readonly cwdPolicy: {
    rootDir: string;
    allowlistRoots: string[];
  };
  private readonly transport?: TerminalTransport;
  private readonly now: () => Date;
  private readonly terminals = new Map<string, ActiveTerminalRuntime>();
  private readonly sessionCreateLocks = new Map<string, Promise<void>>();
  private readonly ticketSecret = randomBytes(32);
  private transportUnsubscribe: (() => void) | null = null;
  private initialized = false;
  private shuttingDown = false;

  constructor(options: TerminalServiceOptions) {
    super();
    this.dataDir = options.dataDir;
    this.runtimeConfig = options.runtimeConfig;
    this.sessionResolver = options.sessionResolver;
    this.ptyRuntime = options.ptyRuntime;
    this.persistence = options.persistence;
    this.cwdPolicy = options.cwdPolicy;
    this.transport = options.transport;
    this.now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<TerminalServiceInitializeResult> {
    if (this.initialized) {
      return {
        restoredRunning: 0,
        restoredExited: 0,
        restoreFailed: 0,
        cleanedOrphans: 0,
        skipped: 0,
      };
    }

    this.initialized = true;

    if (this.transport) {
      this.transportUnsubscribe = this.transport.subscribe((event) => {
        void this.handleTransportEvent(event);
      });
    }

    const result: TerminalServiceInitializeResult = {
      restoredRunning: 0,
      restoredExited: 0,
      restoreFailed: 0,
      cleanedOrphans: 0,
      skipped: 0,
    };

    const persisted = await this.persistence.listPersistedMeta();
    const orphanPids: number[] = [];
    const restoreConcurrency = Math.max(1, this.runtimeConfig.restoreStartupConcurrency);
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

          const session = this.sessionResolver.resolveSession(storedMeta.sessionAgentId);
          if (!session) {
            if (storedMeta.state === "running" && typeof storedMeta.pid === "number") {
              orphanPids.push(storedMeta.pid);
            }
            await this.persistence.deleteTerminal(storedMeta);
            result.cleanedOrphans += 1;
            continue;
          }

          try {
            if (storedMeta.sessionAgentId !== session.sessionAgentId) {
              await this.persistence.moveTerminalScope(storedMeta, session.sessionAgentId);
            }

            const meta: TerminalMeta = {
              ...storedMeta,
              sessionAgentId: session.sessionAgentId,
              profileId: session.profileId,
              recoveredFromPersistence: true,
            };

            const runtime = this.createInactiveRuntime(meta, session);
            const restored = await this.persistence.restoreMirror(meta);
            runtime.journalBytes = await this.persistence.getJournalSize(meta);
            runtime.meta.nextSeq = Math.max(runtime.meta.nextSeq, restored.lastSeq + 1);

            if (storedMeta.state === "running") {
              runtime.descriptor = this.transitionDescriptorState(runtime.descriptor, "restoring");
              runtime.meta.state = "restoring";
              runtime.meta.updatedAt = runtime.descriptor.updatedAt;

              let restoredHandle: TerminalPtyHandle | null = null;
              try {
                restoredHandle = await this.ptyRuntime.spawnPty({
                  shell: runtime.meta.shell || undefined,
                  shellArgs: runtime.meta.shellArgs,
                  cwd: runtime.meta.cwd,
                  cols: runtime.meta.cols,
                  rows: runtime.meta.rows,
                  onData: async (chunk) => {
                    await this.handlePtyOutput(runtime.meta.terminalId, chunk);
                  },
                  onExit: async (event) => {
                    await this.handlePtyExit(runtime.meta.terminalId, event.exitCode, event.exitSignal);
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

                runtime.descriptor = this.transitionDescriptorState(runtime.descriptor, "running");
                runtime.meta.state = "running";
                runtime.meta.updatedAt = runtime.descriptor.updatedAt;
                await this.persistence.saveMeta(runtime.meta);
                this.startSnapshotInterval(runtime);
                result.restoredRunning += 1;
              } catch (restoreError) {
                runtime.pty = null;
                if (restoredHandle) {
                  try {
                    await this.ptyRuntime.killPty(restoredHandle);
                  } catch (cleanupError) {
                    console.warn(
                      `[terminal-service] Failed to cleanup restored PTY ${runtime.meta.terminalId}: ${toErrorMessage(cleanupError)}`,
                    );
                  }
                }

                runtime.descriptor = this.transitionDescriptorState(runtime.descriptor, "restore_failed");
                runtime.meta.state = "restore_failed";
                runtime.meta.pid = null;
                runtime.descriptor.pid = null;
                runtime.meta.updatedAt = runtime.descriptor.updatedAt;
                await this.persistence.saveMeta(runtime.meta);
                result.restoreFailed += 1;

                console.warn(
                  `[terminal-service] Failed to restore running terminal ${runtime.meta.terminalId}: ${toErrorMessage(restoreError)}`,
                );
              }
            } else if (storedMeta.state === "restore_failed") {
              await this.persistence.saveMeta(runtime.meta);
              result.restoreFailed += 1;
            } else {
              runtime.descriptor = this.transitionDescriptorState(runtime.descriptor, "exited");
              runtime.meta.state = "exited";
              runtime.meta.pid = null;
              runtime.descriptor.pid = null;
              runtime.meta.updatedAt = runtime.descriptor.updatedAt;
              await this.persistence.saveMeta(runtime.meta);
              result.restoredExited += 1;
            }

            this.terminals.set(runtime.meta.terminalId, runtime);
          } catch (error) {
            console.warn(`[terminal-service] Failed to restore terminal ${storedMeta.terminalId}: ${toErrorMessage(error)}`);
            result.skipped += 1;
          }
        }
      }),
    );

    if (orphanPids.length > 0) {
      await this.ptyRuntime.cleanupOrphanedProcesses(orphanPids);
    }

    return result;
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    this.shuttingDown = true;
    this.transportUnsubscribe?.();
    this.transportUnsubscribe = null;

    const runtimes = Array.from(this.terminals.values());
    for (const runtime of runtimes) {
      if (runtime.snapshotInterval) {
        clearInterval(runtime.snapshotInterval);
        runtime.snapshotInterval = null;
      }
    }

    await Promise.allSettled(
      runtimes.map(async (runtime) => {
        let ptyToKill: TerminalPtyHandle | null = null;

        await this.withRuntimeLock(runtime, async () => {
          runtime.closing = true;
          try {
            await this.snapshotRuntimeWithTimeout(runtime, `shutdown ${runtime.meta.terminalId}`);
          } catch (error) {
            console.warn(`[terminal-service] Shutdown snapshot failed for ${runtime.meta.terminalId}: ${toErrorMessage(error)}`);
          }

          ptyToKill = runtime.pty;
          runtime.pty = null;
        });

        if (ptyToKill) {
          await this.ptyRuntime.killPty(ptyToKill);
        }

        await this.withRuntimeLock(runtime, async () => {
          if (runtime.descriptor.state === "running" || runtime.descriptor.state === "restoring") {
            runtime.descriptor = this.transitionDescriptorState(runtime.descriptor, "exited");
            runtime.meta.state = "exited";
          }
          runtime.descriptor.pid = null;
          runtime.meta.pid = null;
          runtime.meta.updatedAt = runtime.descriptor.updatedAt = this.timestamp();
          await this.persistence.saveMeta(runtime.meta);
        });
      }),
    );

    await this.transport?.shutdown();
  }

  async create(request: TerminalCreateRequest): Promise<TerminalCreateResponse> {
    const session = this.requireSession(request.sessionAgentId);
    this.assertServiceReady();

    if (!(await this.ptyRuntime.isAvailable())) {
      throw new TerminalServiceError("PTY_UNAVAILABLE", "Integrated terminals require node-pty.");
    }

    return this.withSessionCreateLock(session.sessionAgentId, async () => {
      this.assertServiceReady();
      this.assertTerminalLimit(session.sessionAgentId);

      const cols = sanitizeDimension(request.cols ?? this.runtimeConfig.defaultCols, 20, "cols");
      const rows = sanitizeDimension(request.rows ?? this.runtimeConfig.defaultRows, 5, "rows");
      const cwd = await this.resolveCwd(session, request.cwd);
      const createdAt = this.timestamp();
      const terminalId = randomUUID();
      const name = this.createDefaultName(session.sessionAgentId, request.name);
      const runtime: ActiveTerminalRuntime = {
        meta: {
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
        descriptor: {
          terminalId,
          sessionAgentId: session.sessionAgentId,
          profileId: session.profileId,
          name,
          shell: request.shell?.trim() || "",
          cwd,
          cols,
          rows,
          state: "running",
          pid: null,
          exitCode: null,
          exitSignal: null,
          recoveredFromPersistence: false,
          createdAt,
          updatedAt: createdAt,
        },
        session,
        pty: null,
        closing: false,
        closed: false,
        finalizePromise: null,
        snapshotInterval: null,
        lock: Promise.resolve(),
        attachedClients: new Set(),
        journalBytes: 0,
      };

      let createdHandle: TerminalPtyHandle | null = null;
      this.persistence.createMirror(runtime.meta);
      this.assertTerminalLimit(session.sessionAgentId);
      this.terminals.set(terminalId, runtime);

      try {
        createdHandle = await this.ptyRuntime.spawnPty({
          shell: request.shell,
          shellArgs: request.shellArgs,
          cwd,
          cols,
          rows,
          onData: async (chunk) => {
            await this.handlePtyOutput(runtime.meta.terminalId, chunk);
          },
          onExit: async (event) => {
            await this.handlePtyExit(runtime.meta.terminalId, event.exitCode, event.exitSignal);
          },
        });

        runtime.pty = createdHandle;
        runtime.meta.pid = createdHandle.pid;
        runtime.descriptor.pid = createdHandle.pid;
        runtime.meta.shell = createdHandle.shell;
        runtime.meta.shellArgs = [...createdHandle.shellArgs];
        runtime.descriptor.shell = createdHandle.shell;

        if (this.shuttingDown) {
          throw new TerminalServiceError(
            "SERVICE_SHUTTING_DOWN",
            "Terminal service started shutting down while creating a terminal.",
          );
        }

        await this.persistence.saveMeta(runtime.meta);
        this.startSnapshotInterval(runtime);
        this.emitTerminalCreated(runtime.descriptor);

        const ticket = await this.issueTicket(runtime.meta.terminalId, runtime.meta.sessionAgentId);
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
            await this.ptyRuntime.killPty(createdHandle);
          } catch (cleanupError) {
            console.warn(
              `[terminal-service] Failed to kill PTY for aborted create ${terminalId}: ${toErrorMessage(cleanupError)}`,
            );
          }
        }

        this.terminals.delete(terminalId);
        try {
          await this.persistence.deleteTerminal(runtime.meta);
        } catch (cleanupError) {
          console.warn(
            `[terminal-service] Failed to cleanup aborted terminal ${terminalId}: ${toErrorMessage(cleanupError)}`,
          );
          this.persistence.disposeMirror(terminalId);
        }

        throw this.mapCreateError(error);
      }
    });
  }

  async createTerminal(request: TerminalCreateRequest): Promise<TerminalDescriptor> {
    const response = await this.create(request);
    return response.terminal;
  }

  list(sessionAgentId: string): TerminalDescriptor[] {
    return this.listTerminals(sessionAgentId);
  }

  listTerminals(sessionAgentId: string): TerminalDescriptor[] {
    const scopeSessionAgentId = this.resolveScopeSessionAgentId(sessionAgentId);
    return Array.from(this.terminals.values())
      .filter((runtime) => runtime.meta.sessionAgentId === scopeSessionAgentId && !runtime.closed)
      .map((runtime) => cloneDescriptor(runtime.descriptor))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getTerminal(terminalId: string): TerminalDescriptor | undefined;
  getTerminal(input: { terminalId: string; sessionAgentId: string }): TerminalDescriptor | undefined;
  getTerminal(
    input: string | { terminalId: string; sessionAgentId: string },
  ): TerminalDescriptor | undefined {
    const terminalId = typeof input === "string" ? input : input.terminalId;
    const runtime = this.terminals.get(terminalId);
    if (!runtime || runtime.closed) {
      return undefined;
    }

    if (typeof input !== "string" && runtime.meta.sessionAgentId !== this.resolveScopeSessionAgentId(input.sessionAgentId)) {
      return undefined;
    }

    return cloneDescriptor(runtime.descriptor);
  }

  async rename(terminalId: string, sessionAgentId: string, name: string): Promise<TerminalDescriptor> {
    return this.renameTerminal({ terminalId, request: { sessionAgentId, name } });
  }

  async renameTerminal(input: {
    terminalId: string;
    request: TerminalRenameRequest;
  }): Promise<TerminalDescriptor> {
    const runtime = this.requireRuntime(input.terminalId, input.request.sessionAgentId);
    const trimmed = input.request.name.trim();
    if (!trimmed) {
      throw new TerminalServiceError("INVALID_REQUEST", "Terminal name must be non-empty.");
    }

    return this.withRuntimeLock(runtime, async () => {
      runtime.meta.name = trimmed;
      runtime.meta.updatedAt = this.timestamp();
      runtime.descriptor = {
        ...runtime.descriptor,
        name: trimmed,
        updatedAt: runtime.meta.updatedAt,
      };
      await this.persistence.saveMeta(runtime.meta);
      this.emitTerminalUpdated(runtime.descriptor);
      return cloneDescriptor(runtime.descriptor);
    });
  }

  async resize(terminalId: string, sessionAgentId: string, cols: number, rows: number): Promise<TerminalDescriptor> {
    return this.resizeTerminal({ terminalId, request: { sessionAgentId, cols, rows } });
  }

  async resizeTerminal(input: {
    terminalId: string;
    request: TerminalResizeRequest;
  }): Promise<TerminalDescriptor> {
    const runtime = this.requireRuntime(input.terminalId, input.request.sessionAgentId);
    const cols = sanitizeDimension(input.request.cols, 20, "cols");
    const rows = sanitizeDimension(input.request.rows, 5, "rows");

    return this.withRuntimeLock(runtime, async () => {
      this.assertNotClosing(runtime);
      if (runtime.pty) {
        await this.ptyRuntime.resizePty(runtime.pty, cols, rows);
      }
      this.persistence.resizeMirror(runtime.meta.terminalId, cols, rows);
      runtime.meta.cols = cols;
      runtime.meta.rows = rows;
      runtime.meta.updatedAt = this.timestamp();
      runtime.descriptor = {
        ...runtime.descriptor,
        cols,
        rows,
        updatedAt: runtime.meta.updatedAt,
      };
      await this.persistence.saveMeta(runtime.meta);
      this.emitTerminalUpdated(runtime.descriptor);
      return cloneDescriptor(runtime.descriptor);
    });
  }

  async close(
    terminalId: string,
    sessionAgentId: string,
    reason: TerminalCloseReason = "user_closed",
  ): Promise<void> {
    await this.closeTerminal({ terminalId, sessionAgentId, reason });
  }

  async closeTerminal(input: {
    terminalId: string;
    sessionAgentId: string;
    reason: TerminalCloseReason;
  }): Promise<void> {
    const runtime = this.requireRuntime(input.terminalId, input.sessionAgentId);
    if (runtime.finalizePromise) {
      await runtime.finalizePromise;
      return;
    }

    runtime.finalizePromise = (async () => {
      let firstError: Error | null = null;
      const clients = Array.from(runtime.attachedClients);
      let ptyToKill: TerminalPtyHandle | null = null;

      await this.withRuntimeLock(runtime, async () => {
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
          await this.ptyRuntime.killPty(ptyToKill);
        } catch (error) {
          firstError = toError(error);
          console.warn(`[terminal-service] Failed to kill terminal ${runtime.meta.terminalId}: ${firstError.message}`);
        }
      }

      await this.withRuntimeLock(runtime, async () => {
        try {
          await this.snapshotRuntime(runtime);
        } catch (error) {
          if (!firstError) {
            firstError = toError(error);
          }
          console.warn(`[terminal-service] Failed to snapshot terminal ${runtime.meta.terminalId} before close: ${toErrorMessage(error)}`);
        }

        runtime.closed = true;
        runtime.attachedClients.clear();
        this.terminals.delete(runtime.meta.terminalId);

        try {
          await this.persistence.deleteTerminal(runtime.meta);
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
        this.emit("terminal_closed", {
          type: "terminal_closed",
          sessionAgentId: runtime.meta.sessionAgentId,
          terminalId: runtime.meta.terminalId,
          reason: input.reason,
        } satisfies TerminalClosedEvent);
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

  async handleInput(terminalId: string, data: Buffer | string, sessionAgentId?: string): Promise<void> {
    const runtime = sessionAgentId
      ? this.requireRuntime(terminalId, sessionAgentId)
      : this.requireRuntimeById(terminalId);

    await this.withRuntimeLock(runtime, async () => {
      this.assertNotClosing(runtime);
      if (!runtime.pty) {
        throw new TerminalServiceError("RESTORE_FAILED", `Terminal ${terminalId} is not running.`);
      }
      runtime.pty.write(data);
    });
  }

  async writeInput(input: {
    terminalId: string;
    sessionAgentId: string;
    data: Buffer | string;
  }): Promise<void> {
    await this.handleInput(input.terminalId, input.data, input.sessionAgentId);
  }

  async issueTicket(terminalId: string, sessionAgentId: string): Promise<TerminalIssueTicketResponse> {
    return this.issueWsTicket({ terminalId, sessionAgentId });
  }

  async issueWsTicket(input: {
    terminalId: string;
    sessionAgentId: string;
  }): Promise<TerminalIssueTicketResponse> {
    this.requireRuntime(input.terminalId, input.sessionAgentId);
    if (!this.runtimeConfig.enabled || this.shuttingDown) {
      throw new TerminalServiceError("SERVICE_SHUTTING_DOWN", "Terminal service is shutting down.");
    }
    if (!(await this.ptyRuntime.isAvailable())) {
      throw new TerminalServiceError("PTY_UNAVAILABLE", "Integrated terminals require node-pty.");
    }

    const expiresAt = this.now().getTime() + this.runtimeConfig.wsTicketTtlMs;
    const payload = `${input.terminalId}:${input.sessionAgentId}:${expiresAt}`;
    const signature = createHmac("sha256", this.ticketSecret).update(payload).digest("base64url");
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
    const expected = createHmac("sha256", this.ticketSecret).update(payload).digest("base64url");

    return safeEqual(signature, expected);
  }

  async getRestoreData(terminalId: string): Promise<TerminalRestoreData> {
    const runtime = this.requireRuntimeById(terminalId);
    const state = await this.persistence.readReplayData(runtime.meta);
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
    const runtime = this.requireRuntime(input.terminalId, input.sessionAgentId);
    const client: AttachedClient = {
      onData: input.onData,
      onControl: input.onControl,
    };

    await this.withRuntimeLock(runtime, async () => {
      this.assertNotClosing(runtime);
      const restore = await this.persistence.readReplayData(runtime.meta);

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
      await this.resize(input.terminalId, input.sessionAgentId, input.message.cols, input.message.rows);
      return;
    }
  }

  async cleanupSession(
    sessionAgentId: string,
    reason: Extract<TerminalCloseReason, "session_deleted" | "manager_deleted" | "orphan_cleanup">,
  ): Promise<number> {
    const terminalIds = Array.from(this.terminals.values())
      .filter((runtime) => runtime.meta.sessionAgentId === sessionAgentId)
      .map((runtime) => runtime.meta.terminalId);

    for (const terminalId of terminalIds) {
      await this.closeTerminal({ terminalId, sessionAgentId, reason });
    }

    return terminalIds.length;
  }

  async reconcileSessions(): Promise<{ removed: number }> {
    const validSessions = new Set(this.sessionResolver.listSessions().map((session) => session.sessionAgentId));
    const stale = Array.from(this.terminals.values())
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
      ? this.resolveScopeSessionAgentId(input.sessionAgentId)
      : undefined;
    const runtimes = Array.from(this.terminals.values()).filter((runtime) => {
      if (input?.terminalId && runtime.meta.terminalId !== input.terminalId) {
        return false;
      }
      if (scopeSessionAgentId && runtime.meta.sessionAgentId !== scopeSessionAgentId) {
        return false;
      }
      return !runtime.closed;
    });

    for (const runtime of runtimes) {
      await this.withRuntimeLock(runtime, async () => {
        await this.snapshotRuntime(runtime);
      });
    }

    return runtimes.length;
  }

  private async handleTransportEvent(event: TerminalTransportInboundEvent): Promise<void> {
    switch (event.type) {
      case "input": {
        const payload = event.payload as { terminalId: string; sessionAgentId: string; data: Buffer };
        await this.handleInput(payload.terminalId, payload.data, payload.sessionAgentId);
        return;
      }
      case "resize": {
        const payload = event.payload as { terminalId: string; sessionAgentId: string; cols: number; rows: number };
        await this.resize(payload.terminalId, payload.sessionAgentId, payload.cols, payload.rows);
        return;
      }
      case "close": {
        const payload = event.payload as {
          terminalId: string;
          sessionAgentId: string;
          reason?: TerminalCloseReason;
        };
        await this.close(payload.terminalId, payload.sessionAgentId, payload.reason ?? "user_closed");
        return;
      }
      default:
        return;
    }
  }

  private async handlePtyOutput(terminalId: string, chunk: Buffer): Promise<void> {
    const runtime = this.terminals.get(terminalId);
    if (!runtime || runtime.closed) {
      return;
    }

    await this.withRuntimeLock(runtime, async () => {
      if (runtime.closed) {
        return;
      }

      const seq = runtime.meta.nextSeq;
      runtime.meta.nextSeq += 1;
      runtime.meta.updatedAt = runtime.descriptor.updatedAt = this.timestamp();
      await this.persistence.writeToMirror(runtime.meta.terminalId, chunk);
      const bytesWritten = await this.persistence.appendJournal(runtime.meta, seq, chunk);
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

      this.emit("terminal_output", event);
      this.transport?.publish({
        type: "terminal_output",
        terminalId: runtime.meta.terminalId,
        sessionAgentId: runtime.meta.sessionAgentId,
        seq,
        chunk,
      });

      if (runtime.journalBytes >= this.runtimeConfig.journalMaxBytes) {
        await this.snapshotRuntime(runtime);
      }
    });
  }

  private async handlePtyExit(
    terminalId: string,
    exitCode: number | null,
    exitSignal: number | null,
  ): Promise<void> {
    const runtime = this.terminals.get(terminalId);
    if (!runtime || runtime.closed) {
      return;
    }

    await this.withRuntimeLock(runtime, async () => {
      if (runtime.closed) {
        return;
      }

      runtime.pty = null;
      runtime.meta.exitCode = exitCode;
      runtime.meta.exitSignal = exitSignal;
      runtime.meta.pid = null;
      runtime.meta.state = "exited";
      runtime.meta.updatedAt = this.timestamp();
      runtime.descriptor = this.transitionDescriptorState(
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
      await this.persistence.saveMeta(runtime.meta);

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

      this.emit("terminal_exit", event);
      this.transport?.publish({
        type: "terminal_exit",
        terminalId: runtime.meta.terminalId,
        sessionAgentId: runtime.meta.sessionAgentId,
        exitCode,
        exitSignal,
      });
      this.emitTerminalUpdated(runtime.descriptor);
    });
  }

  private async snapshotRuntime(runtime: ActiveTerminalRuntime): Promise<void> {
    await this.persistence.writeSnapshot(runtime.meta);
    runtime.meta.checkpointSeq = runtime.meta.nextSeq - 1;
    runtime.journalBytes = 0;
    await this.persistence.truncateJournal(runtime.meta);
    await this.persistence.saveMeta(runtime.meta);
  }

  private startSnapshotInterval(runtime: ActiveTerminalRuntime): void {
    if (runtime.snapshotInterval) {
      clearInterval(runtime.snapshotInterval);
    }

    runtime.snapshotInterval = setInterval(() => {
      void this.withRuntimeLock(runtime, async () => {
        if (runtime.closed) {
          return;
        }

        try {
          await this.snapshotRuntime(runtime);
        } catch (error) {
          console.warn(`[terminal-service] Snapshot failed for ${runtime.meta.terminalId}: ${toErrorMessage(error)}`);
        }
      });
    }, this.runtimeConfig.snapshotIntervalMs);
    runtime.snapshotInterval.unref?.();
  }

  private createInactiveRuntime(meta: TerminalMeta, session: ResolvedTerminalSession): ActiveTerminalRuntime {
    return {
      meta,
      descriptor: {
        terminalId: meta.terminalId,
        sessionAgentId: meta.sessionAgentId,
        profileId: meta.profileId,
        name: meta.name,
        shell: meta.shell,
        cwd: meta.cwd,
        cols: meta.cols,
        rows: meta.rows,
        state: meta.state,
        pid: meta.pid,
        exitCode: meta.exitCode,
        exitSignal: meta.exitSignal,
        recoveredFromPersistence: meta.recoveredFromPersistence,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
      },
      session,
      pty: null,
      closing: false,
      closed: false,
      finalizePromise: null,
      snapshotInterval: null,
      lock: Promise.resolve(),
      attachedClients: new Set(),
      journalBytes: 0,
    };
  }

  private transitionDescriptorState(
    descriptor: TerminalDescriptor,
    nextState: TerminalLifecycleState,
  ): TerminalDescriptor {
    const previousState = descriptor.state;
    const nextDescriptor = {
      ...descriptor,
      state: nextState,
      updatedAt: this.timestamp(),
    };

    if (previousState !== nextState) {
      this.emit("terminal_state_changed", {
        terminal: cloneDescriptor(nextDescriptor),
        previousState,
        nextState,
      } satisfies TerminalStateChangedEvent);
    }

    return nextDescriptor;
  }

  private emitTerminalCreated(descriptor: TerminalDescriptor): void {
    const cloned = cloneDescriptor(descriptor);
    this.emit("terminal_created", {
      type: "terminal_created",
      sessionAgentId: cloned.sessionAgentId,
      terminal: cloned,
    } satisfies TerminalCreatedEvent);
    this.transport?.publish({ type: "terminal_state", terminal: cloned });
  }

  private emitTerminalUpdated(descriptor: TerminalDescriptor): void {
    const cloned = cloneDescriptor(descriptor);
    this.emit("terminal_updated", {
      type: "terminal_updated",
      sessionAgentId: cloned.sessionAgentId,
      terminal: cloned,
    } satisfies TerminalUpdatedEvent);
    this.transport?.publish({ type: "terminal_state", terminal: cloned });
  }

  private resolveScopeSessionAgentId(sessionAgentId: string): string {
    return this.sessionResolver.resolveSession(sessionAgentId)?.sessionAgentId ?? sessionAgentId;
  }

  private requireSession(sessionAgentId: string): ResolvedTerminalSession {
    const session = this.sessionResolver.resolveSession(sessionAgentId);
    if (!session) {
      throw new TerminalServiceError("SESSION_NOT_FOUND", `Unknown terminal session: ${sessionAgentId}`);
    }
    return session;
  }

  private requireRuntime(terminalId: string, sessionAgentId: string): ActiveTerminalRuntime {
    const runtime = this.requireRuntimeById(terminalId);
    const scopeSessionAgentId = this.resolveScopeSessionAgentId(sessionAgentId);
    if (runtime.meta.sessionAgentId !== scopeSessionAgentId) {
      throw new TerminalServiceError(
        "TERMINAL_SESSION_MISMATCH",
        `Terminal ${terminalId} does not belong to session ${sessionAgentId}`,
      );
    }
    return runtime;
  }

  private requireRuntimeById(terminalId: string): ActiveTerminalRuntime {
    const runtime = this.terminals.get(terminalId);
    if (!runtime || runtime.closed) {
      throw new TerminalServiceError("TERMINAL_NOT_FOUND", `Unknown terminal: ${terminalId}`);
    }
    return runtime;
  }

  private assertServiceReady(): void {
    if (!this.runtimeConfig.enabled || this.shuttingDown) {
      throw new TerminalServiceError("SERVICE_SHUTTING_DOWN", "Terminal service is unavailable.");
    }
  }

  private assertTerminalLimit(sessionAgentId: string): void {
    const scopeSessionAgentId = this.resolveScopeSessionAgentId(sessionAgentId);
    const count = Array.from(this.terminals.values()).filter(
      (runtime) => runtime.meta.sessionAgentId === scopeSessionAgentId && !runtime.closed,
    ).length;

    if (count >= this.runtimeConfig.maxTerminalsPerSession) {
      throw new TerminalServiceError(
        "TERMINAL_LIMIT_REACHED",
        `Manager ${scopeSessionAgentId} already has ${count} terminals.`,
      );
    }
  }

  private async resolveCwd(session: ResolvedTerminalSession, requestedCwd?: string): Promise<string> {
    const sessionCwd = session.cwd?.trim();
    const homeCwd = homedir().trim();
    const fallbackRootDir = sessionCwd || homeCwd || this.cwdPolicy.rootDir;

    const resolveInput = async (input: string): Promise<string> => {
      return validateDirectoryPath(input, {
        rootDir: fallbackRootDir,
        allowlistRoots: this.cwdPolicy.allowlistRoots,
      });
    };

    const explicitCwd = requestedCwd?.trim();
    if (explicitCwd) {
      try {
        return await resolveInput(explicitCwd);
      } catch (error) {
        throw new TerminalServiceError("INVALID_CWD", toErrorMessage(error));
      }
    }

    const defaults = [sessionCwd, homeCwd, this.cwdPolicy.rootDir].filter((value): value is string => Boolean(value));
    for (const candidate of defaults) {
      try {
        return await resolveInput(candidate);
      } catch {
        // Try next fallback.
      }
    }

    throw new TerminalServiceError("INVALID_CWD", "Unable to resolve a valid terminal working directory.");
  }

  private createDefaultName(sessionAgentId: string, requestedName?: string): string {
    const trimmed = requestedName?.trim();
    if (trimmed) {
      return trimmed;
    }

    const scopeSessionAgentId = this.resolveScopeSessionAgentId(sessionAgentId);
    const nextIndex = Array.from(this.terminals.values()).filter(
      (runtime) => runtime.meta.sessionAgentId === scopeSessionAgentId,
    ).length + 1;
    return `Terminal ${nextIndex}`;
  }

  private assertNotClosing(runtime: ActiveTerminalRuntime): void {
    if (runtime.closing || runtime.closed) {
      throw new TerminalServiceError(
        "TERMINAL_ALREADY_CLOSING",
        `Terminal ${runtime.meta.terminalId} is already closing.`,
      );
    }
  }

  private async withRuntimeLock<T>(runtime: ActiveTerminalRuntime, fn: () => Promise<T>): Promise<T> {
    const previous = runtime.lock;
    let release!: () => void;
    runtime.lock = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async withSessionCreateLock<T>(sessionAgentId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.sessionCreateLocks.get(sessionAgentId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.sessionCreateLocks.set(sessionAgentId, current);

    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.sessionCreateLocks.get(sessionAgentId) === current) {
        this.sessionCreateLocks.delete(sessionAgentId);
      }
    }
  }

  private async snapshotRuntimeWithTimeout(runtime: ActiveTerminalRuntime, label: string): Promise<void> {
    const timeoutMs = this.runtimeConfig.shutdownSnapshotTimeoutMs;
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

  private mapCreateError(error: unknown): Error {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "PTY_UNAVAILABLE"
    ) {
      return new TerminalServiceError("PTY_UNAVAILABLE", "Integrated terminals require node-pty.");
    }

    if (error instanceof TerminalServiceError) {
      return error;
    }

    return new TerminalServiceError("RESTORE_FAILED", toErrorMessage(error));
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function cloneDescriptor(descriptor: TerminalDescriptor): TerminalDescriptor {
  return { ...descriptor };
}

function sanitizeDimension(value: number, minimum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > 1000) {
    throw new TerminalServiceError("INVALID_DIMENSIONS", `Invalid ${label}: ${value}`);
  }
  return value;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function toErrorMessage(error: unknown): string {
  return toError(error).message;
}
