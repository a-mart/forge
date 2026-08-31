import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import {
  isRetiredMessageSource,
  isTerminalAssistantConversationMessage,
  type BrowserHostConnectionSnapshot,
  type BrowserSessionSnapshot,
  type CollaborationStatus,
  type ServerEvent,
  type TerminalClosedEvent,
  type TerminalCreatedEvent,
  type TerminalUpdatedEvent,
} from "@forge/protocol";
import { WebSocketServer } from "ws";

import { BUILDER_PROTOCOL_VERSION } from "@forge/protocol";
import { MobilePushService } from "../mobile/mobile-push-service.js";
import { getForgeAppVersion } from "../utils/app-version.js";
import {
  authenticateRequest,
  classifyCollaborationHttpRequest,
  evaluateCollaborationAdminAccess,
  evaluateCollaborationMemberAccess,
  evaluateCollaborationPasswordChangeAccess,
  resolveCollaborationAuthContextForUserId,
  setCollaborationRequestAuthContext,
  setCollaborationRequestCorsContext,
  setCollaborationSocketAuthContext,
  validateCollaborationHttpOrigin,
  type CollaborationAuthContext,
} from "../collaboration/auth/collaboration-auth-middleware.js";
import { getOrCreateCollaborationBetterAuthService } from "../collaboration/auth/better-auth-service.js";
import type { CollaborationReadinessRequestService } from "../collaboration/readiness-service.js";
import { RemoteBuildSettingsService } from "../collaboration/remote-build-settings-service.js";
import type { CollaborationSettingsService } from "../collaboration/settings-service.js";

import {
  getControlPidFilePath,
  readControlPidFromFile,
  readDaemonizedEnv
} from "../reboot/control-pid.js";
import {
  CortexAutoReviewSettingsService
} from "../swarm/cortex-auto-review-settings.js";
import { BuilderSidebarOrderService } from "../swarm/builder-sidebar-order-service.js";
import { CompactionSettingsService } from "../swarm/compaction-settings-service.js";
import { KnowledgeV2SettingsService } from "../swarm/knowledge-v2-settings-service.js";
import { CliAccessService, readCliApiKeyEnv } from "../swarm/cli-access-service.js";
import { StreamDeckAccessService } from "../swarm/stream-deck-access-service.js";
import { SecureBrowserAccessService } from "../swarm/secure-browser-access-service.js";
import {
  NotificationSettingsService,
  isCliOriginatedSession,
} from "../swarm/notification-settings-service.js";
import { isPidAlive } from "../swarm/platform.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import type { BrowserAutomationService } from "../swarm/browser-automation/index.js";
import { isCollabSession } from "../swarm/swarm-manager-utils.js";
import { UnreadTracker } from "../swarm/unread-tracker.js";
import { isBuilderRuntimeTarget } from "../runtime-target.js";
import { createNoopObservabilityFacade } from "../observability/noop-observability.js";
import type { ObservabilityFacade } from "../observability/observability-types.js";
import { FeedbackService } from "../swarm/feedback-service.js";
import { PresentedChatArtifactTicketStore } from "../swarm/session/presented-chat-artifact.js";
import {
  validateSecureBuilderControlOrigin,
  validateSecureBuilderControlCapability,
  validateTerminalWsOrigin,
} from "../terminal/terminal-access-policy.js";

import {
  authenticateCliWebSocketRequest,
  isCliHttpPath,
  isCliWebSocketPath,
} from "./cli-auth.js";
import { applyCorsHeaders, resolveRequestUrl, sendJson } from "./http-utils.js";
import { createAgentHttpRoutes } from "./http/routes/agent-http-routes.js";
import { createBuilderSidebarOrderRoutes } from "./http/routes/builder-sidebar-order-routes.js";
import { createChatArtifactRoutes } from "./http/routes/chat-artifact-routes.js";
import { createCodexCatalogRoutes } from "./http/routes/codex-catalog-routes.js";
import { createCliAccessSettingsRoutes } from "./http/routes/cli-access-settings-routes.js";
import { createCliRoutes } from "./http/routes/cli-routes.js";
import { createStreamDeckRoutes } from "./http/routes/stream-deck-routes.js";
import { createStreamDeckPairingRoutes } from "./http/routes/stream-deck-pairing-routes.js";
import { createCollaborationRoutes } from "./http/routes/collaboration-routes.js";
import { createCortexAutoReviewRoutes } from "./http/routes/cortex-auto-review-routes.js";
import { createCompactionSettingsRoutes } from "./http/routes/compaction-settings-routes.js";
import { createCortexRoutes } from "./http/routes/cortex-routes.js";
import { createDebugRoutes } from "./http/routes/debug-routes.js";
import { createExtensionRoutes } from "./http/routes/extension-routes.js";
import { createFeedbackRoutes } from "./http/routes/feedback-routes.js";
import { createFileBrowserRoutes } from "./http/routes/file-browser-routes.js";
import { createFileRoutes } from "./http/routes/file-routes.js";
import { createGitDiffRoutes } from "./http/routes/git-diff-routes.js";
import { createGitSourceControlRoutes } from "./http/routes/git-source-control-routes.js";
import { createRemoteUpdateAwarenessRoutes } from "./http/routes/remote-update-awareness-routes.js";
import { createHealthRoutes } from "./http/routes/health-routes.js";
import { createKnowledgeV2SettingsRoutes } from "./http/routes/knowledge-v2-settings-routes.js";
import { createMermaidPreviewRoutes } from "./http/routes/mermaid-preview-routes.js";
import { createMobileRoutes } from "./http/routes/mobile-routes.js";
import { createModelConfigRoutes } from "./http/routes/model-config-routes.js";
import { createOpenRouterRoutes } from "./http/routes/openrouter-routes.js";
import { createProjectResourceRoutes } from "./http/routes/project-resource-routes.js";
import { createRemoteBuildSettingsRoutes } from "./http/routes/remote-build-settings-routes.js";
import { createPhoenixObservabilityRoutes } from "./http/routes/phoenix-observability-routes.js";
import { createPromptRoutes } from "./http/routes/prompt-routes.js";
import { createRestartRecoveryRoutes } from "./http/routes/restart-recovery-routes.js";
import { createSchedulerRoutes } from "./http/routes/scheduler-routes.js";
import { createSessionAuditRoutes } from "./http/routes/session-audit-routes.js";
import {
  createSecureSecretRoutes,
  isDesktopOnlySecureSecretPath,
  type SecureSecretTransportService,
} from "./http/routes/secure-secret-routes.js";
import {
  createSecureSessionRoutes,
  isWebSafeSecureAccessRequestDismissal,
  type SecureSessionsTransportService,
} from "./http/routes/secure-session-routes.js";
import {
  createSecureBrowserControlRoutes,
  isDesktopOnlySecureBrowserPath,
  isPublicSecureBrowserPairingPath,
  isSecureBrowserControlPath,
  isSecureBrowserStatusPath,
  readSecureBrowserCookie,
  setSecureBrowserRequestDevice,
  type SecureBrowserVaultService,
} from "./http/routes/secure-browser-control-routes.js";
import { createSettingsRoutes, type SettingsRouteBundle } from "./http/routes/settings-routes.js";
import { createSkillRoutes } from "./http/routes/skill-routes.js";
import { createSlashCommandRoutes } from "./http/routes/slash-command-routes.js";
import { createSpecialistRoutes } from "./http/routes/specialist-routes.js";
import { createModelCacheVisualizationRoutes } from "./http/routes/model-cache-visualization-routes.js";
import { createRepositorySettingsRoutes } from "./http/routes/repository-settings-routes.js";
import { createStatsRoutes } from "./http/routes/stats-routes.js";
import { RepositorySettingsService } from "../swarm/repository-settings-service.js";
import { RepositoryProjectCreationService } from "../swarm/repository-project-creation-service.js";
import { createStaticUiRoutes } from "./http/routes/static-ui-routes.js";
import { createTelemetryRoutes } from "./http/routes/telemetry-routes.js";
import { createTerminalRoutes } from "./http/routes/terminal-routes.js";
import { createTranscriptionRoutes } from "./http/routes/transcription-routes.js";
import type { HttpRoute } from "./http/shared/http-route.js";
import type { PromptRegistryForRoutes } from "../swarm/prompt-contracts.js";
import { STATS_CACHE_TTL_MS, StatsService } from "../stats/stats-service.js";
import { TokenAnalyticsService } from "../stats/token-analytics-service.js";
import { GenerationThroughputService } from "../stats/generation-throughput-service.js";
import type { TelemetryService } from "../telemetry/telemetry-service.js";
import { LocalRemoteUpdateAwarenessService } from "./http/services/remote-update-awareness-service.js";

export const MAX_WS_INCOMING_PAYLOAD_BYTES = 8 * 1024 * 1024;
import type { TerminalRuntimeConfig } from "../terminal/terminal-config.js";
import { TerminalSettingsService } from "../terminal/terminal-settings-service.js";
import type { TerminalService } from "../terminal/terminal-service.js";
import { TerminalWsProxy } from "../terminal/terminal-ws-proxy.js";
import { resolveSessionAgentIdForUnread } from "./unread-utils.js";
import { CliWsHandler } from "./cli-ws-handler.js";
import { WsHandler } from "./ws-handler.js";

function isSecureBuilderControlPath(pathname: string): boolean {
  return (
    pathname === "/api/secure-secrets"
    || pathname.startsWith("/api/secure-secrets/")
    || pathname === "/api/secure-sessions"
    || pathname.startsWith("/api/secure-sessions/")
    || isSecureBrowserControlPath(pathname)
  );
}

export class SwarmWebSocketServer {
  private readonly swarmManager: SwarmManager;
  private readonly host: string;
  private readonly port: number;
  private actualPort: number | null = null;
  private readonly cortexAutoReviewSettingsService: CortexAutoReviewSettingsService;
  private readonly builderSidebarOrderService: BuilderSidebarOrderService | null;
  private readonly knowledgeV2SettingsService: KnowledgeV2SettingsService | null;
  private readonly compactionSettingsService: CompactionSettingsService | null;
  private readonly repositorySettingsService: RepositorySettingsService | null;
  private readonly repositoryProjectCreationService: RepositoryProjectCreationService | null;
  private readonly terminalService: TerminalService | null;
  private readonly terminalRuntimeConfig: TerminalRuntimeConfig | null;
  private readonly terminalSettingsService: TerminalSettingsService;
  private readonly terminalWsProxy: TerminalWsProxy | null;
  private readonly unreadTracker: UnreadTracker;
  private readonly notificationSettingsService: NotificationSettingsService;
  private readonly remoteBuildSettingsService: RemoteBuildSettingsService;
  private readonly remoteUpdateAwarenessService: LocalRemoteUpdateAwarenessService | null;

  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private cliWss: WebSocketServer | null = null;

  private readonly wsHandler: WsHandler;
  private readonly cliWsHandler: CliWsHandler;
  private readonly cliAccessService: CliAccessService;
  private readonly streamDeckAccessService: StreamDeckAccessService;
  private readonly secureBrowserAccessService: SecureBrowserAccessService;
  private readonly mobilePushService: MobilePushService;
  private readonly settingsRoutes: SettingsRouteBundle;
  private readonly statsService: StatsService;
  private readonly tokenAnalyticsService: TokenAnalyticsService;
  private readonly generationThroughputService: GenerationThroughputService;
  private readonly telemetryService: TelemetryService | null;
  private readonly observabilityService: ObservabilityFacade;
  private readonly feedbackService: FeedbackService;
  private readonly collaborationSettingsService: CollaborationSettingsService | null;
  private readonly collaborationReadinessService: CollaborationReadinessRequestService | null;
  private readonly httpRoutes: HttpRoute[];
  private readonly controlPidFile: string;
  private readonly shouldManageControlPid: boolean;
  private readonly secureControlToken: string;

  private statsRefreshInterval: NodeJS.Timeout | null = null;
  private tokenAnalyticsRefreshInterval: NodeJS.Timeout | null = null;
  private generationThroughputRefreshInterval: NodeJS.Timeout | null = null;

  private ownsControlPidFile = false;

  private readonly onConversationMessage = (event: ServerEvent): void => {
    if (event.type !== "conversation_message" || isRetiredMessageSource(event.sourceContext)) return;
    this.wsHandler.broadcastToSubscribed(event);
    this.cliWsHandler.broadcast(event);
    this.wsHandler.broadcastCollaborationConversationMessage(event);

    const triggersUnread =
      isTerminalAssistantConversationMessage(event) ||
      event.source === "project_agent_input";

    if (triggersUnread) {
      void this.handleUnreadTrigger(event.agentId, "message");
    }
  };

  private readonly onConversationLog = (event: ServerEvent): void => {
    if (event.type !== "conversation_log") return;
    this.wsHandler.broadcastToSubscribed(event);
    this.cliWsHandler.broadcast(event);
  };

  private readonly onActivitySummary = (event: ServerEvent): void => {
    if (event.type !== "activity_summary") return;
    this.wsHandler.broadcastToSubscribed(event);
    this.cliWsHandler.broadcast(event);
  };

  private readonly onPlanSummary = (event: ServerEvent): void => {
    if (event.type !== "plan_summary") return;
    this.wsHandler.broadcastToSubscribed(event);
    this.cliWsHandler.broadcast(event);
  };

  private readonly onAgentMessage = (event: ServerEvent): void => {
    if (event.type !== "agent_message") return;
    this.wsHandler.broadcastToSubscribed(event);
    this.cliWsHandler.broadcast(event);
    this.wsHandler.broadcastCollaborationAgentMessage(event);
  };

  private readonly onAgentToolCall = (event: ServerEvent): void => {
    if (event.type !== "agent_tool_call") return;
    this.wsHandler.broadcastToSubscribed(event);
    this.cliWsHandler.broadcast(event);
    this.wsHandler.broadcastCollaborationAgentToolCall(event);
  };

  private readonly onChoiceRequest = (event: ServerEvent): void => {
    if (event.type !== "choice_request") return;

    this.wsHandler.broadcastToSubscribed(event);
    this.cliWsHandler.broadcast(event);

    const collabSessionAgentId = this.resolveCollaborationChoiceSessionAgentId(event);
    if (collabSessionAgentId) {
      this.wsHandler.broadcastCollaborationChoiceRequest(event, collabSessionAgentId);
    }

    if (event.status === "pending") {
      const sessionAgentId = resolveSessionAgentIdForUnread(this.swarmManager, event.agentId);
      if (!sessionAgentId) {
        return;
      }

      void this.handleUnreadTrigger(event.agentId, "choice_request", sessionAgentId);
    }
  };

  private readonly onCodexElicitation = (event: ServerEvent): void => {
    if (event.type !== "codex_elicitation_request" && event.type !== "codex_elicitation_dismissed") return;
    this.wsHandler.broadcastToSession(event.agentId, event);
  };

  private readonly onModelCacheObservation = (event: ServerEvent): void => {
    if (event.type !== "model_cache_observation") return;
    this.wsHandler.broadcastToSubscribed(event);
    this.cliWsHandler.broadcast(event);
  };

  private readonly onConversationReset = (event: ServerEvent): void => {
    if (event.type !== "conversation_reset") return;
    this.wsHandler.broadcastToSubscribed(event);
    this.cliWsHandler.broadcast(event);
  };

  private readonly onMessagePinned = (event: ServerEvent): void => {
    if (event.type !== "message_pinned") return;
    this.wsHandler.broadcastToSubscribed(event);
    this.cliWsHandler.broadcast(event);

    const descriptor = this.swarmManager.getAgent(event.agentId);
    if (descriptor?.role === "manager" && isCollabSession(descriptor) && descriptor.collab?.channelId) {
      this.wsHandler.getCollaborationSubscriptionManager().broadcastMessagePinned(
        descriptor.collab.channelId,
        event.messageId,
        event.pinned,
      );
    }
  };

  private readonly onAgentStatus = (event: ServerEvent): void => {
    if (event.type !== "agent_status") return;
    this.wsHandler.broadcastToSubscribed(event);
    this.cliWsHandler.broadcast(event);
    this.wsHandler.broadcastCollaborationAgentStatus(event);
  };

  private readonly onSessionWorkersSnapshot = (event: ServerEvent): void => {
    if (event.type !== "session_workers_snapshot") return;
    this.wsHandler.broadcastToSubscribed(event);
    this.cliWsHandler.broadcast(event);
    this.wsHandler.broadcastCollaborationSessionWorkersSnapshot(event);
  };

  private readonly onGenerationThroughput = (event: ServerEvent): void => {
    if (event.type !== "generation_throughput") return;
    // Pi throughput is a Builder-local capability in v1. Do not forward it
    // through CLI or Collaboration subscriptions.
    if (!isBuilderRuntimeTarget(this.swarmManager.getConfig().runtimeTarget)) return;
    this.wsHandler.broadcastGenerationThroughput(event.measurement.sessionId, event);
  };

  private readonly onSessionActiveToolsSnapshot = (event: ServerEvent): void => {
    if (event.type !== "session_active_tools_snapshot") return;
    // Detail-bearing active-tool snapshots remain CLI-only. Builder uses the
    // count-only manager_tool_activity projection below.
    this.cliWsHandler.broadcast(event);
  };

  private readonly onManagerToolActivity = (event: ServerEvent): void => {
    if (event.type !== "manager_tool_activity") return;
    this.wsHandler.broadcastManagerToolActivity(event);
  };

  private readonly onSessionPlanSnapshot = (event: ServerEvent): void => {
    if (event.type !== "session_plan_snapshot") return;
    this.wsHandler.broadcastToExactSubscription(event.sessionAgentId, event);
    this.cliWsHandler.broadcast(event);
  };

  private readonly onSessionAttentionSnapshot = (event: ServerEvent): void => {
    if (event.type !== "session_attention_snapshot") return;
    // Builder-global origin state: every Builder subscription converges, while
    // Collaboration-only and CLI sockets remain outside this fanout. The event
    // carries complete state, so any dropped delivery heals on the next one.
    this.wsHandler.broadcastToSubscribed(event);
  };

  private readonly onSessionGoalSnapshot = (event: ServerEvent): void => {
    if (event.type !== "session_goal_snapshot") return;
    this.wsHandler.broadcastToExactSubscription(event.sessionAgentId, event);
    if (event.requestId === undefined) {
      this.cliWsHandler.broadcast(event);
      return;
    }
    const { requestId: _requestId, ...uncorrelatedEvent } = event;
    this.cliWsHandler.broadcast(uncorrelatedEvent);
  };

  private readonly onAgentsSnapshot = (event: ServerEvent): void => {
    if (event.type !== "agents_snapshot") return;
    this.wsHandler.broadcastToSubscribed(event);
  };

  private readonly onProfilesSnapshot = (event: ServerEvent): void => {
    if (event.type !== "profiles_snapshot") return;
    void this.remoteUpdateAwarenessService?.reconcileProjects().catch((error) => {
      console.warn("[remote-update-awareness] Project reconciliation failed", error);
    });
    this.wsHandler.broadcastToSubscribed(event);
  };

  private readonly onSecureSessionSnapshot = (event: ServerEvent): void => {
    if (event.type !== "secure_session_snapshot") return;
    this.wsHandler.broadcastSecureSessionSnapshot(event);
  };

  private readonly onSecureSecretCatalogChanged = (event: ServerEvent): void => {
    if (event.type !== "secure_secret_catalog_changed") return;
    this.wsHandler.broadcastToSubscribed(event);
  };

  private readonly onTerminalCreated = (event: TerminalCreatedEvent): void => {
    this.wsHandler.broadcastToSession(event.sessionAgentId, event);
  };

  private readonly onTerminalUpdated = (event: TerminalUpdatedEvent): void => {
    this.wsHandler.broadcastToSession(event.sessionAgentId, event);
  };

  private readonly onTerminalClosed = (event: TerminalClosedEvent): void => {
    this.wsHandler.broadcastToSession(event.sessionAgentId, event);
  };

  private async handleUnreadTrigger(
    agentId: string,
    reason: "message" | "choice_request",
    resolvedSessionAgentId?: string
  ): Promise<void> {
    const sessionAgentId = resolvedSessionAgentId ?? resolveSessionAgentIdForUnread(this.swarmManager, agentId);
    if (!sessionAgentId) {
      return;
    }

    // Pre-compute CLI-origin status once — used for both suppression and event payload
    const sessionDescriptor = this.swarmManager.getAgent(sessionAgentId);
    const cliOriginated = await isCliOriginatedSession(sessionDescriptor);

    const suppressUnreadNotification = this.isUnreadNotificationSuppressed(agentId, cliOriginated);
    if (!suppressUnreadNotification) {
      this.wsHandler.broadcastToSubscribed({
        type: "unread_notification",
        agentId,
        reason,
        sessionAgentId,
        ...(cliOriginated ? { cliOriginated: true } : {}),
      });
    }

    if (!this.wsHandler.hasActiveSubscriptionForSession(sessionAgentId)) {
      const { profileId } = this.resolveUnreadContext(sessionAgentId);
      if (profileId) {
        const newCount = this.unreadTracker.increment(profileId, sessionAgentId);
        this.wsHandler.broadcastUnreadCountUpdate(sessionAgentId, newCount);
      }
    }
  }

  private isUnreadNotificationSuppressed(agentId: string, cliOriginated: boolean): boolean {
    const descriptor = this.swarmManager.getAgent(agentId);
    if (descriptor?.role === "manager" && descriptor.sessionPurpose === "cortex_review") {
      return true;
    }

    if (cliOriginated && this.notificationSettingsService.getSettings().muteCliOriginatedNotifications) {
      return true;
    }

    return false;
  }

  private resolveUnreadContext(sessionAgentId: string): { profileId: string | null } {
    const descriptor = this.swarmManager.getAgent(sessionAgentId);
    if (!descriptor || descriptor.role !== "manager") {
      return { profileId: null };
    }

    return { profileId: descriptor.profileId ?? descriptor.agentId };
  }

  private resolveCollaborationChoiceSessionAgentId(event: Extract<ServerEvent, { type: "choice_request" }>): string | undefined {
    const explicitSessionAgentId = event.sessionAgentId?.trim();
    if (explicitSessionAgentId) {
      const sessionDescriptor = this.swarmManager.getAgent(explicitSessionAgentId);
      if (
        !sessionDescriptor ||
        sessionDescriptor.role !== "manager" ||
        !isCollabSession(sessionDescriptor)
      ) {
        console.warn(
          `[collab] Dropping choice_request fanout: invalid sessionAgentId ${explicitSessionAgentId}`,
        );
        return undefined;
      }

      const requesterDescriptor = this.swarmManager.getAgent(event.agentId);
      if (requesterDescriptor) {
        const requesterSessionAgentId =
          requesterDescriptor.role === "manager"
            ? requesterDescriptor.agentId
            : requesterDescriptor.managerId;
        if (requesterSessionAgentId !== explicitSessionAgentId) {
          console.warn(
            `[collab] Dropping choice_request fanout: sessionAgentId ${explicitSessionAgentId} mismatches requester ${event.agentId}`,
          );
          return undefined;
        }
      }

      return explicitSessionAgentId;
    }

    return this.resolveChoiceSessionAgentId(event.agentId);
  }

  broadcastBrowserSessionChanged(
    snapshot: BrowserSessionSnapshot,
    reason: "host-report" | "automation" | "human-command" | "lifecycle" | "recovery",
  ): void {
    this.wsHandler.broadcastToManagerSession(snapshot.sessionAgentId, {
      type: "browser_session_changed",
      snapshot,
      reason,
    });
  }

  broadcastBrowserHostChanged(host: BrowserHostConnectionSnapshot): void {
    this.wsHandler.broadcastToSubscribed({ type: "browser_host_connected", host });
  }

  private resolveChoiceSessionAgentId(agentId: string): string | undefined {
    const descriptor = this.swarmManager.getAgent(agentId);
    if (!descriptor) {
      return undefined;
    }

    const sessionAgentId = descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId;
    const sessionDescriptor = this.swarmManager.getAgent(sessionAgentId);
    if (!sessionDescriptor || sessionDescriptor.role !== "manager" || !isCollabSession(sessionDescriptor)) {
      return undefined;
    }

    return sessionAgentId;
  }

  constructor(options: {
    swarmManager: SwarmManager;
    host: string;
    port: number;
    allowNonManagerSubscriptions: boolean;
    terminalService?: TerminalService | null;
    terminalRuntimeConfig?: TerminalRuntimeConfig | null;
    terminalSettingsService?: TerminalSettingsService;
    promptRegistry?: PromptRegistryForRoutes;
    unreadTracker?: UnreadTracker;
    statsService?: StatsService;
    telemetryService?: TelemetryService | null;
    collaborationSettingsService?: CollaborationSettingsService;
    collaborationReadinessService?: CollaborationReadinessRequestService;
    cliAccessService?: CliAccessService;
    streamDeckAccessService?: StreamDeckAccessService;
    secureBrowserAccessService?: SecureBrowserAccessService;
    notificationSettingsService?: NotificationSettingsService;
    remoteBuildSettingsService?: RemoteBuildSettingsService;
    builderSidebarOrderService?: BuilderSidebarOrderService;
    knowledgeV2SettingsService?: KnowledgeV2SettingsService;
    compactionSettingsService?: CompactionSettingsService;
    observabilityService?: ObservabilityFacade;
    feedbackService?: FeedbackService;
    remoteUpdateAwarenessService?: LocalRemoteUpdateAwarenessService;
    browserAutomationService?: BrowserAutomationService;
    secureControlToken?: string;
  }) {
    this.swarmManager = options.swarmManager;
    this.host = options.host;
    this.port = options.port;
    this.secureControlToken = options.secureControlToken ?? "";
    const isBuilder = isBuilderRuntimeTarget(this.swarmManager.getConfig().runtimeTarget);
    const cortexEnabled = this.swarmManager.getConfig().cortexEnabled;
    this.cortexAutoReviewSettingsService = new CortexAutoReviewSettingsService({
      dataDir: this.swarmManager.getConfig().paths.dataDir,
      cortexEnabled,
    });
    this.builderSidebarOrderService = isBuilderRuntimeTarget(this.swarmManager.getConfig().runtimeTarget)
      ? options.builderSidebarOrderService ??
        new BuilderSidebarOrderService({ dataDir: this.swarmManager.getConfig().paths.dataDir })
      : null;
    this.knowledgeV2SettingsService =
      options.knowledgeV2SettingsService ??
      this.swarmManager.getKnowledgeV2SettingsService?.() ??
      null;
    this.compactionSettingsService =
      options.compactionSettingsService ?? this.swarmManager.getCompactionSettingsService();
    this.cliAccessService = options.cliAccessService ?? new CliAccessService({
      dataDir: this.swarmManager.getConfig().paths.dataDir,
      envApiKey: readCliApiKeyEnv(),
    });
    this.streamDeckAccessService = options.streamDeckAccessService ?? new StreamDeckAccessService({
      dataDir: this.swarmManager.getConfig().paths.dataDir,
    });
    this.secureBrowserAccessService =
      options.secureBrowserAccessService ??
      new SecureBrowserAccessService({
        dataDir: this.swarmManager.getConfig().paths.dataDir,
      });
    this.notificationSettingsService =
      options.notificationSettingsService ??
      new NotificationSettingsService({ dataDir: this.swarmManager.getConfig().paths.dataDir });
    this.remoteBuildSettingsService =
      options.remoteBuildSettingsService ??
      new RemoteBuildSettingsService({
        dataDir: this.swarmManager.getConfig().paths.dataDir,
        envOverrides: this.swarmManager.getConfig().remoteProjectsEnv,
      });
    this.terminalService = options.terminalService ?? null;
    this.terminalRuntimeConfig = options.terminalRuntimeConfig ?? null;
    this.terminalSettingsService =
      options.terminalSettingsService ??
      new TerminalSettingsService({ dataDir: this.swarmManager.getConfig().paths.dataDir });
    this.terminalWsProxy =
      this.terminalService && this.terminalRuntimeConfig
        ? new TerminalWsProxy({
            terminalService: this.terminalService,
            runtimeConfig: this.terminalRuntimeConfig,
          })
        : null;
    this.observabilityService =
      options.observabilityService ??
      createNoopObservabilityFacade(this.swarmManager.getConfig().runtimeTarget);
    this.feedbackService =
      options.feedbackService ??
      new FeedbackService(this.swarmManager.getConfig().paths.dataDir, { observability: this.observabilityService });
    this.unreadTracker =
      options.unreadTracker ??
      new UnreadTracker({
        dataDir: this.swarmManager.getConfig().paths.dataDir,
        getProfileIds: () => this.swarmManager.listProfiles?.().map((profile) => profile.profileId) ?? [],
        getSessionAgentIds: (profileId) =>
          this.swarmManager
            .listAgents?.()
            .filter(
              (descriptor) =>
                descriptor.role === "manager" &&
                !isCollabSession(descriptor) &&
                (descriptor.profileId ?? descriptor.agentId) === profileId,
            )
            .map((descriptor) => descriptor.agentId) ?? [],
      });

    let wsHandlerRef: WsHandler | null = null;

    const remoteUpdateConfig = this.swarmManager.getConfig();
    this.remoteUpdateAwarenessService = isBuilder && (
      options.remoteUpdateAwarenessService ||
      (remoteUpdateConfig.paths.remoteUpdateAwarenessDbPath && remoteUpdateConfig.remoteUpdateAwarenessModules)
    )
      ? options.remoteUpdateAwarenessService ?? new LocalRemoteUpdateAwarenessService({
          swarmManager: this.swarmManager,
          broadcastProjectEvent: (projectId, event) => this.wsHandler.broadcastToProfile(projectId, event),
        })
      : null;

    this.mobilePushService = new MobilePushService({
      swarmManager: this.swarmManager,
      dataDir: this.swarmManager.getConfig().paths.dataDir,
      isSessionActive: (sessionAgentId) => wsHandlerRef?.hasActiveSubscription(sessionAgentId) ?? false,
      notificationSettingsService: this.notificationSettingsService,
    });
    this.controlPidFile = getControlPidFilePath(
      this.swarmManager.getConfig().paths.rootDir,
      this.swarmManager.getConfig().port
    );
    this.shouldManageControlPid =
      !this.swarmManager.getConfig().isDesktop && readDaemonizedEnv() !== "1";
    const artifactTicketStore = new PresentedChatArtifactTicketStore();

    this.wsHandler = new WsHandler({
      swarmManager: this.swarmManager,
      mobilePushService: this.mobilePushService,
      allowNonManagerSubscriptions: options.allowNonManagerSubscriptions,
      terminalService: this.terminalService,
      listTerminalsForSession: this.terminalService
        ? (sessionAgentId) => this.terminalService?.listTerminals(sessionAgentId) ?? []
        : undefined,
      unreadTracker: this.unreadTracker,
      perf: this.swarmManager.getSidebarPerfRecorder(),
      collaborationReadinessService: options.collaborationReadinessService ?? undefined,
      feedbackService: this.feedbackService,
      isRemoteBuildEnabled: () => this.remoteBuildSettingsService.isRemoteBuildEnabled(),
      areRemoteTerminalsEnabled: () => this.remoteBuildSettingsService.areTerminalsEnabled(),
      browserAutomationService: options.browserAutomationService,
      artifactTicketStore,
      getRemoteUpdateAwarenessBootstrapEvent: this.remoteUpdateAwarenessService
        ? (projectId) => {
            try {
              return {
                type: "remote_update_awareness_project_changed" as const,
                snapshot: this.remoteUpdateAwarenessService!.getProjectSnapshot(projectId),
              };
            } catch {
              return { type: "remote_update_awareness_project_cleared" as const, projectId };
            }
          }
        : undefined,
    });
    this.cliWsHandler = new CliWsHandler(this.swarmManager);
    wsHandlerRef = this.wsHandler;

    this.repositorySettingsService = isBuilder
      ? new RepositorySettingsService({ dataDir: this.swarmManager.getConfig().paths.dataDir })
      : null;
    this.repositoryProjectCreationService = this.repositorySettingsService
      ? new RepositoryProjectCreationService({
          swarmManager: this.swarmManager,
          settingsService: this.repositorySettingsService,
          sendToSocket: (socket, event) => this.wsHandler.sendToSocket(socket, event),
        })
      : null;
    this.wsHandler.setRepositoryProjectCreationService(this.repositoryProjectCreationService);

    this.telemetryService = options.telemetryService ?? null;
    this.collaborationSettingsService = options.collaborationSettingsService ?? null;
    this.collaborationReadinessService = options.collaborationReadinessService ?? null;
    this.statsService = options.statsService ?? new StatsService(this.swarmManager, {
      onRefreshAllCompleted: (allStats) => {
        void this.telemetryService?.sendOnStatsRefresh(allStats);
      },
    });
    this.settingsRoutes = createSettingsRoutes({
      swarmManager: this.swarmManager,
      notificationSettingsService: this.notificationSettingsService,
      statsService: this.statsService,
    });
    this.tokenAnalyticsService = new TokenAnalyticsService(this.swarmManager);
    this.generationThroughputService = new GenerationThroughputService(this.swarmManager);

    const secureTransportService = this.swarmManager as unknown as
      SecureSecretTransportService
      & SecureSessionsTransportService
      & SecureBrowserVaultService;

    this.httpRoutes = [
      ...(isBuilderRuntimeTarget(this.swarmManager.getConfig().runtimeTarget)
        ? [createDisabledCollaborationStatusRoute()]
        : []),
      ...(isBuilderRuntimeTarget(this.swarmManager.getConfig().runtimeTarget)
        ? createCliRoutes({
            cliAccessService: this.cliAccessService,
            runtimeTarget: this.swarmManager.getConfig().runtimeTarget,
            swarmManager: this.swarmManager,
          })
        : []),
      ...(isBuilderRuntimeTarget(this.swarmManager.getConfig().runtimeTarget)
          ? createStreamDeckRoutes({
            cliAccessService: this.cliAccessService,
            streamDeckAccessService: this.streamDeckAccessService,
            runtimeTarget: this.swarmManager.getConfig().runtimeTarget,
            swarmManager: this.swarmManager,
            unreadTracker: this.unreadTracker,
            statsService: this.statsService,
            broadcastEvent: (event) => this.wsHandler.broadcastToSubscribed(event),
            onUnreadChanged: (sessionAgentId, count) =>
              this.wsHandler.broadcastUnreadCountUpdate(sessionAgentId, count),
          })
        : []),
      ...createStreamDeckPairingRoutes({
        streamDeckAccessService: this.streamDeckAccessService,
        runtimeTarget: this.swarmManager.getConfig().runtimeTarget,
      }),
      ...createCliAccessSettingsRoutes({
        cliAccessService: this.cliAccessService,
        runtimeTarget: this.swarmManager.getConfig().runtimeTarget,
      }),
      ...(isBuilder
        ? [
            ...createSecureBrowserControlRoutes({
              accessService: this.secureBrowserAccessService,
              vaultService: secureTransportService,
              secureControlAvailable: this.secureControlToken.length >= 32,
            }),
            ...createSecureSecretRoutes({ service: secureTransportService }),
            ...createSecureSessionRoutes({ service: secureTransportService }),
          ]
        : []),
      ...(this.builderSidebarOrderService
        ? createBuilderSidebarOrderRoutes({
            service: this.builderSidebarOrderService,
            runtimeTarget: this.swarmManager.getConfig().runtimeTarget,
            broadcastEvent: (event) => this.wsHandler.broadcastToSubscribed(event),
          })
        : []),
      ...(this.collaborationSettingsService
        ? createCollaborationRoutes({
            config: this.swarmManager.getConfig(),
            settingsService: this.collaborationSettingsService,
            readinessService: this.collaborationReadinessService ?? undefined,
            swarmManager: this.swarmManager,
            broadcasts: this.wsHandler.getCollaborationSubscriptionManager(),
            buildStatusHandshake: () => ({
              instanceName: this.remoteBuildSettingsService.getInstanceDisplayName(),
              forgeVersion: getForgeAppVersion(),
              protocolVersion: BUILDER_PROTOCOL_VERSION,
              capabilities: {
                collab: true,
                remoteBuild: this.remoteBuildSettingsService.isRemoteBuildEnabled(),
                createDirectory: true,
                sessionAttention: true,
              },
            }),
          })
        : []),
      ...createHealthRoutes({
        resolveControlPidFile: () => this.controlPidFile,
        allowReboot: !this.swarmManager.getConfig().isDesktop,
        swarmManager: this.swarmManager
      }),
      ...createFileRoutes({
        swarmManager: this.swarmManager,
        broadcastEvent: (event) => this.wsHandler.broadcastToSubscribed(event),
      }),
      ...createChatArtifactRoutes({ swarmManager: this.swarmManager, ticketStore: artifactTicketStore }),
      ...createFileBrowserRoutes({ swarmManager: this.swarmManager }),
      ...createGitDiffRoutes({ swarmManager: this.swarmManager }),
      ...createGitSourceControlRoutes({ swarmManager: this.swarmManager }),
      ...(this.remoteUpdateAwarenessService
        ? createRemoteUpdateAwarenessRoutes({ service: this.remoteUpdateAwarenessService })
        : []),
      ...createFeedbackRoutes({ swarmManager: this.swarmManager, feedbackService: this.feedbackService }),
      ...(isBuilderRuntimeTarget(this.swarmManager.getConfig().runtimeTarget)
        ? createPhoenixObservabilityRoutes({
            observabilityService: this.observabilityService,
            runtimeTarget: this.swarmManager.getConfig().runtimeTarget,
          })
        : []),
      ...createCortexRoutes({ swarmManager: this.swarmManager, cortexEnabled }),
      ...createCortexAutoReviewRoutes({
        settingsService: this.cortexAutoReviewSettingsService,
        cortexEnabled,
      }),
      ...(this.knowledgeV2SettingsService
        ? createKnowledgeV2SettingsRoutes({
            settingsService: this.knowledgeV2SettingsService,
            dataDir: this.swarmManager.getConfig().paths.dataDir,
            runtimeTarget: this.swarmManager.getConfig().runtimeTarget,
          })
        : []),
      ...(this.compactionSettingsService
        ? createCompactionSettingsRoutes({
            settingsService: this.compactionSettingsService,
            runtimeTarget: this.swarmManager.getConfig().runtimeTarget,
          })
        : []),
      ...(this.repositorySettingsService
        ? createRepositorySettingsRoutes({
            settingsService: this.repositorySettingsService,
            runtimeTarget: this.swarmManager.getConfig().runtimeTarget,
          })
        : []),
      ...createRemoteBuildSettingsRoutes({
        settingsService: this.remoteBuildSettingsService,
        runtimeTarget: this.swarmManager.getConfig().runtimeTarget,
      }),
      ...createDebugRoutes({ swarmManager: this.swarmManager }),
      ...createTranscriptionRoutes({ swarmManager: this.swarmManager }),
      ...createStatsRoutes({
        statsService: this.statsService,
        tokenAnalyticsService: this.tokenAnalyticsService,
        generationThroughputService: this.generationThroughputService,
      }),
      ...(this.telemetryService ? createTelemetryRoutes({ telemetryService: this.telemetryService }) : []),
      ...createSchedulerRoutes({ swarmManager: this.swarmManager }),
      ...createRestartRecoveryRoutes({
        swarmManager: this.swarmManager,
        broadcastEvent: (event) => this.wsHandler.broadcastToSubscribed(event),
      }),
      ...createSlashCommandRoutes({ swarmManager: this.swarmManager }),
      ...createMobileRoutes({ mobilePushService: this.mobilePushService }),
      ...createAgentHttpRoutes({ swarmManager: this.swarmManager }),
      ...createSessionAuditRoutes({ swarmManager: this.swarmManager }),
      ...createCodexCatalogRoutes({ swarmManager: this.swarmManager }),
      ...(this.terminalService ? createTerminalRoutes({ terminalService: this.terminalService, settingsService: this.terminalSettingsService }) : []),
      ...this.settingsRoutes.routes,
      ...createSpecialistRoutes({
        swarmManager: this.swarmManager,
        broadcastEvent: (event) => this.wsHandler.broadcastToSubscribed(event),
      }),
      ...createModelCacheVisualizationRoutes({
        swarmManager: this.swarmManager,
        broadcastEvent: (event) => this.wsHandler.broadcastToSubscribed(event),
      }),
      ...createModelConfigRoutes({
        swarmManager: this.swarmManager,
        broadcastEvent: (event) => this.wsHandler.broadcastToSubscribed(event),
      }),
      ...createProjectResourceRoutes({ swarmManager: this.swarmManager }),
      ...createOpenRouterRoutes({
        swarmManager: this.swarmManager,
        broadcastEvent: (event) => this.wsHandler.broadcastToSubscribed(event),
      }),
      ...createExtensionRoutes({ swarmManager: this.swarmManager }),
      ...createSkillRoutes({ swarmManager: this.swarmManager }),
      ...createMermaidPreviewRoutes(),
      ...(options.promptRegistry
        ? createPromptRoutes({
            promptRegistry: options.promptRegistry,
            dataDir: this.swarmManager.getConfig().paths.dataDir,
            broadcastEvent: (event) => this.wsHandler.broadcastToSubscribed(event),
            promptPreviewProvider: this.swarmManager,
            versioning: this.swarmManager.getVersioningService(),
            listProfiles: () => this.swarmManager.listProfiles(),
            cortexEnabled,
          })
        : []),
      ...createStaticUiRoutes({
        rootDir: this.swarmManager.getConfig().paths.rootDir,
        resourcesDir: this.swarmManager.getConfig().paths.resourcesDir,
        runtimeTarget: this.swarmManager.getConfig().runtimeTarget,
        nodeEnv: process.env.NODE_ENV,
      }),
    ];
  }

  /**
   * Enumerates the registered HTTP route table. Exists for the
   * route-inventory classification gate: every registered route must map to
   * an explicitly reviewed access class (see route-inventory tests).
   */
  listRegisteredHttpRoutes(): ReadonlyArray<Pick<HttpRoute, "methods" | "matches">> {
    return this.httpRoutes;
  }

  async start(): Promise<void> {
    if (this.httpServer || this.wss) {
      return;
    }

    await this.cortexAutoReviewSettingsService.load();
    if (this.builderSidebarOrderService) {
      await this.builderSidebarOrderService.load();
    }
    if (this.knowledgeV2SettingsService) {
      await this.knowledgeV2SettingsService.load();
    }
    if (this.compactionSettingsService) {
      await this.compactionSettingsService.load();
    }
    if (this.repositorySettingsService) {
      await this.repositorySettingsService.load();
    }
    await this.notificationSettingsService.load();
    await this.remoteBuildSettingsService.load();
    await this.unreadTracker.load();
    await this.swarmManager.loadModelCacheVisualizationSettings?.();
    await this.remoteUpdateAwarenessService?.start();

    const httpServer = createServer((request, response) => {
      void this.handleHttpRequest(request, response);
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_INCOMING_PAYLOAD_BYTES });
    const cliWss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_INCOMING_PAYLOAD_BYTES });

    this.httpServer = httpServer;
    this.wss = wss;
    this.cliWss = cliWss;

    this.wsHandler.attach(wss);
    this.cliWsHandler.attach(cliWss);
    httpServer.on("upgrade", (request, socket, head) => {
      void this.handleUpgrade(request, socket, head);
    });

    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        cleanup();
        this.actualPort = resolveListeningPort(httpServer, this.port);
        resolve();
      };

      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };

      const cleanup = (): void => {
        httpServer.off("listening", onListening);
        httpServer.off("error", onError);
      };

      httpServer.on("listening", onListening);
      httpServer.on("error", onError);
      httpServer.listen(this.port, this.host);
    });

    if (this.shouldManageControlPid) {
      this.ownsControlPidFile = await tryWriteOwnedControlPidFile(this.controlPidFile);
    }

    this.swarmManager.on("conversation_message", this.onConversationMessage);
    this.swarmManager.on("conversation_log", this.onConversationLog);
    this.swarmManager.on("activity_summary", this.onActivitySummary);
    this.swarmManager.on("agent_message", this.onAgentMessage);
    this.swarmManager.on("agent_tool_call", this.onAgentToolCall);
    this.swarmManager.on("choice_request", this.onChoiceRequest);
    this.swarmManager.on("codex_elicitation_request", this.onCodexElicitation);
    this.swarmManager.on("codex_elicitation_dismissed", this.onCodexElicitation);
    this.swarmManager.on("plan_summary", this.onPlanSummary);
    this.swarmManager.on("model_cache_observation", this.onModelCacheObservation);
    this.swarmManager.on("conversation_reset", this.onConversationReset);
    this.swarmManager.on("message_pinned", this.onMessagePinned);
    this.swarmManager.on("agent_status", this.onAgentStatus);
    this.swarmManager.on("session_workers_snapshot", this.onSessionWorkersSnapshot);
    this.swarmManager.on("generation_throughput", this.onGenerationThroughput);
    this.swarmManager.on("session_active_tools_snapshot", this.onSessionActiveToolsSnapshot);
    this.swarmManager.on("manager_tool_activity", this.onManagerToolActivity);
    this.swarmManager.on("session_plan_snapshot", this.onSessionPlanSnapshot);
    this.swarmManager.on("session_attention_snapshot", this.onSessionAttentionSnapshot);
    this.swarmManager.on("session_goal_snapshot", this.onSessionGoalSnapshot);
    this.swarmManager.on("agents_snapshot", this.onAgentsSnapshot);
    this.swarmManager.on("profiles_snapshot", this.onProfilesSnapshot);
    this.swarmManager.on("secure_session_snapshot", this.onSecureSessionSnapshot);
    this.swarmManager.on(
      "secure_secret_catalog_changed",
      this.onSecureSecretCatalogChanged,
    );
    this.terminalService?.on("terminal_created", this.onTerminalCreated);
    this.terminalService?.on("terminal_updated", this.onTerminalUpdated);
    this.terminalService?.on("terminal_closed", this.onTerminalClosed);
    await this.mobilePushService.start();

    const refreshStatsInBackground = () => {
      void this.statsService.refreshAllRangesInBackground().catch(() => false);
    };
    const refreshTokenAnalyticsInBackground = () => {
      void this.tokenAnalyticsService.refreshScanInBackground().catch(() => false);
    };
    const refreshGenerationThroughputInBackground = () => {
      void this.generationThroughputService.refreshScanInBackground().catch(() => false);
    };

    // Backstop behavior: keep an automatic refresh cadence (every cache TTL) so telemetry still
    // gets refresh-completion triggers even when nobody calls /api/stats/refresh manually.
    // Avoid an unconditional startup stats refresh here so provider-usage auth probing only runs
    // on demand or on the scheduled background cadence.
    void this.tokenAnalyticsService.prewarmInBackground().catch(() => false);
    void this.generationThroughputService.prewarmInBackground().catch(() => false);
    this.statsRefreshInterval = setInterval(() => {
      refreshStatsInBackground();
    }, STATS_CACHE_TTL_MS);
    this.statsRefreshInterval.unref?.();
    this.tokenAnalyticsRefreshInterval = setInterval(() => {
      refreshTokenAnalyticsInBackground();
    }, STATS_CACHE_TTL_MS);
    this.tokenAnalyticsRefreshInterval.unref?.();
    this.generationThroughputRefreshInterval = setInterval(() => {
      refreshGenerationThroughputInBackground();
    }, STATS_CACHE_TTL_MS);
    this.generationThroughputRefreshInterval.unref?.();

    await this.telemetryService?.start();
  }

  getPort(): number {
    return this.actualPort ?? this.port;
  }

  async stop(): Promise<void> {
    if (this.statsRefreshInterval) {
      clearInterval(this.statsRefreshInterval);
      this.statsRefreshInterval = null;
    }
    if (this.tokenAnalyticsRefreshInterval) {
      clearInterval(this.tokenAnalyticsRefreshInterval);
      this.tokenAnalyticsRefreshInterval = null;
    }
    if (this.generationThroughputRefreshInterval) {
      clearInterval(this.generationThroughputRefreshInterval);
      this.generationThroughputRefreshInterval = null;
    }

    this.swarmManager.off("conversation_message", this.onConversationMessage);
    this.swarmManager.off("conversation_log", this.onConversationLog);
    this.swarmManager.off("activity_summary", this.onActivitySummary);
    this.swarmManager.off("agent_message", this.onAgentMessage);
    this.swarmManager.off("agent_tool_call", this.onAgentToolCall);
    this.swarmManager.off("choice_request", this.onChoiceRequest);
    this.swarmManager.off("codex_elicitation_request", this.onCodexElicitation);
    this.swarmManager.off("codex_elicitation_dismissed", this.onCodexElicitation);
    this.swarmManager.off("plan_summary", this.onPlanSummary);
    this.swarmManager.off("model_cache_observation", this.onModelCacheObservation);
    this.swarmManager.off("conversation_reset", this.onConversationReset);
    this.swarmManager.off("message_pinned", this.onMessagePinned);
    this.swarmManager.off("agent_status", this.onAgentStatus);
    this.swarmManager.off("session_workers_snapshot", this.onSessionWorkersSnapshot);
    this.swarmManager.off("generation_throughput", this.onGenerationThroughput);
    this.swarmManager.off("session_active_tools_snapshot", this.onSessionActiveToolsSnapshot);
    this.swarmManager.off("manager_tool_activity", this.onManagerToolActivity);
    this.swarmManager.off("session_plan_snapshot", this.onSessionPlanSnapshot);
    this.swarmManager.off("session_attention_snapshot", this.onSessionAttentionSnapshot);
    this.swarmManager.off("session_goal_snapshot", this.onSessionGoalSnapshot);
    this.swarmManager.off("agents_snapshot", this.onAgentsSnapshot);
    this.swarmManager.off("profiles_snapshot", this.onProfilesSnapshot);
    this.swarmManager.off("secure_session_snapshot", this.onSecureSessionSnapshot);
    this.swarmManager.off(
      "secure_secret_catalog_changed",
      this.onSecureSecretCatalogChanged,
    );
    this.terminalService?.off("terminal_created", this.onTerminalCreated);
    this.terminalService?.off("terminal_updated", this.onTerminalUpdated);
    this.terminalService?.off("terminal_closed", this.onTerminalClosed);

    const currentWss = this.wss;
    const currentCliWss = this.cliWss;
    const currentHttpServer = this.httpServer;

    this.wss = null;
    this.cliWss = null;
    this.httpServer = null;
    this.actualPort = null;

    // Close ingress immediately, but retain handler state until in-flight work
    // has settled. Repository creation shutdown can still depend on the real
    // socket bookkeeping while it aborts and cleans up active operations.
    const transportShutdown = Promise.allSettled([
      this.terminalWsProxy?.stop() ?? Promise.resolve(),
      currentWss ? closeWebSocketServer(currentWss) : Promise.resolve(),
      currentCliWss ? closeWebSocketServer(currentCliWss) : Promise.resolve(),
      currentHttpServer ? closeHttpServer(currentHttpServer) : Promise.resolve(),
    ]);

    // Stop local Git observations before closing feature storage.
    await this.remoteUpdateAwarenessService?.stop();
    // Abort in-flight clones and await termination/cleanup before persistence drains.
    await this.repositoryProjectCreationService?.shutdown();

    this.wsHandler.reset();
    this.cliWsHandler.reset();
    this.settingsRoutes.cancelActiveSettingsAuthLoginFlows();
    this.telemetryService?.stop();

    await this.swarmManager.flushPendingPersistence?.();

    await Promise.allSettled([
      this.mobilePushService.stop(),
      this.unreadTracker.flush(),
      transportShutdown,
    ]);
    await this.generationThroughputService.dispose();

    if (this.ownsControlPidFile) {
      await removeOwnedControlPidFile(this.controlPidFile);
      this.ownsControlPidFile = false;
    }
  }

  private async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (!this.httpServer || !this.wss || !this.cliWss) {
      ignoreSocketErrors(socket);
      socket.destroy();
      return;
    }

    const requestUrl = resolveRequestUrl(request, `${this.host}:${this.getPort()}`);
    if (isCliWebSocketPath(requestUrl.pathname)) {
      await this.handleCliUpgrade(request, socket, head);
      return;
    }

    if (this.terminalWsProxy?.canHandleUpgrade(requestUrl.pathname)) {
      const handled = this.terminalWsProxy.handleUpgrade(request, socket, head, requestUrl.pathname);
      if (handled) {
        return;
      }
    }

    const config = this.swarmManager.getConfig();
    let authContext: CollaborationAuthContext | null = null;

    if (isBuilderRuntimeTarget(config.runtimeTarget)) {
      const originValidation = validateTerminalWsOrigin(request);
      if (!originValidation.ok) {
        rejectWebSocketUpgrade(socket, 403, originValidation.errorMessage);
        return;
      }
    } else {
      const originValidation = validateCollaborationHttpOrigin(request, config);
      if (!originValidation.ok) {
        rejectWebSocketUpgrade(socket, 403, originValidation.errorMessage);
        return;
      }

      try {
        const authService = await getOrCreateCollaborationBetterAuthService(config);
        const session = await authService.getSessionFromCookieHeader(request.headers.cookie);
        if (!session) {
          rejectWebSocketUpgrade(socket, 401, "Authentication required");
          return;
        }

        const resolvedAuthContext = await resolveCollaborationAuthContextForUserId(config, session.user.id);
        if (!resolvedAuthContext) {
          rejectWebSocketUpgrade(socket, 401, "Authentication required");
          return;
        }

        authContext = {
          ...resolvedAuthContext,
          ...(session.session?.id ? { sessionId: session.session.id } : {}),
        };

        if (authContext.disabled) {
          rejectWebSocketUpgrade(socket, 403, "User account is disabled");
          return;
        }

        if (authContext.passwordChangeRequired) {
          rejectWebSocketUpgrade(socket, 403, "Password change required");
          return;
        }
      } catch (error) {
        console.error("[collaboration] Failed to authenticate WebSocket upgrade", error);
        rejectWebSocketUpgrade(socket, 500, "Internal Server Error");
        return;
      }
    }

    const wss = this.wss;
    if (!wss) {
      ignoreSocketErrors(socket);
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (client) => {
      if (authContext) {
        setCollaborationSocketAuthContext(client, authContext);
        this.wsHandler.getCollaborationSubscriptionManager().registerSocket(client, authContext);
      }

      wss.emit("connection", client, request);
    });
  }

  private async handleCliUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const config = this.swarmManager.getConfig();
    if (!isBuilderRuntimeTarget(config.runtimeTarget)) {
      rejectWebSocketUpgrade(socket, 404, "Not Found");
      return;
    }

    const cliWss = this.cliWss;
    if (!cliWss) {
      ignoreSocketErrors(socket);
      socket.destroy();
      return;
    }

    const authResult = await authenticateCliWebSocketRequest(this.cliAccessService, request);
    if (!authResult.ok) {
      rejectWebSocketUpgrade(socket, authResult.statusCode, authResult.message);
      return;
    }

    cliWss.handleUpgrade(request, socket, head, (client) => {
      cliWss.emit("connection", client, request);
    });
  }

  private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = resolveRequestUrl(request, `${this.host}:${this.getPort()}`);
    let route: HttpRoute | undefined;

    try {
      if (
        isBuilderRuntimeTarget(this.swarmManager.getConfig().runtimeTarget)
        && isSecureBuilderControlPath(requestUrl.pathname)
      ) {
        const originValidation = validateSecureBuilderControlOrigin(
          request,
          {
            backendHost: this.host,
            backendPort: this.getPort(),
          },
        );
        if (!originValidation.ok) {
          sendJson(response, 403, { error: originValidation.errorMessage });
          return;
        }
        const hasDesktopCapability = validateSecureBuilderControlCapability(
          request,
          this.secureControlToken,
        );
        let hasSecureBrowserCapability = false;
        if (
          isSecureBrowserStatusPath(request.method, requestUrl.pathname)
          || (
            !hasDesktopCapability
            && isSecureBrowserControlPath(requestUrl.pathname)
          )
          || (
            !hasDesktopCapability
            && request.method !== "GET"
            && request.method !== "HEAD"
            && request.method !== "OPTIONS"
          )
        ) {
          const authentication = await this.secureBrowserAccessService.authenticateToken(
            readSecureBrowserCookie(request.headers.cookie),
          );
          if (authentication.ok) {
            hasSecureBrowserCapability = true;
            setSecureBrowserRequestDevice(request, authentication.device);
          }
        }
        const isPreflight = request.method === "OPTIONS";
        const desktopOnlyPath =
          isDesktopOnlySecureBrowserPath(requestUrl.pathname)
          || isDesktopOnlySecureSecretPath(requestUrl.pathname);
        const mutationRequiresControl =
          request.method !== "GET"
          && request.method !== "HEAD"
          && request.method !== "OPTIONS"
          && !isWebSafeSecureAccessRequestDismissal(
            request.method,
            requestUrl.pathname,
          )
          && !isPublicSecureBrowserPairingPath(
            request.method,
            requestUrl.pathname,
          );
        if (
          (desktopOnlyPath && !isPreflight && !hasDesktopCapability)
          || (
            mutationRequiresControl
            && !hasDesktopCapability
            && !hasSecureBrowserCapability
          )
        ) {
          sendJson(response, 403, {
            code: "SECURE_PRIVATE_API_UNAVAILABLE",
            error: "SECURE_PRIVATE_API_UNAVAILABLE",
          });
          return;
        }
      }
      if (!isBuilderRuntimeTarget(this.swarmManager.getConfig().runtimeTarget)) {
        if (isCliHttpPath(requestUrl.pathname)) {
          applyCorsHeaders(request, response, "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
          response.statusCode = 404;
          response.end("Not Found");
          return;
        }

        const originValidation = validateCollaborationHttpOrigin(request, this.swarmManager.getConfig());
        if (!originValidation.ok) {
          setCollaborationRequestCorsContext(request, { allowedOrigin: null });
          applyCorsHeaders(request, response, "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
          sendJson(response, 403, { error: originValidation.errorMessage });
          return;
        }

        setCollaborationRequestCorsContext(request, { allowedOrigin: originValidation.allowedOrigin });

        if (requestUrl.pathname === "/api/auth" || requestUrl.pathname.startsWith("/api/auth/")) {
          applyCorsHeaders(request, response, "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
          if (request.method === "OPTIONS") {
            response.statusCode = 204;
            response.end();
            return;
          }

          const authService = await getOrCreateCollaborationBetterAuthService(this.swarmManager.getConfig());
          await authService.handleAuthRequest(request, response);
          return;
        }

        const authContext = await authenticateRequest(request, this.swarmManager.getConfig());
        setCollaborationRequestAuthContext(request, authContext);

        const passwordChangeAccess = evaluateCollaborationPasswordChangeAccess(
          authContext,
          requestUrl.pathname,
          request.method,
        );
        if (!passwordChangeAccess.ok) {
          applyCorsHeaders(request, response, "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
          sendJson(response, passwordChangeAccess.statusCode, { error: passwordChangeAccess.error });
          return;
        }

        const accessClass = classifyCollaborationHttpRequest(requestUrl.pathname, request.method, {
          remoteBuildEnabled: this.remoteBuildSettingsService.isRemoteBuildEnabled(),
          terminalsEnabled: this.remoteBuildSettingsService.areTerminalsEnabled(),
        });
        if (accessClass === "member") {
          const access = evaluateCollaborationMemberAccess(authContext);
          if (!access.ok) {
            applyCorsHeaders(request, response, "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
            sendJson(response, access.statusCode, { error: access.error });
            return;
          }
        } else if (accessClass === "admin") {
          const access = evaluateCollaborationAdminAccess(authContext);
          if (!access.ok) {
            applyCorsHeaders(request, response, "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
            sendJson(response, access.statusCode, { error: access.error });
            return;
          }
        }
      }

      route = this.httpRoutes.find((candidate) => candidate.matches(requestUrl.pathname));

      if (!route) {
        applyCorsHeaders(request, response, "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
        response.statusCode = 404;
        response.end("Not Found");
        return;
      }

      await route.handle(request, response, requestUrl);
    } catch (error) {
      if (response.writableEnded || response.headersSent) {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      const statusCode =
        message.includes("must be") ||
        message.includes("Invalid") ||
        message.includes("Missing") ||
        message.includes("too large")
          ? 400
          : 500;

      applyCorsHeaders(request, response, route?.methods ?? "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
      sendJson(response, statusCode, { error: message });
    }
  }
}

function createDisabledCollaborationStatusRoute(): HttpRoute {
  return {
    methods: "GET, OPTIONS",
    matches: (pathname: string) => pathname === "/api/collaboration/status",
    handle: async (request: IncomingMessage, response: ServerResponse) => {
      applyCorsHeaders(request, response, "GET, OPTIONS");

      if (request.method === "OPTIONS") {
        response.statusCode = 204;
        response.end();
        return;
      }

      if (request.method !== "GET") {
        response.setHeader("Allow", "GET, OPTIONS");
        sendJson(response, 405, { error: "Method Not Allowed" });
        return;
      }

      sendJson(response, 200, buildDisabledCollaborationStatus() as unknown as Record<string, unknown>);
    }
  };
}

function buildDisabledCollaborationStatus(): CollaborationStatus {
  return {
    enabled: false,
    adminExists: false,
    ready: false,
    bootstrapState: "disabled",
    workspaceExists: false,
    workspaceDefaultsInitialized: false,
    storageProfileExists: false,
    storageRootSessionExists: false,
  };
}

function ignoreSocketErrors(socket: Duplex): void {
  socket.once("error", () => {});
}

function rejectWebSocketUpgrade(
  socket: Duplex,
  statusCode: 401 | 403 | 404 | 500,
  message: string,
): void {
  if (socket.destroyed) {
    return;
  }

  ignoreSocketErrors(socket);

  const body = JSON.stringify({ error: message });
  const statusText =
    statusCode === 401
      ? "Unauthorized"
      : statusCode === 403
        ? "Forbidden"
        : statusCode === 404
          ? "Not Found"
          : "Internal Server Error";

  socket.end(
    [
      `HTTP/1.1 ${statusCode} ${statusText}`,
      "Connection: close",
      "Content-Type: application/json; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(body, "utf8")}`,
      "",
      body,
    ].join("\r\n"),
  );
}

async function tryWriteOwnedControlPidFile(pidFile: string): Promise<boolean> {
  const existingPid = await readControlPidFromFile(pidFile);
  if (existingPid !== null && existingPid !== process.pid) {
    try {
      if (isPidAlive(existingPid)) {
        console.warn(`[reboot] Control pid file is already owned by pid ${existingPid}: ${pidFile}`);
        return false;
      }
    } catch {
      // Ignore liveness errors and overwrite stale pid files below.
    }
  }

  await writeFile(pidFile, `${process.pid}\n`, "utf8");
  return true;
}

async function removeOwnedControlPidFile(pidFile: string): Promise<void> {
  try {
    const rawPid = await readFile(pidFile, "utf8");
    if (Number.parseInt(rawPid.trim(), 10) !== process.pid) {
      return;
    }
  } catch (error) {
    if (isErrorWithCode(error, "ENOENT")) {
      return;
    }

    throw error;
  }

  await rm(pidFile, { force: true });
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) {
    client.terminate();
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function resolveListeningPort(server: HttpServer, fallbackPort: number): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    return fallbackPort;
  }

  return address.port;
}
