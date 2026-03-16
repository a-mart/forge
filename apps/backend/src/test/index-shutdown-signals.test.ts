import { afterEach, describe, expect, it, vi } from "vitest";
import type { SwarmConfig } from "../swarm/types.js";

const BASE_CONFIG: SwarmConfig = {
  host: "127.0.0.1",
  port: 47187,
  debug: true,
  allowNonManagerSubscriptions: true,
  managerId: undefined,
  managerDisplayName: "Manager",
  defaultModel: {
    provider: "openai-codex",
    modelId: "gpt-5.3-codex",
    thinkingLevel: "xhigh"
  },
  defaultCwd: "/repo",
  cwdAllowlistRoots: ["/repo"],
  paths: {
    rootDir: "/repo",
    dataDir: "/repo/data",
    swarmDir: "/repo/data/swarm",
    uploadsDir: "/repo/data/uploads",
    agentsStoreFile: "/repo/data/swarm/agents.json",
    profilesDir: "/repo/data/profiles",
    sharedDir: "/repo/data/shared",
    sharedAuthDir: "/repo/data/shared/auth",
    sharedAuthFile: "/repo/data/shared/auth/auth.json",
    sharedSecretsFile: "/repo/data/shared/secrets.json",
    sharedIntegrationsDir: "/repo/data/shared/integrations",
    sessionsDir: "/repo/data/sessions",
    memoryDir: "/repo/data/memory",
    authDir: "/repo/data/auth",
    authFile: "/repo/data/auth/auth.json",
    secretsFile: "/repo/data/secrets.json",
    agentDir: "/repo/data/agent",
    managerAgentDir: "/repo/data/agent/manager",
    repoArchetypesDir: "/repo/.swarm/archetypes",
    memoryFile: undefined,
    repoMemorySkillFile: "/repo/.swarm/skills/memory/SKILL.md",
    schedulesFile: undefined
  }
};

const TRACKED_EVENTS = ["SIGINT", "SIGTERM", "SIGUSR1", "SIGBREAK", "message"] as const;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("index shutdown signal registration", () => {
  it("registers SIGINT, SIGTERM, and SIGUSR1 on POSIX", async () => {
    const signals = await loadRegisteredSignals("linux", { MIDDLEMAN_DAEMONIZED: undefined });
    expect(signals).toContain("SIGINT");
    expect(signals).toContain("SIGTERM");
    expect(signals).toContain("SIGUSR1");
    expect(signals).not.toContain("SIGBREAK");
    expect(signals).toContain("message");
  });

  it("does not register SIGUSR1 for daemonized children", async () => {
    const signals = await loadRegisteredSignals("linux", { MIDDLEMAN_DAEMONIZED: "1" });
    expect(signals).toContain("SIGINT");
    expect(signals).toContain("SIGTERM");
    expect(signals).not.toContain("SIGUSR1");
    expect(signals).toContain("message");
  });

  it("registers SIGBREAK on win32", async () => {
    const signals = await loadRegisteredSignals("win32");
    expect(signals).toContain("SIGINT");
    expect(signals).toContain("SIGTERM");
    expect(signals).not.toContain("SIGUSR1");
    expect(signals).toContain("SIGBREAK");
    expect(signals).toContain("message");
  });
});

async function loadRegisteredSignals(
  platform: NodeJS.Platform,
  envOverrides: Record<string, string | undefined> = {}
): Promise<string[]> {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });

  const previousEnv = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(envOverrides)) {
    previousEnv.set(key, process.env[key]);
    if (typeof value === "string") {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }
  }

  const processEvents = process as unknown as {
    listeners(eventName: string): Array<(...args: any[]) => void>;
    removeListener(eventName: string, listener: (...args: any[]) => void): typeof process;
  };

  const baselineListeners = new Map<string, Set<(...args: any[]) => void>>(
    TRACKED_EVENTS.map((eventName) => [eventName, new Set(processEvents.listeners(eventName))])
  );

  vi.doMock("dotenv", () => ({
    config: vi.fn()
  }));

  vi.doMock("../config.js", () => ({
    createConfig: () => BASE_CONFIG,
    readPlaywrightDashboardEnvOverride: () => undefined
  }));

  vi.doMock("../swarm/swarm-manager.js", () => ({
    SwarmManager: class {
      async boot(): Promise<void> {}
      on(): void {}
      off(): void {}
      listAgents(): [] {
        return [];
      }
      setIntegrationContextProvider(): void {}
    }
  }));

  vi.doMock("../scheduler/cron-scheduler-service.js", () => ({
    CronSchedulerService: class {
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
    }
  }));

  vi.doMock("../scheduler/schedule-storage.js", () => ({
    getScheduleFilePath: () => "/repo/data/schedules/manager.json"
  }));

  vi.doMock("../integrations/registry.js", () => ({
    IntegrationRegistryService: class {
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      getIntegrationContext(): null {
        return null;
      }
    }
  }));

  vi.doMock("../integrations/integration-context.js", () => ({
    formatIntegrationContext: () => ""
  }));

  vi.doMock("../versioning/embedded-git-versioning-service.js", () => ({
    EmbeddedGitVersioningService: class {
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
    }
  }));

  vi.doMock("../playwright/playwright-settings-service.js", () => ({
    PlaywrightSettingsService: class {
      async load(): Promise<void> {}
    }
  }));

  vi.doMock("../playwright/playwright-discovery-service.js", () => ({
    PlaywrightDiscoveryService: class {
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
    }
  }));

  vi.doMock("../playwright/playwright-live-preview-service.js", () => ({
    PlaywrightLivePreviewService: class {
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
    }
  }));

  vi.doMock("../ws/server.js", () => ({
    SwarmWebSocketServer: class {
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
    }
  }));

  try {
    await import("../index.js");
    await waitForSignalRegistration(processEvents, baselineListeners);

    return TRACKED_EVENTS.filter((eventName) => {
      const baseline = baselineListeners.get(eventName) ?? new Set();
      return processEvents.listeners(eventName).some((listener) => !baseline.has(listener));
    });
  } finally {
    for (const eventName of TRACKED_EVENTS) {
      const baseline = baselineListeners.get(eventName) ?? new Set();
      for (const listener of processEvents.listeners(eventName)) {
        if (!baseline.has(listener)) {
          processEvents.removeListener(eventName, listener);
        }
      }
    }

    for (const [key, value] of previousEnv.entries()) {
      if (typeof value === "string") {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }

    if (platformDescriptor) {
      Object.defineProperty(process, "platform", platformDescriptor);
    }
  }
}

async function waitForSignalRegistration(
  processEvents: {
    listeners(eventName: string): Array<(...args: any[]) => void>;
  },
  baselineListeners: Map<string, Set<(...args: any[]) => void>>
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const hasNewListener = TRACKED_EVENTS.some((eventName) => {
      const baseline = baselineListeners.get(eventName) ?? new Set();
      return processEvents.listeners(eventName).some((listener) => !baseline.has(listener));
    });

    if (hasNewListener) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
