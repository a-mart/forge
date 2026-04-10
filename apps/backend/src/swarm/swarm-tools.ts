import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { getSpawnPresetFamilies } from "@forge/protocol";
import { parseSwarmModelPreset, parseSwarmReasoningLevel } from "./model-presets.js";
import { ChoiceRequestCancelledError } from "./swarm-manager.js";
import type { SwarmToolHost } from "./swarm-tool-host.js";
import {
  type AgentDescriptor,
  type MessageChannel,
  type RequestedDeliveryMode,
  type SpawnAgentInput
} from "./types.js";

export type { SwarmToolHost } from "./swarm-tool-host.js";

const deliveryModeSchema = Type.Union([
  Type.Literal("auto"),
  Type.Literal("followUp"),
  Type.Literal("steer")
]);

const SPAWN_PRESET_FAMILIES = getSpawnPresetFamilies();
export const SPAWN_PRESET_IDS = SPAWN_PRESET_FAMILIES.map((family) => family.familyId);

export const spawnModelPresetSchema = Type.Union(
  SPAWN_PRESET_IDS.map((familyId) => Type.Literal(familyId))
);

export const spawnReasoningLevelSchema = Type.Union(
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
  Type.Literal("telegram")
]);

const speakToUserTargetSchema = Type.Object({
  channel: messageChannelSchema,
  channelId: Type.Optional(
    Type.String({ description: "Required when channel is 'telegram'." })
  ),
  userId: Type.Optional(Type.String()),
  threadTs: Type.Optional(Type.String()),
  integrationProfileId: Type.Optional(
    Type.String({ description: "Optional integration profile id for provider-targeted delivery." })
  )
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
          const activity = agent.role === "worker" ? host.getWorkerActivity(agent.agentId) : undefined;
          return {
            agentId: agent.agentId,
            role: agent.role,
            status: agent.status,
            managerId: agent.managerId,
            model: `${agent.model.provider}/${agent.model.modelId}`,
            cwd: compactPath(agent.cwd),
            updatedAt: agent.updatedAt,
            ...(activity ? { activity } : {}),
            ...(isExternalManager ? { isExternal: true } : {}),
            ...(isExternalManager && agent.profileId ? { profileId: agent.profileId } : {}),
            ...(isExternalManager && agent.sessionLabel ? { sessionLabel: agent.sessionLabel } : {})
          };
        });

        const verboseAgents = selectedAgents.map((agent) => {
          const activity = agent.role === "worker" ? host.getWorkerActivity(agent.agentId) : undefined;
          if (agent.role === "manager" && agent.agentId !== visibleManagerId) {
            const { sessionFile: _sessionFile, ...safeExternalManager } = agent;
            return {
              ...safeExternalManager,
              isExternal: true
            };
          }

          return {
            ...agent,
            ...(activity ? { activity } : {})
          };
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
        `Create and start a new worker agent. Prefer specialist mode via \`specialist\` for standard delegation; use ad-hoc archetype/prompt/model overrides only when no specialist fits. agentId is required and normalized to lowercase kebab-case; if taken, a numeric suffix (-2, -3, …) is appended. archetypeId, systemPrompt, model, modelId, reasoningLevel, cwd, and initialMessage remain available in ad-hoc mode. model accepts ${SPAWN_PRESET_IDS.join("|")}.`,
      parameters: Type.Object({
        agentId: Type.String({
          description:
            "Required agent identifier. Normalized to lowercase kebab-case; collisions are suffixed numerically."
        }),
        specialist: Type.Optional(
          Type.String({
            description:
              "Specialist handle. See system prompt for available specialists. Omit to use ad-hoc model params instead."
          })
        ),
        archetypeId: Type.Optional(
          Type.String({ description: "Optional archetype id (for example: merger)." })
        ),
        systemPrompt: Type.Optional(Type.String({ description: "Optional system prompt override." })),
        model: Type.Optional(spawnModelPresetSchema),
        modelId: Type.Optional(
          Type.String({
            description:
              "Override model ID within the selected provider. Use specific model IDs from the catalog " +
              "(e.g. 'gpt-5.3-codex-spark' for fast/cheap, 'claude-haiku-4-5-20251001' for balanced Anthropic). " +
              "Leave empty for preset default."
          })
        ),
        reasoningLevel: Type.Optional(spawnReasoningLevelSchema),
        cwd: Type.Optional(Type.String({ description: "Optional working directory override." })),
        initialMessage: Type.Optional(Type.String({ description: "Optional first message to send after spawn." })),
        webSearch: Type.Optional(
          Type.Boolean({
            description:
              "Enable xAI native web search for this worker. Only effective with Grok models in ad-hoc mode. Ignored when specialist is provided (specialist config controls web search)."
          })
        )
      }),
      async execute(_toolCallId, params) {
        const parsed = params as {
          agentId: string;
          specialist?: string;
          archetypeId?: string;
          systemPrompt?: string;
          model?: unknown;
          modelId?: string;
          reasoningLevel?: unknown;
          cwd?: string;
          initialMessage?: string;
          webSearch?: boolean;
        };

        const spawnInput: SpawnAgentInput = {
          agentId: parsed.agentId,
          specialist: parsed.specialist,
          archetypeId: parsed.archetypeId,
          systemPrompt: parsed.systemPrompt,
          model: parseSwarmModelPreset(parsed.model, "spawn_agent.model"),
          modelId: parsed.modelId,
          reasoningLevel: parseSwarmReasoningLevel(parsed.reasoningLevel, "spawn_agent.reasoningLevel"),
          cwd: parsed.cwd,
          initialMessage: parsed.initialMessage,
          webSearch: parsed.webSearch
        };

        const spawned = await host.spawnAgent(descriptor.agentId, spawnInput);

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
        "Publish a user-visible manager message into the websocket conversation feed. If target is omitted, delivery defaults to web. For Telegram delivery, set target.channel and target.channelId explicitly.",
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
    },
    {
      name: "present_choices",
      label: "Present Choices",
      description:
        "Present structured choices to the user and wait for their response. " +
        "Use this when you want the user to select from specific options instead of typing freeform. " +
        "The user sees an interactive card with clickable buttons. " +
        "Returns the user's selections and any freeform text they provided. " +
        "The tool blocks until the user responds or cancels.",
      parameters: Type.Object({
        questions: Type.Array(
          Type.Object({
            id: Type.String({ description: "Unique question identifier." }),
            header: Type.Optional(
              Type.String({ description: "Bold header text above the question." })
            ),
            question: Type.String({ description: "The question text." }),
            options: Type.Optional(
              Type.Array(
                Type.Object({
                  id: Type.String({ description: "Unique option identifier." }),
                  label: Type.String({ description: "Button label." }),
                  description: Type.Optional(
                    Type.String({ description: "Description shown below the label." })
                  ),
                  recommended: Type.Optional(
                    Type.Boolean({ description: "If true, visually marked as recommended." })
                  ),
                }),
                { description: "Clickable options. Omit for free-text only." }
              )
            ),
            isOther: Type.Optional(
              Type.Boolean({
                description: "If true, show only a free-text input (no option buttons)."
              })
            ),
            placeholder: Type.Optional(
              Type.String({ description: "Placeholder text for the free-text input area." })
            ),
          }),
          { description: "One or more questions to present to the user.", minItems: 1 }
        ),
      }),
      async execute(_toolCallId, params) {
        const parsed = params as {
          questions: Array<{
            id: string;
            header?: string;
            question: string;
            options?: Array<{
              id: string;
              label: string;
              description?: string;
              recommended?: boolean;
            }>;
            isOther?: boolean;
            placeholder?: string;
          }>;
        };

        try {
          const answers = await host.requestUserChoice(
            descriptor.agentId,
            parsed.questions,
          );

          const details = {
            status: "answered",
            answers: answers.map((a) => ({
              questionId: a.questionId,
              selectedOptions: a.selectedOptionIds,
              text: a.text ?? null,
            })),
          };

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(details),
              },
            ],
            details,
          };
        } catch (error) {
          if (error instanceof ChoiceRequestCancelledError) {
            const details = {
              status: "cancelled",
              reason: error.reason,
            };
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(details),
                },
              ],
              details,
            };
          }

          throw error;
        }
      },
    }
  ];



  return [...shared, ...managerOnly];
}
