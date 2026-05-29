import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  type AgentRuntimeExtensionSnapshot,
  type RuntimeExtensionMetadata,
  type RuntimeExtensionSource
} from "@forge/protocol";
import type { Model, Transport } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  DefaultResourceLoader,
  createAgentSession,
  ModelRegistry,
  SettingsManager,
  type AgentSession,
  type LoadExtensionsResult
} from "@mariozechner/pi-coding-agent";
import { AgentRuntime } from "../../agent-runtime.js";
import { ensureCanonicalAuthFilePath } from "../../auth-storage-paths.js";
import type { CredentialPoolService } from "../../credential-pool.js";
import type { ForgeExtensionHost } from "../../forge-extension-host.js";
import { createPiModelRegistry } from "../../pi-model-registry.js";
import type {
  RuntimeCreationOptions,
  RuntimeErrorEvent,
  RuntimeSessionEvent,
  SwarmAgentRuntime
} from "../../runtime-contracts.js";
import { installOpenAICodexWebSocketDiagnostics } from "../../runtime-utils.js";
import {
  buildProjectSafePiProjectSettingsStorage,
  filterUntrustedProjectPiExtensions,
  pathExistsSync,
  type ProjectExecutableTrustPlan
} from "../../project-executable-trust.js";
import { openSessionManagerWithSizeGuard } from "../../session-file-guard.js";
import type { SkillMetadata } from "../../skills/skill-metadata-service.js";
import type { SwarmToolHost } from "../../swarm-tool-host.js";
import { isCollabSession, resolveExactModel } from "../../swarm-manager-utils.js";
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentModelDescriptor,
  AgentStatus,
  SwarmConfig
} from "../../types.js";
import { planPiRuntimePrompt } from "../runtime-prompt-plan.js";
import { planPiResourceLoaderOptions, planRuntimeResourcePaths } from "../runtime-resource-plan.js";
import { planForgePiToolBridgeFactory, planPiExtensionFactories, planRuntimeTools } from "../runtime-tool-plan.js";

interface PiRuntimeCreatorDependencies {
  host: SwarmToolHost;
  forgeExtensionHost: ForgeExtensionHost;
  config: SwarmConfig;
  now: () => string;
  logDebug: (message: string, details?: unknown) => void;
  getPiModelsJsonPath: () => string;
  getCredentialPoolService?: () => CredentialPoolService;
  onSessionFileRotated?: (descriptor: AgentDescriptor, sessionFile: string) => Promise<void>;
  getMemoryRuntimeResources: (descriptor: AgentDescriptor) => Promise<{
    memoryContextFile: { path: string; content: string };
    additionalSkillPaths: string[];
    skillMetadata: SkillMetadata[];
  }>;
  getSwarmContextFiles: (cwd: string) => Promise<Array<{ path: string; content: string }>>;
  resolveProjectExecutableTrustPlan: (options: {
    descriptor: AgentDescriptor;
    sessionDescriptor?: AgentDescriptor;
  }) => Promise<ProjectExecutableTrustPlan>;
  mergeRuntimeContextFiles: (
    baseAgentsFiles: Array<{ path: string; content: string }>,
    options: {
      memoryContextFile: { path: string; content: string };
      swarmContextFiles: Array<{ path: string; content: string }>;
    }
  ) => Array<{ path: string; content: string }>;
  callbacks: {
    onStatusChange: (
      runtimeToken: number,
      agentId: string,
      status: AgentStatus,
      pendingCount: number,
      contextUsage?: AgentContextUsage
    ) => Promise<void>;
    onSessionEvent: (runtimeToken: number, agentId: string, event: RuntimeSessionEvent) => Promise<void>;
    onAgentEnd: (runtimeToken: number, agentId: string) => Promise<void>;
    onRuntimeError: (runtimeToken: number, agentId: string, error: RuntimeErrorEvent) => Promise<void>;
    onRuntimeExtensionSnapshot: (
      runtimeToken: number,
      agentId: string,
      snapshot: AgentRuntimeExtensionSnapshot
    ) => Promise<void>;
  };
}

export class PiRuntimeCreator {
  constructor(private readonly deps: PiRuntimeCreatorDependencies) {}

  async createRuntimeForDescriptor(options: {
    descriptor: AgentDescriptor;
    systemPrompt: string;
    runtimeToken: number;
    sessionDescriptor: AgentDescriptor | undefined;
    creationOptions?: RuntimeCreationOptions;
  }): Promise<SwarmAgentRuntime> {
    const { descriptor, systemPrompt, runtimeToken, sessionDescriptor, creationOptions } = options;
    const projectExecutableTrustPlan = await this.deps.resolveProjectExecutableTrustPlan({
      descriptor,
      sessionDescriptor
    });
    const preparedForgeBindings = await this.deps.forgeExtensionHost.prepareRuntimeBindings({
      descriptor,
      sessionDescriptor,
      runtimeType: "pi",
      runtimeToken,
      projectExecutableTrustPlan
    });
    const { baseSwarmTools, swarmTools } = planRuntimeTools({
      host: this.deps.host,
      descriptor,
      forgeExtensionHost: this.deps.forgeExtensionHost,
      preparedForgeBindings
    });
    const thinkingLevel = normalizeThinkingLevel(descriptor.model.thinkingLevel);
    const pathsPlan = planRuntimeResourcePaths({ config: this.deps.config, descriptor });
    const runtimeAgentDir = pathsPlan.runtimeAgentDir;
    const memoryResources = await this.deps.getMemoryRuntimeResources(descriptor);
    const promptPlan = planPiRuntimePrompt({
      descriptor,
      systemPrompt,
      cwd: descriptor.cwd,
      startupRecoveryContext: creationOptions?.startupRecoveryContext
    });
    const authFilePath = await ensureCanonicalAuthFilePath(this.deps.config);

    this.deps.logDebug("runtime:create:start", {
      runtime: "pi",
      agentId: descriptor.agentId,
      role: descriptor.role,
      model: descriptor.model,
      archetypeId: descriptor.archetypeId,
      cwd: descriptor.cwd,
      authFile: authFilePath,
      agentDir: runtimeAgentDir,
      piModelsJsonPath: this.deps.getPiModelsJsonPath(),
      memoryFile: memoryResources.memoryContextFile.path,
      profileId: pathsPlan.profileId,
      profilePiExtensionsDir: pathsPlan.profilePiExtensionsDir,
      profilePiSkillsDir: pathsPlan.profilePiSkillsDir,
      profilePiPromptsDir: pathsPlan.profilePiPromptsDir,
      profilePiThemesDir: pathsPlan.profilePiThemesDir,
      projectForgeDir: projectExecutableTrustPlan.effectiveForgeDirRealpath,
      projectExecutablesTrusted: projectExecutableTrustPlan.trusted,
      managerSystemPromptSource: descriptor.role === "manager" ? "archetype:manager" : undefined
    });

    const poolSelection = await this.selectPooledCredential(descriptor);
    const authStorage = poolSelection?.authStorage ?? AuthStorage.create(authFilePath);
    const pooledCredentialId = poolSelection?.credentialId;

    const piModelsJsonPath = this.deps.getPiModelsJsonPath();
    const modelRegistry = createPiModelRegistry(authStorage, piModelsJsonPath);
    const model = this.resolveModel(modelRegistry, descriptor.model);
    if (isOpenAICodexModel(model)) {
      installOpenAICodexWebSocketDiagnostics();
    }
    const settingsManager = this.createRuntimeSettingsManager(
      descriptor,
      runtimeAgentDir,
      model,
      projectExecutableTrustPlan.trustedPiSettingsPaths,
      projectExecutableTrustPlan.trusted
    );

    const swarmContextFiles = await this.deps.getSwarmContextFiles(descriptor.cwd);
    const extensionFactories = planPiExtensionFactories({
      descriptor,
      config: this.deps.config,
      logDebug: this.deps.logDebug,
      forgePiToolBridgeFactory: planForgePiToolBridgeFactory({
        forgeExtensionHost: this.deps.forgeExtensionHost,
        preparedForgeBindings,
        baseSwarmTools
      })
    });
    const resourcePlan = planPiResourceLoaderOptions({
      descriptor,
      pathsPlan,
      memoryResources,
      promptPlan,
      swarmContextFiles,
      extensionFactories,
      trustedProjectPiExtensionPaths: projectExecutableTrustPlan.trustedPiExtensionDirs.filter(pathExistsSync),
      extensionsOverride: (result) => filterUntrustedProjectPiExtensions({
        result,
        descriptor,
        config: this.deps.config,
        trustPlan: projectExecutableTrustPlan
      }),
      isCollaborationRuntime: isCollabSession(sessionDescriptor),
      mergeRuntimeContextFiles: this.deps.mergeRuntimeContextFiles
    });
    const resourceLoader =
      descriptor.role === "manager"
        ? new DefaultResourceLoader({
            ...resourcePlan,
            settingsManager
          })
        : new DefaultResourceLoader({
            ...omitSystemPrompt(resourcePlan),
            settingsManager
          });

    try {
      await resourceLoader.reload();
    } catch (error) {
      this.deps.logDebug("runtime:resource_loader:reload_error", {
        agentId: descriptor.agentId,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    const sessionManager = openSessionManagerWithSizeGuard(descriptor.sessionFile, {
      context: `runtime:create:pi:${descriptor.agentId}`,
      rotateOversizedFile: true,
      logWarning: (message, details) => {
        this.deps.logDebug(message, details);

        if (message === "session:file:oversized:rotated") {
          Promise.resolve(this.deps.onSessionFileRotated?.(descriptor, descriptor.sessionFile)).catch((error) => {
            this.deps.logDebug("session:meta:rotation_hook_error", {
              agentId: descriptor.agentId,
              sessionFile: descriptor.sessionFile,
              message: error instanceof Error ? error.message : String(error)
            });
          });
        }
      }
    });
    if (!sessionManager) {
      throw new Error(`Unable to open session file for agent ${descriptor.agentId}: ${descriptor.sessionFile}`);
    }

    const { session, extensionsResult } = await createAgentSession({
      cwd: descriptor.cwd,
      agentDir: runtimeAgentDir,
      authStorage,
      modelRegistry,
      model,
      thinkingLevel: thinkingLevel as any,
      sessionManager,
      resourceLoader,
      ...(settingsManager ? { settingsManager } : {}),
      customTools: swarmTools
    });

    const extensionSnapshot = buildRuntimeExtensionSnapshot({
      descriptor,
      loadedAt: this.deps.now(),
      extensionsResult: filterUntrustedProjectPiExtensions({
        result: extensionsResult,
        descriptor,
        config: this.deps.config,
        trustPlan: projectExecutableTrustPlan
      }),
      config: this.deps.config
    });
    try {
      await this.deps.callbacks.onRuntimeExtensionSnapshot(runtimeToken, descriptor.agentId, extensionSnapshot);
    } catch (error) {
      this.deps.logDebug("runtime:extension_snapshot:error", {
        agentId: descriptor.agentId,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await session.bindExtensions({
        onError: (error) => {
          this.deps.logDebug("extension:error", {
            agentId: descriptor.agentId,
            extensionPath: error.extensionPath,
            event: error.event,
            message: error.error,
            stack: error.stack
          });

          const message = error.error.trim().length > 0 ? error.error.trim() : "Extension handler failed";
          void this.deps.callbacks
            .onRuntimeError(runtimeToken, descriptor.agentId, {
              phase: "extension",
              message,
              stack: error.stack,
              details: {
                extensionPath: error.extensionPath,
                event: error.event
              }
            })
            .catch((bridgeError) => {
              this.deps.logDebug("extension:error_bridge_failed", {
                agentId: descriptor.agentId,
                extensionPath: error.extensionPath,
                event: error.event,
                message: bridgeError instanceof Error ? bridgeError.message : String(bridgeError)
              });
            });
        }
      });
    } catch (error) {
      this.deps.logDebug("extension:bind_error", {
        agentId: descriptor.agentId,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    const activeToolNames = new Set(session.getActiveToolNames());
    for (const tool of swarmTools) {
      activeToolNames.add(tool.name);
    }
    session.setActiveToolsByName(Array.from(activeToolNames));

    this.deps.logDebug("runtime:create:ready", {
      runtime: "pi",
      agentId: descriptor.agentId,
      activeTools: session.getActiveToolNames(),
      systemPromptPreview: previewForLog(session.systemPrompt, 240),
      containsSpeakToUserRule: descriptor.role === "manager" ? session.systemPrompt.includes("speak_to_user") : undefined
    });

    const runtime = new AgentRuntime({
      descriptor: cloneRuntimeDescriptor(descriptor),
      session: session as AgentSession,
      systemPrompt,
      callbacks: {
        onStatusChange: async (agentId, status, pendingCount, contextUsage) => {
          await this.deps.callbacks.onStatusChange(runtimeToken, agentId, status, pendingCount, contextUsage);
        },
        onSessionEvent: async (agentId, event) => {
          await this.deps.callbacks.onSessionEvent(runtimeToken, agentId, event);
        },
        onAgentEnd: async (agentId) => {
          await this.deps.callbacks.onAgentEnd(runtimeToken, agentId);
        },
        onRuntimeError: async (agentId, error) => {
          await this.deps.callbacks.onRuntimeError(runtimeToken, agentId, error);
        }
      },
      now: this.deps.now
    });

    if (pooledCredentialId) {
      runtime.pooledCredentialId = pooledCredentialId;
      runtime.pooledCredentialProvider = descriptor.model.provider;
      runtime.credentialPoolService = this.deps.getCredentialPoolService?.();
    }

    if (preparedForgeBindings) {
      this.deps.forgeExtensionHost.activateRuntimeBindings(preparedForgeBindings);
    }

    return runtime;
  }

  private createRuntimeSettingsManager(
    descriptor: AgentDescriptor,
    runtimeAgentDir: string,
    model: Model<any>,
    trustedProjectSettingsPaths: string[],
    projectExecutablesTrusted: boolean
  ): SettingsManager {
    const settingsManager = SettingsManager.fromStorage(buildProjectSafePiProjectSettingsStorage({
      agentDir: runtimeAgentDir,
      projectSettingsPaths: trustedProjectSettingsPaths.filter(pathExistsSync),
      projectExecutablesTrusted
    }));
    const transport = resolveOpenAICodexTransport(model);
    if (transport) {
      settingsManager.applyOverrides({ transport });
      this.deps.logDebug("runtime:pi:openai_codex_transport", {
        agentId: descriptor.agentId,
        transport,
        model: model.id,
        provider: model.provider
      });
    }
    return settingsManager;
  }

  private async selectPooledCredential(
    descriptor: AgentDescriptor
  ): Promise<{ authStorage: AuthStorage; credentialId: string } | null> {
    const provider = descriptor.model.provider.trim().toLowerCase();
    if (!POOLED_PROVIDERS.has(provider)) {
      return null;
    }

    const getPool = this.deps.getCredentialPoolService;
    if (!getPool) return null;

    const pool = getPool();
    const poolSize = await pool.getPoolSize(provider);
    if (poolSize <= 1) return null;

    const selection = await pool.select(provider);
    if (!selection) {
      const earliestCooldownExpiry = await pool.getEarliestCooldownExpiry(provider);
      const resetMessage = earliestCooldownExpiry
        ? ` Earliest cooldown reset: ${new Date(earliestCooldownExpiry).toISOString()}.`
        : " No cooldown reset time is currently available.";

      this.deps.logDebug("runtime:credential_pool:all_exhausted", {
        provider,
        earliestCooldownExpiry,
        message: `All pooled ${provider} credentials are unavailable.${resetMessage}`
      });

      throw new Error(`All pooled ${provider} credentials are unavailable.${resetMessage}`);
    }

    try {
      const authData = await pool.buildRuntimeAuthData(provider, selection.credentialId);
      const authStorage = AuthStorage.inMemory(authData);
      await pool.markUsed(provider, selection.credentialId);

      this.deps.logDebug("runtime:credential_pool:selected", {
        provider,
        credentialId: selection.credentialId,
        authStorageKey: selection.authStorageKey
      });

      return { authStorage, credentialId: selection.credentialId };
    } catch (error) {
      this.deps.logDebug("runtime:credential_pool:build_auth_error", {
        provider,
        credentialId: selection.credentialId,
        message: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  private resolveModel(modelRegistry: ModelRegistry, descriptor: AgentModelDescriptor): Model<any> {
    const resolved = resolveExactModel(modelRegistry, descriptor);
    if (resolved) {
      return resolved;
    }

    this.deps.logDebug("runtime:model:projection_miss", {
      provider: descriptor.provider,
      modelId: descriptor.modelId,
      message: "Model not found in Forge projection or Pi built-in catalog"
    });

    throw new Error(`Model "${descriptor.modelId}" not found for provider "${descriptor.provider}".`);
  }
}

interface BuildRuntimeExtensionSnapshotOptions {
  descriptor: AgentDescriptor;
  loadedAt: string;
  extensionsResult: LoadExtensionsResult;
  config: SwarmConfig;
}

function buildRuntimeExtensionSnapshot(options: BuildRuntimeExtensionSnapshotOptions): AgentRuntimeExtensionSnapshot {
  const extensions: RuntimeExtensionMetadata[] = options.extensionsResult.extensions
    .filter(
      (extension) =>
        !isInternalInlineExtensionPath(extension.path) && !isInternalInlineExtensionPath(extension.resolvedPath)
    )
    .map((extension) => {
      const resolvedPath = extension.resolvedPath || extension.path;

      return {
        displayName: normalizeExtensionDisplayName(extension.path, resolvedPath),
        path: extension.path,
        resolvedPath,
        source: classifyRuntimeExtensionSource({
          path: extension.path,
          resolvedPath,
          sourceInfo: extension.sourceInfo,
          descriptor: options.descriptor,
          config: options.config
        }),
        events: Array.from(extension.handlers.keys()).sort((left, right) => left.localeCompare(right)),
        tools: Array.from(extension.tools.keys()).sort((left, right) => left.localeCompare(right))
      } satisfies RuntimeExtensionMetadata;
    })
    .sort((left, right) => {
      const byDisplay = left.displayName.localeCompare(right.displayName);
      if (byDisplay !== 0) return byDisplay;
      return left.path.localeCompare(right.path);
    });

  const loadErrors = options.extensionsResult.errors
    .filter((entry) => !isInternalInlineExtensionPath(entry.path))
    .map((entry) => ({
      path: entry.path,
      error: entry.error
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    agentId: options.descriptor.agentId,
    role: options.descriptor.role,
    managerId: options.descriptor.managerId,
    profileId: options.descriptor.profileId,
    loadedAt: options.loadedAt,
    extensions,
    loadErrors
  };
}

function isInternalInlineExtensionPath(pathValue: string | undefined): boolean {
  const normalized = pathValue?.trim() ?? "";
  return normalized.startsWith("<inline");
}

function classifyRuntimeExtensionSource(options: {
  path: string;
  resolvedPath: string;
  sourceInfo:
    | {
        source: string;
        scope: string;
        origin: "package" | "top-level";
        baseDir?: string;
      }
    | undefined;
  descriptor: AgentDescriptor;
  config: SwarmConfig;
}): RuntimeExtensionSource {
  const globalWorkerExtensionsDir = join(options.config.paths.agentDir, "extensions");
  const globalManagerExtensionsDir = join(options.config.paths.managerAgentDir, "extensions");
  const profilesDir = join(options.config.paths.dataDir, "profiles");
  const projectLocalExtensionsDir = join(options.descriptor.cwd, ".pi", "extensions");

  for (const candidate of [options.resolvedPath, options.path]) {
    if (!candidate || isInternalInlineExtensionPath(candidate)) {
      continue;
    }

    if (isPathInside(candidate, globalWorkerExtensionsDir)) {
      return "global-worker";
    }

    if (isPathInside(candidate, globalManagerExtensionsDir)) {
      return "global-manager";
    }

    if (isProfileOverlayExtensionPath(candidate, profilesDir)) {
      return "profile";
    }

    if (isPathInside(candidate, projectLocalExtensionsDir) || isRepoForgePiExtensionPath(candidate)) {
      return "project-local";
    }
  }

  if (options.sourceInfo?.origin === "package") {
    return "package";
  }

  if (
    options.sourceInfo?.source &&
    options.sourceInfo.source !== "local" &&
    options.sourceInfo.source !== "auto" &&
    options.sourceInfo.source !== "cli"
  ) {
    return "package";
  }

  return "unknown";
}

function isRepoForgePiExtensionPath(pathValue: string): boolean {
  return resolve(pathValue).split(/[\\/]+/).join("/").includes("/.forge/pi/extensions/");
}

function isProfileOverlayExtensionPath(pathValue: string, profilesDir: string): boolean {
  if (!isPathInside(pathValue, profilesDir)) {
    return false;
  }

  const relativePath = relative(resolve(profilesDir), resolve(pathValue));
  if (!relativePath || relativePath.startsWith("..")) {
    return false;
  }

  const segments = relativePath.split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (segments.length < 3) {
    return false;
  }

  return segments[1]?.toLowerCase() === "pi" && segments[2]?.toLowerCase() === "extensions";
}

function isPathInside(targetPath: string, rootPath: string): boolean {
  const normalizedTarget = toComparablePath(targetPath);
  const normalizedRoot = toComparablePath(rootPath);

  if (normalizedTarget === normalizedRoot) {
    return true;
  }

  const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
  return normalizedTarget.startsWith(prefix);
}

function toComparablePath(pathValue: string): string {
  const normalized = resolve(pathValue);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizeExtensionDisplayName(pathValue: string, resolvedPathValue: string): string {
  const candidate = (resolvedPathValue || pathValue).trim();
  if (!candidate) {
    return "extension";
  }

  const normalizedBase = basename(candidate);
  const normalizedBaseLower = normalizedBase.toLowerCase();

  if (normalizedBaseLower === "index.ts" || normalizedBaseLower === "index.js") {
    const parentDirName = basename(dirname(candidate));
    if (parentDirName && parentDirName !== "." && parentDirName !== sep) {
      return parentDirName;
    }
  }

  return normalizedBase || candidate;
}

const POOLED_PROVIDERS = new Set(["openai-codex", "anthropic"]);

function normalizeThinkingLevel(level: string): string {
  return level === "x-high" ? "xhigh" : level;
}

function previewForLog(text: string, maxLength = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function isOpenAICodexModel(model: Pick<Model<any>, "provider" | "api">): boolean {
  const provider = String(model.provider ?? "").toLowerCase();
  const api = String(model.api ?? "").toLowerCase();
  return provider === "openai-codex" || api === "openai-codex-responses";
}

export function resolveOpenAICodexTransport(model: Pick<Model<any>, "provider" | "api">): Transport | undefined {
  if (!isOpenAICodexModel(model)) {
    return undefined;
  }

  const rawTransport = process.env.FORGE_OPENAI_CODEX_TRANSPORT?.trim().toLowerCase();
  switch (rawTransport) {
    case undefined:
    case "":
      return "sse";
    case "sse":
    case "websocket":
    case "websocket-cached":
    case "auto":
      return rawTransport;
    default:
      return "sse";
  }
}

function cloneRuntimeDescriptor(descriptor: AgentDescriptor): AgentDescriptor {
  return structuredClone(descriptor);
}

function omitSystemPrompt<T extends { systemPrompt?: string }>(plan: T): Omit<T, "systemPrompt"> {
  const { systemPrompt: _systemPrompt, ...rest } = plan;
  return rest;
}
