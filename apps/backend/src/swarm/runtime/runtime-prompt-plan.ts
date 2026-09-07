import { join } from "node:path";
import type { RuntimeStartupRecoveryContext } from "../runtime-contracts.js";

export interface PiRuntimePromptPlan {
  systemPrompt: string;
  appendSystemPromptOverride: (base: string[]) => string[];
  startupRecoveryContextFile?: { path: string; content: string };
}

export interface PlanPiRuntimePromptOptions {
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

  return {
    systemPrompt: options.systemPrompt,
    appendSystemPromptOverride: () => [],
    ...(startupRecoveryContextFile ? { startupRecoveryContextFile } : {}),
  };
}

export interface SdkRuntimePromptPlan {
  systemPrompt: string;
  startupSystemPromptOverride?: string;
  skipInitialSessionResume?: boolean;
}

export interface PlanSdkRuntimePromptOptions {
  systemPrompt: string;
  startupRecoveryContext?: RuntimeStartupRecoveryContext;
}

function planSdkRuntimePrompt(options: PlanSdkRuntimePromptOptions): SdkRuntimePromptPlan {
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

export function planCursorSdkRuntimePrompt(options: PlanSdkRuntimePromptOptions): SdkRuntimePromptPlan {
  return planSdkRuntimePrompt(options);
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
