import { isNonRunningAgentStatus } from "./agent-state-machine.js";
import {
  formatAgentCreatorContextMessage,
  gatherAgentCreatorContext,
} from "./agent-creator-context.js";
import type { AgentMessageSendOptions } from "./agent-message-dispatcher.js";
import type { PromptCategory, PromptRegistry } from "./prompt-registry.js";
import type {
  AgentDescriptor,
  RequestedDeliveryMode,
  SendMessageReceipt,
} from "./types.js";

const MANAGER_BOOTSTRAP_INTERVIEW_MESSAGE = `You are a newly created manager agent for this specific project/profile.

Cortex may already have captured durable cross-project user defaults such as preferred name, technical level, and response preferences.
If an onboarding snapshot or onboarding-derived summary is present in injected context, treat that as authoritative over any rendered natural-language copy.

Do NOT re-run a generic user onboarding interview.
Do NOT ask broad user-level questions like:
- what they like to be called
- whether they prefer concise or detailed responses in general
- whether they prefer autonomy or collaboration in general
- what explanation depth they want in general
unless that information is truly missing and directly necessary for the immediate work.

Important honesty rule:
- If onboarding defaults are actually present, you may briefly acknowledge that you already have a baseline sense of how they like to work.
- If onboarding was skipped, is still pending, or is effectively empty, do NOT imply that you already know their preferences.
- In that case, stay project-focused and let Cortex handle cross-project preferences later.

Your first job is to orient to THIS project.

Send a warm welcome. Then run a short, practical, project bootstrap conversation focused on:
1. What they are building or trying to accomplish here.
2. Which repo, directory, or codebase is the source of truth.
3. The project stack and architecture, if not obvious from files.
4. Validation commands and quality gates.
5. Repo-specific conventions, constraints, workflows, or guardrails.
6. Docs or guidance you should read first.
7. What they want to do first.

Keep this conversational, not checklist-like.
Ask only the next most useful question.
If the user arrives with a concrete task, get enough bootstrap context to work safely, then move into execution.

Prefer repo inspection over interrogation.
Start by reading these in order when they exist and are relevant:
1. AGENTS.md / SWARM.md / repo-specific agent instructions
2. README.md or top-level docs for project overview
3. package.json / pnpm-workspace.yaml / pyproject.toml / Cargo.toml / go.mod / equivalent manifests
4. build, test, lint, typecheck, or task-runner config
5. CONTRIBUTING.md, docs/DEVELOPMENT.md, or similar contributor guidance

Ask the user only for what you cannot infer confidently from those materials.
Distinguish durable repo conventions from one-off task details.
Do not collapse project-specific rules into cross-project user defaults.

Useful first-message shapes:
- If onboarding defaults are present: "Hi - I already have a baseline sense of how you like to work, so I'll focus on this project. What are we building here, and which repo or directory should I treat as the source of truth?"
- If onboarding defaults are absent: "Hi - I'll focus on getting oriented to this project. What are we building here, and which repo or directory should I treat as the source of truth?"

Do not include the old generic "how do you like to work" interview.
This manager's onboarding is about the project, not the person.`;

const IDLE_WORKER_WATCHDOG_MESSAGE_TEMPLATE = `⚠️ [IDLE WORKER WATCHDOG — BATCHED]

\${WORKER_COUNT} \${WORKER_WORD} went idle without reporting this turn.
Workers: \${WORKER_IDS}

Use list_agents({"verbose":true,"limit":50,"offset":0}) for a paged full list.`;

export interface ManagerBootstrapCoordinatorOptions {
  dataDir: string;
  descriptors: ReadonlyMap<string, AgentDescriptor>;
  promptRegistry: Pick<PromptRegistry, "resolve">;
  hasRuntime(agentId: string): boolean;
  sendMessage(
    fromAgentId: string,
    targetAgentId: string,
    message: string,
    delivery?: RequestedDeliveryMode,
    options?: AgentMessageSendOptions,
  ): Promise<SendMessageReceipt>;
  logDebug(message: string, details?: unknown): void;
}

/** Owns manager onboarding, agent-creator seed injection, and prompt fallback policy. */
export class ManagerBootstrapCoordinator {
  constructor(private readonly options: ManagerBootstrapCoordinatorOptions) {}

  async sendManagerBootstrapMessage(managerId: string): Promise<void> {
    const manager = this.options.descriptors.get(managerId);
    if (!manager || manager.role !== "manager") {
      return;
    }

    if (isNonRunningAgentStatus(manager.status)) {
      return;
    }

    if (!this.options.hasRuntime(managerId)) {
      return;
    }

    const profileId = manager.profileId ?? manager.agentId;

    await this.resolvePromptWithFallback(
      "operational",
      "idle-watchdog",
      profileId,
      IDLE_WORKER_WATCHDOG_MESSAGE_TEMPLATE,
    );

    try {
      const bootstrapMessage = await this.resolvePromptWithFallback(
        "operational",
        "bootstrap",
        profileId,
        MANAGER_BOOTSTRAP_INTERVIEW_MESSAGE,
      );
      await this.options.sendMessage(managerId, managerId, bootstrapMessage, "auto", {
        origin: "internal",
        internalDeliveryKind: "bootstrap",
      });
      this.options.logDebug("manager:bootstrap_message:sent", { managerId });
    } catch (error) {
      this.options.logDebug("manager:bootstrap_message:error", {
        managerId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async injectAgentCreatorContext(sessionAgentId: string, profileId: string): Promise<void> {
    try {
      const sources = await gatherAgentCreatorContext(
        this.options.dataDir,
        profileId,
        this.options.descriptors.values(),
        sessionAgentId,
      );
      const contextText = formatAgentCreatorContextMessage(sources);

      if (!contextText.trim()) {
        this.options.logDebug("agent_creator:context:empty", { sessionAgentId, profileId });
        return;
      }

      await this.options.sendMessage(sessionAgentId, sessionAgentId, contextText, "auto", {
        origin: "internal",
        internalDeliveryKind: "agent_creator_bootstrap",
      });
      this.options.logDebug("agent_creator:context:injected", {
        sessionAgentId,
        profileId,
        agentCount: sources.existingAgents.length,
        recentSessionCount: sources.recentSessions.length,
      });
    } catch (error) {
      this.options.logDebug("agent_creator:context:error", {
        sessionAgentId,
        profileId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async resolvePromptWithFallback(
    category: PromptCategory,
    promptId: string,
    profileId: string | undefined,
    fallback: string,
  ): Promise<string> {
    try {
      return await this.options.promptRegistry.resolve(category, promptId, profileId);
    } catch (error) {
      this.options.logDebug("prompt:resolve:fallback", {
        category,
        promptId,
        profileId,
        message: error instanceof Error ? error.message : String(error),
      });
      return fallback;
    }
  }
}
