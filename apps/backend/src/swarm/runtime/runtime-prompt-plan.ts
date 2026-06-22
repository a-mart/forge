import { join } from "node:path";
import type { RuntimeStartupRecoveryContext } from "../runtime-contracts.js";
import type { AgentDescriptor } from "../types.js";

export interface PiRuntimePromptPlan {
  systemPrompt?: string;
  appendSystemPromptOverride: (base: string[]) => string[];
  startupRecoveryContextFile?: { path: string; content: string };
}

export interface PlanPiRuntimePromptOptions {
  descriptor: Pick<AgentDescriptor, "role">;
  systemPrompt: string;
  cwd: string;
  startupRecoveryContext?: RuntimeStartupRecoveryContext;
}

export function planPiRuntimePrompt(options: PlanPiRuntimePromptOptions): PiRuntimePromptPlan {
  const startupRecoveryContextFile = options.startupRecoveryContext?.blockText
    ? {
        path: join(options.cwd, ".forge", "ephemeral-model-change-recovery.md"),
        content: options.startupRecoveryContext.blockText,
      }
    : undefined;

  if (options.descriptor.role === "manager") {
    return {
      systemPrompt: options.systemPrompt,
      appendSystemPromptOverride: () => [],
      ...(startupRecoveryContextFile ? { startupRecoveryContextFile } : {}),
    };
  }

  return {
    appendSystemPromptOverride: (base) => [...base, options.systemPrompt],
    ...(startupRecoveryContextFile ? { startupRecoveryContextFile } : {}),
  };
}

export interface ClaudeRuntimePromptPlan {
  systemPrompt: string;
  startupSystemPromptOverride?: string;
  skipInitialSessionResume?: boolean;
}

export interface PlanClaudeRuntimePromptOptions {
  systemPrompt: string;
  startupRecoveryContext?: RuntimeStartupRecoveryContext;
}

export function planClaudeRuntimePrompt(options: PlanClaudeRuntimePromptOptions): ClaudeRuntimePromptPlan {
  const startupSystemPromptOverride = appendStartupRecoveryContext(
    options.systemPrompt,
    options.startupRecoveryContext
  );

  return {
    systemPrompt: options.systemPrompt,
    ...(startupSystemPromptOverride !== options.systemPrompt ? { startupSystemPromptOverride } : {}),
    ...(options.startupRecoveryContext ? { skipInitialSessionResume: true } : {}),
  };
}

export function planCursorSdkRuntimePrompt(options: PlanClaudeRuntimePromptOptions): ClaudeRuntimePromptPlan {
  return planClaudeRuntimePrompt(options);
}

export function appendStartupRecoveryContext(
  systemPrompt: string,
  startupRecoveryContext: RuntimeStartupRecoveryContext | undefined
): string {
  if (!startupRecoveryContext?.blockText) {
    return systemPrompt;
  }

  return [systemPrompt, startupRecoveryContext.blockText].filter(Boolean).join("\n\n");
}
