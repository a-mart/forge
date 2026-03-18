import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type {
  OnboardingAutonomyDefault,
  OnboardingExplanationDepth,
  OnboardingResponseVerbosity,
  OnboardingRiskEscalationPreference,
  OnboardingStatus,
  OnboardingTechnicalComfort,
  OnboardingUpdateCadence
} from "@forge/protocol";
import { parseSwarmModelPreset, parseSwarmReasoningLevel } from "./model-presets.js";
import type { OnboardingFactsPatch, OnboardingMutationResult } from "./onboarding-state.js";
import {
  type AgentDescriptor,
  type MessageChannel,
  type MessageSourceContext,
  type MessageTargetContext,
  type RequestedDeliveryMode,
  type SendMessageReceipt,
  type SpawnAgentInput
} from "./types.js";

export interface SwarmToolHost {
  listAgents(): AgentDescriptor[];
  spawnAgent(callerAgentId: string, input: SpawnAgentInput): Promise<AgentDescriptor>;
  killAgent(callerAgentId: string, targetAgentId: string): Promise<void>;
  sendMessage(
    fromAgentId: string,
    targetAgentId: string,
    message: string,
    delivery?: RequestedDeliveryMode
  ): Promise<SendMessageReceipt>;
  publishToUser(
    agentId: string,
    text: string,
    source?: "speak_to_user" | "system",
    targetContext?: MessageTargetContext
  ): Promise<{ targetContext: MessageSourceContext }>;
  isOnboardingMode?(agentId: string): boolean;
  saveOnboardingFacts?(
    callerAgentId: string,
    input: {
      cycleId?: string;
      baseRevision?: number;
      facts: OnboardingFactsPatch;
      renderCommonMd?: boolean;
    }
  ): Promise<OnboardingMutationResult>;
  setOnboardingStatus?(
    callerAgentId: string,
    input: {
      status: OnboardingStatus;
      reason?: string | null;
      cycleId?: string;
      baseRevision?: number;
      renderCommonMd?: boolean;
    }
  ): Promise<OnboardingMutationResult>;
}

const deliveryModeSchema = Type.Union([
  Type.Literal("auto"),
  Type.Literal("followUp"),
  Type.Literal("steer")
]);

const spawnModelPresetSchema = Type.Union([
  Type.Literal("pi-codex"),
  Type.Literal("pi-5.4"),
  Type.Literal("pi-opus"),
  Type.Literal("codex-app")
]);

const spawnReasoningLevelSchema = Type.Union(
  [
    Type.Literal("none"),
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
    Type.Literal("xhigh")
  ],
  {
    description:
      "Reasoning effort level. 'none'/'low' for simple tasks, 'medium' for balanced, 'high'/'xhigh' for complex analysis. Note: Claude Code supports low/medium/high only; 'none' maps to 'low' and 'xhigh' maps to 'high' for Claude models."
  }
);

const messageChannelSchema = Type.Union([
  Type.Literal("web"),
  Type.Literal("slack"),
  Type.Literal("telegram")
]);

const speakToUserTargetSchema = Type.Object({
  channel: messageChannelSchema,
  channelId: Type.Optional(
    Type.String({ description: "Required when channel is 'slack' or 'telegram'." })
  ),
  userId: Type.Optional(Type.String()),
  threadTs: Type.Optional(Type.String()),
  integrationProfileId: Type.Optional(
    Type.String({ description: "Optional integration profile id for provider-targeted delivery." })
  )
});

const onboardingFactStatusSchema = Type.Union([
  Type.Literal("unknown"),
  Type.Literal("tentative"),
  Type.Literal("confirmed"),
  Type.Literal("promoted")
]);

const onboardingStatusSchema = Type.Union([
  Type.Literal("not_started"),
  Type.Literal("active"),
  Type.Literal("deferred"),
  Type.Literal("completed"),
  Type.Literal("migrated")
]);

const technicalComfortValueSchema = Type.Union([
  Type.Literal("non_technical"),
  Type.Literal("mixed"),
  Type.Literal("technical"),
  Type.Literal("advanced")
]);

const responseVerbosityValueSchema = Type.Union([
  Type.Literal("concise"),
  Type.Literal("balanced"),
  Type.Literal("detailed")
]);

const explanationDepthValueSchema = Type.Union([
  Type.Literal("minimal"),
  Type.Literal("standard"),
  Type.Literal("teaching")
]);

const updateCadenceValueSchema = Type.Union([
  Type.Literal("milestones"),
  Type.Literal("periodic"),
  Type.Literal("frequent")
]);

const autonomyDefaultValueSchema = Type.Union([
  Type.Literal("collaborative"),
  Type.Literal("balanced"),
  Type.Literal("autonomous")
]);

const riskEscalationPreferenceValueSchema = Type.Union([
  Type.Literal("low_threshold"),
  Type.Literal("normal"),
  Type.Literal("high_threshold")
]);

const stringFactPatchSchema = Type.Object({
  value: Type.String(),
  status: onboardingFactStatusSchema
});

const technicalComfortFactPatchSchema = Type.Object({
  value: technicalComfortValueSchema,
  status: onboardingFactStatusSchema
});

const responseVerbosityFactPatchSchema = Type.Object({
  value: responseVerbosityValueSchema,
  status: onboardingFactStatusSchema
});

const explanationDepthFactPatchSchema = Type.Object({
  value: explanationDepthValueSchema,
  status: onboardingFactStatusSchema
});

const updateCadenceFactPatchSchema = Type.Object({
  value: updateCadenceValueSchema,
  status: onboardingFactStatusSchema
});

const autonomyDefaultFactPatchSchema = Type.Object({
  value: autonomyDefaultValueSchema,
  status: onboardingFactStatusSchema
});

const riskEscalationPreferenceFactPatchSchema = Type.Object({
  value: riskEscalationPreferenceValueSchema,
  status: onboardingFactStatusSchema
});

const primaryUseCasesFactPatchSchema = Type.Object({
  value: Type.Array(Type.String()),
  status: onboardingFactStatusSchema
});

const onboardingFactsPatchSchema = Type.Object({
  preferredName: Type.Optional(stringFactPatchSchema),
  technicalComfort: Type.Optional(technicalComfortFactPatchSchema),
  responseVerbosity: Type.Optional(responseVerbosityFactPatchSchema),
  explanationDepth: Type.Optional(explanationDepthFactPatchSchema),
  updateCadence: Type.Optional(updateCadenceFactPatchSchema),
  autonomyDefault: Type.Optional(autonomyDefaultFactPatchSchema),
  riskEscalationPreference: Type.Optional(riskEscalationPreferenceFactPatchSchema),
  primaryUseCases: Type.Optional(primaryUseCasesFactPatchSchema)
});

function includeListAgentsEntry(agent: AgentDescriptor, includeTerminated: boolean): boolean {
  if (includeTerminated) {
    return true;
  }

  return agent.status !== "terminated" && agent.status !== "stopped";
}

function rankListAgentsStatus(status: AgentDescriptor["status"]): number {
  switch (status) {
    case "streaming":
      return 0;
    case "error":
      return 1;
    case "idle":
      return 2;
    case "stopped":
      return 3;
    case "terminated":
      return 4;
    default:
      return 5;
  }
}

function sortAgentsForList(left: AgentDescriptor, right: AgentDescriptor): number {
  const rankDiff = rankListAgentsStatus(left.status) - rankListAgentsStatus(right.status);
  if (rankDiff !== 0) {
    return rankDiff;
  }

  const updatedAtDiff = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  if (Number.isFinite(updatedAtDiff) && updatedAtDiff !== 0) {
    return updatedAtDiff;
  }

  return left.agentId.localeCompare(right.agentId);
}

function compactPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized.length === 0 || normalized === "/") {
    return value;
  }

  const segments = normalized.split("/").filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : normalized;
}

export function buildSwarmTools(host: SwarmToolHost, descriptor: AgentDescriptor): ToolDefinition[] {
  const shared: ToolDefinition[] = [
    {
      name: "list_agents",
      label: "List Agents",
      description:
        "List swarm agents with ids, roles, status, model, and workspace. Managers can set includeManagers=true to include other manager sessions.",
      parameters: Type.Object({
        verbose: Type.Optional(
          Type.Boolean({ description: "Include full descriptor fields (still paginated)." })
        ),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 100,
            description: "Page size (default: 20)."
          })
        ),
        offset: Type.Optional(
          Type.Integer({
            minimum: 0,
            description: "Page offset (default: 0)."
          })
        ),
        includeTerminated: Type.Optional(
          Type.Boolean({
            description: "Include terminated/stopped agents in results."
          })
        ),
        includeManagers: Type.Optional(
          Type.Boolean({
            description:
              "Manager only. Include other manager sessions outside the caller's own team, marked with isExternal=true."
          })
        )
      }),
      async execute(_toolCallId, params) {
        const parsed = params as {
          verbose?: boolean;
          limit?: number;
          offset?: number;
          includeTerminated?: boolean;
          includeManagers?: boolean;
        };

        const verbose = parsed.verbose === true;
        const limit = Math.max(1, Math.min(parsed.limit ?? 20, 100));
        const offset = Math.max(0, parsed.offset ?? 0);
        const includeTerminated = parsed.includeTerminated === true;
        const includeManagers = descriptor.role === "manager" && parsed.includeManagers === true;
        const visibleManagerId = descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId;

        const allAgents = host.listAgents();
        const managerDescriptor =
          allAgents.find((agent) => agent.role === "manager" && agent.agentId === visibleManagerId) ??
          allAgents.find((agent) => agent.role === "manager");

        const teamWorkers = allAgents
          .filter(
            (agent) =>
              agent.role === "worker" &&
              agent.managerId === visibleManagerId &&
              includeListAgentsEntry(agent, includeTerminated)
          )
          .sort(sortAgentsForList);

        const externalManagers = includeManagers
          ? allAgents
              .filter(
                (agent) =>
                  agent.role === "manager" &&
                  agent.agentId !== visibleManagerId &&
                  includeListAgentsEntry(agent, includeTerminated)
              )
              .sort(sortAgentsForList)
          : [];

        const pageAgents = [...teamWorkers, ...externalManagers];
        const pagedAgents = pageAgents.slice(offset, offset + limit);
        const hasMore = offset + limit < pageAgents.length;
        const selectedAgents = managerDescriptor ? [managerDescriptor, ...pagedAgents] : pagedAgents;
        const summaryAgents = managerDescriptor ? [managerDescriptor, ...pageAgents] : pageAgents;

        const statusCounts: Record<string, number> = {
          streaming: 0,
          idle: 0,
          error: 0,
          stopped: 0,
          terminated: 0
        };

        for (const agent of summaryAgents) {
          statusCounts[agent.status] = (statusCounts[agent.status] ?? 0) + 1;
        }

        const compactAgents = selectedAgents.map((agent) => {
          const isExternalManager = agent.role === "manager" && agent.agentId !== visibleManagerId;
          return {
            agentId: agent.agentId,
            role: agent.role,
            status: agent.status,
            managerId: agent.managerId,
            model: `${agent.model.provider}/${agent.model.modelId}`,
            cwd: compactPath(agent.cwd),
            updatedAt: agent.updatedAt,
            ...(isExternalManager ? { isExternal: true } : {}),
            ...(isExternalManager && agent.profileId ? { profileId: agent.profileId } : {}),
            ...(isExternalManager && agent.sessionLabel ? { sessionLabel: agent.sessionLabel } : {})
          };
        });

        const verboseAgents = selectedAgents.map((agent) => {
          if (agent.role === "manager" && agent.agentId !== visibleManagerId) {
            const { sessionFile: _sessionFile, ...safeExternalManager } = agent;
            return {
              ...safeExternalManager,
              isExternal: true
            };
          }

          return agent;
        });

        const nextPageParams = [
          `"verbose":${verbose ? "true" : "false"}`,
          `"limit":${limit}`,
          `"offset":${offset + limit}`,
          includeTerminated ? '"includeTerminated":true' : "",
          includeManagers ? '"includeManagers":true' : ""
        ]
          .filter((entry) => entry.length > 0)
          .join(",");

        const payload = {
          summary: {
            totalVisible: summaryAgents.length,
            managers: summaryAgents.filter((agent) => agent.role === "manager").length,
            workers: summaryAgents.filter((agent) => agent.role === "worker").length,
            statusCounts
          },
          page: {
            offset,
            limit,
            returned: pagedAgents.length,
            hasMore,
            mode: verbose ? "verbose" : "default"
          },
          agents: verbose ? verboseAgents : compactAgents,
          hint: hasMore
            ? `More agents available. Use list_agents({${nextPageParams}}) for the next page.`
            : "Use list_agents({\"verbose\":true,\"limit\":50,\"offset\":0}) for paged full descriptors."
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(payload, null, 2)
            }
          ],
          details: payload
        };
      }
    },
    {
      name: "send_message_to_agent",
      label: "Send Message To Agent",
      description:
        "Send a message to another agent by id. Returns immediately with a delivery receipt. If target is busy, queued delivery is accepted as steer.",
      parameters: Type.Object({
        targetAgentId: Type.String({ description: "Agent id to receive the message." }),
        message: Type.String({ description: "Message text to deliver." }),
        delivery: Type.Optional(deliveryModeSchema)
      }),
      async execute(_toolCallId, params) {
        const parsed = params as {
          targetAgentId: string;
          message: string;
          delivery?: RequestedDeliveryMode;
        };

        const receipt = await host.sendMessage(
          descriptor.agentId,
          parsed.targetAgentId,
          parsed.message,
          parsed.delivery
        );

        return {
          content: [
            {
              type: "text",
              text: `Queued message for ${receipt.targetAgentId}. deliveryId=${receipt.deliveryId}, mode=${receipt.acceptedMode}`
            }
          ],
          details: receipt
        };
      }
    }
  ];

  if (descriptor.role !== "manager") {
    return shared;
  }

  const managerOnly: ToolDefinition[] = [
    {
      name: "spawn_agent",
      label: "Spawn Agent",
      description:
        "Create and start a new worker agent. agentId is required and normalized to lowercase kebab-case; if taken, a numeric suffix (-2, -3, …) is appended. archetypeId, systemPrompt, model, modelId, reasoningLevel, cwd, and initialMessage are optional. model accepts pi-codex|pi-5.4|pi-opus|codex-app.",
      parameters: Type.Object({
        agentId: Type.String({
          description:
            "Required agent identifier. Normalized to lowercase kebab-case; collisions are suffixed numerically."
        }),
        archetypeId: Type.Optional(
          Type.String({ description: "Optional archetype id (for example: merger)." })
        ),
        systemPrompt: Type.Optional(Type.String({ description: "Optional system prompt override." })),
        model: Type.Optional(spawnModelPresetSchema),
        modelId: Type.Optional(
          Type.String({
            description:
              "Override model ID within the selected provider. For pi-codex: 'gpt-5.3-codex' (default), 'gpt-5.3-codex-spark' (fast/cheap), etc. For pi-5.4: 'gpt-5.4' (default). For pi-opus: 'claude-opus-4-6' (default), 'claude-sonnet-4-5-20250929' (balanced), 'claude-haiku-4-5-20251001' (fast/cheap). Leave empty for preset default."
          })
        ),
        reasoningLevel: Type.Optional(spawnReasoningLevelSchema),
        cwd: Type.Optional(Type.String({ description: "Optional working directory override." })),
        initialMessage: Type.Optional(Type.String({ description: "Optional first message to send after spawn." }))
      }),
      async execute(_toolCallId, params) {
        const parsed = params as {
          agentId: string;
          archetypeId?: string;
          systemPrompt?: string;
          model?: unknown;
          modelId?: string;
          reasoningLevel?: unknown;
          cwd?: string;
          initialMessage?: string;
        };

        const spawned = await host.spawnAgent(descriptor.agentId, {
          agentId: parsed.agentId,
          archetypeId: parsed.archetypeId,
          systemPrompt: parsed.systemPrompt,
          model: parseSwarmModelPreset(parsed.model, "spawn_agent.model"),
          modelId: parsed.modelId,
          reasoningLevel: parseSwarmReasoningLevel(parsed.reasoningLevel, "spawn_agent.reasoningLevel"),
          cwd: parsed.cwd,
          initialMessage: parsed.initialMessage
        });

        return {
          content: [
            {
              type: "text",
              text: `Spawned agent ${spawned.agentId} (${spawned.displayName})`
            }
          ],
          details: spawned
        };
      }
    },
    {
      name: "kill_agent",
      label: "Kill Agent",
      description: "Terminate a running worker agent. Manager cannot be terminated.",
      parameters: Type.Object({
        targetAgentId: Type.String({ description: "Agent id to terminate." })
      }),
      async execute(_toolCallId, params) {
        const parsed = params as { targetAgentId: string };
        await host.killAgent(descriptor.agentId, parsed.targetAgentId);
        return {
          content: [
            {
              type: "text",
              text: `Terminated agent ${parsed.targetAgentId}`
            }
          ],
          details: {
            targetAgentId: parsed.targetAgentId,
            terminated: true
          }
        };
      }
    },
    {
      name: "speak_to_user",
      label: "Speak To User",
      description:
        "Publish a user-visible manager message into the websocket conversation feed. If target is omitted, delivery defaults to web. For Slack/Telegram delivery, set target.channel and target.channelId explicitly.",
      parameters: Type.Object({
        text: Type.String({ description: "Message content to show to the user." }),
        target: Type.Optional(speakToUserTargetSchema)
      }),
      async execute(_toolCallId, params) {
        const parsed = params as {
          text: string;
          target?: {
            channel: MessageChannel;
            channelId?: string;
            userId?: string;
            threadTs?: string;
            integrationProfileId?: string;
          };
        };

        const published = await host.publishToUser(
          descriptor.agentId,
          parsed.text,
          "speak_to_user",
          parsed.target
        );

        return {
          content: [
            {
              type: "text",
              text: `Published message to user (${published.targetContext.channel}).`
            }
          ],
          details: {
            published: true,
            targetContext: published.targetContext
          }
        };
      }
    }
  ];

  const isOnboardingMode = host.isOnboardingMode?.(descriptor.agentId) === true;
  const saveOnboardingFacts = host.saveOnboardingFacts?.bind(host);
  const setOnboardingStatus = host.setOnboardingStatus?.bind(host);

  if (isOnboardingMode && saveOnboardingFacts && setOnboardingStatus) {
    managerOnly.push(
      {
        name: "save_onboarding_facts",
        label: "Save Onboarding Facts",
        description:
          "Persist durable onboarding facts for the root Cortex onboarding conversation. If cycleId/baseRevision are omitted, the backend resolves the current onboarding snapshot automatically.",
        parameters: Type.Object({
          cycleId: Type.Optional(Type.String({ description: "Optional onboarding cycle id. Omit to use the current cycle automatically." })),
          baseRevision: Type.Optional(
            Type.Integer({ minimum: 0, description: "Optional onboarding revision for CAS. Omit to use the current revision automatically." })
          ),
          facts: onboardingFactsPatchSchema,
          renderCommonMd: Type.Optional(
            Type.Boolean({ description: "Render the managed onboarding block in common.md after a successful save." })
          )
        }),
        async execute(_toolCallId, params) {
          const parsed = params as {
            cycleId?: string;
            baseRevision?: number;
            facts: OnboardingFactsPatch;
            renderCommonMd?: boolean;
          };

          const result = await saveOnboardingFacts(descriptor.agentId, {
            cycleId: parsed.cycleId,
            baseRevision: parsed.baseRevision,
            facts: parsed.facts,
            renderCommonMd: parsed.renderCommonMd
          });

          return {
            content: [
              {
                type: "text",
                text: result.ok
                  ? `Saved onboarding facts at revision ${result.snapshot.revision}.`
                  : `Onboarding fact save failed: ${result.reason}. Current cycleId=${result.snapshot.cycleId}, revision=${result.snapshot.revision}.`
              }
            ],
            details: result
          };
        }
      },
      {
        name: "set_onboarding_status",
        label: "Set Onboarding Status",
        description:
          "Persist the onboarding lifecycle status for the root Cortex onboarding conversation. If cycleId/baseRevision are omitted, the backend resolves the current onboarding snapshot automatically.",
        parameters: Type.Object({
          status: onboardingStatusSchema,
          reason: Type.Optional(Type.String({ description: "Optional short reason for the status change." })),
          cycleId: Type.Optional(Type.String({ description: "Optional onboarding cycle id. Omit to use the current cycle automatically." })),
          baseRevision: Type.Optional(
            Type.Integer({ minimum: 0, description: "Optional onboarding revision for CAS. Omit to use the current revision automatically." })
          ),
          renderCommonMd: Type.Optional(
            Type.Boolean({ description: "Render the managed onboarding block in common.md after a successful status change." })
          )
        }),
        async execute(_toolCallId, params) {
          const parsed = params as {
            status: OnboardingStatus;
            reason?: string;
            cycleId?: string;
            baseRevision?: number;
            renderCommonMd?: boolean;
          };

          const result = await setOnboardingStatus(descriptor.agentId, {
            status: parsed.status,
            reason: parsed.reason,
            cycleId: parsed.cycleId,
            baseRevision: parsed.baseRevision,
            renderCommonMd: parsed.renderCommonMd
          });

          return {
            content: [
              {
                type: "text",
                text: result.ok
                  ? `Set onboarding status to ${parsed.status} at revision ${result.snapshot.revision}.`
                  : `Onboarding status update failed: ${result.reason}. Current cycleId=${result.snapshot.cycleId}, revision=${result.snapshot.revision}.`
              }
            ],
            details: result
          };
        }
      }
    );
  }

  return [...shared, ...managerOnly];
}
