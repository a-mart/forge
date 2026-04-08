import type {
  ForgeDiscoveredExtensionMetadata,
  ForgeExtensionDiagnosticError,
  ForgeRuntimeExtensionSnapshot
} from "@forge/protocol";

export type ForgeScope = "global" | "profile" | "project-local";
export type ForgeRuntimeType = "pi" | "claude" | "codex";

export interface ForgeApi {
  readonly dataDir: string;
  readonly version: string;
  on<E extends ForgeEventName>(event: E, handler: ForgeEventHandler<E>): void;
}

export interface ForgeLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface AgentSnapshot {
  readonly agentId: string;
  readonly role: "manager" | "worker";
  readonly managerId: string;
  readonly profileId?: string;
  readonly cwd: string;
  readonly specialistId?: string;
  readonly model: {
    readonly provider: string;
    readonly modelId: string;
    readonly reasoningLevel: string;
  };
}

export interface SessionSnapshot {
  readonly sessionAgentId: string;
  readonly profileId: string;
  readonly label: string | null;
  readonly cwd: string;
}

export interface RuntimeContext {
  readonly agent: AgentSnapshot;
  readonly session: SessionSnapshot;
  readonly runtime: { readonly type: ForgeRuntimeType };
  readonly log: ForgeLogger;
}

export interface HostContext {
  readonly log: ForgeLogger;
}

export interface SessionLifecycleEvent {
  readonly action: "created" | "forked" | "renamed" | "deleted";
  readonly session: SessionSnapshot;
  readonly sourceSessionAgentId?: string;
}

export interface ToolBeforeEvent {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly input: Record<string, unknown>;
}

export interface ToolAfterResultEnvelope {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
  readonly raw?: unknown;
}

export interface ToolAfterEvent extends ToolBeforeEvent {
  readonly result: ToolAfterResultEnvelope;
  readonly isError: boolean;
}

export interface ToolBeforeResult {
  readonly block?: true;
  readonly reason?: string;
  readonly input?: Record<string, unknown>;
}

export interface RuntimeErrorObservedEvent {
  readonly phase: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export interface VersioningMutation {
  readonly path: string;
  readonly action: "write" | "delete";
  readonly source: string;
  readonly profileId?: string;
  readonly sessionId?: string;
  readonly agentId?: string;
}

export interface VersioningCommitEvent {
  readonly sha: string;
  readonly subject: string;
  readonly body: string;
  readonly paths: readonly string[];
  readonly mutations: readonly VersioningMutation[];
  readonly reason: string;
  readonly profileIds: readonly string[];
}

export interface ForgeEventMap {
  "session:lifecycle": [SessionLifecycleEvent, HostContext, void];
  "tool:before": [ToolBeforeEvent, RuntimeContext, ToolBeforeResult | void];
  "tool:after": [ToolAfterEvent, RuntimeContext, void];
  "runtime:error": [RuntimeErrorObservedEvent, RuntimeContext, void];
  "versioning:commit": [VersioningCommitEvent, HostContext, void];
}

export type ForgeEventName = keyof ForgeEventMap;

export type ForgeEventHandler<E extends ForgeEventName> = ForgeEventMap[E] extends [infer Ev, infer Ctx, infer Ret]
  ? (event: Ev, ctx: Ctx) => Ret | Promise<Ret>
  : never;

export interface DiscoveredForgeExtension extends ForgeDiscoveredExtensionMetadata {
  readonly scope: ForgeScope;
}

export interface LoadedForgeExtensionModule {
  readonly discovered: DiscoveredForgeExtension;
  readonly setup: (forge: ForgeApi) => void | Promise<void>;
  readonly metadata: {
    readonly name?: string;
    readonly description?: string;
  };
}

export interface ForgeBoundHandlerRegistry {
  readonly "session:lifecycle": ForgeEventHandler<"session:lifecycle">[];
  readonly "tool:before": ForgeEventHandler<"tool:before">[];
  readonly "tool:after": ForgeEventHandler<"tool:after">[];
  readonly "runtime:error": ForgeEventHandler<"runtime:error">[];
  readonly "versioning:commit": ForgeEventHandler<"versioning:commit">[];
}

export interface ForgePreparedRuntimeBindings {
  readonly agentId: string;
  readonly runtimeType: ForgeRuntimeType;
  readonly loadedAt: string;
  readonly discovered: readonly DiscoveredForgeExtension[];
  readonly loadedModules: readonly LoadedForgeExtensionModule[];
  readonly handlers: ForgeBoundHandlerRegistry;
}

export interface ForgeRuntimeBindingSnapshot {
  readonly agentId: string;
  readonly snapshot: ForgeRuntimeExtensionSnapshot;
}

export interface ForgeDiagnosticErrorRecord extends ForgeExtensionDiagnosticError {
  readonly scope?: ForgeScope;
}

export interface ForgeExtensionLoadFailure {
  readonly discovered: DiscoveredForgeExtension;
  readonly error: string;
}
