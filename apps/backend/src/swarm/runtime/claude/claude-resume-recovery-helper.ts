import { buildClaudeRecoveryContext, type ClaudeRecoveryPendingTurnExclusion } from "./claude-recovery-context.js";
import { isConversationEntryEvent } from "../../conversation-validators.js";
import type { AgentDescriptor, ConversationEntryEvent } from "../../types.js";

export type ClaudeResumeRecoveryReason = "missing_persistence" | "resume_failed";

export interface ClaudeResumeRecoveryProbeDetails {
  status: "verified" | "missing" | "unknown";
  sessionFilePath?: string;
}

export interface ClaudeResumeRecoveryCompactionSummary {
  compactedAt?: string;
}

export interface ClaudeResumeRecoveryRuntimeStatePlan {
  claudeSessionId: null;
  generationId: number;
}

export interface ClaudeResumeRecoveryStartPlan {
  nextGenerationId: number;
  persistedRuntimeState: ClaudeResumeRecoveryRuntimeStatePlan;
  systemPromptOverride?: string;
  recoveryContext?: {
    eligibleEntryCount: number;
    includedEntryCount: number;
    omittedEntryCount: number;
    pendingTurnExcluded: boolean;
    truncated: boolean;
    approxTokenCount: number;
  };
}

export interface PlanClaudeResumeRecoveryStartOptions {
  descriptor: AgentDescriptor;
  durableConversationEntries: unknown[];
  persistedCompactionSummary?: ClaudeResumeRecoveryCompactionSummary;
  activeSystemPrompt: string;
  pendingTurnExclusion?: ClaudeRecoveryPendingTurnExclusion;
  modelContextWindow?: number;
  hasPinnedContent: boolean;
  probeResult: ClaudeResumeRecoveryProbeDetails;
  reason: ClaudeResumeRecoveryReason;
  currentGenerationId: number;
  logDebug: (event: string, details?: Record<string, unknown>) => void;
}

export function planClaudeResumeRecoveryStart(
  options: PlanClaudeResumeRecoveryStartOptions
): ClaudeResumeRecoveryStartPlan {
  const nextGenerationId = options.currentGenerationId + 1;
  const plan: ClaudeResumeRecoveryStartPlan = {
    nextGenerationId,
    persistedRuntimeState: {
      claudeSessionId: null,
      generationId: nextGenerationId
    }
  };

  try {
    const conversationEntries = options.durableConversationEntries.filter(isConversationEntryEvent);
    const recoveryContext = buildClaudeRecoveryContext({
      descriptor: options.descriptor,
      entries: conversationEntries as ConversationEntryEvent[],
      compactedAt: options.persistedCompactionSummary?.compactedAt,
      pendingTurnExclusion: options.pendingTurnExclusion,
      modelContextWindow: options.modelContextWindow,
      existingPrompt: options.activeSystemPrompt,
      hasPinnedContent: options.hasPinnedContent
    });

    options.logDebug("thread_resume:recovery_context", {
      reason: options.reason,
      probeStatus: options.probeResult.status,
      sessionFilePath: options.probeResult.sessionFilePath,
      eligibleEntryCount: recoveryContext.eligibleEntryCount,
      includedEntryCount: recoveryContext.includedEntryCount,
      omittedEntryCount: recoveryContext.omittedEntryCount,
      pendingTurnExcluded: recoveryContext.pendingTurnExcluded,
      truncated: recoveryContext.truncated,
      approxTokenCount: recoveryContext.approxTokenCount
    });

    plan.recoveryContext = {
      eligibleEntryCount: recoveryContext.eligibleEntryCount,
      includedEntryCount: recoveryContext.includedEntryCount,
      omittedEntryCount: recoveryContext.omittedEntryCount,
      pendingTurnExcluded: recoveryContext.pendingTurnExcluded,
      truncated: recoveryContext.truncated,
      approxTokenCount: recoveryContext.approxTokenCount
    };

    if (recoveryContext.blockText) {
      plan.systemPromptOverride = [options.activeSystemPrompt, recoveryContext.blockText].filter(Boolean).join("\n\n");
    }
  } catch (error) {
    options.logDebug("thread_resume:recovery_context_error", {
      reason: options.reason,
      probeStatus: options.probeResult.status,
      sessionFilePath: options.probeResult.sessionFilePath,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  return plan;
}
