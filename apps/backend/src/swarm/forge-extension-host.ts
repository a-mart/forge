import { join, resolve } from "node:path";
import type {
  ForgeDiscoveredExtensionMetadata,
  ForgeRuntimeExtensionSnapshot,
  ForgeSettingsExtensionsPayload
} from "@forge/protocol";
import { getGlobalForgeExtensionsDir, getProfilesDir } from "./data-paths.js";
import { discoverForgeExtensions, listForgeProfileIdsOnDisk } from "./forge-extension-discovery.js";
import { loadForgeExtensionModules } from "./forge-extension-loader.js";
import type { RuntimeErrorEvent } from "./runtime-types.js";
import type { AgentDescriptor } from "./types.js";
import { createForgeBindingToken } from "./forge-extension-types.js";
import type {
  DiscoveredForgeExtension,
  ForgeApi,
  ForgeBoundExtension,
  ForgeBoundHandlerRegistry,
  ForgeDiagnosticErrorRecord,
  ForgeEventName,
  ForgePreparedRuntimeBindings,
  ForgeRuntimeType,
  HostContext,
  RuntimeContext,
  SessionLifecycleEvent,
  ToolAfterResultEnvelope,
  ToolBeforeResult,
  VersioningCommitEvent
} from "./forge-extension-types.js";

const MAX_RECENT_ERRORS = 50;
const FORGE_SCOPE_SORT_ORDER = {
  global: 0,
  profile: 1,
  "project-local": 2
} as const;
const KNOWN_FORGE_EVENT_NAMES: ForgeEventName[] = [
  "session:lifecycle",
  "tool:before",
  "tool:after",
  "runtime:error",
  "versioning:commit"
];

interface ForgeExtensionHostOptions {
  dataDir: string;
  now?: () => string;
  version?: string;
}

export class ForgeExtensionHost {
  private readonly dataDir: string;
  private readonly now: () => string;
  private readonly version: string;
  private readonly activeRuntimeBindingsByToken = new Map<string, ForgePreparedRuntimeBindings>();
  private readonly runtimeSnapshotsByToken = new Map<string, ForgeRuntimeExtensionSnapshot>();
  private readonly recentErrors: ForgeDiagnosticErrorRecord[] = [];

  constructor(options: ForgeExtensionHostOptions) {
    this.dataDir = options.dataDir;
    this.now = options.now ?? (() => new Date().toISOString());
    this.version = options.version ?? process.env.FORGE_APP_VERSION ?? "dev";
  }

  async buildSettingsSnapshot(options: { cwdValues: string[] }): Promise<ForgeSettingsExtensionsPayload> {
    const discovered = await this.discoverForSettings(options.cwdValues);
    const loadResults = await loadForgeExtensionModules(discovered);
    const loadedByKey = new Map(loadResults.loaded.map((entry) => [getDiscoveredKey(entry.discovered), entry]));
    const loadErrorByKey = new Map(loadResults.errors.map((entry) => [getDiscoveredKey(entry.discovered), entry.error]));

    const discoveredWithDiagnostics: ForgeDiscoveredExtensionMetadata[] = discovered.map((entry) => {
      const loaded = loadedByKey.get(getDiscoveredKey(entry));
      return {
        displayName: entry.displayName,
        path: entry.path,
        scope: entry.scope,
        profileId: entry.profileId,
        cwd: entry.cwd,
        name: loaded?.metadata.name,
        description: loaded?.metadata.description,
        loadError: loadErrorByKey.get(getDiscoveredKey(entry))
      };
    });

    return {
      discovered: discoveredWithDiagnostics,
      snapshots: Array.from(this.runtimeSnapshotsByToken.values()).map(cloneForgeRuntimeSnapshot),
      recentErrors: this.recentErrors.map((entry) => ({ ...entry })),
      directories: {
        global: getGlobalForgeExtensionsDir(this.dataDir),
        profileTemplate: join(getProfilesDir(this.dataDir), "<profileId>", "extensions"),
        projectLocalRelative: ".forge/extensions"
      }
    };
  }

  recordDiagnosticError(error: Omit<ForgeDiagnosticErrorRecord, "timestamp"> & { timestamp?: string }): void {
    this.recentErrors.unshift({
      ...error,
      timestamp: error.timestamp ?? this.now()
    });

    if (this.recentErrors.length > MAX_RECENT_ERRORS) {
      this.recentErrors.length = MAX_RECENT_ERRORS;
    }
  }

  async prepareRuntimeBindings(options: {
    descriptor: AgentDescriptor;
    sessionDescriptor?: AgentDescriptor;
    runtimeType: ForgeRuntimeType;
    runtimeToken: number;
  }): Promise<ForgePreparedRuntimeBindings | null> {
    const runtimeContext = {
      agent: this.buildAgentSnapshot(options.descriptor),
      session: this.buildSessionSnapshot(
        options.descriptor,
        options.descriptor.role === "worker" ? options.sessionDescriptor : options.descriptor
      ),
      runtime: { type: options.runtimeType } as const
    };

    const discovered = await discoverForgeExtensions({
      dataDir: this.dataDir,
      scopes: [
        "global",
        ...(runtimeContext.session.profileId ? (["profile"] as const) : []),
        ...(runtimeContext.session.cwd ? (["project-local"] as const) : [])
      ],
      profileId: runtimeContext.session.profileId,
      cwd: runtimeContext.session.cwd
    });

    if (discovered.length === 0) {
      return null;
    }

    const loadedAt = this.now();
    const { extensions, diagnostics } = await this.loadBoundExtensions({
      discovered,
      loadedAt,
      agentId: options.descriptor.agentId,
      runtimeType: options.runtimeType
    });

    return {
      bindingToken: createForgeBindingToken(options.runtimeToken),
      agentId: options.descriptor.agentId,
      runtimeType: options.runtimeType,
      loadedAt,
      discovered,
      extensions,
      snapshot: {
        agentId: options.descriptor.agentId,
        role: options.descriptor.role,
        managerId: options.descriptor.managerId,
        profileId: options.descriptor.profileId,
        runtimeType: options.runtimeType,
        loadedAt,
        extensions: extensions.map((extension) => ({
          displayName: extension.module.discovered.displayName,
          path: extension.module.discovered.path,
          scope: extension.module.discovered.scope,
          name: extension.module.metadata.name,
          description: extension.module.metadata.description,
          hooks: getRegisteredHookNames(extension.handlers)
        }))
      },
      runtimeContext,
      diagnostics
    };
  }

  activateRuntimeBindings(bindings: ForgePreparedRuntimeBindings): void {
    this.activeRuntimeBindingsByToken.set(bindings.bindingToken, bindings);
    this.runtimeSnapshotsByToken.set(bindings.bindingToken, cloneForgeRuntimeSnapshot(bindings.snapshot));

    for (const diagnostic of bindings.diagnostics) {
      this.recordDiagnosticError(diagnostic);
    }
  }

  deactivateRuntimeBindings(bindingToken: string): void {
    this.activeRuntimeBindingsByToken.delete(bindingToken);
    this.runtimeSnapshotsByToken.delete(bindingToken);
  }

  async dispatchToolBefore(
    bindingToken: string,
    options: {
      toolName: string;
      toolCallId: string;
      input: Record<string, unknown>;
    }
  ): Promise<ToolBeforeResult | undefined> {
    const bindings = this.activeRuntimeBindingsByToken.get(bindingToken);
    if (!bindings) {
      return undefined;
    }

    let workingInput = cloneStructured(options.input);
    let changed = false;

    for (const extension of bindings.extensions) {
      for (const handler of extension.handlers["tool:before"]) {
        try {
          const result = await handler(
            Object.freeze({
              toolName: options.toolName,
              toolCallId: options.toolCallId,
              input: Object.freeze(cloneStructured(workingInput))
            }),
            this.buildRuntimeContext(bindings, "tool:before", extension.module.discovered.path)
          );

          if (result?.block === true) {
            return {
              block: true,
              reason: result.reason?.trim() || `Tool ${options.toolName} was blocked by a Forge extension.`
            };
          }

          if (result?.input !== undefined) {
            if (!isPlainObject(result.input)) {
              this.recordInvalidToolBeforeMutationDiagnostic(bindings, extension.module.discovered.path);
              continue;
            }

            workingInput = cloneStructured(result.input);
            changed = true;
          }
        } catch (error) {
          this.recordHandlerDiagnosticError(bindings, "tool:before", extension.module.discovered.path, error);
        }
      }
    }

    return changed ? { input: workingInput } : undefined;
  }

  async dispatchToolAfter(
    bindingToken: string,
    options: {
      toolName: string;
      toolCallId: string;
      input: Record<string, unknown>;
      result: ToolAfterResultEnvelope;
    }
  ): Promise<void> {
    const bindings = this.activeRuntimeBindingsByToken.get(bindingToken);
    if (!bindings) {
      return;
    }

    const event = Object.freeze({
      toolName: options.toolName,
      toolCallId: options.toolCallId,
      input: Object.freeze(cloneStructured(options.input)),
      result: Object.freeze(cloneStructured(options.result)),
      isError: options.result.ok === false
    });

    for (const extension of bindings.extensions) {
      for (const handler of extension.handlers["tool:after"]) {
        try {
          await handler(event, this.buildRuntimeContext(bindings, "tool:after", extension.module.discovered.path));
        } catch (error) {
          this.recordHandlerDiagnosticError(bindings, "tool:after", extension.module.discovered.path, error);
        }
      }
    }
  }

  async dispatchSessionLifecycle(options: {
    action: SessionLifecycleEvent["action"];
    sessionDescriptor: AgentDescriptor;
    sourceDescriptor?: AgentDescriptor;
  }): Promise<void> {
    const discovered = await this.discoverHostDispatchExtensions({
      hook: "session:lifecycle",
      scopes: ["global", "profile", "project-local"],
      profileId: options.sessionDescriptor.profileId ?? options.sessionDescriptor.agentId,
      cwd: options.sessionDescriptor.cwd
    });
    if (discovered.length === 0) {
      return;
    }

    const loadedAt = this.now();
    const { extensions, diagnostics } = await this.loadBoundExtensions({
      discovered,
      loadedAt,
      hook: "session:lifecycle"
    });
    this.recordDiagnosticErrors(diagnostics);

    const event = Object.freeze({
      action: options.action,
      session: this.buildSessionSnapshot(options.sessionDescriptor),
      ...(options.sourceDescriptor
        ? {
            sourceSessionAgentId:
              options.sourceDescriptor.role === "manager"
                ? options.sourceDescriptor.agentId
                : options.sourceDescriptor.managerId
          }
        : {})
    });

    for (const extension of extensions) {
      for (const handler of extension.handlers["session:lifecycle"]) {
        try {
          await handler(event, this.buildHostContext("session:lifecycle", extension.module.discovered));
        } catch (error) {
          this.recordHostHandlerDiagnosticError("session:lifecycle", extension.module.discovered, error);
        }
      }
    }
  }

  async dispatchRuntimeError(bindingToken: string, error: RuntimeErrorEvent): Promise<void> {
    const bindings = this.activeRuntimeBindingsByToken.get(bindingToken);
    if (!bindings) {
      return;
    }

    const event = Object.freeze({
      phase: error.phase,
      message: error.message.trim().length > 0 ? error.message.trim() : "Unknown runtime error",
      ...(error.details ? { details: Object.freeze({ ...error.details }) } : {})
    });

    for (const extension of bindings.extensions) {
      for (const handler of extension.handlers["runtime:error"]) {
        try {
          await handler(event, this.buildRuntimeContext(bindings, "runtime:error", extension.module.discovered.path));
        } catch (handlerError) {
          this.recordHandlerDiagnosticError(bindings, "runtime:error", extension.module.discovered.path, handlerError);
        }
      }
    }
  }

  async dispatchVersioningCommit(event: VersioningCommitEvent): Promise<void> {
    const discovered = await this.discoverHostDispatchExtensions({
      hook: "versioning:commit",
      scopes: ["global", "profile"],
      profileIds: event.profileIds
    });
    if (discovered.length === 0) {
      return;
    }

    const loadedAt = this.now();
    const { extensions, diagnostics } = await this.loadBoundExtensions({
      discovered,
      loadedAt,
      hook: "versioning:commit"
    });
    this.recordDiagnosticErrors(diagnostics);

    const frozenEvent = Object.freeze({
      sha: event.sha,
      subject: event.subject,
      body: event.body,
      paths: Object.freeze([...event.paths]),
      mutations: Object.freeze(event.mutations.map((mutation) => Object.freeze({ ...mutation }))),
      reason: event.reason,
      profileIds: Object.freeze([...event.profileIds])
    });

    for (const extension of extensions) {
      for (const handler of extension.handlers["versioning:commit"]) {
        try {
          await handler(frozenEvent, this.buildHostContext("versioning:commit", extension.module.discovered));
        } catch (error) {
          this.recordHostHandlerDiagnosticError("versioning:commit", extension.module.discovered, error);
        }
      }
    }
  }

  getVersion(): string {
    return this.version;
  }

  private createForgeApi(handlers: ForgeBoundHandlerRegistry): ForgeApi {
    return {
      dataDir: this.dataDir,
      version: this.version,
      on: (event, handler) => {
        if (!isKnownForgeEventName(event)) {
          throw new Error(
            `Unknown Forge hook "${String(event)}". Valid hooks: ${KNOWN_FORGE_EVENT_NAMES.join(", ")}`
          );
        }

        handlers[event].push(handler as never);
      }
    };
  }

  private async loadBoundExtensions(options: {
    discovered: readonly DiscoveredForgeExtension[];
    loadedAt: string;
    agentId?: string;
    runtimeType?: ForgeRuntimeType;
    hook?: ForgeEventName;
  }): Promise<{
    extensions: ForgeBoundExtension[];
    diagnostics: ForgeDiagnosticErrorRecord[];
  }> {
    const loadResults = await loadForgeExtensionModules(options.discovered);
    const diagnostics: ForgeDiagnosticErrorRecord[] = loadResults.errors.map((entry) => ({
      timestamp: options.loadedAt,
      phase: "load",
      message: entry.error,
      hook: options.hook,
      path: entry.discovered.path,
      scope: entry.discovered.scope,
      agentId: options.agentId,
      runtimeType: options.runtimeType
    }));

    const extensions: ForgeBoundExtension[] = [];
    for (const loadedModule of loadResults.loaded) {
      const handlers = createEmptyHandlerRegistry();
      try {
        await loadedModule.setup(this.createForgeApi(handlers));
        extensions.push({
          module: loadedModule,
          handlers
        });
      } catch (error) {
        diagnostics.push({
          timestamp: options.loadedAt,
          phase: "setup",
          message: normalizeErrorMessage(error),
          hook: options.hook,
          path: loadedModule.discovered.path,
          scope: loadedModule.discovered.scope,
          agentId: options.agentId,
          runtimeType: options.runtimeType
        });
      }
    }

    return { extensions, diagnostics };
  }

  private buildAgentSnapshot(descriptor: AgentDescriptor): RuntimeContext["agent"] {
    return Object.freeze({
      agentId: descriptor.agentId,
      role: descriptor.role,
      managerId: descriptor.managerId,
      profileId: descriptor.profileId,
      cwd: descriptor.cwd,
      specialistId: descriptor.specialistId,
      model: Object.freeze({
        provider: descriptor.model.provider,
        modelId: descriptor.model.modelId,
        reasoningLevel: descriptor.model.thinkingLevel
      })
    });
  }

  private buildSessionSnapshot(
    descriptor: AgentDescriptor,
    sessionDescriptor?: AgentDescriptor
  ): RuntimeContext["session"] {
    const sessionAgentId =
      descriptor.role === "manager"
        ? descriptor.agentId
        : sessionDescriptor?.role === "manager"
          ? sessionDescriptor.agentId
          : descriptor.managerId;
    const resolvedSessionDescriptor =
      sessionDescriptor?.role === "manager"
        ? sessionDescriptor
        : descriptor.role === "manager"
          ? descriptor
          : undefined;

    return Object.freeze({
      sessionAgentId,
      profileId: resolvedSessionDescriptor?.profileId ?? descriptor.profileId ?? sessionAgentId,
      label: resolvedSessionDescriptor?.sessionLabel ?? null,
      cwd: resolvedSessionDescriptor?.cwd ?? descriptor.cwd
    });
  }

  private buildRuntimeContext(
    bindings: ForgePreparedRuntimeBindings,
    hook: string,
    extensionPath: string
  ): RuntimeContext {
    return Object.freeze({
      agent: bindings.runtimeContext.agent,
      session: bindings.runtimeContext.session,
      runtime: bindings.runtimeContext.runtime,
      log: this.buildLogger({
        agentId: bindings.agentId,
        runtimeType: bindings.runtimeType,
        hook,
        path: extensionPath
      })
    });
  }

  private buildHostContext(hook: ForgeEventName, discovered: DiscoveredForgeExtension): HostContext {
    return Object.freeze({
      log: this.buildLogger({
        hook,
        path: discovered.path,
        scope: discovered.scope
      })
    });
  }

  private buildLogger(options: {
    hook: string;
    path: string;
    scope?: DiscoveredForgeExtension["scope"];
    agentId?: string;
    runtimeType?: ForgeRuntimeType;
  }): RuntimeContext["log"] & HostContext["log"] {
    const baseData = {
      ...(options.agentId ? { agentId: options.agentId } : {}),
      ...(options.runtimeType ? { runtimeType: options.runtimeType } : {}),
      ...(options.scope ? { scope: options.scope } : {}),
      hook: options.hook,
      path: options.path
    };

    return {
      debug: (message, data) => this.logDiagnostic("debug", message, { ...baseData, ...data }),
      info: (message, data) => this.logDiagnostic("info", message, { ...baseData, ...data }),
      warn: (message, data) => this.logDiagnostic("warn", message, { ...baseData, ...data }),
      error: (message, data) => this.logDiagnostic("error", message, { ...baseData, ...data })
    };
  }

  private recordHandlerDiagnosticError(
    bindings: ForgePreparedRuntimeBindings,
    hook: string,
    extensionPath: string,
    error: unknown
  ): void {
    const message = normalizeErrorMessage(error);
    this.recordDiagnosticError({
      phase: "handler",
      message,
      hook,
      path: extensionPath,
      agentId: bindings.agentId,
      runtimeType: bindings.runtimeType
    });
    this.logDiagnostic("warn", "forge_extension:handler_failed", {
      agentId: bindings.agentId,
      runtimeType: bindings.runtimeType,
      hook,
      path: extensionPath,
      message
    });
  }

  private recordInvalidToolBeforeMutationDiagnostic(
    bindings: ForgePreparedRuntimeBindings,
    extensionPath: string
  ): void {
    const message = 'Forge extension tool:before handler returned invalid input mutation. Expected a plain object.';
    this.recordDiagnosticError({
      phase: "validation",
      message,
      hook: "tool:before",
      path: extensionPath,
      agentId: bindings.agentId,
      runtimeType: bindings.runtimeType
    });
    this.logDiagnostic("warn", "forge_extension:handler_validation_failed", {
      agentId: bindings.agentId,
      runtimeType: bindings.runtimeType,
      hook: "tool:before",
      path: extensionPath,
      message
    });
  }

  private recordHostHandlerDiagnosticError(
    hook: ForgeEventName,
    discovered: DiscoveredForgeExtension,
    error: unknown
  ): void {
    const message = normalizeErrorMessage(error);
    this.recordDiagnosticError({
      phase: "handler",
      message,
      hook,
      path: discovered.path,
      scope: discovered.scope
    });
    this.logDiagnostic("warn", "forge_extension:handler_failed", {
      hook,
      path: discovered.path,
      scope: discovered.scope,
      message
    });
  }

  private recordDiagnosticErrors(diagnostics: readonly ForgeDiagnosticErrorRecord[]): void {
    for (const diagnostic of diagnostics) {
      this.recordDiagnosticError(diagnostic);
    }
  }

  private async discoverHostDispatchExtensions(options: {
    hook: ForgeEventName;
    scopes: Array<"global" | "profile" | "project-local">;
    profileId?: string;
    profileIds?: readonly string[];
    cwd?: string;
  }): Promise<DiscoveredForgeExtension[]> {
    try {
      const discovered: DiscoveredForgeExtension[] = [];

      if (options.scopes.includes("global")) {
        discovered.push(
          ...(await discoverForgeExtensions({
            dataDir: this.dataDir,
            scopes: ["global"]
          }))
        );
      }

      const profileIds = options.profileIds
        ? Array.from(new Set(options.profileIds.filter((profileId) => profileId.trim().length > 0)))
        : options.profileId
          ? [options.profileId]
          : [];
      if (options.scopes.includes("profile")) {
        for (const profileId of profileIds.sort((left, right) => left.localeCompare(right))) {
          discovered.push(
            ...(await discoverForgeExtensions({
              dataDir: this.dataDir,
              scopes: ["profile"],
              profileId
            }))
          );
        }
      }

      if (options.scopes.includes("project-local") && options.cwd) {
        discovered.push(
          ...(await discoverForgeExtensions({
            dataDir: this.dataDir,
            scopes: ["project-local"],
            cwd: options.cwd
          }))
        );
      }

      return dedupeAndSortDiscoveredExtensions(discovered);
    } catch (error) {
      this.recordDiagnosticError({
        phase: "discover",
        message: normalizeErrorMessage(error),
        hook: options.hook
      });
      return [];
    }
  }

  private async discoverForSettings(cwdValues: string[]): Promise<Awaited<ReturnType<typeof discoverForgeExtensions>>> {
    const discovered = await discoverForgeExtensions({
      dataDir: this.dataDir,
      scopes: ["global"]
    });

    const profileIds = await listForgeProfileIdsOnDisk(this.dataDir);
    for (const profileId of profileIds) {
      discovered.push(
        ...(await discoverForgeExtensions({
          dataDir: this.dataDir,
          scopes: ["profile"],
          profileId
        }))
      );
    }

    for (const cwd of normalizeCwdValues(cwdValues)) {
      discovered.push(
        ...(await discoverForgeExtensions({
          dataDir: this.dataDir,
          scopes: ["project-local"],
          cwd
        }))
      );
    }

    return dedupeAndSortDiscoveredExtensions(discovered);
  }

  private logDiagnostic(level: "debug" | "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void {
    const payload = data ? ` ${safeSerializeDiagnosticData(data)}` : "";
    const text = `[forge-extension] ${message}${payload}`;

    switch (level) {
      case "debug":
      case "info":
        console.log(text);
        return;
      case "warn":
        console.warn(text);
        return;
      case "error":
        console.error(text);
        return;
    }
  }
}

function getDiscoveredKey(entry: {
  path: string;
  scope: string;
  profileId?: string;
  cwd?: string;
}): string {
  return [entry.scope, entry.path, entry.profileId ?? "", entry.cwd ?? ""].join("::");
}

function dedupeAndSortDiscoveredExtensions(
  discovered: readonly DiscoveredForgeExtension[]
): DiscoveredForgeExtension[] {
  const unique = new Map<string, DiscoveredForgeExtension>();

  for (const entry of discovered) {
    const key = getDiscoveredKey(entry);
    if (!unique.has(key)) {
      unique.set(key, entry);
    }
  }

  return Array.from(unique.values()).sort((left, right) => {
    const byScope = FORGE_SCOPE_SORT_ORDER[left.scope] - FORGE_SCOPE_SORT_ORDER[right.scope];
    if (byScope !== 0) {
      return byScope;
    }

    return toComparablePath(left.path).localeCompare(toComparablePath(right.path));
  });
}

function normalizeCwdValues(cwdValues: string[]): string[] {
  return Array.from(
    new Set(
      cwdValues
        .map((cwd) => cwd.trim())
        .filter((cwd) => cwd.length > 0)
    )
  ).sort((left, right) => left.localeCompare(right));
}

function toComparablePath(pathValue: string): string {
  const resolvedPath = resolve(pathValue.trim());
  return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

function cloneForgeRuntimeSnapshot(snapshot: ForgeRuntimeExtensionSnapshot): ForgeRuntimeExtensionSnapshot {
  return {
    ...snapshot,
    extensions: snapshot.extensions.map((extension) => ({
      ...extension,
      hooks: [...extension.hooks]
    }))
  };
}

function createEmptyHandlerRegistry(): ForgeBoundHandlerRegistry {
  return {
    "session:lifecycle": [],
    "tool:before": [],
    "tool:after": [],
    "runtime:error": [],
    "versioning:commit": []
  };
}

function getRegisteredHookNames(handlers: ForgeBoundHandlerRegistry): string[] {
  return KNOWN_FORGE_EVENT_NAMES.filter((eventName) => handlers[eventName].length > 0);
}

function isKnownForgeEventName(value: string): value is ForgeEventName {
  return KNOWN_FORGE_EVENT_NAMES.includes(value as ForgeEventName);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneStructured<T>(value: T): T {
  return structuredClone(value);
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }

  return "Unknown Forge extension error";
}

function safeSerializeDiagnosticData(data: Record<string, unknown>): string {
  try {
    return JSON.stringify(data);
  } catch {
    return '"<unserializable>"';
  }
}
