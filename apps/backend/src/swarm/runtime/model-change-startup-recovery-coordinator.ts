import type { RuntimeCreationOptions, SwarmAgentRuntime } from "../runtime-contracts.js";
import type { AgentDescriptor } from "../types.js";
import {
  appendModelChangeContinuityApplied,
  createModelChangeContinuityApplied,
  type ModelChangeContinuityRequest
} from "./model-change-continuity.js";
import { resolvePendingModelChangeRuntimeStartup } from "./model-change-runtime-startup.js";

export type ModelChangeStartupRecoveryManagerDescriptor = AgentDescriptor & {
  role: "manager";
  profileId: string;
};

export interface ModelChangeStartupRecoveryCoordinatorOptions {
  now: () => string;
  logDebug: (message: string, details?: Record<string, unknown>) => void;
  getEffectiveContextWindow: (modelId: string, provider?: string) => number | undefined;
  hasPinnedContent: (agentId: string) => boolean;
}

export interface PrepareModelChangeStartupRecoveryResult {
  continuityRequest?: ModelChangeContinuityRequest;
  runtimeCreationOptions?: RuntimeCreationOptions;
}

export class ModelChangeStartupRecoveryCoordinator {
  constructor(private readonly options: ModelChangeStartupRecoveryCoordinatorOptions) {}

  async prepareManagerRuntimeCreation(
    descriptor: ModelChangeStartupRecoveryManagerDescriptor,
    systemPrompt: string
  ): Promise<PrepareModelChangeStartupRecoveryResult> {
    const recovery = await resolvePendingModelChangeRuntimeStartup({
      descriptor,
      targetModel: descriptor.model,
      existingPrompt: systemPrompt,
      modelContextWindow: this.options.getEffectiveContextWindow(
        descriptor.model.modelId,
        descriptor.model.provider
      ),
      hasPinnedContent: this.options.hasPinnedContent(descriptor.agentId)
    });

    if (!recovery.request) {
      return {};
    }

    this.options.logDebug("manager:model_change_continuity:prepare", {
      agentId: descriptor.agentId,
      requestId: recovery.request.requestId,
      sourceModel: recovery.request.sourceModel,
      targetModel: recovery.request.targetModel,
      policy: recovery.policy,
      eligibleEntryCount: recovery.recoveryContext?.eligibleEntryCount,
      includedEntryCount: recovery.recoveryContext?.includedEntryCount,
      omittedEntryCount: recovery.recoveryContext?.omittedEntryCount,
      truncated: recovery.recoveryContext?.truncated,
      approxTokenCount: recovery.recoveryContext?.approxTokenCount
    });

    return {
      continuityRequest: recovery.request,
      runtimeCreationOptions: recovery.policy === "skip_pi_to_pi"
        ? undefined
        : {
            startupRecoveryContext: {
              reason: "model_change",
              blockText: recovery.recoveryContext?.blockText ?? ""
            }
          }
    };
  }

  async appendAppliedModelChangeContinuity(
    descriptor: ModelChangeStartupRecoveryManagerDescriptor,
    request: ModelChangeContinuityRequest,
    runtime: SwarmAgentRuntime
  ): Promise<void> {
    await appendModelChangeContinuityApplied({
      sessionFile: descriptor.sessionFile,
      cwd: descriptor.cwd,
      applied: createModelChangeContinuityApplied({
        requestId: request.requestId,
        appliedAt: this.options.now(),
        sessionAgentId: descriptor.agentId,
        attachedRuntime: runtime.descriptor.model
      }),
      now: this.options.now
    });
  }
}
