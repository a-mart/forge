import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { createConfig, readPlaywrightDashboardEnvOverride } from "./config.js";
import { checkDataDirMigration } from "./startup-migration.js";
import { formatIntegrationContext } from "./integrations/integration-context.js";
import { IntegrationRegistryService } from "./integrations/registry.js";
import { PlaywrightDiscoveryService } from "./playwright/playwright-discovery-service.js";
import { PlaywrightLivePreviewService } from "./playwright/playwright-live-preview-service.js";
import { PlaywrightSettingsService } from "./playwright/playwright-settings-service.js";
import { EmbeddedGitVersioningService } from "./versioning/embedded-git-versioning-service.js";
import {
  RESTART_SIGNAL,
  clearRestartParentPidEnv,
  readDaemonizedEnv,
  readRestartParentPidEnv,
  setRestartParentPidEnv
} from "./reboot/control-pid.js";
import { CronSchedulerService } from "./scheduler/cron-scheduler-service.js";
import { getScheduleFilePath } from "./scheduler/schedule-storage.js";
import { SwarmManager } from "./swarm/swarm-manager.js";
import type { AgentDescriptor } from "./swarm/types.js";
import { SwarmWebSocketServer } from "./ws/server.js";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(backendRoot, "..", "..");
loadDotenv({ path: resolve(repoRoot, ".env") });

async function main(): Promise<void> {
  await checkDataDirMigration();
  const config = createConfig();

  const versioningService = new EmbeddedGitVersioningService({
    dataDir: config.paths.dataDir,
    logger: {
      info: (message) => console.log(message),
      warn: (message) => console.warn(message),
      error: (message) => console.error(message)
    }
  });
  await versioningService.start();

  const swarmManager = new SwarmManager(config, {
    versioningService
  });
  await swarmManager.boot();

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
        managerId: profileId
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
      () => syncSchedulers(profileIds)
    );
    schedulerLifecycle = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };

  await queueSchedulerSync(collectSchedulerProfileIds(swarmManager.listAgents(), config.managerId));

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
    promptRegistry: swarmManager.promptRegistry,
  });

  await waitForRestartParentToExit();
  await wsServer.start();

  console.log(`Forge backend listening on ws://${config.host}:${config.port}`);

  let stopped = false;
  let restarting = false;

  const stop = async (options?: { skipWsServer?: boolean }): Promise<void> => {
    if (stopped) {
      return;
    }

    stopped = true;
    swarmManager.off("agents_snapshot", handleAgentsSnapshot);
    await Promise.allSettled([
      queueSchedulerSync(new Set<string>()),
      integrationRegistry.stop(),
      playwrightDiscovery?.stop(),
      playwrightLivePreviewService.stop(),
      versioningService.stop(),
      options?.skipWsServer ? Promise.resolve() : wsServer.stop()
    ]);
  };

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`Received ${signal}. Shutting down...`);
    await stop();
    process.exit(0);
  };

  const restart = async (): Promise<void> => {
    if (restarting || stopped) {
      return;
    }

    restarting = true;
    console.log(`[reboot] Received ${RESTART_SIGNAL}. Restarting backend...`);

    try {
      await wsServer.stop();
      await spawnReplacementProcess();
      await stop({ skipWsServer: true });
      process.exit(0);
    } catch (error) {
      restarting = false;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[reboot] Failed to restart current process: ${message}`);

      try {
        await wsServer.start();
      } catch (restartError) {
        const restartMessage = restartError instanceof Error ? restartError.message : String(restartError);
        console.error(`[reboot] Failed to restore WebSocket server after restart failure: ${restartMessage}`);
      }
    }
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  if (process.platform !== "win32" && readDaemonizedEnv() !== "1") {
    process.on(RESTART_SIGNAL, () => {
      void restart();
    });
  }

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

async function waitForRestartParentToExit(): Promise<void> {
  const rawParentPid = readRestartParentPidEnv();
  if (typeof rawParentPid !== "string" || rawParentPid.trim().length === 0) {
    return;
  }

  clearRestartParentPidEnv();

  const parentPid = Number.parseInt(rawParentPid.trim(), 10);
  if (!Number.isInteger(parentPid) || parentPid <= 0) {
    return;
  }

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      process.kill(parentPid, 0);
    } catch (error) {
      if (isErrorWithCode(error, "ESRCH")) {
        return;
      }

      throw error;
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}

async function spawnReplacementProcess(): Promise<void> {
  const replacementArgs = [...process.execArgv, ...process.argv.slice(1)];
  const replacementEnv = {
    ...process.env,
  };
  setRestartParentPidEnv(`${process.pid}`);
  replacementEnv.FORGE_RESTART_PARENT_PID = `${process.pid}`;

  await new Promise<void>((resolveSpawn, reject) => {
    const child = spawn(process.execPath, replacementArgs, {
      cwd: process.cwd(),
      env: replacementEnv,
      stdio: "inherit"
    });

    child.once("error", reject);
    child.once("spawn", () => {
      resolveSpawn();
    });
  });
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
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
        `Stop the other process or run with FORGE_PORT=<port> (legacy MIDDLEMAN_PORT also works).`
    );
  } else {
    console.error(error);
  }
  process.exit(1);
});
