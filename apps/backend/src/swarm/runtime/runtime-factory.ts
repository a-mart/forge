import { readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  getCatalogProvider,
  type AgentRuntimeExtensionSnapshot,
  type RuntimeExtensionMetadata,
  type RuntimeExtensionSource
} from "@forge/protocol";
import { getModel, type Model } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  DefaultResourceLoader,
  compact as runPiCompaction,
  createAgentSession,
  ModelRegistry,
  type AgentSession,
  type ExtensionFactory,
  type LoadExtensionsResult
} from "@mariozechner/pi-coding-agent";
import { AgentRuntime } from "../agent-runtime.js";
import { buildCreateProjectAgentTool } from "../agent-creator-tool.js";
import { buildCreateSessionTool } from "../agents/create-session-tool.js";
import { ensureCanonicalAuthFilePath } from "../auth-storage-paths.js";
import type { CredentialPoolService } from "../credential-pool.js";
import { openSessionManagerWithSizeGuard } from "../session-file-guard.js";
import { ClaudeAgentRuntime } from "../claude-agent-runtime.js";
import { ClaudeAuthResolver } from "../claude-auth-resolver.js";
import { createClaudeMcpToolBridge } from "../claude-mcp-tool-bridge.js";
import type { ForgeExtensionHost } from "../forge-extension-host.js";
import { wrapForgeToolsWithExtensionHooks } from "../forge-instrumented-tools.js";
import { buildForgePiToolBridgeExtensionFactory } from "../forge-pi-tool-bridge.js";
import { isClaudeSdkUnavailableError } from "../claude-sdk-loader.js";
import { CodexAgentRuntime } from "../codex-agent-runtime.js";
import type {
  RuntimeCreationOptions,
  RuntimeErrorEvent,
  RuntimeSessionEvent,
  SwarmAgentRuntime,
  RuntimeStartupRecoveryContext
} from "../runtime-contracts.js";
import type { SwarmToolHost } from "../swarm-tool-host.js";
import { buildSwarmTools } from "../swarm-tools.js";
import { normalizeArchetypeId } from "../prompt-registry.js";
import { combineCompactionCustomInstructions, loadPins } from "../message-pins.js";
import { createCatalogRequestBehaviorExtensionFactory } from "../model-catalog-request-behaviors.js";
import { modelCatalogService } from "../model-catalog-service.js";
import {
  getProfilePiExtensionsDir,
  getProfilePiPromptsDir,
  getProfilePiSkillsDir,
  getProfilePiThemesDir,
  getSessionDir,
} from "../data-paths.js";
import { createPiModelRegistry } from "../pi-model-registry.js";
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentModelDescriptor,
  AgentStatus,
  SwarmConfig
} from "../types.js";

interface RuntimeFactoryDependencies {
  host: SwarmToolHost;
  forgeExtensionHost: ForgeExtensionHost;
  config: SwarmConfig;
  now: () => string;
  logDebug: (message: string, details?: unknown) => void;
  getPiModelsJsonPath: () => string;
  getAgentDescriptor?: (agentId: string) => AgentDescriptor | undefined;
  getCredentialPoolService?: () => CredentialPoolService;
  onSessionFileRotated?: (descriptor: AgentDescriptor, sessionFile: string) => Promise<void>;
  getMemoryRuntimeResources: (descriptor: AgentDescriptor) => Promise<{
    memoryContextFile: { path: string; content: string };
    additionalSkillPaths: string[];
  }>;
  getSwarmContextFiles: (cwd: string) => Promise<Array<{ path: string; content: string }>>;
  buildClaudeRuntimeSystemPrompt: (descriptor: AgentDescriptor, systemPrompt: string) => Promise<string>;
  buildCodexRuntimeSystemPrompt: (descriptor: AgentDescriptor, systemPrompt: string) => Promise<string>;
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

export class RuntimeFactory {
  constructor(private readonly deps: RuntimeFactoryDependencies) {}

  async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken = 0,
    options?: RuntimeCreationOptions
  ): Promise<SwarmAgentRuntime> {
    if (isClaudeSdkModelDescriptor(descriptor.model)) {
      try {
        return await this.createClaudeRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken, options);
      } catch (error) {
        if (!isClaudeSdkUnavailableError(error)) {
          throw error;
        }

        this.deps.logDebug("runtime:create:claude_sdk:unavailable", {
          agentId: descriptor.agentId,
          model: descriptor.model,
          message: error.message,
          code: error.code
        });

        throw new Error(
          `${error.message} Install the Claude Agent SDK or switch this agent to the Pi-proxied anthropic/${descriptor.model.modelId} variant.`
        );
      }
    }

    if (isCodexAppServerModelDescriptor(descriptor.model)) {
      return this.createCodexRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken, options);
    }

    return this.createPiRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken, options);
  }

  private getForgeSessionDescriptor(descriptor: AgentDescriptor): AgentDescriptor | undefined {
    if (descriptor.role === "manager") {
      return descriptor;
    }

    const sessionDescriptor = this.deps.getAgentDescriptor?.(descriptor.managerId);
    return sessionDescriptor?.role === "manager" ? sessionDescriptor : undefined;
  }

  private async createPiRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken: number,
    options?: RuntimeCreationOptions
  ): Promise<SwarmAgentRuntime> {
    const preparedForgeBindings = await this.deps.forgeExtensionHost.prepareRuntimeBindings({
      descriptor,
      sessionDescriptor: this.getForgeSessionDescriptor(descriptor),
      runtimeType: "pi",
      runtimeToken
    });
    const baseSwarmTools = this.buildRuntimeTools(descriptor);
    const swarmTools = preparedForgeBindings
      ? wrapForgeToolsWithExtensionHooks({
          tools: baseSwarmTools,
          forgeExtensionHost: this.deps.forgeExtensionHost,
          bindingToken: preparedForgeBindings.bindingToken
        })
      : baseSwarmTools;
    const thinkingLevel = normalizeThinkingLevel(descriptor.model.thinkingLevel);
    const runtimeAgentDir =
      descriptor.role === "manager" ? this.deps.config.paths.managerAgentDir : this.deps.config.paths.agentDir;
    const memoryResources = await this.deps.getMemoryRuntimeResources(descriptor);
    const profileId = descriptor.profileId ?? descriptor.agentId;
    const profilePiExtensionsDir = getProfilePiExtensionsDir(this.deps.config.paths.dataDir, profileId);
    const profilePiSkillsDir = getProfilePiSkillsDir(this.deps.config.paths.dataDir, profileId);
    const profilePiPromptsDir = getProfilePiPromptsDir(this.deps.config.paths.dataDir, profileId);
    const profilePiThemesDir = getProfilePiThemesDir(this.deps.config.paths.dataDir, profileId);
    const startupRecoveryContextFile = options?.startupRecoveryContext?.blockText
      ? {
          path: join(descriptor.cwd, ".forge", "ephemeral-model-change-recovery.md"),
          content: options.startupRecoveryContext.blockText
        }
      : undefined;
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
      profileId,
      profilePiExtensionsDir,
      profilePiSkillsDir,
      profilePiPromptsDir,
      profilePiThemesDir,
      managerSystemPromptSource:
        descriptor.role === "manager" ? "archetype:manager" : undefined
    });

    // Pool-aware credential selection for supported Pi multi-account providers.
    const poolSelection = await this.selectPooledCredential(descriptor);
    const authStorage = poolSelection?.authStorage ?? AuthStorage.create(authFilePath);
    const pooledCredentialId = poolSelection?.credentialId;

    const piModelsJsonPath = this.deps.getPiModelsJsonPath();
    const modelRegistry = createPiModelRegistry(authStorage, piModelsJsonPath);
    const swarmContextFiles = await this.deps.getSwarmContextFiles(descriptor.cwd);
    const applyRuntimeContext = (base: { agentsFiles: Array<{ path: string; content: string }> }) => ({
      agentsFiles: [
        ...this.deps.mergeRuntimeContextFiles(base.agentsFiles, {
          memoryContextFile: memoryResources.memoryContextFile,
          swarmContextFiles
        }),
        ...(startupRecoveryContextFile ? [startupRecoveryContextFile] : [])
      ]
    });

    const extensionFactories = this.buildExtensionFactories(descriptor, {
      forgePiToolBridgeFactory: preparedForgeBindings
        ? buildForgePiToolBridgeExtensionFactory({
            forgeExtensionHost: this.deps.forgeExtensionHost,
            bindingToken: preparedForgeBindings.bindingToken,
            skippedToolNames: baseSwarmTools.map((tool) => tool.name)
          })
        : undefined
    });
    const additionalSkillPaths = [
      ...memoryResources.additionalSkillPaths,
      ...(dirHasFiles(profilePiSkillsDir) ? [profilePiSkillsDir] : [])
    ];
    const additionalExtensionPaths = dirHasFiles(profilePiExtensionsDir) ? [profilePiExtensionsDir] : [];
    const additionalPromptTemplatePaths = dirHasFiles(profilePiPromptsDir) ? [profilePiPromptsDir] : [];
    const additionalThemePaths = dirHasFiles(profilePiThemesDir) ? [profilePiThemesDir] : [];
    const resourceLoader =
      descriptor.role === "manager"
        ? new DefaultResourceLoader({
            cwd: descriptor.cwd,
            agentDir: runtimeAgentDir,
            additionalExtensionPaths,
            additionalSkillPaths,
            additionalPromptTemplatePaths,
            additionalThemePaths,
            agentsFilesOverride: applyRuntimeContext,
            extensionFactories,
            // Manager prompt comes from the archetype prompt registry.
            systemPrompt,
            appendSystemPromptOverride: () => []
          })
        : new DefaultResourceLoader({
            cwd: descriptor.cwd,
            agentDir: runtimeAgentDir,
            additionalExtensionPaths,
            additionalSkillPaths,
            additionalPromptTemplatePaths,
            additionalThemePaths,
            agentsFilesOverride: applyRuntimeContext,
            extensionFactories,
            appendSystemPromptOverride: (base) => [...base, systemPrompt]
          });

    try {
      await resourceLoader.reload();
    } catch (error) {
      this.deps.logDebug("runtime:resource_loader:reload_error", {
        agentId: descriptor.agentId,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    const model = this.resolveModel(modelRegistry, descriptor.model);

    const sessionManager = openSessionManagerWithSizeGuard(descriptor.sessionFile, {
      context: `runtime:create:pi:${descriptor.agentId}`,
      rotateOversizedFile: true,
      logWarning: (message, details) => {
        this.deps.logDebug(message, details);

        if (message === "session:file:oversized:rotated") {
          Promise.resolve(this.deps.onSessionFileRotated?.(descriptor, descriptor.sessionFile)).catch(
            (error) => {
              this.deps.logDebug("session:meta:rotation_hook_error", {
                agentId: descriptor.agentId,
                sessionFile: descriptor.sessionFile,
                message: error instanceof Error ? error.message : String(error)
              });
            }
          );
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
      customTools: swarmTools
    });

    const extensionSnapshot = buildRuntimeExtensionSnapshot({
      descriptor,
      loadedAt: this.deps.now(),
      extensionsResult,
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
      containsSpeakToUserRule:
        descriptor.role === "manager" ? session.systemPrompt.includes("speak_to_user") : undefined
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

  private async createClaudeRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken: number,
    options?: RuntimeCreationOptions
  ): Promise<SwarmAgentRuntime> {
    const preparedForgeBindings = await this.deps.forgeExtensionHost.prepareRuntimeBindings({
      descriptor,
      sessionDescriptor: this.getForgeSessionDescriptor(descriptor),
      runtimeType: "claude",
      runtimeToken
    });
    const baseSwarmTools = this.buildRuntimeTools(descriptor);
    const swarmTools = preparedForgeBindings
      ? wrapForgeToolsWithExtensionHooks({
          tools: baseSwarmTools,
          forgeExtensionHost: this.deps.forgeExtensionHost,
          bindingToken: preparedForgeBindings.bindingToken
        })
      : baseSwarmTools;
    const profileId = descriptor.profileId ?? descriptor.agentId;
    const sessionId = descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId;
    const workerId = descriptor.role === "worker" ? descriptor.agentId : undefined;
    const authResolver = new ClaudeAuthResolver(this.deps.config.paths.dataDir);
    const [mcpBridge, claudeSystemPrompt, memoryResources] = await Promise.all([
      createClaudeMcpToolBridge(swarmTools, { serverName: `forge-swarm-${descriptor.agentId}` }),
      this.deps.buildClaudeRuntimeSystemPrompt(descriptor, systemPrompt),
      this.deps.getMemoryRuntimeResources(descriptor)
    ]);

    this.deps.logDebug("runtime:create:start", {
      runtime: "claude-sdk",
      agentId: descriptor.agentId,
      role: descriptor.role,
      model: descriptor.model,
      archetypeId: descriptor.archetypeId,
      cwd: descriptor.cwd,
      profileId,
      sessionId,
      workerId,
      mcpServer: mcpBridge.serverName,
      allowedToolCount: mcpBridge.allowedTools.length
    });

    const startupSystemPromptOverride = appendStartupRecoveryContext(
      claudeSystemPrompt,
      options?.startupRecoveryContext
    );
    const skipInitialSessionResume = Boolean(options?.startupRecoveryContext);
    const runtime = new ClaudeAgentRuntime({
      descriptor: cloneRuntimeDescriptor(descriptor),
      systemPrompt: claudeSystemPrompt,
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
      dataDir: this.deps.config.paths.dataDir,
      profileId,
      sessionId,
      ...(workerId ? { workerId } : {}),
      authResolver,
      mcpServers: {
        [mcpBridge.serverName]: mcpBridge.server
      },
      allowedTools: mcpBridge.allowedTools,
      runtimeEnv: {
        SWARM_DATA_DIR: this.deps.config.paths.dataDir,
        SWARM_MEMORY_FILE: memoryResources.memoryContextFile.path
      },
      modelContextWindow: modelCatalogService.getEffectiveContextWindow(
        descriptor.model.modelId,
        descriptor.model.provider
      ),
      startupSystemPromptOverride:
        startupSystemPromptOverride !== claudeSystemPrompt ? startupSystemPromptOverride : undefined,
      skipInitialSessionResume
    });

    this.deps.logDebug("runtime:create:ready", {
      runtime: "claude-sdk",
      agentId: descriptor.agentId,
      activeTools: swarmTools.map((tool) => tool.name),
      allowedTools: mcpBridge.allowedTools,
      systemPromptPreview: previewForLog(claudeSystemPrompt, 240)
    });

    if (preparedForgeBindings) {
      this.deps.forgeExtensionHost.activateRuntimeBindings(preparedForgeBindings);
    }

    return runtime;
  }

  private async createCodexRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken: number,
    options?: RuntimeCreationOptions
  ): Promise<SwarmAgentRuntime> {
    const preparedForgeBindings = await this.deps.forgeExtensionHost.prepareRuntimeBindings({
      descriptor,
      sessionDescriptor: this.getForgeSessionDescriptor(descriptor),
      runtimeType: "codex",
      runtimeToken
    });
    const baseSwarmTools = this.buildRuntimeTools(descriptor);
    const swarmTools = preparedForgeBindings
      ? wrapForgeToolsWithExtensionHooks({
          tools: baseSwarmTools,
          forgeExtensionHost: this.deps.forgeExtensionHost,
          bindingToken: preparedForgeBindings.bindingToken
        })
      : baseSwarmTools;
    const memoryResources = await this.deps.getMemoryRuntimeResources(descriptor);
    const codexSystemPrompt = await this.deps.buildCodexRuntimeSystemPrompt(descriptor, systemPrompt);
    const startupSystemPromptOverride = appendStartupRecoveryContext(
      codexSystemPrompt,
      options?.startupRecoveryContext
    );
    const skipInitialThreadResume = Boolean(options?.startupRecoveryContext);

    this.deps.logDebug("runtime:create:start", {
      runtime: "codex-app-server",
      agentId: descriptor.agentId,
      role: descriptor.role,
      model: descriptor.model,
      archetypeId: descriptor.archetypeId,
      cwd: descriptor.cwd
    });

    const runtime = await CodexAgentRuntime.create({
      descriptor: cloneRuntimeDescriptor(descriptor),
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
      now: this.deps.now,
      systemPrompt: codexSystemPrompt,
      tools: swarmTools,
      runtimeEnv: {
        SWARM_DATA_DIR: this.deps.config.paths.dataDir,
        SWARM_MEMORY_FILE: memoryResources.memoryContextFile.path
      },
      onSessionFileRotated: async (sessionFile) => {
        await this.deps.onSessionFileRotated?.(descriptor, sessionFile);
      },
      startupSystemPromptOverride:
        startupSystemPromptOverride !== codexSystemPrompt ? startupSystemPromptOverride : undefined,
      skipInitialThreadResume
    });

    this.deps.logDebug("runtime:create:ready", {
      runtime: "codex-app-server",
      agentId: descriptor.agentId,
      activeTools: swarmTools.map((tool) => tool.name),
      systemPromptPreview: previewForLog(codexSystemPrompt, 240)
    });

    if (preparedForgeBindings) {
      this.deps.forgeExtensionHost.activateRuntimeBindings(preparedForgeBindings);
    }

    return runtime;
  }

  private buildRuntimeTools(descriptor: AgentDescriptor) {
    const swarmTools = buildSwarmTools(this.deps.host, descriptor);

    if (descriptor.role !== "manager") {
      return swarmTools;
    }

    if (descriptor.projectAgent?.capabilities?.includes("create_session")) {
      swarmTools.push(buildCreateSessionTool(this.deps.host, descriptor));
    }

    if (descriptor.sessionPurpose === "agent_creator") {
      swarmTools.push(buildCreateProjectAgentTool(this.deps.host, descriptor));
    }

    if (normalizeArchetypeId(descriptor.archetypeId ?? "") !== CORTEX_ARCHETYPE_ID) {
      return swarmTools;
    }

    return swarmTools.filter((tool) => !CORTEX_DISABLED_TOOL_NAMES.has(tool.name));
  }

  private buildExtensionFactories(
    descriptor: AgentDescriptor,
    options?: {
      forgePiToolBridgeFactory?: ExtensionFactory;
    }
  ): ExtensionFactory[] {
    const factories: ExtensionFactory[] = [];

    if (descriptor.role === "manager" && descriptor.profileId) {
      factories.push((pi) => {
        pi.on("session_before_compact", async (event, ctx) => {
          const sessionDir = getSessionDir(
            this.deps.config.paths.dataDir,
            descriptor.profileId ?? descriptor.agentId,
            descriptor.agentId
          );
          const registry = await loadPins(sessionDir);
          const existingInstructions = event.customInstructions?.trim() || undefined;
          const combinedInstructions = combineCompactionCustomInstructions(existingInstructions, registry);

          if (!combinedInstructions || combinedInstructions === existingInstructions) {
            return undefined;
          }

          if (!ctx.model) {
            return undefined;
          }

          const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model as Model<any>);
          if (!auth.ok) {
            const message =
              `Pinned-message preservation during auto-compaction is unavailable for ${descriptor.agentId}: ${auth.error}`;
            console.warn(`[swarm] ${message}`);
            ctx.ui.notify(message, "warning");
            return undefined;
          }

          // Pi's compaction helper currently requires a raw API key plus optional headers.
          // If a provider can only authenticate via headers, fall back to Pi's default compaction.
          if (!auth.apiKey) {
            const message =
              `Pinned-message preservation during auto-compaction is unavailable for ${descriptor.agentId}: this auth mode does not expose a raw API key to the compaction helper.`;
            console.warn(`[swarm] ${message}`);
            ctx.ui.notify(message, "warning");
            return undefined;
          }

          const compaction = await runPiCompaction(
            event.preparation,
            ctx.model as Model<any>,
            auth.apiKey,
            auth.headers,
            combinedInstructions,
            event.signal
          );

          return {
            compaction
          };
        });
      });
    }

    if (process.env.FORGE_DEBUG === "true") {
      factories.push((pi) => {
        pi.on("tool_call", (event) => {
          try {
            this.deps.logDebug("extension:tool_call", {
              agentId: descriptor.agentId,
              toolName: event.toolName,
              inputPreview: previewJsonForLog(event.input, 200)
            });
          } catch {
            // Extension handler errors must not propagate into tool execution
          }
        });
      });
    }

    if (options?.forgePiToolBridgeFactory) {
      // Ordering relative to user Pi extensions is intentionally unspecified in v1.
      factories.push(options.forgePiToolBridgeFactory);
    }

    const provider = getCatalogProvider(descriptor.model.provider);
    if (provider?.requestBehaviorId) {
      factories.push(
        createCatalogRequestBehaviorExtensionFactory({
          webSearchEnabled: descriptor.webSearch === true
        })
      );
    }

    return factories;
  }


  /**
   * Select a pooled credential for supported Pi providers if multiple accounts exist.
   * Returns null if the provider is not pool-enabled or the pool has 0-1 credentials.
   */
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
      // Fall back to file-backed auth only when building pooled auth failed.
      return null;
    }
  }

  private resolveModel(modelRegistry: ModelRegistry, descriptor: AgentModelDescriptor): Model<any> {
    const direct = modelRegistry.find(descriptor.provider, descriptor.modelId);
    if (direct) {
      return direct;
    }

    this.deps.logDebug("runtime:model:projection_miss", {
      provider: descriptor.provider,
      modelId: descriptor.modelId,
      message: "Model not found in Forge projection — falling back to Pi built-in catalog"
    });

    const fromCatalog = getModel(descriptor.provider as any, descriptor.modelId as any);
    if (fromCatalog) {
      return fromCatalog;
    }

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

    if (isPathInside(candidate, projectLocalExtensionsDir)) {
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

function appendStartupRecoveryContext(
  systemPrompt: string,
  startupRecoveryContext: RuntimeStartupRecoveryContext | undefined
): string {
  if (!startupRecoveryContext?.blockText) {
    return systemPrompt;
  }

  return [systemPrompt, startupRecoveryContext.blockText].filter(Boolean).join("\n\n");
}

const CORTEX_ARCHETYPE_ID = "cortex";
const CORTEX_DISABLED_TOOL_NAMES = new Set(["list_agents", "kill_agent"]);
const POOLED_PROVIDERS = new Set(["openai-codex", "anthropic"]);

function isClaudeSdkModelDescriptor(
  descriptor: Pick<AgentModelDescriptor, "provider">
): boolean {
  return descriptor.provider.trim().toLowerCase() === "claude-sdk";
}

function isCodexAppServerModelDescriptor(descriptor: Pick<AgentModelDescriptor, "provider">): boolean {
  return descriptor.provider.trim().toLowerCase() === "openai-codex-app-server";
}

function normalizeThinkingLevel(level: string): string {
  return level === "x-high" ? "xhigh" : level;
}

function dirHasFiles(dirPath: string): boolean {
  try {
    return readdirSync(dirPath).length > 0;
  } catch {
    return false;
  }
}

function previewForLog(text: string, maxLength = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function cloneRuntimeDescriptor(descriptor: AgentDescriptor): AgentDescriptor {
  return structuredClone(descriptor);
}

function previewJsonForLog(value: unknown, maxLength = 160): string {
  try {
    const serialized = JSON.stringify(value);
    if (!serialized) {
      return "<unserializable>";
    }
    return previewForLog(serialized, maxLength);
  } catch {
    return "<unserializable>";
  }
}
