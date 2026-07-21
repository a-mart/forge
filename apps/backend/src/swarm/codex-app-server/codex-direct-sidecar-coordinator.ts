import type {
  AgentDescriptor,
  ConversationAttachment,
  MessageSourceContext,
} from "../types.js";
import { isReservedProjectAgentHandle } from "../agents/project-agent-registry.js";
import { isExternalThreadDescriptor } from "../external-thread-compatibility.js";
import { CodexAppServerService } from "./codex-app-server-service.js";
import {
  classifyCodexUserMessage,
  isBuilderWebCodexRoutingSurface,
  parseLeadingCodexMention,
} from "./codex-mention-router.js";
import {
  createCodexSidecarHostAdapter,
  type CodexSidecarHostAdapterDeps,
} from "./codex-sidecar-host-adapter.js";
import { truncateCodexPreview } from "./codex-sidecar-parent-cards.js";
import {
  CodexSidecarBusyError,
  type CodexAppServerServiceOptions,
} from "./types.js";
import type { CodexPendingElicitation, CodexElicitationDecision, CodexElicitationPersistScope } from "./codex-elicitation-broker.js";

export type CodexDirectSidecarManager = AgentDescriptor & {
  role: "manager";
  profileId: string;
};

export interface CodexDirectSidecarCoordinatorHost
  extends Omit<CodexSidecarHostAdapterDeps, "appendConversationEntry"> {
  listSessionsForProfile(profileId: string): AgentDescriptor[];
  scheduleProjectExecutableTrustPrompt(manager: AgentDescriptor & { role: "manager" }): void;
  markSessionActivity(agentId: string, timestamp: string): void;
  markSessionUserMessageActivity(agentId: string, timestamp: string): void;
  emitCodexElicitation?(event: CodexPendingElicitation): void;
  dismissCodexElicitation?(elicitationId: string, managerAgentId: string): void;
}

export interface CodexDirectSidecarCoordinatorOptions {
  dataDir: string;
  host: CodexDirectSidecarCoordinatorHost;
  codexAppServerService?: CodexAppServerService;
  codexAppServerServiceOptions?: CodexAppServerServiceOptions;
}

export interface CodexDirectSidecarRouteInput {
  target: AgentDescriptor;
  text: string;
  attachments: ConversationAttachment[];
  sourceContext: MessageSourceContext;
}

/**
 * Owns direct Codex app-server sidecar creation, routing, and lifecycle seams.
 * Plugin-scoped Codex delegation remains owned by CodexPluginDelegationCoordinator.
 */
export class CodexDirectSidecarCoordinator {
  readonly appServerService: CodexAppServerService;

  constructor(private readonly options: CodexDirectSidecarCoordinatorOptions) {
    const { host } = options;
    this.appServerService =
      options.codexAppServerService ??
      new CodexAppServerService(
        createCodexSidecarHostAdapter({
          now: host.now,
          logDebug: host.logDebug,
          getDescriptor: host.getDescriptor,
          upsertDescriptor: host.upsertDescriptor,
          saveStore: host.saveStore,
          ensureSessionFileParentDirectory: host.ensureSessionFileParentDirectory,
          appendConversationEntry: (_agentId, entry) => {
            if (entry.type !== "conversation_message") {
              host.logDebug("codex_sidecar:unsupported_append_entry", { entryType: entry.type });
              return;
            }

            host.emitConversationMessage(entry);
          },
          emitConversationMessage: host.emitConversationMessage,
          emitConversationLog: host.emitConversationLog,
          emitAgentMessage: host.emitAgentMessage,
          emitAgentToolCall: host.emitAgentToolCall,
          emitStatus: host.emitStatus,
          emitAgentsSnapshot: host.emitAgentsSnapshot,
          emitProfilesSnapshot: host.emitProfilesSnapshot,
          listWorkersForSession: host.listWorkersForSession,
          emitCodexElicitation: host.emitCodexElicitation,
          dismissCodexElicitation: host.dismissCodexElicitation,
        }),
        {
          dataDir: options.dataDir,
          ...options.codexAppServerServiceOptions,
        },
      );
  }

  isSidecarDescriptor(descriptor: AgentDescriptor): boolean {
    return isExternalThreadDescriptor(descriptor);
  }

  interruptTurn(agentId: string): Promise<void> {
    return this.appServerService.interruptTurn(agentId);
  }

  cleanupTurnStateForTermination(agentId: string): Promise<void> {
    return this.appServerService.cleanupSidecarTurnStateForTermination(agentId);
  }

  respondToElicitation(input: {
    elicitationId: string;
    managerAgentId: string;
    decision: CodexElicitationDecision;
    values?: Record<string, unknown>;
    persistScope?: CodexElicitationPersistScope;
  }): boolean {
    return this.appServerService.respondToElicitation(input);
  }

  getPendingElicitationsForManager(managerAgentId: string) {
    return this.appServerService.getPendingElicitationsForManager(managerAgentId);
  }

  assertMentionRoutingAvailable(manager: CodexDirectSidecarManager): void {
    const conflictingProjectAgent = this.options.host
      .listSessionsForProfile(manager.profileId)
      .find(
        (descriptor) =>
          typeof descriptor.projectAgent?.handle === "string" &&
          isReservedProjectAgentHandle(descriptor.projectAgent.handle),
      );
    if (!conflictingProjectAgent) {
      return;
    }

    throw new Error(
      'Codex @mention routing is unavailable because project agent handle "codex" is already in use in this profile. Rename that project agent and try again.',
    );
  }

  async maybeRouteUserMessage(input: CodexDirectSidecarRouteInput): Promise<boolean> {
    const { target, text, attachments, sourceContext } = input;
    if (isExternalThreadDescriptor(target)) {
      const manager = this.options.host.getDescriptor(target.managerId);
      if (!manager || manager.role !== "manager") {
        throw new Error(`Codex sidecar ${target.agentId} is missing its parent manager session.`);
      }
      if (!isBuilderWebCodexRoutingSurface(sourceContext, manager)) {
        throw new Error("Selected Codex sidecar only accepts direct sends from Builder web sessions.");
      }
      if (attachments.length > 0) {
        throw new Error("Codex sidecar messages support text only in this version.");
      }
      if (!text) {
        throw new Error("Codex sidecar message text must not be empty.");
      }

      this.options.host.scheduleProjectExecutableTrustPrompt(
        manager as AgentDescriptor & { role: "manager" },
      );
      await this.routeUserMessage(manager, target, text, sourceContext, {
        emitParentRequestCard: false,
      });
      return true;
    }

    if (target.role !== "manager" || !isBuilderWebCodexRoutingSurface(sourceContext, target)) {
      return false;
    }

    const classification = classifyCodexUserMessage(text);
    if (classification.kind === "plugin_delegate") {
      return false;
    }

    const mentionRoute = parseLeadingCodexMention(text);
    if (!mentionRoute.routed) {
      return false;
    }

    const manager = target as CodexDirectSidecarManager;
    this.assertMentionRoutingAvailable(manager);
    if (attachments.length > 0) {
      throw new Error("Codex @mention routing supports text-only messages in this version.");
    }
    if (!mentionRoute.strippedText) {
      throw new Error("Add a message after @Codex to send it to Codex app-server.");
    }

    this.options.host.scheduleProjectExecutableTrustPrompt(manager);
    const sidecar = await this.appServerService.getOrCreateSidecarDescriptor(manager);
    await this.routeUserMessage(manager, sidecar, mentionRoute.strippedText, sourceContext, {
      emitParentRequestCard: true,
    });
    return true;
  }

  private async routeUserMessage(
    manager: AgentDescriptor,
    sidecar: AgentDescriptor,
    text: string,
    sourceContext: MessageSourceContext,
    options: { emitParentRequestCard: boolean },
  ): Promise<void> {
    this.options.host.logDebug("codex_sidecar:user_message_route", {
      managerAgentId: manager.agentId,
      sidecarAgentId: sidecar.agentId,
      sourceContext,
      emitParentRequestCard: options.emitParentRequestCard,
      textPreview: previewForLog(text),
    });

    try {
      await this.appServerService.sendTextTurn(sidecar.agentId, text, {
        promptPreview: truncateCodexPreview(text),
        parentRouting: {
          managerAgentId: manager.agentId,
          emitParentRequestCard: options.emitParentRequestCard,
          sourceContext,
        },
      });
      const routedAt = this.options.host.now();
      this.options.host.markSessionActivity(manager.agentId, routedAt);
      this.options.host.markSessionUserMessageActivity(manager.agentId, routedAt);
    } catch (error) {
      if (error instanceof CodexSidecarBusyError) {
        throw new Error("Codex is busy with an active turn. Stop the current turn or wait for it to finish.");
      }
      throw error;
    }
  }
}

function previewForLog(text: string, maxLength = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength)}...`;
}
