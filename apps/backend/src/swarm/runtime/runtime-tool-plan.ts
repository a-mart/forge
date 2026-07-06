import { getCatalogProvider } from "@forge/protocol";
import type { ExtensionFactory, ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { CompactionRuntimeSettingsProvider } from "../compaction-runtime-settings-provider.js";
import { createForgePiCompactionExtensionFactory } from "../compaction/forge-pi-compaction-extension.js";
import { buildCreateProjectAgentTool } from "../agent-creator-tool.js";
import { buildCreateSessionTool } from "../agents/create-session-tool.js";
import type { ForgeExtensionHost } from "../forge-extension-host.js";
import type { ForgePreparedRuntimeBindings } from "../forge-extension-types.js";
import { wrapForgeToolsWithExtensionHooks } from "../forge-instrumented-tools.js";
import { buildForgePiToolBridgeExtensionFactory } from "../forge-pi-tool-bridge.js";
import { createCatalogRequestBehaviorExtensionFactory } from "../model-catalog-request-behaviors.js";
import { normalizeArchetypeId } from "../prompt-registry.js";
import type { SwarmToolHost } from "../swarm-tool-host.js";
import { buildSwarmTools } from "../swarm-tools.js";
import type { AgentDescriptor, SwarmConfig } from "../types.js";

interface PlanRuntimeToolsOptions {
  host: SwarmToolHost;
  descriptor: AgentDescriptor;
  forgeExtensionHost: ForgeExtensionHost;
  preparedForgeBindings?: ForgePreparedRuntimeBindings | null;
}

export interface RuntimeToolPlan {
  baseSwarmTools: ToolDefinition[];
  swarmTools: ToolDefinition[];
}

export function planRuntimeTools(options: PlanRuntimeToolsOptions): RuntimeToolPlan {
  const baseSwarmTools = buildBaseRuntimeTools(options.host, options.descriptor);
  const swarmTools = options.preparedForgeBindings
    ? wrapForgeToolsWithExtensionHooks({
        tools: baseSwarmTools,
        forgeExtensionHost: options.forgeExtensionHost,
        bindingToken: options.preparedForgeBindings.bindingToken,
        host: options.host,
        descriptor: options.descriptor
      })
    : baseSwarmTools;

  return { baseSwarmTools, swarmTools };
}

export function planForgePiToolBridgeFactory(options: {
  forgeExtensionHost: ForgeExtensionHost;
  preparedForgeBindings?: ForgePreparedRuntimeBindings | null;
  baseSwarmTools: readonly ToolDefinition[];
  host?: SwarmToolHost;
  descriptor?: AgentDescriptor;
}): ExtensionFactory | undefined {
  return options.preparedForgeBindings
    ? buildForgePiToolBridgeExtensionFactory({
        forgeExtensionHost: options.forgeExtensionHost,
        bindingToken: options.preparedForgeBindings.bindingToken,
        skippedToolNames: options.baseSwarmTools.map((tool) => tool.name),
        host: options.host,
        descriptor: options.descriptor
      })
    : undefined;
}

export function buildBaseRuntimeTools(host: SwarmToolHost, descriptor: AgentDescriptor): ToolDefinition[] {
  const swarmTools = buildSwarmTools(host, descriptor);

  if (descriptor.role !== "manager") {
    return swarmTools;
  }

  if (descriptor.projectAgent?.capabilities?.includes("create_session")) {
    swarmTools.push(buildCreateSessionTool(host, descriptor));
  }

  if (descriptor.sessionPurpose === "agent_creator") {
    swarmTools.push(buildCreateProjectAgentTool(host, descriptor));
  }

  if (normalizeArchetypeId(descriptor.archetypeId ?? "") !== CORTEX_ARCHETYPE_ID) {
    return swarmTools;
  }

  return swarmTools.filter((tool) => !CORTEX_DISABLED_TOOL_NAMES.has(tool.name));
}

interface PlanPiExtensionFactoriesOptions {
  descriptor: AgentDescriptor;
  config: SwarmConfig;
  logDebug: (message: string, details?: unknown) => void;
  getCompactionRuntimeSettingsProvider: () => CompactionRuntimeSettingsProvider;
  forgePiToolBridgeFactory?: ExtensionFactory;
  compactionFailureScopeKey?: string;
}

export function planPiExtensionFactories(options: PlanPiExtensionFactoriesOptions): ExtensionFactory[] {
  const { descriptor } = options;
  const factories: ExtensionFactory[] = [];

  if (descriptor.role === "manager" && descriptor.profileId) {
    factories.push(createForgePiCompactionExtensionFactory({
      descriptor,
      config: options.config,
      logDebug: options.logDebug,
      getCompactionRuntimeSettingsProvider: options.getCompactionRuntimeSettingsProvider,
      failureScopeKey: options.compactionFailureScopeKey,
    }));
  }

  if (process.env.FORGE_DEBUG === "true") {
    factories.push((pi) => {
      pi.on("tool_call", (event) => {
        try {
          options.logDebug("extension:tool_call", {
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

  if (options.forgePiToolBridgeFactory) {
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

function previewForLog(text: string, maxLength = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

const CORTEX_ARCHETYPE_ID = "cortex";
const CORTEX_DISABLED_TOOL_NAMES = new Set(["list_agents", "kill_agent", "task", "save_learning"]);
