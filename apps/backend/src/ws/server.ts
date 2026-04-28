import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type {
  CollaborationStatus,
  ServerEvent,
  TerminalClosedEvent,
  TerminalCreatedEvent,
  TerminalUpdatedEvent,
} from "@forge/protocol";
import { WebSocketServer } from "ws";
import type { IntegrationRegistryService } from "../integrations/registry.js";
import { MobilePushService } from "../mobile/mobile-push-service.js";
import {
  authenticateRequest,
  classifyCollaborationHttpRequest,
  evaluateCollaborationAdminAccess,
  evaluateCollaborationAuthenticatedAccess,
  evaluateCollaborationPasswordChangeAccess,
  setCollaborationRequestAuthContext,
  setCollaborationRequestCorsContext,
  validateCollaborationHttpOrigin,
} from "../collaboration/auth/collaboration-auth-middleware.js";
import { getOrCreateCollaborationBetterAuthService } from "../collaboration/auth/better-auth-service.js";
import type { CollaborationReadinessRequestService } from "../collaboration/readiness-service.js";
import type { CollaborationSettingsService } from "../collaboration/settings-service.js";

import type { PlaywrightDiscoveryService } from "../playwright/playwright-discovery-service.js";
import { PlaywrightLivePreviewProxy } from "../playwright/playwright-live-preview-proxy.js";
import { PlaywrightLivePreviewService } from "../playwright/playwright-live-preview-service.js";
import { PlaywrightSettingsService } from "../playwright/playwright-settings-service.js";
import {
  getControlPidFilePath,
  readControlPidFromFile,
  readDaemonizedEnv
} from "../reboot/control-pid.js";
import {
  CortexAutoReviewSettingsService
} from "../swarm/cortex-auto-review-settings.js";
import { isPidAlive } from "../swarm/platform.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { UnreadTracker } from "../swarm/unread-tracker.js";
import { isBuilderRuntimeTarget } from "../runtime-target.js";

import { applyCorsHeaders, resolveRequestUrl, sendJson } from "./http-utils.js";
import { createAgentHttpRoutes } from "./http/routes/agent-http-routes.js";
import { createChromeCdpRoutes } from "./http/routes/chrome-cdp-routes.js";
import { createCollaborationRoutes } from "./http/routes/collaboration-routes.js";
import { createCortexAutoReviewRoutes } from "./http/routes/cortex-auto-review-routes.js";
import { createCortexRoutes } from "./http/routes/cortex-routes.js";
import { createDebugRoutes } from "./http/routes/debug-routes.js";
import { createExtensionRoutes } from "./http/routes/extension-routes.js";
import { createFeedbackRoutes } from "./http/routes/feedback-routes.js";
import { createFileBrowserRoutes } from "./http/routes/file-browser-routes.js";
import { createFileRoutes } from "./http/routes/file-routes.js";
import { createGitDiffRoutes } from "./http/routes/git-diff-routes.js";
import { createHealthRoutes } from "./http/routes/health-routes.js";
import { createIntegrationRoutes } from "./http/routes/integration-routes.js";
import { createMermaidPreviewRoutes } from "./http/routes/mermaid-preview-routes.js";
import { createMobileRoutes } from "./http/routes/mobile-routes.js";
import { createModelConfigRoutes } from "./http/routes/model-config-routes.js";
import { createOpenRouterRoutes } from "./http/routes/openrouter-routes.js";
import { createPlaywrightLiveRoutes } from "./http/routes/playwright-live-routes.js";
import { createPlaywrightRoutes } from "./http/routes/playwright-routes.js";
import { createPromptRoutes } from "./http/routes/prompt-routes.js";
import { createSchedulerRoutes } from "./http/routes/scheduler-routes.js";
import { createSettingsRoutes, type SettingsRouteBundle } from "./http/routes/settings-routes.js";
import { createSkillRoutes } from "./http/routes/skill-routes.js";
import { createSlashCommandRoutes } from "./http/routes/slash-command-routes.js";
import { createSpecialistRoutes } from "./http/routes/specialist-routes.js";
import { createStatsRoutes } from "./http/routes/stats-routes.js";
import { createTelemetryRoutes } from "./http/routes/telemetry-routes.js";
import { createTerminalRoutes } from "./http/routes/terminal-routes.js";
import { createTranscriptionRoutes } from "./http/routes/transcription-routes.js";
import type { HttpRoute } from "./http/shared/http-route.js";
import type { PromptRegistryForRoutes } from "../swarm/prompt-contracts.js";
import { STATS_CACHE_TTL_MS, StatsService } from "../stats/stats-service.js";
import { TokenAnalyticsService } from "../stats/token-analytics-service.js";
import type { TelemetryService } from "../telemetry/telemetry-service.js";
import type { TerminalRuntimeConfig } from "../terminal/terminal-config.js";
import { TerminalSettingsService } from "../terminal/terminal-settings-service.js";
import type { TerminalService } from "../terminal/terminal-service.js";
import { TerminalWsProxy } from "../terminal/terminal-ws-proxy.js";
import { resolveSessionAgentIdForUnread } from "./unread-utils.js";
import { WsHandler } from "./ws-handler.js";

export class SwarmWebSocketServer {
  private readonly swarmManager: SwarmManager;
  private readonly host: string;
  private readonly port: number;
  private actualPort: number | null = null;
  private readonly integrationRegistry: IntegrationRegistryService | null;
  private readonly playwrightDiscovery: PlaywrightDiscoveryService | null;
  private readonly playwrightLivePreviewService: PlaywrightLivePreviewService;
  private readonly playwrightLivePreviewProxy: PlaywrightLivePreviewProxy;
  private readonly playwrightSettingsService: PlaywrightSettingsService;
  private readonly cortexAutoReviewSettingsService: CortexAutoReviewSettingsService;
  private readonly playwrightEnvEnabledOverride: boolean | undefined;
  private readonly terminalService: TerminalService | null;
  private readonly terminalRuntimeConfig: TerminalRuntimeConfig | null;
  private readonly terminalSettingsService: TerminalSettingsService;
  private readonly terminalWsProxy: TerminalWsProxy | null;
  private readonly unreadTracker: UnreadTracker;

  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;

  private readonly wsHandler: WsHandler;
  private readonly mobilePushService: MobilePushService;
  private readonly settingsRoutes: SettingsRouteBundle;
  private readonly statsService: StatsService;
  private readonly tokenAnalyticsService: TokenAnalyticsService;
  private readonly telemetryService: TelemetryService | null;
  private readonly collaborationSettingsService: CollaborationSettingsService | null;
  private readonly collaborationReadinessService: CollaborationReadinessRequestService | null;
  private readonly httpRoutes: HttpRoute[];
  private readonly controlPidFile: string;
  private readonly shouldManageControlPid: boolean;

  private statsRefreshInterval: NodeJS.Timeout | null = null;
  private tokenAnalyticsRefreshInterval: NodeJS.Timeout | null = null;

  private ownsControlPidFile = false;

  private readonly onConversationMessage = (event: ServerEvent): void => {
    if (event.type !== "conversation_message") return;
    this.wsHandler.broadcastToSubscribed(event);

    const shouldBroadcastUnread =
      !this.isUnreadNotificationSuppressed(event.agentId) &&
      (
        (event.role === "assistant" && event.source === "speak_to_user") ||
        event.source === "project_agent_input"
      );

    if (shouldBroadcastUnread) {
      const sessionAgentId = resolveSessionAgentIdForUnread(this.swarmManager, event.agentId);
      if (!sessionAgentId) {
        return;
      }

      this.wsHandler.broadcastToSubscribed({
        type: "unread_notification",
        agentId: event.agentId,
        reason: "message",
        sessionAgentId,
      });

      if (!this.wsHandler.hasActiveSubscriptionForSession(sessionAgentId)) {
        const { profileId } = this.resolveUnreadContext(sessionAgentId);
        if (profileId) {
          const newCount = this.unreadTracker.increment(profileId, sessionAgentId);
          this.wsHandler.broadcastUnreadCountUpdate(sessionAgentId, newCount);
        }
      }
    }
  };

  private readonly onConversationLog = (event: ServerEvent): void => {
    if (event.type !== "conversation_log") return;
    this.wsHandler.broadcastToSubscribed(event);
  };

  private readonly onAgentMessage = (event: ServerEvent): void => {
    if (event.type !== "agent_message") return;
    this.wsHandler.broadcastToSubscribed(event);
  };

  private readonly onAgentToolCall = (event: ServerEvent): void => {
    if (event.type !== "agent_tool_call") return;
    this.wsHandler.broadcastToSubscribed(event);
  };

  private readonly onChoiceRequest = (event: ServerEvent): void => {
    if (event.type !== "choice_request") return;

    this.wsHandler.broadcastToSubscribed(event);

    if (event.status === "pending") {
      const sessionAgentId = resolveSessionAgentIdForUnread(this.swarmManager, event.agentId);
      if (!sessionAgentId) {
        return;
      }

      this.wsHandler.broadcastToSubscribed({
        type: "unread_notification",
        agentId: event.agentId,
        reason: "choice_request",
        sessionAgentId,
      });

      if (!this.wsHandler.hasActiveSubscriptionForSession(sessionAgentId)) {
        const { profileId } = this.resolveUnreadContext(sessionAgentId);
        if (profileId) {
          const newCount = this.unreadTracker.increment(profileId, sessionAgentId);
          this.wsHandler.broadcastUnreadCountUpdate(sessionAgentId, newCount);
        }
      }
    }
  };

  private readonly onConversationReset = (event: ServerEvent): void => {
    if (event.type !== "conversation_reset") return;
    this.wsHandler.broadcastToSubscribed(event);
  };

  private readonly onMessagePinned = (event: ServerEvent): void => {
    if (event.type !== "message_pinned") return;
    this.wsHandler.broadcastToSubscribed(event);
  };

  private readonly onAgentStatus = (event: ServerEvent): void => {
    if (event.type !== "agent_status") return;
    this.wsHandler.broadcastToSubscribed(event);
  };

  private readonly onSessionWorkersSnapshot = (event: ServerEvent): void => {
    if (event.type !== "session_workers_snapshot") return;
    this.wsHandler.broadcastToSubscribed(event);
  };

  private readonly onAgentsSnapshot = (event: ServerEvent): void => {
    if (event.type !== "agents_snapshot") return;
    this.wsHandler.broadcastToSubscribed(event);
  };

  private readonly onProfilesSnapshot = (event: ServerEvent): void => {
    if (event.type !== "profiles_snapshot") return;
    this.wsHandler.broadcastToSubscribed(event);
  };

  private readonly onTelegramStatus = (event: ServerEvent): void => {
    if (event.type !== "telegram_status") return;
    this.wsHandler.broadcastToSubscribed(event);
  };

  private readonly onPlaywrightDiscoverySnapshot = (event: ServerEvent): void => {
    if (event.type !== "playwright_discovery_snapshot") return;
    this.wsHandler.broadcastToSubscribed(event);
  };

  private readonly onPlaywrightDiscoveryUpdated = (event: ServerEvent): void => {
    if (event.type !== "playwright_discovery_updated") return;
    this.wsHandler.broadcastToSubscribed(event);
  };

  private readonly onPlaywrightDiscoverySettingsUpdated = (event: ServerEvent): void => {
    if (event.type !== "playwright_discovery_settings_updated") return;
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

  private isUnreadNotificationSuppressed(agentId: string): boolean {
    const descriptor = this.swarmManager.getAgent(agentId);
    return descriptor?.role === "manager" && descriptor.sessionPurpose === "cortex_review";
  }

  private resolveUnreadContext(sessionAgentId: string): { profileId: string | null } {
    const descriptor = this.swarmManager.getAgent(sessionAgentId);
    if (!descriptor || descriptor.role !== "manager") {
      return { profileId: null };
    }

    return { profileId: descriptor.profileId ?? descriptor.agentId };
  }


  constructor(options: {
    swarmManager: SwarmManager;
    host: string;
    port: number;
    allowNonManagerSubscriptions: boolean;
    integrationRegistry?: IntegrationRegistryService;
    playwrightDiscovery?: PlaywrightDiscoveryService | null;
    playwrightLivePreviewService?: PlaywrightLivePreviewService;
    playwrightSettingsService?: PlaywrightSettingsService;
    playwrightEnvEnabledOverride?: boolean;
    terminalService?: TerminalService | null;
    terminalRuntimeConfig?: TerminalRuntimeConfig | null;
    terminalSettingsService?: TerminalSettingsService;
    promptRegistry?: PromptRegistryForRoutes;
    unreadTracker?: UnreadTracker;
    statsService?: StatsService;
    telemetryService?: TelemetryService | null;
    collaborationSettingsService?: CollaborationSettingsService;
    collaborationReadinessService?: CollaborationReadinessRequestService;
  }) {
    this.swarmManager = options.swarmManager;
    this.host = options.host;
    this.port = options.port;
    this.integrationRegistry = options.integrationRegistry ?? null;
    this.playwrightDiscovery = options.playwrightDiscovery ?? null;
    this.playwrightLivePreviewService =
      options.playwrightLivePreviewService ??
      new PlaywrightLivePreviewService({ discoveryService: this.playwrightDiscovery });
    this.playwrightLivePreviewProxy = new PlaywrightLivePreviewProxy({
      livePreviewService: this.playwrightLivePreviewService,
    });
    this.playwrightSettingsService =
      options.playwrightSettingsService ??
      new PlaywrightSettingsService({ dataDir: this.swarmManager.getConfig().paths.dataDir });
    const cortexEnabled = this.swarmManager.getConfig().cortexEnabled;
    this.cortexAutoReviewSettingsService = new CortexAutoReviewSettingsService({
      dataDir: this.swarmManager.getConfig().paths.dataDir,
      cortexEnabled,
    });
    this.playwrightEnvEnabledOverride = options.playwrightEnvEnabledOverride;
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
                (descriptor.profileId ?? descriptor.agentId) === profileId,
            )
            .map((descriptor) => descriptor.agentId) ?? [],
      });

    let wsHandlerRef: WsHandler | null = null;

    this.mobilePushService = new MobilePushService({
      swarmManager: this.swarmManager,
      dataDir: this.swarmManager.getConfig().paths.dataDir,
      isSessionActive: (sessionAgentId) => wsHandlerRef?.hasActiveSubscription(sessionAgentId) ?? false
    });
    this.controlPidFile = getControlPidFilePath(
      this.swarmManager.getConfig().paths.rootDir,
      this.swarmManager.getConfig().port
    );
    this.shouldManageControlPid =
      !this.swarmManager.getConfig().isDesktop && readDaemonizedEnv() !== "1";

    this.wsHandler = new WsHandler({
      swarmManager: this.swarmManager,
      integrationRegistry: this.integrationRegistry,
      mobilePushService: this.mobilePushService,
      playwrightDiscovery: this.playwrightDiscovery,
      allowNonManagerSubscriptions: options.allowNonManagerSubscriptions,
      terminalService: this.terminalService,
      listTerminalsForSession: this.terminalService
        ? (sessionAgentId) => this.terminalService?.listTerminals(sessionAgentId) ?? []
        : undefined,
      unreadTracker: this.unreadTracker,
      perf: this.swarmManager.getSidebarPerfRecorder(),
    });
    wsHandlerRef = this.wsHandler;

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
      statsService: this.statsService,
    });
    this.tokenAnalyticsService = new TokenAnalyticsService(this.swarmManager);

    this.httpRoutes = [
      ...(isBuilderRuntimeTarget(this.swarmManager.getConfig().runtimeTarget)
        ? [createDisabledCollaborationStatusRoute()]
        : []),
      ...(this.collaborationSettingsService
        ? createCollaborationRoutes({
            config: this.swarmManager.getConfig(),
            settingsService: this.collaborationSettingsService,
            readinessService: this.collaborationReadinessService ?? undefined,
            swarmManager: this.swarmManager,
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
      ...createFileBrowserRoutes({ swarmManager: this.swarmManager }),
      ...createGitDiffRoutes({ swarmManager: this.swarmManager }),
      ...createFeedbackRoutes({ swarmManager: this.swarmManager }),
      ...createCortexRoutes({ swarmManager: this.swarmManager, cortexEnabled }),
      ...createCortexAutoReviewRoutes({
        settingsService: this.cortexAutoReviewSettingsService,
        cortexEnabled,
      }),
      ...createDebugRoutes({ swarmManager: this.swarmManager }),
      ...createTranscriptionRoutes({ swarmManager: this.swarmManager }),
      ...createStatsRoutes({
        statsService: this.statsService,
        tokenAnalyticsService: this.tokenAnalyticsService,
      }),
      ...(this.telemetryService ? createTelemetryRoutes({ telemetryService: this.telemetryService }) : []),
      ...createSchedulerRoutes({ swarmManager: this.swarmManager }),
      ...createSlashCommandRoutes({ swarmManager: this.swarmManager }),
      ...createMobileRoutes({ mobilePushService: this.mobilePushService }),
      ...createAgentHttpRoutes({ swarmManager: this.swarmManager }),
      ...(this.terminalService ? createTerminalRoutes({ terminalService: this.terminalService, settingsService: this.terminalSettingsService }) : []),
      ...this.settingsRoutes.routes,
      ...createSpecialistRoutes({
        swarmManager: this.swarmManager,
        broadcastEvent: (event) => this.wsHandler.broadcastToSubscribed(event),
      }),
      ...createModelConfigRoutes({
        swarmManager: this.swarmManager,
        broadcastEvent: (event) => this.wsHandler.broadcastToSubscribed(event),
      }),
      ...createOpenRouterRoutes({
        swarmManager: this.swarmManager,
        broadcastEvent: (event) => this.wsHandler.broadcastToSubscribed(event),
      }),
      ...createExtensionRoutes({ swarmManager: this.swarmManager }),
      ...createSkillRoutes({ swarmManager: this.swarmManager }),
      ...createChromeCdpRoutes({ swarmManager: this.swarmManager }),
      ...createPlaywrightRoutes({
        discoveryService: this.playwrightDiscovery,
        settingsService: this.playwrightSettingsService,
        envEnabledOverride: this.playwrightEnvEnabledOverride,
      }),
      ...createPlaywrightLiveRoutes({
        livePreviewService: this.playwrightLivePreviewService,
      }),
      ...createMermaidPreviewRoutes(),
      ...createIntegrationRoutes({
        swarmManager: this.swarmManager,
        integrationRegistry: this.integrationRegistry
      }),
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
    ];
  }

  async start(): Promise<void> {
    if (this.httpServer || this.wss) {
      return;
    }

    await this.cortexAutoReviewSettingsService.load();
    await this.unreadTracker.load();

    const httpServer = createServer((request, response) => {
      void this.handleHttpRequest(request, response);
    });
    const wss = new WebSocketServer({ noServer: true });

    this.httpServer = httpServer;
    this.wss = wss;

    this.wsHandler.attach(wss);
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
    this.swarmManager.on("agent_message", this.onAgentMessage);
    this.swarmManager.on("agent_tool_call", this.onAgentToolCall);
    this.swarmManager.on("choice_request", this.onChoiceRequest);
    this.swarmManager.on("conversation_reset", this.onConversationReset);
    this.swarmManager.on("message_pinned", this.onMessagePinned);
    this.swarmManager.on("agent_status", this.onAgentStatus);
    this.swarmManager.on("session_workers_snapshot", this.onSessionWorkersSnapshot);
    this.swarmManager.on("agents_snapshot", this.onAgentsSnapshot);
    this.swarmManager.on("profiles_snapshot", this.onProfilesSnapshot);
    this.integrationRegistry?.on("telegram_status", this.onTelegramStatus);
    this.playwrightDiscovery?.on("playwright_discovery_snapshot", this.onPlaywrightDiscoverySnapshot);
    this.playwrightDiscovery?.on("playwright_discovery_updated", this.onPlaywrightDiscoveryUpdated);
    this.playwrightDiscovery?.on("playwright_discovery_settings_updated", this.onPlaywrightDiscoverySettingsUpdated);
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

    // Backstop behavior: keep an automatic refresh cadence (every cache TTL) so telemetry still
    // gets refresh-completion triggers even when nobody calls /api/stats/refresh manually.
    // Avoid an unconditional startup stats refresh here so provider-usage auth probing only runs
    // on demand or on the scheduled background cadence.
    void this.tokenAnalyticsService.prewarmInBackground().catch(() => false);
    this.statsRefreshInterval = setInterval(() => {
      refreshStatsInBackground();
    }, STATS_CACHE_TTL_MS);
    this.statsRefreshInterval.unref?.();
    this.tokenAnalyticsRefreshInterval = setInterval(() => {
      refreshTokenAnalyticsInBackground();
    }, STATS_CACHE_TTL_MS);
    this.tokenAnalyticsRefreshInterval.unref?.();

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

    this.swarmManager.off("conversation_message", this.onConversationMessage);
    this.swarmManager.off("conversation_log", this.onConversationLog);
    this.swarmManager.off("agent_message", this.onAgentMessage);
    this.swarmManager.off("agent_tool_call", this.onAgentToolCall);
    this.swarmManager.off("choice_request", this.onChoiceRequest);
    this.swarmManager.off("conversation_reset", this.onConversationReset);
    this.swarmManager.off("message_pinned", this.onMessagePinned);
    this.swarmManager.off("agent_status", this.onAgentStatus);
    this.swarmManager.off("session_workers_snapshot", this.onSessionWorkersSnapshot);
    this.swarmManager.off("agents_snapshot", this.onAgentsSnapshot);
    this.swarmManager.off("profiles_snapshot", this.onProfilesSnapshot);
    this.integrationRegistry?.off("telegram_status", this.onTelegramStatus);
    this.playwrightDiscovery?.off("playwright_discovery_snapshot", this.onPlaywrightDiscoverySnapshot);
    this.playwrightDiscovery?.off("playwright_discovery_updated", this.onPlaywrightDiscoveryUpdated);
    this.playwrightDiscovery?.off("playwright_discovery_settings_updated", this.onPlaywrightDiscoverySettingsUpdated);
    this.terminalService?.off("terminal_created", this.onTerminalCreated);
    this.terminalService?.off("terminal_updated", this.onTerminalUpdated);
    this.terminalService?.off("terminal_closed", this.onTerminalClosed);

    const currentWss = this.wss;
    const currentHttpServer = this.httpServer;

    this.wss = null;
    this.httpServer = null;
    this.actualPort = null;

    this.wsHandler.reset();
    this.settingsRoutes.cancelActiveSettingsAuthLoginFlows();
    this.telemetryService?.stop();

    await Promise.allSettled([
      this.mobilePushService.stop(),
      this.unreadTracker.flush(),
      this.terminalWsProxy?.stop() ?? Promise.resolve(),
      this.playwrightLivePreviewProxy.stop(),
      currentWss ? closeWebSocketServer(currentWss) : Promise.resolve(),
      currentHttpServer ? closeHttpServer(currentHttpServer) : Promise.resolve(),
    ]);

    if (this.ownsControlPidFile) {
      await removeOwnedControlPidFile(this.controlPidFile);
      this.ownsControlPidFile = false;
    }
  }

  private async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (!this.httpServer || !this.wss) {
      ignoreSocketErrors(socket);
      socket.destroy();
      return;
    }

    const requestUrl = resolveRequestUrl(request, `${this.host}:${this.getPort()}`);
    if (this.terminalWsProxy?.canHandleUpgrade(requestUrl.pathname)) {
      const handled = this.terminalWsProxy.handleUpgrade(request, socket, head, requestUrl.pathname);
      if (handled) {
        return;
      }
    }

    if (this.playwrightLivePreviewProxy.canHandleUpgrade(requestUrl.pathname)) {
      const handled = this.playwrightLivePreviewProxy.handleUpgrade(request, socket, head, requestUrl.pathname);
      if (handled) {
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
      wss.emit("connection", client, request);
    });
  }

  private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = resolveRequestUrl(request, `${this.host}:${this.getPort()}`);
    let route: HttpRoute | undefined;

    try {
      if (!isBuilderRuntimeTarget(this.swarmManager.getConfig().runtimeTarget)) {
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

        const accessClass = classifyCollaborationHttpRequest(requestUrl.pathname, request.method);
        if (accessClass === "authenticated") {
          const access = evaluateCollaborationAuthenticatedAccess(authContext);
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
