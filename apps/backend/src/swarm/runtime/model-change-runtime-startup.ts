import { readFile } from "node:fs/promises";
import { isConversationEntryEvent } from "../conversation-validators.js";
import type { AgentDescriptor, AgentModelDescriptor, ConversationEntryEvent } from "../types.js";
import {
  buildModelChangeRecoveryContext,
  type ModelChangeRecoveryContextResult
} from "./model-change-recovery-context.js";
import {
  findLatestPendingModelChangeContinuityRequest,
  loadModelChangeContinuityState,
  type ModelChangeContinuityRequest
} from "./model-change-continuity.js";
import { isEnoentError } from "../../utils/fs-errors.js";

const CONVERSATION_ENTRY_CUSTOM_TYPE = "swarm_conversation_entry";

export interface ResolvePendingModelChangeRuntimeStartupOptions {
  descriptor: Pick<AgentDescriptor, "agentId" | "role" | "sessionFile">;
  targetModel: Pick<AgentModelDescriptor, "provider" | "modelId"> & { thinkingLevel?: string };
  existingPrompt?: string;
  modelContextWindow?: number;
  hasPinnedContent?: boolean;
}

export interface ResolvePendingModelChangeRuntimeStartupResult {
  request?: ModelChangeContinuityRequest;
  recoveryContext?: ModelChangeRecoveryContextResult;
  policy: "no_request" | "skip_pi_to_pi" | "recovered" | "recovered_empty";
}

export async function resolvePendingModelChangeRuntimeStartup(
  options: ResolvePendingModelChangeRuntimeStartupOptions
): Promise<ResolvePendingModelChangeRuntimeStartupResult> {
  const continuityState = await loadModelChangeContinuityState(options.descriptor.sessionFile);
  const request = findLatestPendingModelChangeContinuityRequest({
    sessionAgentId: options.descriptor.agentId,
    requests: continuityState.requests,
    applied: continuityState.applied,
    targetModel: options.targetModel
  });

  if (!request) {
    return {
      policy: "no_request"
    };
  }

  if (!shouldApplyModelChangeRecoveryContext(request)) {
    return {
      request,
      policy: "skip_pi_to_pi"
    };
  }

  const sessionRecoveryInputs = await loadSessionRecoveryInputs(options.descriptor.sessionFile);
  const recoveryContext = buildModelChangeRecoveryContext({
    descriptor: options.descriptor,
    entries: sessionRecoveryInputs.entries,
    modelContextWindow: options.modelContextWindow,
    existingPrompt: options.existingPrompt,
    hasPinnedContent: options.hasPinnedContent
  });

  return {
    request,
    recoveryContext,
    policy: recoveryContext.blockText ? "recovered" : "recovered_empty"
  };
}

export function shouldApplyModelChangeRecoveryContext(request: ModelChangeContinuityRequest): boolean {
  return !(request.sourceModel.runtimeKind === "pi" && request.targetModel.runtimeKind === "pi");
}

async function loadSessionRecoveryInputs(sessionFile: string): Promise<{
  entries: ConversationEntryEvent[];
}> {
  const content = await readFile(sessionFile, "utf8").catch((error: unknown) => {
    if (isEnoentError(error)) {
      return "";
    }

    throw error;
  });

  const entries: ConversationEntryEvent[] = [];

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }

    const customEntry = parsed as {
      type?: unknown;
      customType?: unknown;
      data?: unknown;
    };
    if (customEntry.type !== "custom") {
      continue;
    }

    if (customEntry.customType === CONVERSATION_ENTRY_CUSTOM_TYPE && isConversationEntryEvent(customEntry.data)) {
      entries.push(customEntry.data);
    }
  }

  return { entries };
}

