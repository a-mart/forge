import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  type AgentRuntimeExtensionSnapshot,
  type RuntimeExtensionMetadata,
  type RuntimeExtensionSource
} from "@forge/protocol";
import type { Model, Transport } from "../../pi/pi-ai-compat.js";
import type { ObservabilityFacade, ObservabilityToolDefinition } from "../../../observability/observability-types.js";
import {
  AuthStorage,
  DefaultResourceLoader,
  createAgentSession,
  ModelRegistry,
  SettingsManager,
  type AgentSession,
  type LoadExtensionsResult,
  type ToolDefinition
} from "@earendil-works/pi-coding-agent";
import { AgentRuntime } from "../../agent-runtime.js";
import { ensureCanonicalAuthFilePath } from "../../auth-storage-paths.js";
import { resizeImageIfNeeded } from "../image-utils.js";
import type { CredentialPoolService } from "../../credential-pool.js";
import type {
  OpenAIAuthBrokerLeaseHandle,
  OpenAIAuthBrokerRuntimeService,
} from "../../openai-auth/openai-auth-broker-runtime-service.js";
import type { ForgeExtensionHost } from "../../forge-extension-host.js";
import { createPiModelRegistry } from "../../pi-model-registry.js";
import { formatPiExtensionLoadError } from "../../pi-extension-migration-diagnostics.js";
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
import { mapForgeReasoningToPiThinkingLevel } from "../../pi-thinking-level.js";
import type { SkillMetadata } from "../../skills/skill-metadata-service.js";
import type { SwarmToolHost } from "../../swarm-tool-host.js";
import { isCodexPluginWorkerDescriptor } from "../../codex-app-server/codex-plugin-scope-service.js";
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
import type { CompactionRuntimeSettingsProvider } from "../../compaction-runtime-settings-provider.js";
import { buildForgePiCompactionFailureScopeKey } from "../../compaction/forge-pi-compaction-extension.js";
import { recordRuntimePromptAndCreation, summarizeRuntimeTools } from "../runtime-observability-capture.js";
import { planForgePiToolBridgeFactory, planPiExtensionFactories, planRuntimeTools } from "../runtime-tool-plan.js";

type PiProviderContextMessages = Parameters<
  NonNullable<AgentSession["agent"]["transformContext"]>
>[0];

type PiProviderContextMessage = PiProviderContextMessages[number];

export function installPiProviderContextImageResize(session: AgentSession): void {
  const existingTransformContext = session.agent.transformContext;

  session.agent.transformContext = async (messages, signal) => {
    let transformedMessages = messages;
    if (existingTransformContext) {
      try {
        transformedMessages = await existingTransformContext.call(session.agent, messages, signal);
      } catch {
        transformedMessages = messages;
      }
    }

    try {
      return await resizePiProviderContextImages(transformedMessages);
    } catch {
      return transformedMessages;
    }
  };
}

export async function resizePiProviderContextImages(
  messages: PiProviderContextMessages
): Promise<PiProviderContextMessages> {
  let resizedMessages: PiProviderContextMessages | undefined;

  for (const [messageIndex, message] of messages.entries()) {
    const content = readArrayContent(message);
    if (!content) {
      continue;
    }

    let resizedContent: unknown[] | undefined;
    for (const [blockIndex, block] of content.entries()) {
      if (!isValidPiImageBlock(block)) {
        continue;
      }

      const resized = await resizeImageIfNeeded(block.data, block.mimeType);
      if (resized.data === block.data && resized.mimeType === block.mimeType) {
        continue;
      }

      resizedContent ??= [...content];
      resizedContent[blockIndex] = {
        ...block,
        data: resized.data,
        mimeType: resized.mimeType
      };
    }

    if (!resizedContent) {
      continue;
    }

    resizedMessages ??= [...messages];
    resizedMessages[messageIndex] = {
      ...message,
      content: resizedContent
    } as PiProviderContextMessage;
  }

  return resizedMessages ?? messages;
}

function readArrayContent(message: PiProviderContextMessage): unknown[] | undefined {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? content : undefined;
}

function isValidPiImageBlock(value: unknown): value is Record<string, unknown> & {
  type: "image";
  data: string;
  mimeType: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const block = value as Record<string, unknown>;
  return block.type === "image"
    && typeof block.data === "string"
    && block.data.trim().length > 0
    && typeof block.mimeType === "string"
    && block.mimeType.trim().toLowerCase().startsWith("image/");
}

interface PiRuntimeCreatorDependencies {
  host: SwarmToolHost;
  forgeExtensionHost: ForgeExtensionHost;
  config: SwarmConfig;
  now: () => string;
  logDebug: (message: string, details?: unknown) => void;
  getPiModelsJsonPath: () => string;
  getCredentialPoolService?: () => CredentialPoolService;
  getOpenAIAuthBrokerRuntimeService?: () => OpenAIAuthBrokerRuntimeService;
  observability?: ObservabilityFacade;
  getCompactionRuntimeSettingsProvider: () => CompactionRuntimeSettingsProvider;
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
    /** Projector ground truth: epoch-ms of last user-facing manager output (see SwarmRuntimeCallbacks). */
    getLastUserFacingManagerOutputAt?: (agentId: string) => number | undefined;
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
    const thinkingLevel = mapForgeReasoningToPiThinkingLevel(descriptor.model.thinkingLevel);
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

    const provider = descriptor.model.provider.trim().toLowerCase();
    const compactionFailureScopeKey = buildForgePiCompactionFailureScopeKey(descriptor.agentId, runtimeToken);
    const brokerRuntimeService = this.deps.getOpenAIAuthBrokerRuntimeService?.();
    const useBrokerAuth = provider === "openai-codex"
      && brokerRuntimeService
      && await brokerRuntimeService.isBrokerModeActive();

    let poolSelection: Awaited<ReturnType<PiRuntimeCreator["selectPooledCredential"]>> = null;
    let brokerLeaseHandle: OpenAIAuthBrokerLeaseHandle | undefined;
    let authStorage: AuthStorage;

    if (useBrokerAuth) {
      const prepared = await brokerRuntimeService.acquireForRuntime(descriptor);
      authStorage = prepared.authStorage;
      brokerLeaseHandle = prepared.handle;
    } else {
      poolSelection = await this.selectPooledCredential(descriptor);
      authStorage = poolSelection?.authStorage ?? AuthStorage.create(authFilePath);
    }
    const pooledCredentialId = poolSelection?.credentialId;
    let brokerLeaseOwnershipTransferred = !brokerLeaseHandle;

    try {
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
      getCompactionRuntimeSettingsProvider: this.deps.getCompactionRuntimeSettingsProvider,
      getPiModelsJsonPath: this.deps.getPiModelsJsonPath,
      getCredentialPoolService: this.deps.getCredentialPoolService,
      getOpenAIAuthBrokerRuntimeService: this.deps.getOpenAIAuthBrokerRuntimeService,
      forgePiToolBridgeFactory: planForgePiToolBridgeFactory({
        forgeExtensionHost: this.deps.forgeExtensionHost,
        preparedForgeBindings,
        baseSwarmTools,
        host: this.deps.host,
        descriptor
      }),
      compactionFailureScopeKey,
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
      await resourceLoader.reload({
        resolveProjectTrust: async () => projectExecutableTrustPlan.trusted,
      });
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
      thinkingLevel,
      sessionManager,
      resourceLoader,
      ...(settingsManager ? { settingsManager } : {}),
      customTools: swarmTools
    });
    installPiProviderContextImageResize(session);

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

          const rawMessage = error.error.trim().length > 0 ? error.error.trim() : "Extension handler failed";
          const message = formatPiExtensionLoadError(error.error, rawMessage);
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
      const rawMessage = error instanceof Error ? error.message : String(error);
      const message = formatPiExtensionLoadError(error, rawMessage);
      this.deps.logDebug("extension:bind_error", {
        agentId: descriptor.agentId,
        message
      });
    }

    const activeToolNames = resolvePiActiveToolNamesForDescriptor(
      descriptor,
      session.getActiveToolNames(),
      swarmTools.map((tool) => tool.name),
    );
    session.setActiveToolsByName(activeToolNames);

    this.deps.logDebug("runtime:create:ready", {
      runtime: "pi",
      agentId: descriptor.agentId,
      activeTools: activeToolNames,
      systemPromptPreview: previewForLog(session.systemPrompt, 240),
      containsSpeakToUserRule: descriptor.role === "manager" ? session.systemPrompt.includes("speak_to_user") : undefined
    });

    recordRuntimePromptAndCreation({
      observability: this.deps.observability,
      descriptor,
      runtimeToken,
      runtimeType: "pi",
      forgeResolvedPrompt: systemPrompt,
      finalSystemPrompt: session.systemPrompt,
      activeTools: summarizePiActiveTools(session as AgentSession, swarmTools, activeToolNames),
      metadata: {
        thinkingLevel,
        agentDir: runtimeAgentDir,
        memoryFile: memoryResources.memoryContextFile.path,
        projectExecutablesTrusted: projectExecutableTrustPlan.trusted,
        pooledCredentialProvider: pooledCredentialId ? descriptor.model.provider : undefined,
      },
    });

    const runtime = new AgentRuntime({
      descriptor: cloneRuntimeDescriptor(descriptor),
      session: session as AgentSession,
      systemPrompt,
      compactionRuntimeSettingsProvider: this.deps.getCompactionRuntimeSettingsProvider(),
      compactionFailureScopeKey,
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
        },
        getLastUserFacingManagerOutputAt: (agentId) =>
          this.deps.callbacks.getLastUserFacingManagerOutputAt?.(agentId)
      },
      now: this.deps.now
    });

    if (pooledCredentialId) {
      runtime.pooledCredentialId = pooledCredentialId;
      runtime.pooledCredentialProvider = descriptor.model.provider;
      runtime.credentialPoolService = this.deps.getCredentialPoolService?.();
    }

    if (brokerRuntimeService && provider === "openai-codex") {
      runtime.configureOpenAIAuthBrokerController(brokerRuntimeService, brokerLeaseHandle);
    }

    if (preparedForgeBindings) {
      this.deps.forgeExtensionHost.activateRuntimeBindings(preparedForgeBindings);
    }

    brokerLeaseOwnershipTransferred = true;
    return runtime;
    } catch (error) {
      if (brokerLeaseHandle && !brokerLeaseOwnershipTransferred) {
        await brokerRuntimeService?.release(brokerLeaseHandle, "runtime_create_failed");
        this.deps.logDebug("runtime:broker:lease_released_after_create_failure", {
          agentId: descriptor.agentId,
          leaseId: brokerLeaseHandle.leaseId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
      throw error;
    }
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
    }), {
      // Keep SettingsManager untrusted at construction. The only project-executable
      // trust elevation seam is DefaultResourceLoader.reload({ resolveProjectTrust })
      // using Forge's ProjectExecutableTrustPlan below.
      projectTrusted: false,
    });
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

function summarizePiActiveTools(
  session: AgentSession,
  swarmTools: readonly ToolDefinition[],
  activeToolNames: readonly string[],
): ObservabilityToolDefinition[] {
  const activeNames = Array.from(new Set(activeToolNames));
  const byName = new Map<string, ObservabilityToolDefinition>();

  for (const tool of summarizeRuntimeTools(swarmTools, { activeToolNames: activeNames })) {
    byName.set(tool.name, tool);
  }

  for (const tool of listPiSessionTools(session)) {
    if (!activeNames.includes(tool.name)) {
      continue;
    }
    byName.set(tool.name, tool);
  }

  for (const name of activeNames) {
    const tool = getPiSessionToolDefinition(session, name);
    if (tool) {
      byName.set(name, tool);
    }
  }

  return activeNames.map((name) => byName.get(name) ?? { name, source: "pi" });
}

function listPiSessionTools(session: AgentSession): ObservabilityToolDefinition[] {
  const getAllTools = (session as { getAllTools?: () => unknown }).getAllTools;
  if (typeof getAllTools !== "function") {
    return [];
  }

  return normalizePiToolCollection(getAllTools.call(session));
}

function getPiSessionToolDefinition(session: AgentSession, name: string): ObservabilityToolDefinition | undefined {
  const getToolDefinition = (session as { getToolDefinition?: (toolName: string) => unknown }).getToolDefinition;
  if (typeof getToolDefinition !== "function") {
    return undefined;
  }

  const value = getToolDefinition.call(session, name);
  if (value === undefined || value === null) {
    return undefined;
  }

  return normalizePiToolDefinition(name, value);
}

function normalizePiToolCollection(value: unknown): ObservabilityToolDefinition[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const normalized = normalizePiToolDefinition(undefined, entry);
      return normalized ? [normalized] : [];
    });
  }

  if (value instanceof Map) {
    return Array.from(value.entries()).flatMap(([name, entry]) => {
      const normalized = normalizePiToolDefinition(String(name), entry);
      return normalized ? [normalized] : [];
    });
  }

  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([name, entry]) => {
      const normalized = normalizePiToolDefinition(name, entry);
      return normalized ? [normalized] : [];
    });
  }

  return [];
}

function normalizePiToolDefinition(fallbackName: string | undefined, value: unknown): ObservabilityToolDefinition | undefined {
  if (!value || typeof value !== "object") {
    return fallbackName ? { name: fallbackName, source: "pi" } : undefined;
  }

  const record = value as {
    name?: unknown;
    description?: unknown;
    parameters?: unknown;
    inputSchema?: unknown;
    schema?: unknown;
    source?: unknown;
  };
  const name = typeof record.name === "string" && record.name.length > 0 ? record.name : fallbackName;
  if (!name) {
    return undefined;
  }

  return {
    name,
    description: typeof record.description === "string" ? record.description : undefined,
    jsonSchema: record.parameters ?? record.inputSchema ?? record.schema,
    source: typeof record.source === "string" ? record.source : "pi",
  };
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
    .map((entry) => {
      const rawError: unknown = entry.error;
      const rawMessage =
        typeof rawError === "string"
          ? rawError
          : rawError instanceof Error
            ? rawError.message
            : String(rawError ?? "");
      return {
        path: entry.path,
        error: formatPiExtensionLoadError(rawError, rawMessage || "Extension failed to load"),
      };
    })
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

export function resolvePiActiveToolNamesForDescriptor(
  descriptor: AgentDescriptor,
  sessionActiveToolNames: readonly string[],
  swarmToolNames: readonly string[],
): string[] {
  if (isCodexPluginWorkerDescriptor(descriptor)) {
    return Array.from(new Set(swarmToolNames));
  }

  return Array.from(new Set([...sessionActiveToolNames, ...swarmToolNames]));
}

const POOLED_PROVIDERS = new Set(["openai-codex", "anthropic"]);

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
