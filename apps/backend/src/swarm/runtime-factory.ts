import { getModel, type Model } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  DefaultResourceLoader,
  createAgentSession,
  ModelRegistry,
  type AgentSession,
  type ExtensionFactory
} from "@mariozechner/pi-coding-agent";
import { AgentRuntime } from "./agent-runtime.js";
import { ensureCanonicalAuthFilePath } from "./auth-storage-paths.js";
import { openSessionManagerWithSizeGuard } from "./session-file-guard.js";
import { CodexAgentRuntime } from "./codex-agent-runtime.js";
import type { RuntimeErrorEvent, RuntimeSessionEvent, SwarmAgentRuntime } from "./runtime-types.js";
import { buildSwarmTools, type SwarmToolHost } from "./swarm-tools.js";
import { normalizeArchetypeId } from "./prompt-registry.js";
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentModelDescriptor,
  AgentStatus,
  SwarmConfig
} from "./types.js";

interface RuntimeFactoryDependencies {
  host: SwarmToolHost;
  config: SwarmConfig;
  now: () => string;
  logDebug: (message: string, details?: unknown) => void;
  onSessionFileRotated?: (descriptor: AgentDescriptor, sessionFile: string) => Promise<void>;
  getMemoryRuntimeResources: (descriptor: AgentDescriptor) => Promise<{
    memoryContextFile: { path: string; content: string };
    additionalSkillPaths: string[];
  }>;
  getSwarmContextFiles: (cwd: string) => Promise<Array<{ path: string; content: string }>>;
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
  };
}

export class RuntimeFactory {
  constructor(private readonly deps: RuntimeFactoryDependencies) {}

  async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken = 0
  ): Promise<SwarmAgentRuntime> {
    if (isCodexAppServerModelDescriptor(descriptor.model)) {
      return this.createCodexRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken);
    }

    return this.createPiRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken);
  }

  private async createPiRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken: number
  ): Promise<SwarmAgentRuntime> {
    const swarmTools = this.buildRuntimeTools(descriptor);
    const thinkingLevel = normalizeThinkingLevel(descriptor.model.thinkingLevel);
    const runtimeAgentDir =
      descriptor.role === "manager" ? this.deps.config.paths.managerAgentDir : this.deps.config.paths.agentDir;
    const memoryResources = await this.deps.getMemoryRuntimeResources(descriptor);

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
      memoryFile: memoryResources.memoryContextFile.path,
      managerSystemPromptSource:
        descriptor.role === "manager" ? "archetype:manager" : undefined
    });

    const authStorage = AuthStorage.create(authFilePath);
    const modelRegistry = new ModelRegistry(authStorage);
    const swarmContextFiles = await this.deps.getSwarmContextFiles(descriptor.cwd);
    const applyRuntimeContext = (base: { agentsFiles: Array<{ path: string; content: string }> }) => ({
      agentsFiles: this.deps.mergeRuntimeContextFiles(base.agentsFiles, {
        memoryContextFile: memoryResources.memoryContextFile,
        swarmContextFiles
      })
    });

    const extensionFactories = this.buildExtensionFactories(descriptor);
    const resourceLoader =
      descriptor.role === "manager"
        ? new DefaultResourceLoader({
            cwd: descriptor.cwd,
            agentDir: runtimeAgentDir,
            additionalSkillPaths: memoryResources.additionalSkillPaths,
            agentsFilesOverride: applyRuntimeContext,
            extensionFactories,
            // Manager prompt comes from the archetype prompt registry.
            systemPrompt,
            appendSystemPromptOverride: () => []
          })
        : new DefaultResourceLoader({
            cwd: descriptor.cwd,
            agentDir: runtimeAgentDir,
            additionalSkillPaths: memoryResources.additionalSkillPaths,
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
    if (!model) {
      throw new Error(
        `Unable to resolve model ${descriptor.model.provider}/${descriptor.model.modelId}. ` +
          "Install a model supported by @mariozechner/pi-ai."
      );
    }

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

    const { session } = await createAgentSession({
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

    return new AgentRuntime({
      descriptor,
      session: session as AgentSession,
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
  }

  private async createCodexRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken: number
  ): Promise<SwarmAgentRuntime> {
    const swarmTools = this.buildRuntimeTools(descriptor);
    const memoryResources = await this.deps.getMemoryRuntimeResources(descriptor);
    const swarmContextFiles = await this.deps.getSwarmContextFiles(descriptor.cwd);

    const codexSystemPrompt = this.buildCodexRuntimeSystemPrompt(systemPrompt, {
      memoryContextFile: memoryResources.memoryContextFile,
      swarmContextFiles
    });

    this.deps.logDebug("runtime:create:start", {
      runtime: "codex-app-server",
      agentId: descriptor.agentId,
      role: descriptor.role,
      model: descriptor.model,
      archetypeId: descriptor.archetypeId,
      cwd: descriptor.cwd
    });

    const runtime = await CodexAgentRuntime.create({
      descriptor,
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
      }
    });

    this.deps.logDebug("runtime:create:ready", {
      runtime: "codex-app-server",
      agentId: descriptor.agentId,
      activeTools: swarmTools.map((tool) => tool.name),
      systemPromptPreview: previewForLog(codexSystemPrompt, 240)
    });

    return runtime;
  }

  private buildRuntimeTools(descriptor: AgentDescriptor) {
    const swarmTools = buildSwarmTools(this.deps.host, descriptor);

    if (descriptor.role !== "manager") {
      return swarmTools;
    }

    if (normalizeArchetypeId(descriptor.archetypeId ?? "") !== CORTEX_ARCHETYPE_ID) {
      return swarmTools;
    }

    return swarmTools.filter((tool) => !CORTEX_DISABLED_TOOL_NAMES.has(tool.name));
  }

  private buildExtensionFactories(descriptor: AgentDescriptor): ExtensionFactory[] {
    const factories: ExtensionFactory[] = [];

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

    return factories;
  }

  private buildCodexRuntimeSystemPrompt(
    baseSystemPrompt: string,
    options: {
      memoryContextFile: { path: string; content: string };
      swarmContextFiles: Array<{ path: string; content: string }>;
    }
  ): string {
    const sections: string[] = [];

    const trimmedBase = baseSystemPrompt.trim();
    if (trimmedBase.length > 0) {
      sections.push(trimmedBase);
    }

    for (const contextFile of options.swarmContextFiles) {
      const content = contextFile.content.trim();
      if (!content) {
        continue;
      }

      sections.push(
        [
          `Repository swarm policy (${contextFile.path}):`,
          "----- BEGIN SWARM CONTEXT -----",
          content,
          "----- END SWARM CONTEXT -----"
        ].join("\n")
      );
    }

    const memoryContent = options.memoryContextFile.content.trim();
    if (memoryContent) {
      sections.push(
        [
          `Persistent swarm memory (${options.memoryContextFile.path}):`,
          "----- BEGIN SWARM MEMORY -----",
          memoryContent,
          "----- END SWARM MEMORY -----"
        ].join("\n")
      );
    }

    return sections.join("\n\n");
  }

  private resolveModel(modelRegistry: ModelRegistry, descriptor: AgentModelDescriptor): Model<any> | undefined {
    const direct = modelRegistry.find(descriptor.provider, descriptor.modelId);
    if (direct) return direct;

    const fromCatalog = getModel(descriptor.provider as any, descriptor.modelId as any);
    if (fromCatalog) return fromCatalog;

    return modelRegistry.getAll()[0];
  }
}

const CORTEX_ARCHETYPE_ID = "cortex";
const CORTEX_DISABLED_TOOL_NAMES = new Set(["list_agents", "kill_agent"]);

function isCodexAppServerModelDescriptor(descriptor: Pick<AgentModelDescriptor, "provider">): boolean {
  return descriptor.provider.trim().toLowerCase() === "openai-codex-app-server";
}

function normalizeThinkingLevel(level: string): string {
  return level === "x-high" ? "xhigh" : level;
}

function previewForLog(text: string, maxLength = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
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
