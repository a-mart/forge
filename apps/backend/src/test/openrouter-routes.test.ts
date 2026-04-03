import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type {
  AgentDescriptor,
  AgentContextUsage,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SwarmConfig,
} from "../swarm/types.js";
import type { SwarmAgentRuntime } from "../swarm/runtime-types.js";
import { getScheduleFilePath } from "../scheduler/schedule-storage.js";
import { getOpenRouterModelsPath } from "../swarm/data-paths.js";
import { getPiModelsProjectionPath } from "../swarm/model-catalog-projection.js";
import { SwarmManager } from "../swarm/swarm-manager.js";
import { SwarmWebSocketServer } from "../ws/server.js";

const tempRoots: string[] = [];

class FakeRuntime {
  readonly descriptor: AgentDescriptor;
  private readonly sessionManager: SessionManager;

  constructor(descriptor: AgentDescriptor) {
    this.descriptor = descriptor;
    this.sessionManager = SessionManager.open(descriptor.sessionFile);
  }

  getStatus(): AgentDescriptor["status"] {
    return this.descriptor.status;
  }

  getPendingCount(): number {
    return 0;
  }

  getContextUsage(): AgentContextUsage | undefined {
    return undefined;
  }

  async sendMessage(_message: string, _delivery: RequestedDeliveryMode = "auto"): Promise<SendMessageReceipt> {
    this.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "ack" }],
    } as any);

    return {
      targetAgentId: this.descriptor.agentId,
      deliveryId: "fake-delivery",
      acceptedMode: "prompt",
    };
  }

  async terminate(): Promise<void> {}

  async recycle(): Promise<void> {}

  async stopInFlight(): Promise<void> {
    this.descriptor.status = "idle";
  }

  async compact(customInstructions?: string): Promise<unknown> {
    return {
      status: "ok",
      customInstructions: customInstructions ?? null,
    };
  }
}

class TestSwarmManager extends SwarmManager {
  protected override async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    _systemPrompt?: string,
    _runtimeToken?: number,
  ): Promise<SwarmAgentRuntime> {
    return new FakeRuntime(descriptor) as unknown as SwarmAgentRuntime;
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => removeTempRoot(root)));
  delete process.env.OPENROUTER_API_KEY;
});

async function removeTempRoot(root: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
      if (code !== "ENOTEMPTY" && code !== "EBUSY") {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }

  await rm(root, { recursive: true, force: true });
}

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Unable to allocate port");
  }

  const port = address.port;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

  return port;
}

async function makeTempConfig(port: number): Promise<SwarmConfig> {
  const root = await mkdtemp(join(tmpdir(), "forge-openrouter-routes-"));
  tempRoots.push(root);

  const dataDir = join(root, "data");
  const swarmDir = join(dataDir, "swarm");
  const sessionsDir = join(dataDir, "sessions");
  const uploadsDir = join(dataDir, "uploads");
  const profilesDir = join(dataDir, "profiles");
  const sharedDir = join(dataDir, "shared");
  const sharedConfigDir = join(sharedDir, "config");
  const sharedCacheDir = join(sharedDir, "cache");
  const sharedStateDir = join(sharedDir, "state");
  const sharedAuthDir = join(sharedConfigDir, "auth");
  const sharedAuthFile = join(sharedAuthDir, "auth.json");
  const sharedSecretsFile = join(sharedConfigDir, "secrets.json");
  const sharedIntegrationsDir = join(sharedConfigDir, "integrations");
  const authDir = join(dataDir, "auth");
  const agentDir = join(dataDir, "agent");
  const managerAgentDir = join(agentDir, "manager");
  const repoArchetypesDir = join(root, ".swarm", "archetypes");
  const memoryDir = join(dataDir, "memory");
  const memoryFile = join(memoryDir, "manager.md");
  const repoMemorySkillFile = join(root, ".swarm", "skills", "memory", "SKILL.md");

  await mkdir(swarmDir, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(uploadsDir, { recursive: true });
  await mkdir(profilesDir, { recursive: true });
  await mkdir(sharedAuthDir, { recursive: true });
  await mkdir(sharedIntegrationsDir, { recursive: true });
  await mkdir(sharedCacheDir, { recursive: true });
  await mkdir(sharedStateDir, { recursive: true });
  await mkdir(authDir, { recursive: true });
  await mkdir(memoryDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(managerAgentDir, { recursive: true });
  await mkdir(repoArchetypesDir, { recursive: true });

  return {
    host: "127.0.0.1",
    port,
    debug: false,
    isDesktop: false,
    allowNonManagerSubscriptions: false,
    managerId: "manager",
    managerDisplayName: "Manager",
    defaultModel: {
      provider: "openai-codex",
      modelId: "gpt-5.3-codex",
      thinkingLevel: "medium",
    },
    defaultCwd: root,
    cwdAllowlistRoots: [root, join(root, "worktrees")],
    paths: {
      rootDir: root,
      dataDir,
      swarmDir,
      uploadsDir,
      agentsStoreFile: join(swarmDir, "agents.json"),
      profilesDir,
      sharedDir,
      sharedConfigDir,
      sharedCacheDir,
      sharedStateDir,
      sharedAuthDir,
      sharedAuthFile,
      sharedSecretsFile,
      sharedIntegrationsDir,
      sessionsDir,
      memoryDir,
      authDir,
      authFile: join(authDir, "auth.json"),
      secretsFile: join(dataDir, "secrets.json"),
      agentDir,
      managerAgentDir,
      repoArchetypesDir,
      memoryFile,
      repoMemorySkillFile,
      schedulesFile: getScheduleFilePath(dataDir, "manager"),
    },
  };
}

async function bootWithDefaultManager(manager: TestSwarmManager, config: SwarmConfig): Promise<void> {
  await manager.boot();

  const managerId = config.managerId ?? "manager";
  const managerName = config.managerDisplayName ?? managerId;
  const existingManager = manager.listAgents().find(
    (descriptor) => descriptor.agentId === managerId && descriptor.role === "manager",
  );
  if (existingManager) {
    return;
  }

  const callerAgentId = manager.listAgents().find((descriptor) => descriptor.role === "manager")?.agentId ?? managerId;
  await manager.createManager(callerAgentId, {
    name: managerName,
    cwd: config.defaultCwd,
  });
}

async function startServer(): Promise<{
  config: SwarmConfig;
  manager: TestSwarmManager;
  server: SwarmWebSocketServer;
}> {
  const port = await getAvailablePort();
  const config = await makeTempConfig(port);
  const manager = new TestSwarmManager(config);
  await bootWithDefaultManager(manager, config);

  const server = new SwarmWebSocketServer({
    swarmManager: manager,
    host: config.host,
    port: config.port,
    allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
  });
  await server.start();

  return { config, manager, server };
}

describe("openrouter-routes", () => {
  it("lists available OpenRouter models from Pi's built-in catalog", async () => {
    const { config, server } = await startServer();

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/settings/openrouter/available-models`);
      expect(response.status).toBe(200);

      const payload = (await response.json()) as {
        models: Array<{
          modelId: string;
          displayName: string;
          upstreamProvider: string;
          contextWindow: number;
          maxOutputTokens: number;
          supportsReasoning: boolean;
          supportsTools: boolean;
          inputModes: string[];
          pricing: { inputPerMillion: number; outputPerMillion: number } | null;
        }>;
      };

      expect(payload.models.length).toBeGreaterThan(0);
      const claude = payload.models.find((model) => model.modelId === "anthropic/claude-3.5-sonnet");
      expect(claude).toMatchObject({
        modelId: "anthropic/claude-3.5-sonnet",
        upstreamProvider: "anthropic",
      });
      expect(claude?.displayName.length ?? 0).toBeGreaterThan(0);
      expect(claude?.contextWindow ?? 0).toBeGreaterThan(0);
      expect(claude?.maxOutputTokens ?? 0).toBeGreaterThan(0);
      expect(typeof claude?.supportsReasoning).toBe("boolean");
      expect(typeof claude?.supportsTools).toBe("boolean");
      expect(Array.isArray(claude?.inputModes)).toBe(true);
      if (claude?.pricing) {
        expect(claude.pricing.inputPerMillion).toBeGreaterThanOrEqual(0);
        expect(claude.pricing.outputPerMillion).toBeGreaterThanOrEqual(0);
        expect(claude.pricing.inputPerMillion).toBeLessThan(1_000);
      }
    } finally {
      await server.stop();
    }
  });

  it("returns stored OpenRouter models with isConfigured=false when no credential is present", async () => {
    const { config, server } = await startServer();

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/settings/openrouter/models`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        models: unknown[];
        isConfigured: boolean;
      };

      expect(payload.models).toEqual([]);
      expect(payload.isConfigured).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it("returns stored OpenRouter models with credential availability", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const { config, server } = await startServer();

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/settings/openrouter/models`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        models: unknown[];
        isConfigured: boolean;
      };

      expect(payload.models).toEqual([]);
      expect(payload.isConfigured).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("adds and removes URL-encoded model ids, regenerates the projection, and exposes OpenRouter selector entries", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const { config, manager, server } = await startServer();
    const modelId = "anthropic/claude-3.5-sonnet";
    const projectionPath = getPiModelsProjectionPath(config.paths.dataDir);
    const reloadSpy = vi.spyOn(manager, "reloadOpenRouterModelsAndProjection");

    try {
      const initialProjection = JSON.parse(await readFile(projectionPath, "utf8")) as {
        providers: Record<string, unknown>;
      };
      expect(initialProjection.providers.openrouter).toBeUndefined();

      const addResponse = await fetch(
        `http://${config.host}:${config.port}/api/settings/openrouter/models/${encodeURIComponent(modelId)}`,
        { method: "PUT" },
      );
      expect(addResponse.status).toBe(200);
      const added = (await addResponse.json()) as {
        modelId: string;
        displayName: string;
        supportedReasoningLevels: string[];
        inputModes: string[];
        addedAt: string;
      };
      expect(added.modelId).toBe(modelId);
      expect(added.displayName.length).toBeGreaterThan(0);
      expect(added.supportedReasoningLevels.length).toBeGreaterThan(0);
      expect(added.inputModes.length).toBeGreaterThan(0);
      expect(reloadSpy).toHaveBeenCalledTimes(1);

      const duplicateAddResponse = await fetch(
        `http://${config.host}:${config.port}/api/settings/openrouter/models/${encodeURIComponent(modelId)}`,
        { method: "PUT" },
      );
      expect(duplicateAddResponse.status).toBe(200);
      const duplicateAdded = (await duplicateAddResponse.json()) as { modelId: string; addedAt: string };
      expect(duplicateAdded.modelId).toBe(modelId);
      expect(duplicateAdded.addedAt).toBe(added.addedAt);
      expect(reloadSpy).toHaveBeenCalledTimes(1);

      const storedFile = JSON.parse(await readFile(getOpenRouterModelsPath(config.paths.dataDir), "utf8")) as {
        models: Record<string, { modelId: string; addedAt: string }>;
      };
      expect(storedFile.models[modelId]?.modelId).toBe(modelId);
      expect(storedFile.models[modelId]?.addedAt).toBe(added.addedAt);

      const afterAddProjection = JSON.parse(await readFile(projectionPath, "utf8")) as {
        providers: Record<string, { models?: Array<{ id: string }> }>;
      };
      expect(afterAddProjection.providers.openrouter?.models).toEqual([
        expect.objectContaining({ id: modelId }),
      ]);

      const openRouterModelsResponse = await fetch(`http://${config.host}:${config.port}/api/settings/openrouter/models`);
      expect(openRouterModelsResponse.status).toBe(200);
      const openRouterModelsPayload = (await openRouterModelsResponse.json()) as {
        models: Array<{ modelId: string }>;
        isConfigured: boolean;
      };
      expect(openRouterModelsPayload.isConfigured).toBe(true);
      expect(openRouterModelsPayload.models.map((model) => model.modelId)).toEqual([modelId]);

      const selectableResponse = await fetch(`http://${config.host}:${config.port}/api/settings/models`);
      expect(selectableResponse.status).toBe(200);
      const selectablePayload = (await selectableResponse.json()) as {
        models: Array<{ provider: string; modelId: string; presetId: string }>;
      };
      expect(selectablePayload.models).toContainEqual(
        expect.objectContaining({
          provider: "openrouter",
          modelId,
          presetId: `openrouter:${modelId}`,
        }),
      );

      const deleteResponse = await fetch(
        `http://${config.host}:${config.port}/api/settings/openrouter/models/${encodeURIComponent(modelId)}`,
        { method: "DELETE" },
      );
      expect(deleteResponse.status).toBe(200);
      expect(reloadSpy).toHaveBeenCalledTimes(2);

      const afterDeleteProjection = JSON.parse(await readFile(projectionPath, "utf8")) as {
        providers: Record<string, unknown>;
      };
      expect(afterDeleteProjection.providers.openrouter).toBeUndefined();

      const afterDeleteModelsResponse = await fetch(`http://${config.host}:${config.port}/api/settings/openrouter/models`);
      expect(afterDeleteModelsResponse.status).toBe(200);
      const afterDeleteModelsPayload = (await afterDeleteModelsResponse.json()) as {
        models: Array<{ modelId: string }>;
      };
      expect(afterDeleteModelsPayload.models).toEqual([]);

      const afterDeleteSelectableResponse = await fetch(`http://${config.host}:${config.port}/api/settings/models`);
      expect(afterDeleteSelectableResponse.status).toBe(200);
      const afterDeleteSelectablePayload = (await afterDeleteSelectableResponse.json()) as {
        models: Array<{ provider: string; modelId: string; presetId: string }>;
      };
      expect(afterDeleteSelectablePayload.models).not.toContainEqual(
        expect.objectContaining({
          provider: "openrouter",
          modelId,
          presetId: `openrouter:${modelId}`,
        }),
      );
    } finally {
      reloadSpy.mockRestore();
      await server.stop();
    }
  });

  it("rolls back the stored model file when projection regeneration fails", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const { config, manager, server } = await startServer();
    const modelId = "anthropic/claude-3.5-sonnet";
    const projectionPath = getPiModelsProjectionPath(config.paths.dataDir);
    const reloadSpy = vi
      .spyOn(manager, "reloadOpenRouterModelsAndProjection")
      .mockRejectedValueOnce(new Error("projection failed"));

    try {
      const addResponse = await fetch(
        `http://${config.host}:${config.port}/api/settings/openrouter/models/${encodeURIComponent(modelId)}`,
        { method: "PUT" },
      );
      expect(addResponse.status).toBe(500);
      await expect(addResponse.json()).resolves.toMatchObject({ error: "projection failed" });

      const openRouterModelsResponse = await fetch(`http://${config.host}:${config.port}/api/settings/openrouter/models`);
      expect(openRouterModelsResponse.status).toBe(200);
      const openRouterModelsPayload = (await openRouterModelsResponse.json()) as {
        models: Array<{ modelId: string }>;
      };
      expect(openRouterModelsPayload.models).toEqual([]);

      const storedFile = JSON.parse(await readFile(getOpenRouterModelsPath(config.paths.dataDir), "utf8")) as {
        models: Record<string, { modelId: string }>;
      };
      expect(storedFile.models[modelId]).toBeUndefined();

      const projection = JSON.parse(await readFile(projectionPath, "utf8")) as {
        providers: Record<string, unknown>;
      };
      expect(projection.providers.openrouter).toBeUndefined();
      expect(reloadSpy).toHaveBeenCalledTimes(2);
    } finally {
      reloadSpy.mockRestore();
      await server.stop();
    }
  });

  it("rejects unknown catalog additions and missing deletions", async () => {
    const { config, server } = await startServer();

    try {
      const unknownAddResponse = await fetch(
        `http://${config.host}:${config.port}/api/settings/openrouter/models/${encodeURIComponent("does/not-exist")}`,
        { method: "PUT" },
      );
      expect(unknownAddResponse.status).toBe(404);
      await expect(unknownAddResponse.json()).resolves.toMatchObject({
        error: "Unknown OpenRouter modelId: does/not-exist",
      });

      const unknownDeleteResponse = await fetch(
        `http://${config.host}:${config.port}/api/settings/openrouter/models/${encodeURIComponent("anthropic/claude-3.5-sonnet")}`,
        { method: "DELETE" },
      );
      expect(unknownDeleteResponse.status).toBe(404);
      await expect(unknownDeleteResponse.json()).resolves.toMatchObject({
        error: "Unknown OpenRouter modelId: anthropic/claude-3.5-sonnet",
      });
    } finally {
      await server.stop();
    }
  });
});
