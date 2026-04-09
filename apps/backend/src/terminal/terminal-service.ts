import { randomBytes } from "node:crypto";
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
  TerminalRenameRequest,
  TerminalResizeRequest,
  TerminalUpdatedEvent,
  TerminalWsClientControlMessage,
  TerminalWsServerControlMessage,
} from "@forge/protocol";
import { validateDirectoryPath } from "../swarm/cwd-policy.js";
import { cloneDescriptor, toErrorMessage } from "./terminal-service-helpers.js";
import { TerminalServiceClientController } from "./terminal-service-client.js";
import { TerminalServiceLifecycleController } from "./terminal-service-lifecycle.js";
import { TerminalServiceRuntimeController } from "./terminal-service-runtime.js";
import {
  TerminalServiceError,
  type ActiveTerminalRuntime,
  type TerminalRestoreData,
  type TerminalServiceContext,
  type TerminalServiceInitializeResult,
  type TerminalServiceOptions,
  type TerminalStateChangedEvent,
} from "./terminal-service-types.js";
import type { ResolvedTerminalSession } from "./terminal-session-resolver.js";

export { TerminalServiceError } from "./terminal-service-types.js";

export class TerminalService extends EventEmitter {
  private readonly runtimeConfig;
  private readonly sessionResolver;
  private readonly ptyRuntime;
  private readonly persistence;
  private readonly cwdPolicy;
  private readonly transport;
  private readonly nowProvider: () => Date;
  private readonly terminals = new Map<string, ActiveTerminalRuntime>();
  private readonly sessionCreateLocks = new Map<string, Promise<void>>();
  private readonly ticketSecret = randomBytes(32);
  private transportUnsubscribe: (() => void) | null = null;
  private initialized = false;
  private shuttingDown = false;
  private readonly context: TerminalServiceContext;
  private readonly runtimeOperations: TerminalServiceRuntimeController;
  private readonly lifecycleOperations: TerminalServiceLifecycleController;
  private readonly clientOperations: TerminalServiceClientController;

  constructor(options: TerminalServiceOptions) {
    super();
    this.runtimeConfig = options.runtimeConfig;
    this.sessionResolver = options.sessionResolver;
    this.ptyRuntime = options.ptyRuntime;
    this.persistence = options.persistence;
    this.cwdPolicy = options.cwdPolicy;
    this.transport = options.transport;
    this.nowProvider = options.now ?? (() => new Date());

    const self = this;
    this.context = {
      get runtimeConfig() {
        return self.runtimeConfig;
      },
      get sessionResolver() {
        return self.sessionResolver;
      },
      get ptyRuntime() {
        return self.ptyRuntime;
      },
      get persistence() {
        return self.persistence;
      },
      get cwdPolicy() {
        return self.cwdPolicy;
      },
      get transport() {
        return self.transport;
      },
      get terminals() {
        return self.terminals;
      },
      get sessionCreateLocks() {
        return self.sessionCreateLocks;
      },
      get ticketSecret() {
        return self.ticketSecret;
      },
      now: () => self.nowProvider(),
      getInitialized: () => self.initialized,
      setInitialized: (value) => {
        self.initialized = value;
      },
      getShuttingDown: () => self.shuttingDown,
      setShuttingDown: (value) => {
        self.shuttingDown = value;
      },
      getTransportUnsubscribe: () => self.transportUnsubscribe,
      setTransportUnsubscribe: (value) => {
        self.transportUnsubscribe = value;
      },
      emit: (eventName, ...args) => self.emit(eventName, ...args),
      resolveScopeSessionAgentId: (sessionAgentId) => self.resolveScopeSessionAgentId(sessionAgentId),
      requireSession: (sessionAgentId) => self.requireSession(sessionAgentId),
      requireRuntime: (terminalId, sessionAgentId) => self.requireRuntime(terminalId, sessionAgentId),
      requireRuntimeById: (terminalId) => self.requireRuntimeById(terminalId),
      assertServiceReady: () => self.assertServiceReady(),
      assertTerminalLimit: (sessionAgentId) => self.assertTerminalLimit(sessionAgentId),
      resolveCwd: (session, requestedCwd) => self.resolveCwd(session, requestedCwd),
      createDefaultName: (sessionAgentId, requestedName) => self.createDefaultName(sessionAgentId, requestedName),
      assertNotClosing: (runtime) => self.assertNotClosing(runtime),
      withRuntimeLock: (runtime, fn) => self.withRuntimeLock(runtime, fn),
      withSessionCreateLock: (sessionAgentId, fn) => self.withSessionCreateLock(sessionAgentId, fn),
      handleInput: (terminalId, data, sessionAgentId) => self.runtimeOperations.handleInput(terminalId, data, sessionAgentId),
      handlePtyOutput: (terminalId, chunk) => self.runtimeOperations.handlePtyOutput(terminalId, chunk),
      handlePtyExit: (terminalId, exitCode, exitSignal) =>
        self.runtimeOperations.handlePtyExit(terminalId, exitCode, exitSignal),
      resize: (terminalId, sessionAgentId, cols, rows) => self.resize(terminalId, sessionAgentId, cols, rows),
      close: (terminalId, sessionAgentId, reason) => self.close(terminalId, sessionAgentId, reason),
      issueWsTicket: (input) => self.clientOperations.issueWsTicket(input),
      handleTransportEvent: (event) => self.clientOperations.handleTransportEvent(event),
      snapshotRuntime: (runtime) => self.runtimeOperations.snapshotRuntime(runtime),
      startSnapshotInterval: (runtime) => self.runtimeOperations.startSnapshotInterval(runtime),
      snapshotRuntimeWithTimeout: (runtime, label) => self.runtimeOperations.snapshotRuntimeWithTimeout(runtime, label),
      transitionDescriptorState: (descriptor, nextState) => self.transitionDescriptorState(descriptor, nextState),
      emitTerminalCreated: (descriptor) => self.emitTerminalCreated(descriptor),
      emitTerminalUpdated: (descriptor) => self.emitTerminalUpdated(descriptor),
      mapCreateError: (error) => self.mapCreateError(error),
      timestamp: () => self.timestamp(),
    };

    this.runtimeOperations = new TerminalServiceRuntimeController(this.context);
    this.clientOperations = new TerminalServiceClientController(this.context);
    this.lifecycleOperations = new TerminalServiceLifecycleController(this.context);
  }

  async initialize(): Promise<TerminalServiceInitializeResult> {
    return this.lifecycleOperations.initialize();
  }

  async shutdown(): Promise<void> {
    await this.lifecycleOperations.shutdown();
  }

  async create(request: TerminalCreateRequest): Promise<TerminalCreateResponse> {
    return this.lifecycleOperations.create(request);
  }

  async createTerminal(request: TerminalCreateRequest): Promise<TerminalDescriptor> {
    const response = await this.create(request);
    return response.terminal;
  }

  list(sessionAgentId: string): TerminalDescriptor[] {
    return this.listTerminals(sessionAgentId);
  }

  listTerminals(sessionAgentId: string): TerminalDescriptor[] {
    return this.lifecycleOperations.listTerminals(sessionAgentId);
  }

  getTerminal(terminalId: string): TerminalDescriptor | undefined;
  getTerminal(input: { terminalId: string; sessionAgentId: string }): TerminalDescriptor | undefined;
  getTerminal(
    input: string | { terminalId: string; sessionAgentId: string },
  ): TerminalDescriptor | undefined {
    return this.lifecycleOperations.getTerminal(input);
  }

  async rename(terminalId: string, sessionAgentId: string, name: string): Promise<TerminalDescriptor> {
    return this.renameTerminal({ terminalId, request: { sessionAgentId, name } });
  }

  async renameTerminal(input: {
    terminalId: string;
    request: TerminalRenameRequest;
  }): Promise<TerminalDescriptor> {
    return this.lifecycleOperations.renameTerminal(input);
  }

  async resize(terminalId: string, sessionAgentId: string, cols: number, rows: number): Promise<TerminalDescriptor> {
    return this.resizeTerminal({ terminalId, request: { sessionAgentId, cols, rows } });
  }

  async resizeTerminal(input: {
    terminalId: string;
    request: TerminalResizeRequest;
  }): Promise<TerminalDescriptor> {
    return this.lifecycleOperations.resizeTerminal(input);
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
    await this.lifecycleOperations.closeTerminal(input);
  }

  async handleInput(terminalId: string, data: Buffer | string, sessionAgentId?: string): Promise<void> {
    await this.runtimeOperations.handleInput(terminalId, data, sessionAgentId);
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
    return this.clientOperations.issueWsTicket(input);
  }

  validateWsTicket(input: {
    terminalId: string;
    sessionAgentId: string;
    ticket: string;
  }): boolean {
    return this.clientOperations.validateWsTicket(input);
  }

  async getRestoreData(terminalId: string): Promise<TerminalRestoreData> {
    return this.clientOperations.getRestoreData(terminalId);
  }

  async attachClient(input: {
    terminalId: string;
    sessionAgentId: string;
    onData: (chunk: Buffer) => void;
    onControl: (message: TerminalWsServerControlMessage) => void;
  }): Promise<() => void> {
    return this.clientOperations.attachClient(input);
  }

  async handleClientControl(input: {
    terminalId: string;
    sessionAgentId: string;
    message: TerminalWsClientControlMessage;
    reply: (message: TerminalWsServerControlMessage) => void;
  }): Promise<void> {
    await this.clientOperations.handleClientControl(input);
  }

  async cleanupSession(
    sessionAgentId: string,
    reason: Extract<TerminalCloseReason, "session_deleted" | "manager_deleted" | "orphan_cleanup">,
  ): Promise<number> {
    return this.lifecycleOperations.cleanupSession(sessionAgentId, reason);
  }

  async reconcileSessions(): Promise<{ removed: number }> {
    return this.lifecycleOperations.reconcileSessions();
  }

  async snapshotNow(input?: { sessionAgentId?: string; terminalId?: string }): Promise<number> {
    return this.lifecycleOperations.snapshotNow(input);
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

    if (count >= this.runtimeConfig.maxTerminalsPerManager) {
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
    return this.nowProvider().toISOString();
  }
}
