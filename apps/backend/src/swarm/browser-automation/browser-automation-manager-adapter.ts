import type {
  BrowserAutomationInputByOperation,
  BrowserAutomationOperation,
} from "@forge/protocol";
import { normalizeArchetypeId } from "../prompt-registry.js";
import type { AgentDescriptor } from "../types.js";
import {
  type BrowserAutomationInvocationResult,
  BrowserAutomationService,
} from "./browser-automation-service.js";

interface BrowserAutomationManagerAdapterOptions {
  getDescriptor: (agentId: string) => AgentDescriptor | undefined;
  getService: () => BrowserAutomationService;
}

export function createBrowserAutomationManagerInvoker(options: BrowserAutomationManagerAdapterOptions) {
  return function invokeBrowserAutomation<Operation extends BrowserAutomationOperation>(
    callerAgentId: string,
    operation: Operation,
    input: BrowserAutomationInputByOperation[Operation],
  ): Promise<BrowserAutomationInvocationResult<Operation>> {
    const descriptor = options.getDescriptor(callerAgentId);
    if (!descriptor || descriptor.role !== "manager" || !descriptor.profileId) {
      return Promise.resolve({
        ok: false,
        operation,
        error: { code: "session-not-found", message: "Browser automation requires a Forge manager session.", retryable: false },
      });
    }
    if (!isEligibleLocalBuilderManager(descriptor)) {
      return Promise.resolve({
        ok: false,
        operation,
        error: { code: "session-not-found", message: "Browser automation is only available to local Builder manager sessions.", retryable: false },
      });
    }
    return options.getService().invoke(callerAgentId, descriptor.profileId, operation, input);
  };
}

export function isEligibleLocalBuilderManager(descriptor: AgentDescriptor): boolean {
  return descriptor.role === "manager"
    && !!descriptor.profileId
    && descriptor.sessionSurface !== "collab"
    && descriptor.sessionPurpose === undefined
    && descriptor.cli === undefined
    && descriptor.externalThread === undefined
    && normalizeArchetypeId(descriptor.archetypeId ?? "") !== "cortex";
}
