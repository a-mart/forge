import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { ServerEvent } from "@forge/protocol";
import { WebSocketServer } from "ws";
import type { IntegrationRegistryService } from "../integrations/registry.js";
import { MobilePushService } from "../mobile/mobile-push-service.js";
import type { PlaywrightDiscoveryService } from "../playwright/playwright-discovery-service.js";
import { PlaywrightLivePreviewProxy } from "../playwright/playwright-live-preview-proxy.js";
import { PlaywrightLivePreviewService } from "../playwright/playwright-live-preview-service.js";
import { PlaywrightSettingsService } from "../playwright/playwright-settings-service.js";
import {
  getControlPidFilePath,
  readControlPidFromFile,
  readDaemonizedEnv
} from "../reboot/control-pid.js";
import { isPidAlive } from "../swarm/platform.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { applyCorsHeaders, resolveRequestUrl, sendJson } from "./http-utils.js";
import { createAgentHttpRoutes } from "./routes/agent-routes.js";
import { createChromeCdpRoutes } from "./routes/chrome-cdp-routes.js";
import { createCortexRoutes } from "./routes/cortex-routes.js";
import { createFileRoutes } from "./routes/file-routes.js";
import { createFeedbackRoutes } from "./routes/feedback-routes.js";
import { createFileBrowserRoutes } from "./routes/file-browser-routes.js";
import { createGitDiffRoutes } from "./routes/git-diff-routes.js";
import { createHealthRoutes } from "./routes/health-routes.js";
import type { HttpRoute } from "./routes/http-route.js";
import { createIntegrationRoutes } from "./routes/integration-routes.js";
import { createMobileRoutes } from "./routes/mobile-routes.js";
import { createPlaywrightLiveRoutes } from "./routes/playwright-live-routes.js";
import { createPlaywrightRoutes } from "./routes/playwright-routes.js";
import { createPromptRoutes, type PromptRegistryForRoutes } from "./routes/prompt-routes.js";
import { createSchedulerRoutes } from "./routes/scheduler-routes.js";
import { createSettingsRoutes, type SettingsRouteBundle } from "./routes/settings-routes.js";
import { createSlashCommandRoutes } from "./routes/slash-command-routes.js";
import { createTranscriptionRoutes } from "./routes/transcription-routes.js";
import { STATS_CACHE_TTL_MS, StatsService } from "../stats/stats-service.js";
import { createStatsRoutes } from "./routes/stats-routes.js";
import { WsHandler } from "./ws-handler.js";

export class SwarmWebSocketServer {
  private readonly swarmManager: SwarmManager;
  private readonly host: string;
  private readonly port: number;
  private readonly integrationRegistry: IntegrationRegistryService | null;
  private readonly playwrightDiscovery: PlaywrightDiscoveryService | null;
  private readonly playwrightLivePreviewService: PlaywrightLivePreviewService;
  private readonly playwrightLivePreviewProxy: PlaywrightLivePreviewProxy;
  private readonly playwrightSettingsService: PlaywrightSettingsService;
  private readonly playwrightEnvEnabledOverride: boolean | undefined;

  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;

  private readonly wsHandler: WsHandler;
  private readonly mobilePushService: MobilePushService;
  private readonly settingsRoutes: SettingsRouteBundle;
  private readonly statsService: StatsService;
  private readonly httpRoutes: HttpRoute[];
  private readonly controlPidFile: string;
  private readonly shouldManageControlPid: boolean;

  private statsRefreshInterval: NodeJS.Timeout | null = null;

  private ownsControlPidFile = false;

  private readonly onConversationMessage = (event: ServerEvent): void => {
    if (event.type !== "conversation_message") return;
    this.wsHandler.broadcastToSubscribed(event);

    if (
      event.role === "assistant" &&
      event.source === "speak_to_user" &&
      !this.isUnreadNotificationSuppressed(event.agentId)
    ) {
      this.wsHandler.broadcastToSubscribed({
        type: "unread_notification",
        agentId: event.agentId,
      });
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
      this.wsHandler.broadcastToSubscribed({
        type: "unread_notification",
        agentId: event.agentId,
      });
    }
  };

  private readonly onConversationReset = (event: ServerEvent): void => {
    if (event.type !== "conversation_reset") return;
    this.wsHandler.broadcastToSubscribed(event);
  };

  private readonly onAgentStatus = (event: ServerEvent): void => {
    if (event.type !== "agent_status") return;
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

  private isUnreadNotificationSuppressed(agentId: string): boolean {
    const descriptor = this.swarmManager.getAgent(agentId);
    return descriptor?.role === "manager" && descriptor.sessionPurpose === "cortex_review";
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
    promptRegistry?: PromptRegistryForRoutes;
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
    this.playwrightEnvEnabledOverride = options.playwrightEnvEnabledOverride;

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
    this.shouldManageControlPid = readDaemonizedEnv() !== "1";

    this.wsHandler = new WsHandler({
      swarmManager: this.swarmManager,
      integrationRegistry: this.integrationRegistry,
      mobilePushService: this.mobilePushService,
      playwrightDiscovery: this.playwrightDiscovery,
      allowNonManagerSubscriptions: options.allowNonManagerSubscriptions
    });
    wsHandlerRef = this.wsHandler;

    this.settingsRoutes = createSettingsRoutes({ swarmManager: this.swarmManager });
    this.statsService = new StatsService(this.swarmManager);
    this.httpRoutes = [
      ...createHealthRoutes({
        resolveControlPidFile: () => this.controlPidFile
      }),
      ...createFileRoutes({
        swarmManager: this.swarmManager,
        broadcastEvent: (event) => this.wsHandler.broadcastToSubscribed(event),
      }),
      ...createFileBrowserRoutes({ swarmManager: this.swarmManager }),
      ...createGitDiffRoutes({ swarmManager: this.swarmManager }),
      ...createFeedbackRoutes({ swarmManager: this.swarmManager }),
      ...createCortexRoutes({ swarmManager: this.swarmManager }),
      ...createTranscriptionRoutes({ swarmManager: this.swarmManager }),
      ...createStatsRoutes({ statsService: this.statsService }),
      ...createSchedulerRoutes({ swarmManager: this.swarmManager }),
      ...createSlashCommandRoutes({ swarmManager: this.swarmManager }),
      ...createMobileRoutes({ mobilePushService: this.mobilePushService }),
      ...createAgentHttpRoutes({ swarmManager: this.swarmManager }),
      ...this.settingsRoutes.routes,
      ...createChromeCdpRoutes({ swarmManager: this.swarmManager }),
      ...createPlaywrightRoutes({
        discoveryService: this.playwrightDiscovery,
        settingsService: this.playwrightSettingsService,
        envEnabledOverride: this.playwrightEnvEnabledOverride,
      }),
      ...createPlaywrightLiveRoutes({
        livePreviewService: this.playwrightLivePreviewService,
      }),
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
          })
        : []),
    ];
  }

  async start(): Promise<void> {
    if (this.httpServer || this.wss) {
      return;
    }

    const httpServer = createServer((request, response) => {
      void this.handleHttpRequest(request, response);
    });
    const wss = new WebSocketServer({ noServer: true });

    this.httpServer = httpServer;
    this.wss = wss;

    this.wsHandler.attach(wss);
    httpServer.on("upgrade", (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });

    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        cleanup();
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
    this.swarmManager.on("agent_status", this.onAgentStatus);
    this.swarmManager.on("agents_snapshot", this.onAgentsSnapshot);
    this.swarmManager.on("profiles_snapshot", this.onProfilesSnapshot);
    this.integrationRegistry?.on("telegram_status", this.onTelegramStatus);
    this.playwrightDiscovery?.on("playwright_discovery_snapshot", this.onPlaywrightDiscoverySnapshot);
    this.playwrightDiscovery?.on("playwright_discovery_updated", this.onPlaywrightDiscoveryUpdated);
    this.playwrightDiscovery?.on("playwright_discovery_settings_updated", this.onPlaywrightDiscoverySettingsUpdated);
    await this.mobilePushService.start();

    void this.statsService.refreshAllRangesInBackground();
    this.statsRefreshInterval = setInterval(() => {
      void this.statsService.refreshAllRangesInBackground();
    }, STATS_CACHE_TTL_MS);
    this.statsRefreshInterval.unref?.();
  }

  async stop(): Promise<void> {
    if (this.statsRefreshInterval) {
      clearInterval(this.statsRefreshInterval);
      this.statsRefreshInterval = null;
    }

    this.swarmManager.off("conversation_message", this.onConversationMessage);
    this.swarmManager.off("conversation_log", this.onConversationLog);
    this.swarmManager.off("agent_message", this.onAgentMessage);
    this.swarmManager.off("agent_tool_call", this.onAgentToolCall);
    this.swarmManager.off("choice_request", this.onChoiceRequest);
    this.swarmManager.off("conversation_reset", this.onConversationReset);
    this.swarmManager.off("agent_status", this.onAgentStatus);
    this.swarmManager.off("agents_snapshot", this.onAgentsSnapshot);
    this.swarmManager.off("profiles_snapshot", this.onProfilesSnapshot);
    this.integrationRegistry?.off("telegram_status", this.onTelegramStatus);
    this.playwrightDiscovery?.off("playwright_discovery_snapshot", this.onPlaywrightDiscoverySnapshot);
    this.playwrightDiscovery?.off("playwright_discovery_updated", this.onPlaywrightDiscoveryUpdated);
    this.playwrightDiscovery?.off("playwright_discovery_settings_updated", this.onPlaywrightDiscoverySettingsUpdated);

    const currentWss = this.wss;
    const currentHttpServer = this.httpServer;

    this.wss = null;
    this.httpServer = null;

    this.wsHandler.reset();
    this.settingsRoutes.cancelActiveSettingsAuthLoginFlows();

    await Promise.allSettled([
      this.mobilePushService.stop(),
      this.playwrightLivePreviewProxy.stop(),
      currentWss ? closeWebSocketServer(currentWss) : Promise.resolve(),
      currentHttpServer ? closeHttpServer(currentHttpServer) : Promise.resolve(),
    ]);

    if (this.ownsControlPidFile) {
      await removeOwnedControlPidFile(this.controlPidFile);
      this.ownsControlPidFile = false;
    }
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.httpServer || !this.wss) {
      socket.destroy();
      return;
    }

    const requestUrl = resolveRequestUrl(request, `${this.host}:${this.port}`);
    if (this.playwrightLivePreviewProxy.canHandleUpgrade(requestUrl.pathname)) {
      const handled = this.playwrightLivePreviewProxy.handleUpgrade(request, socket, head, requestUrl.pathname);
      if (handled) {
        return;
      }
    }

    this.wss.handleUpgrade(request, socket, head, (client) => {
      this.wss?.emit("connection", client, request);
    });
  }

  private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = resolveRequestUrl(request, `${this.host}:${this.port}`);
    const route = this.httpRoutes.find((candidate) => candidate.matches(requestUrl.pathname));

    if (!route) {
      response.statusCode = 404;
      response.end("Not Found");
      return;
    }

    try {
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

      applyCorsHeaders(request, response, route.methods);
      sendJson(response, statusCode, { error: message });
    }
  }
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
