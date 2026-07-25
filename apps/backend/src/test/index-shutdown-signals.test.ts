import { afterEach, describe, expect, it, vi } from "vitest";
import type { SwarmConfig } from "../swarm/types.js";

const BASE_CONFIG: SwarmConfig = {
  host: "127.0.0.1",
  port: 47187,
  debug: true,
  isDesktop: false,
  runtimeTarget: "builder",
  cortexEnabled: true,
  allowNonManagerSubscriptions: true,
  managerId: undefined,
  managerDisplayName: "Manager",
  defaultModel: {
    provider: "openai-codex",
    modelId: "gpt-5.5",
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
    sharedConfigDir: "/repo/data/shared/config",
    sharedCacheDir: "/repo/data/shared/cache",
    sharedStateDir: "/repo/data/shared/state",
    sharedAuthDir: "/repo/data/shared/config/auth",
    sharedAuthFile: "/repo/data/shared/config/auth/auth.json",
    sharedSecretsFile: "/repo/data/shared/config/secrets.json",
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
    const startupCalls: string[] = [];
    const signals = await loadRegisteredSignals("linux", { FORGE_DAEMONIZED: undefined }, startupCalls);
    expect(startupCalls.slice(0, 2)).toEqual(["stdio-epipe-guard", "dotenv"]);
    expect(signals).toContain("SIGINT");
    expect(signals).toContain("SIGTERM");
    expect(signals).toContain("SIGUSR1");
    expect(signals).not.toContain("SIGBREAK");
    expect(signals).toContain("message");
  });

  it("does not register SIGUSR1 for daemonized children", async () => {
    const signals = await loadRegisteredSignals("linux", { FORGE_DAEMONIZED: "1" });
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

  it("exits a desktop backend after an IPC shutdown completes", async () => {
    const calls: string[] = [];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      calls.push(`exit:${code}`);
      return undefined as never;
    });

    await loadRegisteredSignals("win32", {}, undefined, {
      isDesktop: true,
      stop: async () => {
        calls.push("stop:start");
        await Promise.resolve();
        calls.push("stop:complete");
      },
      inspect: async (listeners) => {
        expect(listeners.message).toHaveLength(1);
        listeners.message[0]?.({ type: "shutdown" });
        await waitFor(() => exitSpy.mock.calls.length > 0);
      },
    });

    expect(calls).toEqual(["stop:start", "stop:complete", "exit:0"]);
  });
});

interface LifecycleTestOptions {
  isDesktop?: boolean;
  stop?: () => Promise<void>;
  inspect?: (
    listeners: Partial<Record<(typeof TRACKED_EVENTS)[number], Array<(...args: any[]) => void>>>,
  ) => Promise<void> | void;
}

async function loadRegisteredSignals(
  platform: NodeJS.Platform,
  envOverrides: Record<string, string | undefined> = {},
  startupCalls?: string[],
  lifecycleOptions: LifecycleTestOptions = {},
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
    config: vi.fn(() => {
      startupCalls?.push("dotenv");
    })
  }));

  vi.doMock("../stdio-epipe-guard.js", () => ({
    installBackendStdioEpipeGuard: vi.fn(() => {
      startupCalls?.push("stdio-epipe-guard");
    })
  }));

  vi.doMock("../config.js", () => ({
    createConfig: () => ({
      ...BASE_CONFIG,
      isDesktop: lifecycleOptions.isDesktop ?? BASE_CONFIG.isDesktop,
    }),
  }));

  vi.doMock("../startup-migration.js", () => ({
    checkDataDirMigration: async () => undefined
  }));

  vi.doMock("../swarm/swarm-manager.js", () => ({
    SwarmManager: class {
      async boot(): Promise<void> {}
      on(): void {}
      off(): void {}
      listAgents(): [] {
        return [];
      }
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

  vi.doMock("../versioning/embedded-git-versioning-service.js", () => ({
    EmbeddedGitVersioningService: class {
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
    }
  }));

  vi.doMock("../desktop-secure-control-token.js", () => ({
    readDesktopSecureControlTokenFromFd: async () => "t".repeat(32),
  }));

  vi.doMock("../server.js", () => ({
    startServer: async () => ({
      host: BASE_CONFIG.host,
      port: BASE_CONFIG.port,
      config: BASE_CONFIG,
      stop: lifecycleOptions.stop ?? (async () => {}),
      stopListening: async () => {},
      startListening: async () => {},
    }),
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

    const addedListeners = Object.fromEntries(
      TRACKED_EVENTS.map((eventName) => {
        const baseline = baselineListeners.get(eventName) ?? new Set();
        return [
          eventName,
          processEvents.listeners(eventName).filter((listener) => !baseline.has(listener)),
        ];
      }),
    ) as Record<(typeof TRACKED_EVENTS)[number], Array<(...args: any[]) => void>>;
    await lifecycleOptions.inspect?.(addedListeners);

    return TRACKED_EVENTS.filter((eventName) => addedListeners[eventName].length > 0);
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
  await waitFor(() => TRACKED_EVENTS.some((eventName) => {
    const baseline = baselineListeners.get(eventName) ?? new Set();
    return processEvents.listeners(eventName).some((listener) => !baseline.has(listener));
  }));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for process lifecycle callback");
}
