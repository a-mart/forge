import type {
  TerminalCloseReason,
  TerminalDescriptor,
  TerminalIssueTicketResponse,
  TerminalLifecycleState,
  TerminalMeta,
} from "@forge/protocol";
import type { TerminalRuntimeConfig } from "./terminal-config.js";
import type { TerminalPersistence } from "./terminal-persistence.js";
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

export interface AttachedClient {
  onData: (chunk: Buffer) => void;
  onControl: (message: import("@forge/protocol").TerminalWsServerControlMessage) => void;
}

export interface ActiveTerminalRuntime {
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

export type TerminalServiceErrorCode =
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

export class TerminalServiceError extends Error {
  readonly code: TerminalServiceErrorCode;

  constructor(code: TerminalServiceErrorCode, message: string) {
    super(message);
    this.name = "TerminalServiceError";
    this.code = code;
  }
}

export interface TerminalServiceContext {
  readonly runtimeConfig: TerminalRuntimeConfig;
  readonly sessionResolver: TerminalSessionResolver;
  readonly ptyRuntime: TerminalPtyRuntime;
  readonly persistence: TerminalPersistence;
  readonly cwdPolicy: {
    rootDir: string;
    allowlistRoots: string[];
  };
  readonly transport?: TerminalTransport;
  readonly terminals: Map<string, ActiveTerminalRuntime>;
  readonly sessionCreateLocks: Map<string, Promise<void>>;
  readonly ticketSecret: Buffer;
  now(): Date;
  getInitialized(): boolean;
  setInitialized(value: boolean): void;
  getShuttingDown(): boolean;
  setShuttingDown(value: boolean): void;
  getTransportUnsubscribe(): (() => void) | null;
  setTransportUnsubscribe(value: (() => void) | null): void;
  emit(eventName: string | symbol, ...args: unknown[]): boolean;
  resolveScopeSessionAgentId(sessionAgentId: string): string;
  requireSession(sessionAgentId: string): ResolvedTerminalSession;
  requireRuntime(terminalId: string, sessionAgentId: string): ActiveTerminalRuntime;
  requireRuntimeById(terminalId: string): ActiveTerminalRuntime;
  assertServiceReady(): void;
  assertTerminalLimit(sessionAgentId: string): void;
  resolveCwd(session: ResolvedTerminalSession, requestedCwd?: string): Promise<string>;
  createDefaultName(sessionAgentId: string, requestedName?: string): string;
  assertNotClosing(runtime: ActiveTerminalRuntime): void;
  withRuntimeLock<T>(runtime: ActiveTerminalRuntime, fn: () => Promise<T>): Promise<T>;
  withSessionCreateLock<T>(sessionAgentId: string, fn: () => Promise<T>): Promise<T>;
  handleInput(terminalId: string, data: Buffer | string, sessionAgentId?: string): Promise<void>;
  handlePtyOutput(terminalId: string, chunk: Buffer): Promise<void>;
  handlePtyExit(terminalId: string, exitCode: number | null, exitSignal: number | null): Promise<void>;
  resize(terminalId: string, sessionAgentId: string, cols: number, rows: number): Promise<TerminalDescriptor>;
  close(terminalId: string, sessionAgentId: string, reason?: TerminalCloseReason): Promise<void>;
  issueWsTicket(input: {
    terminalId: string;
    sessionAgentId: string;
  }): Promise<TerminalIssueTicketResponse>;
  handleTransportEvent(event: TerminalTransportInboundEvent): Promise<void>;
  snapshotRuntime(runtime: ActiveTerminalRuntime): Promise<void>;
  startSnapshotInterval(runtime: ActiveTerminalRuntime): void;
  snapshotRuntimeWithTimeout(runtime: ActiveTerminalRuntime, label: string): Promise<void>;
  transitionDescriptorState(
    descriptor: TerminalDescriptor,
    nextState: TerminalLifecycleState,
  ): TerminalDescriptor;
  emitTerminalCreated(descriptor: TerminalDescriptor): void;
  emitTerminalUpdated(descriptor: TerminalDescriptor): void;
  mapCreateError(error: unknown): Error;
  timestamp(): string;
}
