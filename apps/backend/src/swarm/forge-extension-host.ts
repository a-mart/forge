import { join, resolve } from "node:path";
import type {
  ForgeDiscoveredExtensionMetadata,
  ForgeRuntimeExtensionSnapshot,
  ForgeSettingsExtensionsPayload
} from "@forge/protocol";
import { getGlobalForgeExtensionsDir, getProfilesDir } from "./data-paths.js";
import { discoverForgeExtensions, listForgeProfileIdsOnDisk } from "./forge-extension-discovery.js";
import { loadForgeExtensionModules } from "./forge-extension-loader.js";
import type { AgentDescriptor } from "./types.js";
import type {
  ForgeApi,
  ForgeBoundExtension,
  ForgeBoundHandlerRegistry,
  ForgeDiagnosticErrorRecord,
  ForgeEventName,
  ForgePreparedRuntimeBindings,
  ForgeRuntimeType,
  HostContext,
  RuntimeContext,
  ToolAfterResultEnvelope,
  ToolBeforeResult
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
  private readonly activeRuntimeBindingsByAgentId = new Map<string, ForgePreparedRuntimeBindings>();
  private readonly runtimeSnapshotsByAgentId = new Map<string, ForgeRuntimeExtensionSnapshot>();
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
      snapshots: Array.from(this.runtimeSnapshotsByAgentId.values()).map(cloneForgeRuntimeSnapshot),
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
    runtimeType: ForgeRuntimeType;
  }): Promise<ForgePreparedRuntimeBindings | null> {
    const runtimeContext = {
      agent: this.buildAgentSnapshot(options.descriptor),
      session: this.buildSessionSnapshot(options.descriptor),
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
    const loadResults = await loadForgeExtensionModules(discovered);
    const diagnostics: ForgeDiagnosticErrorRecord[] = loadResults.errors.map((entry) => ({
      timestamp: loadedAt,
      phase: "load",
      message: entry.error,
      path: entry.discovered.path,
      scope: entry.discovered.scope,
      agentId: options.descriptor.agentId,
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
          timestamp: loadedAt,
          phase: "setup",
          message: normalizeErrorMessage(error),
          path: loadedModule.discovered.path,
          scope: loadedModule.discovered.scope,
          agentId: options.descriptor.agentId,
          runtimeType: options.runtimeType
        });
      }
    }

    return {
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
    this.activeRuntimeBindingsByAgentId.set(bindings.agentId, bindings);
    this.runtimeSnapshotsByAgentId.set(bindings.agentId, cloneForgeRuntimeSnapshot(bindings.snapshot));

    for (const diagnostic of bindings.diagnostics) {
      this.recordDiagnosticError(diagnostic);
    }
  }

  deactivateRuntimeBindings(agentId: string): void {
    this.activeRuntimeBindingsByAgentId.delete(agentId);
    this.runtimeSnapshotsByAgentId.delete(agentId);
  }

  async dispatchToolBefore(
    agentId: string,
    options: {
      toolName: string;
      toolCallId: string;
      input: Record<string, unknown>;
    }
  ): Promise<ToolBeforeResult | undefined> {
    const bindings = this.activeRuntimeBindingsByAgentId.get(agentId);
    if (!bindings) {
      return undefined;
    }

    let workingInput = cloneToolInput(options.input);
    let changed = false;

    for (const extension of bindings.extensions) {
      for (const handler of extension.handlers["tool:before"]) {
        try {
          const result = await handler(
            Object.freeze({
              toolName: options.toolName,
              toolCallId: options.toolCallId,
              input: Object.freeze(cloneToolInput(workingInput))
            }),
            this.buildRuntimeContext(bindings, "tool:before", extension.module.discovered.path)
          );

          if (result?.block === true) {
            return {
              block: true,
              reason: result.reason?.trim() || `Tool ${options.toolName} was blocked by a Forge extension.`
            };
          }

          if (result?.input) {
            workingInput = cloneToolInput(result.input);
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
    agentId: string,
    options: {
      toolName: string;
      toolCallId: string;
      input: Record<string, unknown>;
      result: ToolAfterResultEnvelope;
    }
  ): Promise<void> {
    const bindings = this.activeRuntimeBindingsByAgentId.get(agentId);
    if (!bindings) {
      return;
    }

    const event = Object.freeze({
      toolName: options.toolName,
      toolCallId: options.toolCallId,
      input: Object.freeze(cloneToolInput(options.input)),
      result: Object.freeze({ ...options.result }),
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

  async dispatchSessionLifecycle(): Promise<void> {
    return undefined;
  }

  async dispatchRuntimeError(): Promise<void> {
    return undefined;
  }

  async dispatchVersioningCommit(): Promise<void> {
    return undefined;
  }

  getVersion(): string {
    return this.version;
  }

  private createForgeApi(handlers: ForgeBoundHandlerRegistry): ForgeApi {
    return {
      dataDir: this.dataDir,
      version: this.version,
      on: (event, handler) => {
        handlers[event].push(handler as never);
      }
    };
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

  private buildSessionSnapshot(descriptor: AgentDescriptor): RuntimeContext["session"] {
    const sessionAgentId = descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId;
    return Object.freeze({
      sessionAgentId,
      profileId: descriptor.profileId ?? sessionAgentId,
      label: descriptor.role === "manager" ? descriptor.sessionLabel ?? null : null,
      cwd: descriptor.cwd
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

  private buildLogger(options: {
    agentId: string;
    runtimeType: ForgeRuntimeType;
    hook: string;
    path: string;
  }): RuntimeContext["log"] & HostContext["log"] {
    const baseData = {
      agentId: options.agentId,
      runtimeType: options.runtimeType,
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

    return discovered.sort((left, right) => {
      const byScope = FORGE_SCOPE_SORT_ORDER[left.scope] - FORGE_SCOPE_SORT_ORDER[right.scope];
      if (byScope !== 0) {
        return byScope;
      }

      return toComparablePath(left.path).localeCompare(toComparablePath(right.path));
    });
  }

  private logDiagnostic(level: "debug" | "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void {
    const payload = data ? ` ${JSON.stringify(data)}` : "";
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

function cloneToolInput(input: Record<string, unknown>): Record<string, unknown> {
  return { ...input };
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
