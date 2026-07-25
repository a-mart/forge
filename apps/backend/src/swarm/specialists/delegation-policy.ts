import type { EffortTier } from "@forge/protocol";
import type { SpawnAgentInput } from "../types.js";
import { resolveLegacySpecialistRewrite } from "./specialist-registry.js";

export type WorkerBehaviorMode =
  | "general"
  | "plan"
  | "correctness-review"
  | "design-review"
  | "research";

export type WorkerExecutionPolicy = "support" | "routine" | "deep";

export const WORKER_BEHAVIOR_MODES = [
  "general",
  "plan",
  "correctness-review",
  "design-review",
  "research",
] as const satisfies readonly WorkerBehaviorMode[];

export const WORKER_EXECUTION_POLICIES = [
  "support",
  "routine",
  "deep",
] as const satisfies readonly WorkerExecutionPolicy[];

const EXECUTION_POLICY_TIERS: Record<WorkerExecutionPolicy, EffortTier> = {
  support: "fast",
  routine: "standard",
  deep: "deep",
};

interface BehaviorModeConfig {
  defaultPolicy: WorkerExecutionPolicy;
  lens?: string;
}

const BEHAVIOR_MODE_CONFIGS: Record<WorkerBehaviorMode, BehaviorModeConfig> = {
  general: { defaultPolicy: "routine" },
  plan: { defaultPolicy: "deep", lens: "planner" },
  "correctness-review": {
    defaultPolicy: "deep",
    lens: "code-reviewer",
  },
  "design-review": {
    defaultPolicy: "deep",
    lens: "code-reviewer-2",
  },
  research: { defaultPolicy: "support", lens: "researcher" },
};

export interface ManagerDelegationInput {
  agentId: string;
  initialMessage: string;
  mode?: WorkerBehaviorMode;
  executionPolicy?: WorkerExecutionPolicy;
  customSpecialist?: string;
  planStep?: string;
  cwd?: string;
  requiresSecureRuntime?: boolean;
}

export interface ResolvedManagerDelegation {
  spawnInput: SpawnAgentInput;
  requestedMode?: WorkerBehaviorMode;
  requestedExecutionPolicy?: WorkerExecutionPolicy;
}

export function resolveManagerDelegation(input: ManagerDelegationInput): ResolvedManagerDelegation {
  const agentId = input.agentId?.trim();
  if (!agentId) {
    throw new Error("spawn_agent requires a non-empty agentId");
  }

  const initialMessage = input.initialMessage?.trim();
  if (!initialMessage) {
    throw new Error("spawn_agent requires a non-empty initialMessage");
  }

  const customSpecialist = input.customSpecialist?.trim();
  if (input.customSpecialist !== undefined && !customSpecialist) {
    throw new Error("spawn_agent.customSpecialist must be a non-empty saved specialist handle");
  }
  if (customSpecialist) {
    if (input.mode !== undefined || input.executionPolicy !== undefined) {
      throw new Error(
        "customSpecialist cannot be combined with mode or executionPolicy; its saved definition owns worker behavior and model selection.",
      );
    }
    if (resolveLegacySpecialistRewrite(customSpecialist)) {
      throw new Error(
        `customSpecialist "${customSpecialist}" is reserved for Forge compatibility; use a behavior mode or a different saved custom handle.`,
      );
    }
    return {
      spawnInput: {
        agentId,
        initialMessage,
        specialist: customSpecialist,
        planStep: input.planStep,
        cwd: input.cwd,
        requiresSecureRuntime: input.requiresSecureRuntime,
      },
    };
  }

  if (input.mode !== undefined && !WORKER_BEHAVIOR_MODES.includes(input.mode)) {
    throw new Error(`spawn_agent.mode must be one of ${WORKER_BEHAVIOR_MODES.join("|")}`);
  }
  if (
    input.executionPolicy !== undefined &&
    !WORKER_EXECUTION_POLICIES.includes(input.executionPolicy)
  ) {
    throw new Error(
      `spawn_agent.executionPolicy must be one of ${WORKER_EXECUTION_POLICIES.join("|")}`,
    );
  }

  const mode = input.mode ?? "general";
  const modeConfig = BEHAVIOR_MODE_CONFIGS[mode];
  const executionPolicy = input.executionPolicy ?? modeConfig.defaultPolicy;

  return {
    requestedMode: mode,
    requestedExecutionPolicy: executionPolicy,
    spawnInput: {
      agentId,
      initialMessage,
      tier: EXECUTION_POLICY_TIERS[executionPolicy],
      lens: modeConfig.lens,
      policyControlledModel: true,
      planStep: input.planStep,
      cwd: input.cwd,
      requiresSecureRuntime: input.requiresSecureRuntime,
    },
  };
}

export function translateManagerDelegationError(
  error: unknown,
  resolved: ResolvedManagerDelegation,
): Error {
  const original = error instanceof Error ? error : new Error(String(error));
  const mode = resolved.requestedMode;
  const policy = resolved.requestedExecutionPolicy;
  if (!mode || !policy) {
    return original;
  }

  const lens = BEHAVIOR_MODE_CONFIGS[mode].lens;
  if (lens && original.message.startsWith(`Unknown lens: ${lens}`)) {
    return new Error(`Behavior mode "${mode}" is not available in this session.`);
  }
  if (lens && original.message.startsWith(`Lens "${lens}" is disabled`)) {
    return new Error(`Behavior mode "${mode}" is disabled in this session.`);
  }
  if (lens && original.message.startsWith(`Lens "${lens}" is currently unavailable:`)) {
    return new Error(
      original.message.replace(
        `Lens "${lens}" is currently unavailable:`,
        `Behavior mode "${mode}" is currently unavailable:`,
      ),
    );
  }
  if (original.message.startsWith("Tier \"") || original.message.startsWith("Unknown tier:")) {
    return new Error(`Execution policy "${policy}" is not available: ${original.message}`);
  }
  return original;
}
