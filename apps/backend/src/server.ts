import { formatIntegrationContext } from "./integrations/integration-context.js";
import { IntegrationRegistryService } from "./integrations/registry.js";
import { PlaywrightDiscoveryService } from "./playwright/playwright-discovery-service.js";
import { PlaywrightLivePreviewService } from "./playwright/playwright-live-preview-service.js";
import { PlaywrightSettingsService } from "./playwright/playwright-settings-service.js";
import { readPlaywrightDashboardEnvOverride, createConfig } from "./config.js";
import { CronSchedulerService } from "./scheduler/cron-scheduler-service.js";
import { getScheduleFilePath } from "./scheduler/schedule-storage.js";
import { acquireRuntimeLock, type RuntimeLock } from "./runtime-lock.js";
import { SwarmManager } from "./swarm/swarm-manager.js";
import { seedBuiltins } from "./swarm/specialists/specialist-registry.js";
import { UnreadTracker } from "./swarm/unread-tracker.js";
import type { AgentDescriptor, SessionLifecycleEvent, SwarmConfig } from "./swarm/types.js";
import { readTerminalRuntimeConfig } from "./terminal/terminal-config.js";
import { TerminalPersistence } from "./terminal/terminal-persistence.js";
import { NodePtyRuntime } from "./terminal/terminal-pty-runtime.js";
import type { TerminalSessionResolver } from "./terminal/terminal-session-resolver.js";
import { TerminalService } from "./terminal/terminal-service.js";
import { EmbeddedGitVersioningService } from "./versioning/embedded-git-versioning-service.js";
import { SwarmWebSocketServer } from "./ws/server.js";

export interface ServerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ServerReadyInfo {
  host: string;
  port: number;
  config: SwarmConfig;
}

export interface StartServerOptions {
  config?: SwarmConfig;
  logger?: Partial<ServerLogger>;
  onReady?: (info: ServerReadyInfo) => Promise<void> | void;
}

export interface StartedServer extends ServerReadyInfo {
  stop(): Promise<void>;
  stopListening(): Promise<void>;
  startListening(): Promise<void>;
}

let activeServer: BackendServer | null = null;

export async function startServer(options: StartServerOptions = {}): Promise<StartedServer> {
  if (activeServer) {
    throw new Error("Server already started");
  }

  const config = options.config ?? createConfig();
  const logger = createLogger(options.logger);

  const runtimeLock = acquireRuntimeLock(config.paths.dataDir);

  // Ensure the lock is released even on unclean exits (Ctrl+C, crashes, SIGTERM)
  const emergencyRelease = () => {
    try { runtimeLock.release(); } catch { /* best effort */ }
  };
  process.once("exit", emergencyRelease);
  process.once("SIGINT", emergencyRelease);
  process.once("SIGTERM", emergencyRelease);

  const versioningService = new EmbeddedGitVersioningService({
    dataDir: config.paths.dataDir,
    logger,
  });
  await versioningService.start();

  await seedBuiltins(config.paths.dataDir);

  const swarmManager = new SwarmManager(config, {
    versioningService,
  });

  const schedulersByProfileId = new Map<string, CronSchedulerService>();
  let schedulerLifecycle: Promise<void> = Promise.resolve();

  const syncSchedulers = async (profileIds: Set<string>): Promise<void> => {
    for (const profileId of profileIds) {
      if (schedulersByProfileId.has(profileId)) {
        continue;
      }

      const scheduler = new CronSchedulerService({
        swarmManager,
        schedulesFile: getScheduleFilePath(config.paths.dataDir, profileId),
        managerId: profileId,
      });
      await scheduler.start();
      schedulersByProfileId.set(profileId, scheduler);
    }

    for (const [profileId, scheduler] of schedulersByProfileId.entries()) {
      if (profileIds.has(profileId)) {
        continue;
      }

      await scheduler.stop();
      schedulersByProfileId.delete(profileId);
    }
  };

  const queueSchedulerSync = (profileIds: Set<string>): Promise<void> => {
    const next = schedulerLifecycle.then(
      () => syncSchedulers(profileIds),
      () => syncSchedulers(profileIds),
    );
    schedulerLifecycle = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const handleAgentsSnapshot = (event: unknown): void => {
    if (!event || typeof event !== "object") {
      return;
    }

    const payload = event as { type?: string; agents?: unknown };
    if (payload.type !== "agents_snapshot" || !Array.isArray(payload.agents)) {
      return;
    }

    const profileIds = collectSchedulerProfileIds(payload.agents, config.managerId);
    void queueSchedulerSync(profileIds).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[scheduler] Failed to sync scheduler instances: ${message}`);
    });
  };

  const integrationRegistry = new IntegrationRegistryService({
    swarmManager,
    dataDir: config.paths.dataDir,
    defaultManagerId: config.managerId,
  });
  const playwrightSettingsService = new PlaywrightSettingsService({
    dataDir: config.paths.dataDir,
  });
  const playwrightEnvEnabledOverride = readPlaywrightDashboardEnvOverride();

  let playwrightDiscovery: PlaywrightDiscoveryService | null = null;
  let playwrightLivePreviewService: PlaywrightLivePreviewService | null = null;
  let terminalService: TerminalService | null = null;
  let handleTerminalSessionLifecycle: (event: SessionLifecycleEvent) => void = () => undefined;
  let handleTerminalAgentsSnapshot: () => void = () => undefined;
  let server: BackendServer | null = null;

  try {
    await swarmManager.boot();

    const unreadTracker = new UnreadTracker({
      dataDir: config.paths.dataDir,
      getProfileIds: () => swarmManager.listProfiles().map((profile) => profile.profileId),
      getSessionAgentIds: (profileId) =>
        swarmManager
          .listAgents()
          .filter((descriptor) => descriptor.role === "manager" && (descriptor.profileId ?? descriptor.agentId) === profileId)
          .map((descriptor) => descriptor.agentId),
    });

    await queueSchedulerSync(collectSchedulerProfileIds(swarmManager.listAgents(), config.managerId));
    swarmManager.on("agents_snapshot", handleAgentsSnapshot);

    const terminalRuntimeConfig = readTerminalRuntimeConfig();
    const terminalSessionResolver: TerminalSessionResolver = {
      resolveSession: (sessionAgentId) => {
        const descriptor = swarmManager.getAgent(sessionAgentId);
        if (!descriptor || descriptor.role !== "manager") {
          return undefined;
        }

        return {
          sessionAgentId: descriptor.profileId ?? descriptor.agentId,
          profileId: descriptor.profileId ?? descriptor.agentId,
          cwd: descriptor.cwd,
        };
      },
      listSessions: () => {
        const scopes = new Map<string, { sessionAgentId: string; profileId: string; cwd: string }>();
        for (const descriptor of swarmManager.listAgents()) {
          if (descriptor.role !== "manager") {
            continue;
          }

          const scopeAgentId = descriptor.profileId ?? descriptor.agentId;
          if (!scopes.has(scopeAgentId)) {
            scopes.set(scopeAgentId, {
              sessionAgentId: scopeAgentId,
              profileId: descriptor.profileId ?? descriptor.agentId,
              cwd: descriptor.cwd,
            });
          }
        }

        return Array.from(scopes.values());
      },
    };
    const terminalPersistence = new TerminalPersistence({
      dataDir: config.paths.dataDir,
      scrollbackLines: terminalRuntimeConfig.scrollbackLines,
      journalMaxBytes: terminalRuntimeConfig.journalMaxBytes,
    });
    const terminalPtyRuntime = new NodePtyRuntime({
      outputBatchIntervalMs: terminalRuntimeConfig.outputBatchIntervalMs,
      defaultShell: terminalRuntimeConfig.defaultShell,
    });
    terminalService = new TerminalService({
      dataDir: config.paths.dataDir,
      runtimeConfig: terminalRuntimeConfig,
      sessionResolver: terminalSessionResolver,
      ptyRuntime: terminalPtyRuntime,
      persistence: terminalPersistence,
      cwdPolicy: {
        rootDir: config.paths.rootDir,
        allowlistRoots: config.cwdAllowlistRoots,
      },
    });
    handleTerminalSessionLifecycle = (event: SessionLifecycleEvent): void => {
      if (event.action !== "deleted") {
        return;
      }

      void terminalService?.cleanupSession(event.sessionAgentId, "session_deleted").catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[terminal] Failed to cleanup deleted session terminals: ${message}`);
      });
    };
    handleTerminalAgentsSnapshot = (): void => {
      void terminalService?.reconcileSessions().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[terminal] Failed to reconcile session terminals: ${message}`);
      });
    };
    swarmManager.on("session_lifecycle", handleTerminalSessionLifecycle);
    swarmManager.on("agents_snapshot", handleTerminalAgentsSnapshot);
    try {
      const terminalInit = await terminalService.initialize();
      logger.info(
        `[terminal] initialized restoredRunning=${terminalInit.restoredRunning} restoredExited=${terminalInit.restoredExited} restoreFailed=${terminalInit.restoreFailed} cleanedOrphans=${terminalInit.cleanedOrphans} skipped=${terminalInit.skipped}`,
      );
    } catch (error) {
      swarmManager.off("session_lifecycle", handleTerminalSessionLifecycle);
      swarmManager.off("agents_snapshot", handleTerminalAgentsSnapshot);
      throw error;
    }

    await integrationRegistry.start();
    swarmManager.setIntegrationContextProvider((profileId) => {
      const integrationContext = integrationRegistry.getIntegrationContext(profileId);
      return formatIntegrationContext(integrationContext);
    });

    await playwrightSettingsService.load();

    if (process.platform !== "win32") {
      try {
        playwrightDiscovery = new PlaywrightDiscoveryService({
          swarmManager,
          settingsService: playwrightSettingsService,
          envEnabledOverride: playwrightEnvEnabledOverride,
        });
        await playwrightDiscovery.start();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[playwright] Failed to start discovery service: ${message}`);
        playwrightDiscovery = null;
      }
    } else {
      logger.info("[playwright] Playwright dashboard disabled on Windows");
    }

    playwrightLivePreviewService = new PlaywrightLivePreviewService({
      discoveryService: playwrightDiscovery,
    });
    const wsServer = new SwarmWebSocketServer({
      swarmManager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
      integrationRegistry,
      playwrightDiscovery,
      playwrightLivePreviewService,
      playwrightSettingsService,
      playwrightEnvEnabledOverride,
      terminalService,
      terminalRuntimeConfig,
      promptRegistry: swarmManager.promptRegistry,
      unreadTracker,
    });

    server = new BackendServer({
      config,
      swarmManager,
      versioningService,
      integrationRegistry,
      playwrightDiscovery,
      playwrightLivePreviewService,
      wsServer,
      queueSchedulerSync,
      handleAgentsSnapshot,
      terminalService,
      handleTerminalSessionLifecycle,
      handleTerminalAgentsSnapshot,
      runtimeLock,
    });

    await playwrightLivePreviewService.start();
    await server.startListening();

    activeServer = server;
    await options.onReady?.({
      host: server.host,
      port: server.port,
      config,
    });
    return server;
  } catch (error) {
    if (server) {
      await server.stop();
    } else {
      swarmManager.off("agents_snapshot", handleAgentsSnapshot);
      if (terminalService) {
        swarmManager.off("session_lifecycle", handleTerminalSessionLifecycle);
        swarmManager.off("agents_snapshot", handleTerminalAgentsSnapshot);
      }
      await Promise.allSettled([
        queueSchedulerSync(new Set<string>()),
        integrationRegistry.stop(),
        playwrightDiscovery?.stop(),
        playwrightLivePreviewService?.stop(),
        terminalService?.shutdown(),
        versioningService.stop(),
      ]);
      runtimeLock.release();
    }
    throw error;
  }
}

export async function stopServer(): Promise<void> {
  await activeServer?.stop();
}

class BackendServer implements StartedServer {
  readonly host: string;
  port: number;
  readonly config: SwarmConfig;

  private readonly swarmManager: SwarmManager;
  private readonly versioningService: EmbeddedGitVersioningService;
  private readonly integrationRegistry: IntegrationRegistryService;
  private playwrightDiscovery: PlaywrightDiscoveryService | null;
  private readonly playwrightLivePreviewService: PlaywrightLivePreviewService;
  private readonly wsServer: SwarmWebSocketServer;
  private readonly queueSchedulerSync: (profileIds: Set<string>) => Promise<void>;
  private readonly handleAgentsSnapshot: (event: unknown) => void;
  private readonly terminalService: TerminalService | null;
  private readonly handleTerminalSessionLifecycle: (event: SessionLifecycleEvent) => void;
  private readonly handleTerminalAgentsSnapshot: () => void;
  private readonly runtimeLock: RuntimeLock;

  private listening = false;
  private stopped = false;

  constructor(options: {
    config: SwarmConfig;
    swarmManager: SwarmManager;
    versioningService: EmbeddedGitVersioningService;
    integrationRegistry: IntegrationRegistryService;
    playwrightDiscovery: PlaywrightDiscoveryService | null;
    playwrightLivePreviewService: PlaywrightLivePreviewService;
    wsServer: SwarmWebSocketServer;
    queueSchedulerSync: (profileIds: Set<string>) => Promise<void>;
    handleAgentsSnapshot: (event: unknown) => void;
    terminalService: TerminalService | null;
    handleTerminalSessionLifecycle: (event: SessionLifecycleEvent) => void;
    handleTerminalAgentsSnapshot: () => void;
    runtimeLock: RuntimeLock;
  }) {
    this.host = options.config.host;
    this.port = options.config.port;
    this.config = options.config;
    this.swarmManager = options.swarmManager;
    this.versioningService = options.versioningService;
    this.integrationRegistry = options.integrationRegistry;
    this.playwrightDiscovery = options.playwrightDiscovery;
    this.playwrightLivePreviewService = options.playwrightLivePreviewService;
    this.wsServer = options.wsServer;
    this.queueSchedulerSync = options.queueSchedulerSync;
    this.handleAgentsSnapshot = options.handleAgentsSnapshot;
    this.terminalService = options.terminalService;
    this.handleTerminalSessionLifecycle = options.handleTerminalSessionLifecycle;
    this.handleTerminalAgentsSnapshot = options.handleTerminalAgentsSnapshot;
    this.runtimeLock = options.runtimeLock;
  }

  async startListening(): Promise<void> {
    if (this.stopped || this.listening) {
      return;
    }

    await this.wsServer.start();
    this.port = this.wsServer.getPort();
    this.listening = true;
  }

  async stopListening(): Promise<void> {
    if (this.stopped || !this.listening) {
      return;
    }

    this.listening = false;
    await this.wsServer.stop();
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    this.swarmManager.off("agents_snapshot", this.handleAgentsSnapshot);
    this.swarmManager.off("session_lifecycle", this.handleTerminalSessionLifecycle);
    this.swarmManager.off("agents_snapshot", this.handleTerminalAgentsSnapshot);

    const shouldStopWsServer = this.listening;
    this.listening = false;

    if (shouldStopWsServer) {
      await this.wsServer.stop();
    }

    await Promise.allSettled([
      this.queueSchedulerSync(new Set<string>()),
      this.integrationRegistry.stop(),
      this.playwrightDiscovery?.stop(),
      this.playwrightLivePreviewService.stop(),
      this.terminalService?.shutdown(),
      this.versioningService.stop(),
    ]);

    this.runtimeLock.release();

    if (activeServer === this) {
      activeServer = null;
    }
  }
}

function createLogger(logger: Partial<ServerLogger> | undefined): ServerLogger {
  return {
    info: logger?.info ?? ((message: string) => console.log(message)),
    warn: logger?.warn ?? ((message: string) => console.warn(message)),
    error: logger?.error ?? ((message: string) => console.error(message)),
  };
}

/**
 * Collect unique profile IDs from manager agents for scheduler instantiation.
 * Schedules are profile-scoped, so we create one scheduler per profile, not per session.
 */
function collectSchedulerProfileIds(agents: unknown[], fallbackManagerId?: string): Set<string> {
  const profileIds = new Set<string>();

  for (const agent of agents) {
    if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
      continue;
    }

    const descriptor = agent as Partial<AgentDescriptor>;
    if (descriptor.role !== "manager") {
      continue;
    }

    if (typeof descriptor.agentId !== "string" || descriptor.agentId.trim().length === 0) {
      continue;
    }

    const id = (typeof descriptor.profileId === "string" && descriptor.profileId.trim().length > 0)
      ? descriptor.profileId.trim()
      : descriptor.agentId.trim();
    profileIds.add(id);
  }

  const normalizedFallbackManagerId =
    typeof fallbackManagerId === "string" ? fallbackManagerId.trim() : "";
  if (profileIds.size === 0 && normalizedFallbackManagerId.length > 0) {
    profileIds.add(normalizedFallbackManagerId);
  }

  return profileIds;
}
