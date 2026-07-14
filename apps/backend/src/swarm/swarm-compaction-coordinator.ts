import { isNonRunningAgentStatus } from "./agent-state-machine.js";
import {
  combineCompactionCustomInstructions,
  type PinRegistry,
} from "./message-pins.js";
import type { CaptureCascadeCoordinator } from "./capture-cascade-coordinator.js";
import type { SessionPlanCoordinator } from "./planning/session-plan-coordinator.js";
import type {
  SmartCompactResult,
  SwarmAgentRuntime,
} from "./runtime-contracts.js";
import {
  assertBuilderSession,
  normalizeMessageSourceContext,
  previewForLog,
} from "./swarm-manager-utils.js";
import type {
  AgentDescriptor,
  ConversationMessageEvent,
  MessageSourceContext,
} from "./types.js";

type ManagerDescriptor = AgentDescriptor & {
  role: "manager";
  profileId: string;
};

export interface CompactAgentContextOptions {
  customInstructions?: string;
  sourceContext?: MessageSourceContext;
  trigger?: "api" | "slash_command" | "cli";
}

export interface SwarmCompactionCoordinatorOptions {
  descriptors: Map<string, AgentDescriptor>;
  getOrCreateRuntime: (descriptor: AgentDescriptor) => Promise<SwarmAgentRuntime>;
  syncPinnedContent: (descriptor: ManagerDescriptor) => Promise<PinRegistry>;
  sessionPlans: SessionPlanCoordinator;
  captureCascade: CaptureCascadeCoordinator;
  incrementCompactionCount: (
    profileId: string,
    agentId: string,
    failureLogMessage: string,
  ) => Promise<number | undefined>;
  emitConversationMessage: (event: ConversationMessageEvent) => void;
  now: () => string;
  logDebug: (message: string, details?: unknown) => void;
}

/** Owns explicit and smart manager-context compaction from validation through capture. */
export class SwarmCompactionCoordinator {
  constructor(private readonly options: SwarmCompactionCoordinatorOptions) {}

  async compact(
    agentId: string,
    options?: CompactAgentContextOptions,
  ): Promise<unknown> {
    const descriptor = this.requireRunningManager(agentId, "Compaction");
    const runtime = await this.options.getOrCreateRuntime(descriptor);
    const sourceContext = normalizeMessageSourceContext(
      options?.sourceContext ?? { channel: "web" },
    );
    const customInstructions = await this.resolveInstructions(
      descriptor,
      options?.customInstructions,
    );

    this.options.logDebug("manager:compact:start", {
      agentId,
      trigger: options?.trigger ?? "api",
      sourceContext,
      customInstructionsPreview: previewForLog(customInstructions ?? ""),
    });
    this.emitSystemMessage(agentId, "Compacting manager context...", sourceContext);

    try {
      const result = await runtime.compact(customInstructions);
      await this.recordSuccessfulCompaction(
        descriptor,
        "manager:compact:count-increment-failed",
      );
      this.emitSystemMessage(agentId, "Compaction complete.", sourceContext);
      this.options.logDebug("manager:compact:complete", {
        agentId,
        trigger: options?.trigger ?? "api",
      });
      await this.options.captureCascade.run(agentId, "compaction");
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitSystemMessage(agentId, `Compaction failed: ${message}`, sourceContext);
      this.options.logDebug("manager:compact:error", {
        agentId,
        trigger: options?.trigger ?? "api",
        message,
      });
      throw error;
    }
  }

  async smartCompact(
    agentId: string,
    options?: CompactAgentContextOptions,
  ): Promise<SmartCompactResult> {
    const descriptor = this.requireRunningManager(agentId, "Smart compaction");
    const runtime = await this.options.getOrCreateRuntime(descriptor);
    const sourceContext = normalizeMessageSourceContext(
      options?.sourceContext ?? { channel: "web" },
    );
    const customInstructions = await this.resolveInstructions(
      descriptor,
      options?.customInstructions,
    );

    this.options.logDebug("manager:smart_compact:start", {
      agentId,
      trigger: options?.trigger ?? "api",
      sourceContext,
      customInstructionsPreview: previewForLog(customInstructions ?? ""),
    });
    this.emitSystemMessage(agentId, "Running smart compaction…", sourceContext);

    try {
      const result = await runtime.smartCompact(customInstructions, {
        skipResumeIfIdle: true,
      });
      if (result.compacted) {
        await this.recordSuccessfulCompaction(
          descriptor,
          "manager:smart_compact:count-increment-failed",
        );
        const usage = runtime.getContextUsage();
        const usageSuffix = usage
          ? ` Context now at ${Math.round(usage.percent)}%.`
          : "";
        this.emitSystemMessage(
          agentId,
          `Smart compaction complete.${usageSuffix}`,
          sourceContext,
        );
      } else {
        const text =
          runtime.runtimeType === "claude" &&
          result.reason === "claude_runtime_below_compaction_threshold"
            ? "Smart compaction skipped because context is already below the Claude compaction threshold."
            : "Smart compaction finished, but context was not reduced.";
        this.emitSystemMessage(agentId, text, sourceContext);
      }

      this.options.logDebug("manager:smart_compact:complete", {
        agentId,
        trigger: options?.trigger ?? "api",
        compacted: result.compacted,
        reason: result.compacted ? undefined : result.reason,
      });
      if (result.compacted) {
        await this.options.captureCascade.run(agentId, "compaction");
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitSystemMessage(
        agentId,
        /\btimeout\b|\btimed out\b/i.test(message)
          ? "Smart compaction timed out."
          : `Smart compaction failed: ${message}`,
        sourceContext,
      );
      this.options.logDebug("manager:smart_compact:error", {
        agentId,
        trigger: options?.trigger ?? "api",
        message,
      });
      throw error;
    }
  }

  private requireRunningManager(
    agentId: string,
    operation: "Compaction" | "Smart compaction",
  ): ManagerDescriptor {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor) {
      throw new Error(`Unknown target agent: ${agentId}`);
    }
    if (isNonRunningAgentStatus(descriptor.status)) {
      throw new Error(`Target agent is not running: ${agentId}`);
    }
    if (descriptor.role !== "manager") {
      throw new Error(`${operation} is only supported for manager agents: ${agentId}`);
    }
    assertBuilderSession(
      descriptor,
      operation === "Compaction"
        ? "compact Builder sessions"
        : "smart-compact Builder sessions",
    );
    return descriptor as ManagerDescriptor;
  }

  private async resolveInstructions(
    descriptor: ManagerDescriptor,
    customInstructions?: string,
  ): Promise<string | undefined> {
    const registry = await this.options.syncPinnedContent(descriptor);
    const instructionsWithPins = combineCompactionCustomInstructions(
      customInstructions?.trim() || undefined,
      registry,
    );
    return this.options.sessionPlans.appendCompactionInstructions(
      descriptor,
      instructionsWithPins,
    );
  }

  private async recordSuccessfulCompaction(
    descriptor: ManagerDescriptor,
    failureLogMessage: string,
  ): Promise<void> {
    const count = await this.options.incrementCompactionCount(
      descriptor.profileId,
      descriptor.agentId,
      failureLogMessage,
    );
    if (count !== undefined) {
      descriptor.compactionCount = count;
    }
  }

  private emitSystemMessage(
    agentId: string,
    text: string,
    sourceContext: MessageSourceContext,
  ): void {
    this.options.emitConversationMessage({
      type: "conversation_message",
      agentId,
      role: "system",
      text,
      timestamp: this.options.now(),
      source: "system",
      sourceContext,
    });
  }
}
