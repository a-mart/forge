import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { createConfig, readPlaywrightDashboardEnvOverride } from "./config.js";
import { formatIntegrationContext } from "./integrations/integration-context.js";
import { IntegrationRegistryService } from "./integrations/registry.js";
import { PlaywrightDiscoveryService } from "./playwright/playwright-discovery-service.js";
import { PlaywrightLivePreviewService } from "./playwright/playwright-live-preview-service.js";
import { PlaywrightSettingsService } from "./playwright/playwright-settings-service.js";
import { CronSchedulerService } from "./scheduler/cron-scheduler-service.js";
import { getScheduleFilePath } from "./scheduler/schedule-storage.js";
import { SwarmManager } from "./swarm/swarm-manager.js";
import type { AgentDescriptor } from "./swarm/types.js";
import { SwarmWebSocketServer } from "./ws/server.js";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(backendRoot, "..", "..");
loadDotenv({ path: resolve(repoRoot, ".env") });

async function main(): Promise<void> {
  const config = createConfig();

  const swarmManager = new SwarmManager(config);
  await swarmManager.boot();

  const schedulersByManagerId = new Map<string, CronSchedulerService>();
  let schedulerLifecycle: Promise<void> = Promise.resolve();

  const syncSchedulers = async (managerIds: Set<string>): Promise<void> => {
    for (const managerId of managerIds) {
      if (schedulersByManagerId.has(managerId)) {
        continue;
      }

      const scheduler = new CronSchedulerService({
        swarmManager,
        schedulesFile: getScheduleFilePath(config.paths.dataDir, managerId),
        managerId
      });
      await scheduler.start();
      schedulersByManagerId.set(managerId, scheduler);
    }

    for (const [managerId, scheduler] of schedulersByManagerId.entries()) {
      if (managerIds.has(managerId)) {
        continue;
      }

      await scheduler.stop();
      schedulersByManagerId.delete(managerId);
    }
  };

  const queueSchedulerSync = (managerIds: Set<string>): Promise<void> => {
    const next = schedulerLifecycle.then(
      () => syncSchedulers(managerIds),
      () => syncSchedulers(managerIds)
    );
    schedulerLifecycle = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };

  await queueSchedulerSync(collectManagerIds(swarmManager.listAgents(), config.managerId));

  const handleAgentsSnapshot = (event: unknown): void => {
    if (!event || typeof event !== "object") {
      return;
    }

    const payload = event as { type?: string; agents?: unknown };
    if (payload.type !== "agents_snapshot" || !Array.isArray(payload.agents)) {
      return;
    }

    const managerIds = collectManagerIds(payload.agents, config.managerId);
    void queueSchedulerSync(managerIds).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[scheduler] Failed to sync scheduler instances: ${message}`);
    });
  };

  swarmManager.on("agents_snapshot", handleAgentsSnapshot);

  const integrationRegistry = new IntegrationRegistryService({
    swarmManager,
    dataDir: config.paths.dataDir,
    defaultManagerId: config.managerId
  });
  await integrationRegistry.start();

  swarmManager.setIntegrationContextProvider((profileId) => {
    const integrationContext = integrationRegistry.getIntegrationContext(profileId);
    return formatIntegrationContext(integrationContext);
  });

  const playwrightSettingsService = new PlaywrightSettingsService({
    dataDir: config.paths.dataDir,
  });
  await playwrightSettingsService.load();

  const playwrightEnvEnabledOverride = readPlaywrightDashboardEnvOverride();

  let playwrightDiscovery: PlaywrightDiscoveryService | null = null;
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
      console.error(`[playwright] Failed to start discovery service: ${message}`);
      playwrightDiscovery = null;
    }
  } else {
    console.log("[playwright] Playwright dashboard disabled on Windows");
  }

  const playwrightLivePreviewService = new PlaywrightLivePreviewService({
    discoveryService: playwrightDiscovery,
  });
  await playwrightLivePreviewService.start();

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
  });
  await wsServer.start();

  console.log(`Middleman backend listening on ws://${config.host}:${config.port}`);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`Received ${signal}. Shutting down...`);
    swarmManager.off("agents_snapshot", handleAgentsSnapshot);
    await Promise.allSettled([
      queueSchedulerSync(new Set<string>()),
      integrationRegistry.stop(),
      playwrightDiscovery?.stop(),
      playwrightLivePreviewService.stop(),
      wsServer.stop()
    ]);
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  if (process.platform === "win32") {
    process.on("SIGBREAK", () => {
      void shutdown("SIGBREAK");
    });
  }

  process.on("message", (message) => {
    if (
      message === "shutdown" ||
      (typeof message === "object" && message && (message as { type?: string }).type === "shutdown")
    ) {
      void shutdown("message:shutdown");
    }
  });
}

/**
 * Collect unique profile IDs from manager agents for scheduler instantiation.
 * Schedules are profile-scoped, so we create one scheduler per profile, not per session.
 */
function collectManagerIds(agents: unknown[], fallbackManagerId?: string): Set<string> {
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

    // Use profileId when available; fall back to agentId for legacy agents.
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

void main().catch((error) => {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "EADDRINUSE"
  ) {
    const config = createConfig();
    console.error(
      `Failed to start backend: ws://${config.host}:${config.port} is already in use. ` +
        `Stop the other process or run with MIDDLEMAN_PORT=<port>.`
    );
  } else {
    console.error(error);
  }
  process.exit(1);
});
