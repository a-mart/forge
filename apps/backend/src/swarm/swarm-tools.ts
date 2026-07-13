import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getSpawnPresetFamilies } from "@forge/protocol";
import { parseSwarmModelPreset, parseSwarmReasoningLevel } from "./model-presets.js";
import { ChoiceRequestCancelledError } from "./swarm-manager.js";
import type { SwarmToolHost } from "./swarm-tool-host.js";
import {
  buildCodexPluginScopedToolDefinitions,
  CODEX_PLUGIN_SPECIALIST_ID,
  isCodexPluginWorkerDescriptor,
} from "./codex-app-server/codex-plugin-scope-service.js";
import {
  type AgentDescriptor,
  type MessageChannel,
  type RequestedDeliveryMode,
  type SpawnAgentInput
} from "./types.js";
import { buildUpdatePlanTool } from "./planning/update-plan-tool.js";

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
    Type.Literal("xhigh"),
    Type.Literal("max"),
    Type.Literal("ultra")
  ],
  {
    description:
      "Reasoning effort level. 'none'/'low' for simple tasks, 'medium' for balanced, 'high'/'xhigh' for complex analysis, and GPT-5.6 Sol additionally supports 'max' and 'ultra'. Note: Claude Code supports low/medium/high only; 'none' maps to 'low' and 'xhigh'/'max'/'ultra' map to 'high' for Claude models."
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

const knowledgeScopeSchema = Type.Union([
  Type.Literal("global"),
  Type.Literal("profile"),
  Type.Literal("all")
]);

const knowledgeEntryTypeSchema = Type.Union([
  Type.Literal("preference"),
  Type.Literal("convention"),
  Type.Literal("gotcha"),
  Type.Literal("pointer")
]);

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

function recordToolSideEffect(
  host: SwarmToolHost,
  descriptor: AgentDescriptor,
  event: Parameters<NonNullable<SwarmToolHost["recordToolSideEffect"]>>[1],
): void {
  host.recordToolSideEffect?.(descriptor.agentId, event);
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
        "Send a message to another agent by id. Returns immediately with a delivery receipt. If target is busy, queued delivery is accepted as steer. When assigning or reassigning a worker to one current plan step, pass that step's exact text in planStep.",
      parameters: Type.Object({
        targetAgentId: Type.String({ description: "Agent id to receive the message." }),
        message: Type.String({ description: "Message text to deliver." }),
        delivery: Type.Optional(deliveryModeSchema),
        planStep: Type.Optional(Type.String({
          description: "Exact text of the current plan step this worker assignment supports. Omit for general or cross-cutting work."
        }))
      }),
      async execute(_toolCallId, params) {
        const parsed = params as {
          targetAgentId: string;
          message: string;
          delivery?: RequestedDeliveryMode;
          planStep?: string;
        };

        const receipt = await host.sendMessage(
          descriptor.agentId,
          parsed.targetAgentId,
          parsed.message,
          parsed.delivery,
          {
            observabilityParentTool: {
              agentId: descriptor.agentId,
              toolCallId: _toolCallId,
              toolName: "send_message_to_agent",
            },
            ...(parsed.planStep ? { planStep: parsed.planStep } : {}),
          }
        );
        recordToolSideEffect(host, descriptor, {
          toolName: "send_message_to_agent",
          toolCallId: _toolCallId,
          phase: "side_effect",
          input: parsed,
          output: receipt,
          metadata: {
            targetAgentId: parsed.targetAgentId,
            acceptedMode: receipt.acceptedMode,
            deliveryId: receipt.deliveryId,
            planStep: parsed.planStep,
          },
        });

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
    },
    {
      name: "knowledge",
      label: "Knowledge",
      description:
        "Search or read Cortex v2 recalled notes. Search returns metadata only; read pulls a single full entry before acting on it.",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("search"), Type.Literal("read")]),
        query: Type.Optional(Type.String({ description: "Search query for action=search." })),
        id: Type.Optional(Type.String({ description: "Entry id for action=read." })),
        scope: Type.Optional(knowledgeScopeSchema),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      }),
      async execute(_toolCallId, params) {
        if (!host.searchKnowledge || !host.readKnowledgeEntry) {
          throw new Error("Knowledge v2 is not available in this runtime.");
        }
        const parsed = params as {
          action?: "search" | "read";
          query?: string;
          id?: string;
          scope?: "global" | "profile" | "all";
          limit?: number;
        };

        if (parsed.action === "read") {
          if (!parsed.id?.trim()) {
            throw new Error("knowledge read requires id.");
          }
          const entry = await host.readKnowledgeEntry(descriptor.agentId, parsed.id);
          return {
            content: [{ type: "text", text: JSON.stringify(entry, null, 2) }],
            details: entry,
          };
        }

        const results = await host.searchKnowledge(descriptor.agentId, {
          query: parsed.query,
          scope: parsed.scope,
          limit: parsed.limit,
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ results }, null, 2) }],
          details: { results },
        };
      }
    }
  ];

  if (descriptor.role !== "manager") {
    const isInternalCodexPluginWorker = isCodexPluginWorkerDescriptor(descriptor);
    const codexPluginScope = isInternalCodexPluginWorker
      ? host.getCodexPluginScopeForWorker?.(descriptor.agentId)
      : undefined;
    const codexPluginTools = codexPluginScope && host.callCodexPluginScopedTool
      ? buildCodexPluginScopedToolDefinitions({
          scope: codexPluginScope,
          executeScopedTool: (scopedToolName, args) =>
            host.callCodexPluginScopedTool!(descriptor.agentId, scopedToolName, args),
          exportScopedToolResult: host.exportCodexPluginScopedToolResult
            ? (scopedToolName, args, options) =>
                host.exportCodexPluginScopedToolResult!(descriptor.agentId, {
                  scopedToolName,
                  args,
                  ...options,
                })
            : undefined,
        })
      : [];

    const workerBaseTools = isInternalCodexPluginWorker
      ? shared.filter((tool) => tool.name === "send_message_to_agent")
      : shared;

    return [...workerBaseTools, ...codexPluginTools];
  }

  const managerOnly: ToolDefinition[] = [
    buildUpdatePlanTool(host, descriptor),
    {
      name: "spawn_agent",
      label: "Spawn Agent",
      description:
        `Create and start a new worker agent. Prefer tier/lens mode via \`tier\` and optional \`lens\`; legacy \`specialist\` handles remain supported for custom specialists and compatibility. When the assignment maps to one current plan step, pass that step's exact text in planStep. Use ad-hoc archetype/prompt/model overrides only when no tier/lens fits. agentId is required and normalized to lowercase kebab-case; if taken, a numeric suffix (-2, -3, …) is appended. archetypeId, systemPrompt, model, modelId, reasoningLevel, cwd, and initialMessage remain available in ad-hoc mode. model accepts ${SPAWN_PRESET_IDS.join("|")}.`,
      parameters: Type.Object({
        agentId: Type.String({
          description:
            "Required agent identifier. Normalized to lowercase kebab-case; collisions are suffixed numerically."
        }),
        planStep: Type.Optional(
          Type.String({
            description: "Exact text of the current plan step this worker assignment supports. Omit for general or cross-cutting work."
          })
        ),
        specialist: Type.Optional(
          Type.String({
            description:
              "Legacy specialist handle. Builtin handles are rewritten to tier/lens; custom specialist handles still use their saved model/prompt."
          })
        ),
        tier: Type.Optional(
          Type.Union([
            Type.Literal("light"),
            Type.Literal("fast"),
            Type.Literal("standard"),
            Type.Literal("deep"),
            Type.Literal("max"),
          ], {
            description: "Effort tier for the worker: light, fast, standard, deep, or max."
          })
        ),
        lens: Type.Optional(
          Type.String({
            description: "Optional lens id for technique/output-contract guidance, such as planner, researcher, code-reviewer, code-reviewer-2, architect, or codex-plugin."
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
          planStep?: string;
          specialist?: string;
          tier?: "light" | "fast" | "standard" | "deep" | "max";
          lens?: string;
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
          planStep: parsed.planStep,
          specialist: parsed.specialist,
          tier: parsed.tier,
          lens: parsed.lens,
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
        recordToolSideEffect(host, descriptor, {
          toolName: "spawn_agent",
          toolCallId: _toolCallId,
          phase: "side_effect",
          input: spawnInput,
          output: { agentId: spawned.agentId, role: spawned.role, displayName: spawned.displayName },
          metadata: {
            spawnedAgentId: spawned.agentId,
            planStep: spawnInput.planStep,
            specialist: spawnInput.specialist,
            tier: spawnInput.tier,
            lens: spawnInput.lens,
            modelProvider: spawned.model.provider,
            modelId: spawned.model.modelId,
          },
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
      name: "retry_codex_plugin_worker",
      label: "Retry Codex Plugin Worker",
      description:
        "Respawn a Codex Plugin specialist using the last server-owned plugin selector context for this manager. Server-side authorization is valid only during a current user turn that Forge classified as an explicit retry/continuation after a scoped Codex Plugin worker was stopped or failed. Does not accept selectors; ask the user to re-tag @Codex if authorization is unavailable, expired, or the plugin/scope must change.",
      parameters: Type.Object({
        initialMessage: Type.String({ description: "Task/context for the retried Codex Plugin worker." }),
        retryContextId: Type.Optional(
          Type.String({ description: "Optional opaque retry context id from prior retry/export guidance. Selectors are never accepted here." })
        ),
      }),
      async execute(_toolCallId, params) {
        if (!host.retryCodexPluginWorker) {
          throw new Error("Codex Plugin retry is not available in this runtime.");
        }
        const parsed = params as { initialMessage?: string; retryContextId?: string };
        const spawned = await host.retryCodexPluginWorker(descriptor.agentId, {
          initialMessage: parsed.initialMessage ?? "",
          retryContextId: parsed.retryContextId,
        });
        recordToolSideEffect(host, descriptor, {
          toolName: "retry_codex_plugin_worker",
          toolCallId: _toolCallId,
          phase: "side_effect",
          input: parsed,
          output: { agentId: spawned.agentId, role: spawned.role, displayName: spawned.displayName },
          metadata: {
            spawnedAgentId: spawned.agentId,
            specialist: CODEX_PLUGIN_SPECIALIST_ID,
          },
        });
        return {
          content: [
            {
              type: "text",
              text: `Respawned Codex Plugin worker ${spawned.agentId} (${spawned.displayName})`
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
        "Publish a user-visible manager message with explicit routing. Use for non-web targets, routed/protected delivery, proactive external delivery, or cases where server metadata requires explicit target delivery. Do not use merely because a normal Builder turn came from a worker callback; normal web/session closeouts use final assistant text. If target is omitted, delivery defaults to web. For Telegram delivery, set target.channel and target.channelId explicitly.",
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
        recordToolSideEffect(host, descriptor, {
          toolName: "speak_to_user",
          toolCallId: _toolCallId,
          phase: "side_effect",
          input: parsed,
          output: published,
          userVisible: true,
          metadata: {
            targetChannel: published.targetContext.channel,
          },
        });

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
            multiSelect: Type.Optional(
              Type.Boolean({ description: "If true, allow selecting multiple options. Submit button required to confirm." })
            ),
            minSelections: Type.Optional(
              Type.Integer({ description: "Minimum selections required (multi-select only). Default: 0.", minimum: 0 })
            ),
            maxSelections: Type.Optional(
              Type.Integer({ description: "Maximum selections allowed (multi-select only).", minimum: 1 })
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
            multiSelect?: boolean;
            minSelections?: number;
            maxSelections?: number;
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

          recordToolSideEffect(host, descriptor, {
            toolName: "present_choices",
            toolCallId: _toolCallId,
            phase: "side_effect",
            input: parsed,
            output: details,
            userVisible: true,
            metadata: { status: "answered" },
          });

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
            recordToolSideEffect(host, descriptor, {
              toolName: "present_choices",
              toolCallId: _toolCallId,
              phase: "side_effect",
              input: parsed,
              output: details,
              isError: true,
              userVisible: true,
              metadata: { status: "cancelled" },
            });
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
    },
    {
      name: "save_learning",
      label: "Save Learning",
      description:
        "Persist a durable correction, preference, convention, gotcha, or pointer through the Cortex v2 single-writer knowledge store. Do not use for task-local details, secrets, or facts directly derivable from the repository.",
      parameters: Type.Object({
        type: knowledgeEntryTypeSchema,
        scope: Type.Union([
          Type.Literal("global"),
          Type.String({ description: "Use profile:<profileId> for project-scoped knowledge." }),
        ]),
        title: Type.String({ description: "One-line durable claim title." }),
        body: Type.String({ description: "Short markdown body, capped by the writer at 120 tokens." }),
        evidence: Type.Union([Type.Literal("user-stated"), Type.Literal("observed")]),
      }),
      async execute(_toolCallId, params) {
        if (!host.saveLearning) {
          throw new Error("Knowledge v2 save_learning is not available in this runtime.");
        }
        const parsed = params as {
          type: "preference" | "convention" | "gotcha" | "pointer";
          scope: "global" | `profile:${string}`;
          title: string;
          body: string;
          evidence: "user-stated" | "observed";
        };
        const entry = await host.saveLearning(descriptor.agentId, parsed);
        const details = {
          id: entry.frontmatter.id,
          version: entry.frontmatter.version,
          scope: entry.frontmatter.scope,
          support_count: entry.frontmatter.support_count,
        };
        recordToolSideEffect(host, descriptor, {
          toolName: "save_learning",
          toolCallId: _toolCallId,
          phase: "side_effect",
          input: parsed,
          output: details,
          metadata: details,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(details) }],
          details,
        };
      },
    },
  ];

  return [...shared, ...managerOnly];
}
