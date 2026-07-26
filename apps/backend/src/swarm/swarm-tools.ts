import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getSpawnPresetFamilies } from "@forge/protocol";
import { ChoiceRequestCancelledError } from "./swarm-choice-service.js";
import type { SwarmToolHost } from "./swarm-tool-host.js";
import {
  buildCodexPluginScopedToolDefinitions,
  CODEX_PLUGIN_SPECIALIST_ID,
  isCodexPluginWorkerDescriptor,
} from "./codex-app-server/codex-plugin-scope-service.js";
import {
  type AgentDescriptor,
  type RequestedDeliveryMode,
  type SpawnAgentInput
} from "./types.js";
import { buildUpdatePlanTool } from "./planning/update-plan-tool.js";
import { buildUpdateWorkGraphTool } from "./planning/update-work-graph-tool.js";
import { buildGoalTools } from "./goals/goal-tools.js";
import { buildSecureSessionTools } from "./secure-sessions/secure-session-tools.js";
import {
  resolveManagerDelegation,
  translateManagerDelegationError,
  WORKER_BEHAVIOR_MODES,
  WORKER_EXECUTION_POLICIES,
} from "./specialists/delegation-policy.js";

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
      "Reasoning effort level. 'none'/'low' for simple tasks, 'medium' for balanced, 'high'/'xhigh' for complex analysis, and GPT-5.6 Sol additionally supports 'max' and 'ultra'. Native Anthropic Claude models support their catalog-declared reasoning levels."
  }
);

const speakToUserTargetSchema = Type.Object({
  channel: Type.Literal("web"),
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

const workerBehaviorModeSchema = Type.Union(
  WORKER_BEHAVIOR_MODES.map((mode) => Type.Literal(mode)),
);

const workerExecutionPolicySchema = Type.Union(
  WORKER_EXECUTION_POLICIES.map((policy) => Type.Literal(policy)),
);

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
  const secureSessionTools = buildSecureSessionTools(host, descriptor);
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
        "Send a message to another agent by id. Returns immediately with a delivery receipt. If target is busy, queued delivery is accepted as steer. When assigning or reassigning a worker to one current plan step, pass that step's exact text in planStep. Set requiresSecureRuntime=true when this assignment needs granted Secure Sessions material; Forge fails closed before delivery if the target cannot use the secure boundary.",
      parameters: Type.Object({
        targetAgentId: Type.String({ description: "Agent id to receive the message." }),
        message: Type.String({ description: "Message text to deliver." }),
        delivery: Type.Optional(deliveryModeSchema),
        planStep: Type.Optional(Type.String({
          description: "Exact text of the current plan step this worker assignment supports. Omit for general or cross-cutting work."
        })),
        requiresSecureRuntime: Type.Optional(Type.Boolean({
          description:
            "Require Secure Sessions for this assignment and reject it before delivery if the target worker cannot use a secure runtime.",
        })),
      }),
      async execute(_toolCallId, params) {
        const parsed = params as {
          targetAgentId: string;
          message: string;
          delivery?: RequestedDeliveryMode;
          planStep?: string;
          requiresSecureRuntime?: boolean;
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
            ...(parsed.requiresSecureRuntime
              ? { requiresSecureRuntime: true }
              : {}),
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
            requiresSecureRuntime: parsed.requiresSecureRuntime,
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

    const workerBaseTools = shared.filter((tool) => tool.name === "knowledge");

    return [...workerBaseTools, ...secureSessionTools, ...codexPluginTools];
  }

  const managerOnly: ToolDefinition[] = [
    buildUpdateWorkGraphTool(host, descriptor),
    buildUpdatePlanTool(host, descriptor),
    ...buildGoalTools(host, descriptor),
    {
      name: "spawn_agent",
      label: "Spawn Agent",
      description:
        "Delegate a concrete task to an independent worker. Choose a behavior mode for the output contract and an execution policy for model cost/capability. Defaults are mode=general and executionPolicy=routine; plan and review modes default to deep, but any mode can use support for bounded low-risk work. Set requiresSecureRuntime=true when the assignment must use granted Secure Sessions material; Forge selects a compatible configured fallback and fails closed rather than dispatching insecurely. Use customSpecialist only for a saved custom specialist, without mode or executionPolicy. The call returns after the assignment is accepted.",
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
        mode: Type.Optional(workerBehaviorModeSchema),
        executionPolicy: Type.Optional(workerExecutionPolicySchema),
        customSpecialist: Type.Optional(
          Type.String({ description: "Saved custom specialist handle. Mutually exclusive with mode and executionPolicy." })
        ),
        cwd: Type.Optional(Type.String({ description: "Optional working directory override." })),
        requiresSecureRuntime: Type.Optional(
          Type.Boolean({
            description:
              "Require Secure Sessions for this worker's initial assignment. Fails closed if Team Secure Mode or a compatible secure runtime is unavailable.",
          }),
        ),
        initialMessage: Type.String({ description: "Concrete task and expected outcome for the worker." }),
      }),
      async execute(_toolCallId, params) {
        const parsed = params as {
          agentId: string;
          planStep?: string;
          mode?: "general" | "plan" | "correctness-review" | "design-review" | "research";
          executionPolicy?: "support" | "routine" | "deep";
          customSpecialist?: string;
          cwd?: string;
          requiresSecureRuntime?: boolean;
          initialMessage: string;
        };

        const resolvedDelegation = resolveManagerDelegation(parsed);
        const spawnInput = resolvedDelegation.spawnInput;

        let spawned: AgentDescriptor;
        try {
          spawned = await host.spawnAgent(descriptor.agentId, spawnInput);
        } catch (error) {
          throw translateManagerDelegationError(error, resolvedDelegation);
        }
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
            requestedMode: resolvedDelegation.requestedMode,
            requestedExecutionPolicy: resolvedDelegation.requestedExecutionPolicy,
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
      name: "delegate_codex_plugin",
      label: "Delegate to Codex Plugin",
      description:
        "Delegate a task using the server-owned Codex Plugin selector context attached to the current user turn. Selectors and scope are never accepted from the model; ask the user to tag @Codex again when no current context is available.",
      parameters: Type.Object({
        initialMessage: Type.String({ description: "Concrete read-only task for the selected Codex Plugin context." }),
        planStep: Type.Optional(
          Type.String({ description: "Exact text of the current plan step this worker assignment supports." }),
        ),
      }),
      async execute(_toolCallId, params) {
        const parsed = params as { initialMessage: string; planStep?: string };
        const spawnInput: SpawnAgentInput = {
          agentId: CODEX_PLUGIN_SPECIALIST_ID,
          specialist: CODEX_PLUGIN_SPECIALIST_ID,
          initialMessage: parsed.initialMessage,
          planStep: parsed.planStep,
        };
        const spawned = await host.spawnAgent(descriptor.agentId, spawnInput);
        recordToolSideEffect(host, descriptor, {
          toolName: "delegate_codex_plugin",
          toolCallId: _toolCallId,
          phase: "side_effect",
          input: parsed,
          output: { agentId: spawned.agentId, role: spawned.role, displayName: spawned.displayName },
          metadata: {
            spawnedAgentId: spawned.agentId,
            specialist: CODEX_PLUGIN_SPECIALIST_ID,
            planStep: parsed.planStep,
          },
        });
        return {
          content: [
            {
              type: "text",
              text: `Delegated to Codex Plugin worker ${spawned.agentId} (${spawned.displayName})`,
            },
          ],
          details: spawned,
        };
      },
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
        "Publish a user-visible manager message to the current web session. Do not use merely because a normal Builder turn contains a worker result; normal web/session closeouts use final assistant text. The optional target may only explicitly select web delivery.",
      parameters: Type.Object({
        text: Type.String({ description: "Message content to show to the user." }),
        target: Type.Optional(speakToUserTargetSchema)
      }),
      async execute(_toolCallId, params) {
        const parsed = params as {
          text: string;
          target?: { channel: "web" };
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
          userVisible: published.published !== false,
          metadata: {
            targetChannel: published.targetContext.channel,
          },
        });

        return {
          content: [
            {
              type: "text",
              text: published.published === false
                ? "Message not published because a newer user message superseded this turn. Respond to the newer message instead."
                : `Published message to user (${published.targetContext.channel}).`
            }
          ],
          details: {
            published: published.published !== false,
            targetContext: published.targetContext,
            ...(published.reason ? { reason: published.reason } : {}),
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

  return [...shared, ...secureSessionTools, ...managerOnly];
}
