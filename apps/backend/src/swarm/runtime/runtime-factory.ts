import { type AgentRuntimeExtensionSnapshot } from "@forge/protocol";
import { isClaudeSdkUnavailableError } from "../claude-sdk-loader.js";
import type { CredentialPoolService } from "../credential-pool.js";
import type { ForgeExtensionHost } from "../forge-extension-host.js";
import type { ProjectExecutableTrustPlan } from "../project-executable-trust.js";
import type {
  RuntimeCreationOptions,
  RuntimeErrorEvent,
  RuntimeSessionEvent,
  SwarmAgentRuntime
} from "../runtime-contracts.js";
import type { SkillMetadata } from "../skills/skill-metadata-service.js";
import type { SwarmToolHost } from "../swarm-tool-host.js";
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentModelDescriptor,
  AgentStatus,
  SwarmConfig
} from "../types.js";
import { ClaudeRuntimeCreator } from "./claude/claude-runtime-creator.js";
import { PiRuntimeCreator } from "./pi/pi-runtime-creator.js";
import { CursorSdkRuntimeCreator } from "./cursor-sdk/cursor-sdk-runtime-creator.js";

export { resolveOpenAICodexTransport } from "./pi/pi-runtime-creator.js";

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
    skillMetadata: SkillMetadata[];
  }>;
  getSwarmContextFiles: (cwd: string) => Promise<Array<{ path: string; content: string }>>;
  resolveProjectExecutableTrustPlan: (options: {
    descriptor: AgentDescriptor;
    sessionDescriptor?: AgentDescriptor;
  }) => Promise<ProjectExecutableTrustPlan>;
  buildClaudeRuntimeSystemPrompt: (descriptor: AgentDescriptor, systemPrompt: string) => Promise<string>;
  buildCursorSdkRuntimeSystemPrompt: (descriptor: AgentDescriptor, systemPrompt: string) => Promise<string>;
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
  private readonly claudeRuntimeCreator: ClaudeRuntimeCreator;
  private readonly cursorSdkRuntimeCreator: CursorSdkRuntimeCreator;
  private readonly piRuntimeCreator: PiRuntimeCreator;

  constructor(private readonly deps: RuntimeFactoryDependencies) {
    this.claudeRuntimeCreator = new ClaudeRuntimeCreator(deps);
    this.cursorSdkRuntimeCreator = new CursorSdkRuntimeCreator(deps);
    this.piRuntimeCreator = new PiRuntimeCreator(deps);
  }

  async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken = 0,
    options?: RuntimeCreationOptions
  ): Promise<SwarmAgentRuntime> {
    if (isClaudeSdkModelDescriptor(descriptor.model)) {
      try {
        return await this.claudeRuntimeCreator.createRuntimeForDescriptor({
          descriptor,
          systemPrompt,
          runtimeToken,
          sessionDescriptor: this.getForgeSessionDescriptor(descriptor),
          creationOptions: options
        });
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

    if (isCursorSdkModelDescriptor(descriptor.model)) {
      return this.cursorSdkRuntimeCreator.createRuntimeForDescriptor({
        descriptor,
        systemPrompt,
        runtimeToken,
        sessionDescriptor: this.getForgeSessionDescriptor(descriptor),
        creationOptions: options
      });
    }

    if (isAcpModelDescriptor(descriptor.model)) {
      throw new Error("Cursor ACP has been removed. Restart Forge to migrate this agent to Cursor SDK Composer 2.5, or change the model manually.");
    }

    return this.piRuntimeCreator.createRuntimeForDescriptor({
      descriptor,
      systemPrompt,
      runtimeToken,
      sessionDescriptor: this.getForgeSessionDescriptor(descriptor),
      creationOptions: options
    });
  }

  private getForgeSessionDescriptor(descriptor: AgentDescriptor): AgentDescriptor | undefined {
    if (descriptor.role === "manager") {
      return descriptor;
    }

    const sessionDescriptor = this.deps.getAgentDescriptor?.(descriptor.managerId);
    return sessionDescriptor?.role === "manager" ? sessionDescriptor : undefined;
  }
}

function isClaudeSdkModelDescriptor(descriptor: Pick<AgentModelDescriptor, "provider">): boolean {
  return descriptor.provider.trim().toLowerCase() === "claude-sdk";
}

function isCursorSdkModelDescriptor(descriptor: Pick<AgentModelDescriptor, "provider">): boolean {
  return descriptor.provider.trim().toLowerCase() === "cursor-sdk";
}

function isAcpModelDescriptor(descriptor: Pick<AgentModelDescriptor, "provider">): boolean {
  return descriptor.provider.trim().toLowerCase() === "cursor-acp";
}
