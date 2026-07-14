import { describe, expect, it, vi } from "vitest";
import {
  CodexPluginDelegationCoordinator,
  type CodexPluginAppServerPort,
  type CodexPluginDelegationHost,
  type CodexPluginDelegationTurnContext,
} from "../codex-app-server/codex-plugin-delegation-coordinator.js";
import type { CodexPluginArtifactFilePort } from
  "../codex-app-server/codex-plugin-artifact-files.js";
import {
  CodexMcpCatalog,
  type CodexCatalogSnapshot,
  type CodexMcpToolCallResult,
} from "../codex-app-server/codex-mcp-catalog.js";
import {
  CODEX_PLUGIN_INTERNAL_WORKER_KIND,
  CODEX_PLUGIN_SPECIALIST_COLOR,
  CODEX_PLUGIN_SPECIALIST_DISPLAY_NAME,
  CODEX_PLUGIN_SPECIALIST_ID,
} from "../codex-app-server/codex-plugin-scope-service.js";
import type { AgentDescriptor, SpawnAgentInput } from "../types.js";

describe("CodexPluginDelegationCoordinator", () => {
  it("preflights selector turns and prepares immutable delegation context plus guidance", () => {
    const harness = new CoordinatorHarness();
    const route = harness.coordinator.classifyAndPreflightUserTurn(
      harness.manager,
      "@Codex -fireflies summarize the meeting",
      { channel: "web" },
    );
    const prepared = harness.coordinator.prepareUserTurn({
      manager: harness.manager,
      text: "@Codex -fireflies summarize the meeting",
      sourceContext: { channel: "web" },
      classification: route,
      userMessageId: "message-1",
    });

    expect(route).toEqual({
      kind: "plugin_delegate",
      selectors: ["fireflies"],
      strippedText: "summarize the meeting",
    });
    expect(harness.mentionChecks).toEqual([harness.manager.agentId]);
    expect(prepared.delegationContext).toMatchObject({
      managerAgentId: harness.manager.agentId,
      originalText: "@Codex -fireflies summarize the meeting",
      selectors: ["fireflies"],
      userMessageId: "message-1",
    });
    const guidance = harness.coordinator.appendManagerTurnGuidance(
      "user request",
      prepared.delegationContext,
    );
    expect(guidance).toContain("Selected selector(s), bound server-side");
    expect(guidance).toContain("Retry context id");
    expect(guidance).toContain("attachment payloads are not forwarded");

    expect(() => harness.coordinator.classifyAndPreflightUserTurn(
      { ...harness.manager, collab: { workspaceId: "w", channelId: "c" } },
      "@Codex:fireflies summarize",
      { channel: "web" },
    )).toThrow(/Builder web manager sessions/i);
  });

  it("activates and clears turn-scoped gates, delegation, retry state, and specialist visibility", () => {
    const harness = new CoordinatorHarness();
    const context = harness.prepareSelectorContext("fireflies");
    const gate = harness.coordinator.buildTurnGate(
      harness.manager,
      { channel: "web" },
      context.originalText,
      { kind: "plugin_delegate", selectors: ["fireflies"], strippedText: "find it" },
    );

    expect(harness.coordinator.applySpecialistAvailability([], "builder", harness.manager.agentId)).toEqual([]);
    harness.coordinator.activateManagerTurn(harness.manager.agentId, { gate, delegation: context });
    const visible = harness.coordinator.applySpecialistAvailability([], "builder", harness.manager.agentId);
    expect(visible).toEqual([
      expect.objectContaining({
        specialistId: CODEX_PLUGIN_SPECIALIST_ID,
        displayName: CODEX_PLUGIN_SPECIALIST_DISPLAY_NAME,
        available: true,
      }),
    ]);

    harness.coordinator.completeProviderCycle(harness.manager.agentId);
    expect(harness.coordinator.applySpecialistAvailability([], "builder", harness.manager.agentId)).toEqual([]);
    expect(harness.coordinator.applySpecialistAvailability([], "collaboration", harness.manager.agentId)).toEqual([]);
  });

  it("materializes a scoped worker, mutates its identity, and delivers one server-built bootstrap", async () => {
    const harness = new CoordinatorHarness();
    const context = harness.prepareSelectorContext("fireflies");
    harness.coordinator.activateManagerTurn(harness.manager.agentId, { delegation: context });

    const worker = await harness.coordinator.spawnSpecialistWorker(harness.manager.agentId, {
      agentId: "codex-plugin-fireflies",
      specialist: CODEX_PLUGIN_SPECIALIST_ID,
      initialMessage: "Fetch the latest meeting",
      planStep: "Inspect Fireflies",
    });

    expect(worker).toMatchObject({
      internalWorkerKind: CODEX_PLUGIN_INTERNAL_WORKER_KIND,
      displayName: CODEX_PLUGIN_SPECIALIST_DISPLAY_NAME,
      specialistId: CODEX_PLUGIN_SPECIALIST_ID,
      specialistDisplayName: CODEX_PLUGIN_SPECIALIST_DISPLAY_NAME,
      specialistColor: CODEX_PLUGIN_SPECIALIST_COLOR,
    });
    expect(harness.initialTasks).toHaveLength(1);
    expect(harness.initialTasks[0]).toMatchObject({
      managerAgentId: harness.manager.agentId,
      workerAgentId: worker.agentId,
      planStep: "Inspect Fireflies",
    });
    expect(harness.initialTasks[0]?.message).toContain("Fetch the latest meeting");
    expect(harness.initialTasks[0]?.message).toContain("codex_fireflies_list_recent");
    expect(harness.coordinator.getScopeForWorker(worker.agentId)).toMatchObject({
      managerAgentId: harness.manager.agentId,
      workerAgentId: worker.agentId,
      selectors: ["fireflies"],
    });
  });

  it("rejects a concurrent same-manager spawn before materializing another worker", async () => {
    const harness = new CoordinatorHarness();
    const context = harness.prepareSelectorContext("fireflies");
    harness.coordinator.activateManagerTurn(harness.manager.agentId, { delegation: context });

    let markArrived!: () => void;
    const arrived = new Promise<void>((resolve) => {
      markArrived = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.beforeSpawn = async () => {
      markArrived();
      await gate;
    };

    const firstSpawn = harness.coordinator.spawnSpecialistWorker(harness.manager.agentId, {
      agentId: "codex-plugin-a",
      initialMessage: "task alpha",
    });
    await arrived;
    await expect(harness.coordinator.spawnSpecialistWorker(harness.manager.agentId, {
      agentId: "codex-plugin-b",
      initialMessage: "task beta",
    })).rejects.toThrow("already in progress");
    release();

    const worker = await firstSpawn;
    expect(worker.agentId).toBe("codex-plugin-a");
    expect(harness.descriptors.has("codex-plugin-b")).toBe(false);
    expect(harness.initialTasks).toHaveLength(1);
    expect(harness.initialTasks[0]?.message).toContain("task alpha");
    expect(harness.coordinator.getScopeForWorker(worker.agentId)).toBeDefined();
  });

  it("rolls back materialized scope and pending bootstrap when spawn delivery fails", async () => {
    const harness = new CoordinatorHarness();
    const context = harness.prepareSelectorContext("fireflies");
    harness.coordinator.activateManagerTurn(harness.manager.agentId, { delegation: context });
    harness.initialTaskError = new Error("bootstrap failed");

    await expect(harness.coordinator.spawnSpecialistWorker(harness.manager.agentId, {
      agentId: "codex-plugin-failed",
      initialMessage: "fail after materialization",
    })).rejects.toThrow("bootstrap failed");

    expect(harness.coordinator.getScopeForWorker("codex-plugin-failed")).toBeUndefined();
    expect(harness.logs).toContainEqual(expect.objectContaining({
      event: "codex_plugin:specialist_spawn_failed",
      details: expect.objectContaining({ requestedAgentId: "codex-plugin-failed" }),
    }));
  });

  it("authorizes retry only for explicit continuation of a stopped worker and consumes it once", async () => {
    const harness = new CoordinatorHarness();
    const context = harness.prepareSelectorContext("fireflies");
    harness.coordinator.activateManagerTurn(harness.manager.agentId, { delegation: context });
    const firstWorker = await harness.coordinator.spawnSpecialistWorker(harness.manager.agentId, {
      agentId: "codex-plugin-fireflies",
      initialMessage: "first task",
    });
    harness.coordinator.markWorkerStoppedAndCloseScope(firstWorker.agentId);

    const unrelated = harness.coordinator.prepareUserTurn({
      manager: harness.manager,
      text: "show the project status",
      sourceContext: { channel: "web" },
      classification: { kind: "none" },
      userMessageId: "unrelated",
    });
    expect(unrelated.retryAuthorizationContext).toBeUndefined();

    const secondContext = harness.prepareSelectorContext("fireflies");
    harness.coordinator.activateManagerTurn(harness.manager.agentId, { delegation: secondContext });
    const stoppedWorker = await harness.coordinator.spawnSpecialistWorker(harness.manager.agentId, {
      agentId: "codex-plugin-fireflies-2",
      initialMessage: "second task",
    });
    harness.coordinator.markWorkerStoppedAndCloseScope(stoppedWorker.agentId);
    const retry = harness.coordinator.prepareUserTurn({
      manager: harness.manager,
      text: "retry that Codex plugin request",
      sourceContext: { channel: "web" },
      classification: { kind: "none" },
      userMessageId: "retry-message",
    });
    expect(retry.retryAuthorizationContext).toMatchObject({
      retryContextId: secondContext.contextId,
      lastWorkerAgentId: stoppedWorker.agentId,
    });
    harness.coordinator.recordDispatchAccepted(harness.manager.agentId, {
      retryAuthorization: retry.retryAuthorizationContext,
      acceptedMode: "prompt",
    });

    const retried = await harness.coordinator.retryWorker(harness.manager.agentId, {
      initialMessage: "finish the request",
      retryContextId: secondContext.contextId,
    });
    expect(retried.agentId).toContain("codex-plugin-fireflies");
    await expect(harness.coordinator.retryWorker(harness.manager.agentId, {
      initialMessage: "try twice",
      retryContextId: secondContext.contextId,
    })).rejects.toThrow(/only available during the current user turn/i);
  });

  it("enforces scoped worker delivery and closes scope across stop, error, reset, and manager cleanup", async () => {
    const harness = new CoordinatorHarness();
    const context = harness.prepareSelectorContext("fireflies");
    harness.coordinator.activateManagerTurn(harness.manager.agentId, { delegation: context });
    const worker = await harness.coordinator.spawnSpecialistWorker(harness.manager.agentId, {
      agentId: "codex-plugin-fireflies",
      initialMessage: "task",
    });
    const otherManager = makeManager("manager-b");
    harness.descriptors.set(otherManager.agentId, otherManager);

    expect(() => harness.coordinator.assertWorkerNotUserTargetable(worker)).toThrow(/scoped/i);
    expect(() => harness.coordinator.assertWorkerDeliveryAllowed(worker, harness.manager)).not.toThrow();
    expect(() => harness.coordinator.assertWorkerDeliveryAllowed(worker, otherManager)).toThrow(/owning manager/i);
    expect(() => harness.coordinator.assertWorkerDeliveryAllowed(harness.manager, worker, {
      origin: "internal",
      hasAttachments: true,
    })).toThrow(/do not accept attachment/i);

    harness.coordinator.handleRuntimeError(worker.agentId, worker);
    expect(harness.coordinator.getScopeForWorker(worker.agentId)).toBeUndefined();
    harness.coordinator.clearForRuntimeReset(worker.agentId);
    harness.coordinator.closeManagerScopesAndRetry(harness.manager.agentId);
    harness.coordinator.closeManagerScopesAndRetry(harness.manager.agentId);
    expect(harness.coordinator.getScopeForWorker(worker.agentId)).toBeUndefined();
  });

  it("authorizes exact scoped tools and keeps raw manager MCP calls denied", async () => {
    const harness = new CoordinatorHarness();
    const worker = await harness.spawnActiveWorker();
    const scope = harness.coordinator.getScopeForWorker(worker.agentId)!;
    const toolName = scope.allowedTools[0]!.scopedToolName;

    await expect(harness.coordinator.callScopedTool(worker.agentId, toolName, { limit: 2 })).resolves.toMatchObject({
      ok: true,
      selector: "fireflies/list_recent",
    });
    expect(harness.appServer.call).toHaveBeenCalledWith(expect.objectContaining({
      managerAgentId: harness.manager.agentId,
      ownerId: worker.agentId,
      cwd: harness.manager.cwd,
      args: { limit: 2 },
    }));
    await expect(harness.coordinator.callScopedTool(worker.agentId, "codex_unknown")).rejects.toThrow(/not allowed/i);
    expect(() => harness.coordinator.listRawTools()).toThrow(/Raw Codex MCP tools are not available/i);
    expect(() => harness.coordinator.callRawTool()).toThrow(/Raw Codex MCP tool calls are not available/i);
    await expect(harness.coordinator.browseCatalog(harness.manager.agentId)).resolves.toMatchObject({
      plugins: expect.any(Array),
    });
  });

  it("exports artifact then manifest and preserves the current partial-write failure contract", async () => {
    const harness = new CoordinatorHarness();
    const worker = await harness.spawnActiveWorker();
    const toolName = harness.coordinator.getScopeForWorker(worker.agentId)!.allowedTools[0]!.scopedToolName;

    const exported = await harness.coordinator.exportScopedToolResult(worker.agentId, {
      scopedToolName: toolName,
      args: { b: 2, a: 1 },
      fileName: "meeting.json",
      format: "json",
      includePreview: true,
    });
    expect(exported).toMatchObject({
      ok: true,
      absolutePath: expect.stringMatching(/meeting\.json$/),
      manifestPath: expect.stringMatching(/meeting\.json\.manifest\.json$/),
      artifactMarkdown: expect.stringContaining("[artifact:"),
      preview: "bounded preview",
    });
    expect(harness.artifacts.operations.map((entry) => entry.kind)).toEqual([
      "mkdir",
      "artifact",
      "manifest",
    ]);
    const manifest = JSON.parse(harness.artifacts.manifests.at(-1)!.body) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      managerAgentId: harness.manager.agentId,
      workerAgentId: worker.agentId,
      argsSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      redacted: true,
    });

    harness.artifacts.manifestError = new Error("manifest write failed");
    const artifactCount = harness.artifacts.artifacts.length;
    await expect(harness.coordinator.exportScopedToolResult(worker.agentId, {
      scopedToolName: toolName,
      format: "json",
      includePreview: false,
    })).rejects.toThrow("manifest write failed");
    expect(harness.artifacts.artifacts).toHaveLength(artifactCount + 1);

    harness.artifacts.manifestError = undefined;
    harness.artifacts.artifactError = new Error("artifact write failed");
    const manifestCount = harness.artifacts.manifests.length;
    await expect(harness.coordinator.exportScopedToolResult(worker.agentId, {
      scopedToolName: toolName,
      format: "json",
      includePreview: false,
    })).rejects.toThrow("artifact write failed");
    expect(harness.artifacts.manifests).toHaveLength(manifestCount);
  });

  it("normalizes persisted plugin workers and preserves configured specialist definitions", () => {
    const harness = new CoordinatorHarness();
    const worker = makeWorker("legacy-plugin", harness.manager.agentId, {
      internalWorkerKind: CODEX_PLUGIN_INTERNAL_WORKER_KIND,
      displayName: "Legacy",
      specialistId: "old",
      specialistDisplayName: "Old",
      specialistColor: "#000000",
      status: "streaming",
    });
    harness.descriptors.set(worker.agentId, worker);

    expect(harness.coordinator.normalizeWorkersForBoot()).toBe(true);
    expect(worker).toMatchObject({
      displayName: CODEX_PLUGIN_SPECIALIST_DISPLAY_NAME,
      specialistId: CODEX_PLUGIN_SPECIALIST_ID,
      specialistDisplayName: CODEX_PLUGIN_SPECIALIST_DISPLAY_NAME,
      specialistColor: CODEX_PLUGIN_SPECIALIST_COLOR,
      status: "stopped",
    });
    expect(harness.coordinator.normalizeWorkersForBoot()).toBe(false);

    const context = harness.prepareSelectorContext("fireflies");
    harness.coordinator.activateManagerTurn(harness.manager.agentId, { delegation: context });
    const configured = {
      specialistId: CODEX_PLUGIN_SPECIALIST_ID,
      displayName: "Configured Codex",
      color: "#123456",
      enabled: true,
      whenToUse: "configured",
      promptBody: "custom",
      available: true,
    };
    expect(harness.coordinator.applySpecialistAvailability([configured], "builder", harness.manager.agentId))
      .toEqual([configured]);
  });
});

class CoordinatorHarness {
  readonly manager = makeManager("manager-a");
  readonly descriptors = new Map<string, AgentDescriptor>([[this.manager.agentId, this.manager]]);
  readonly mentionChecks: string[] = [];
  readonly initialTasks: Array<{
    managerAgentId: string;
    workerAgentId: string;
    message: string;
    planStep?: string;
  }> = [];
  readonly logs: Array<{ event: string; details: Record<string, unknown> }> = [];
  readonly appServer = new FakeAppServer();
  readonly artifacts = new FakeArtifactFiles();
  readonly coordinator: CodexPluginDelegationCoordinator;
  beforeSpawn?: (input: SpawnAgentInput) => Promise<void>;
  initialTaskError?: Error;
  nowMs = 1_000_000;

  constructor() {
    const host: CodexPluginDelegationHost = {
      getDescriptor: (agentId) => this.descriptors.get(agentId),
      listDescriptors: () => this.descriptors.values(),
      assertDescriptorNotArchived: (descriptor) => {
        if (descriptor.archivedAt) throw new Error("archived");
      },
      assertMentionRoutingAvailable: (manager) => {
        this.mentionChecks.push(manager.agentId);
      },
      spawnAgent: async (managerAgentId, input) => {
        await this.beforeSpawn?.(input);
        const worker = makeWorker(input.agentId, managerAgentId);
        this.descriptors.set(worker.agentId, worker);
        await this.coordinator.prepareWorkerDescriptorForSpawn({
          descriptor: worker,
          specialistId: input.specialist ?? "",
          spawnInput: input,
        });
        return worker;
      },
      sendInitialTask: async (input) => {
        this.initialTasks.push(input);
        if (this.initialTaskError) throw this.initialTaskError;
      },
      getSessionDir: () => "/session/manager-a",
      now: () => "2026-07-13T12:00:00.000Z",
      logDebug: (event, details) => {
        this.logs.push({ event, details });
      },
    };
    this.coordinator = new CodexPluginDelegationCoordinator({
      appServer: this.appServer.port,
      host,
      artifactFiles: this.artifacts,
      nowMs: () => this.nowMs,
    });
  }

  prepareSelectorContext(selector: string): CodexPluginDelegationTurnContext {
    const text = `@Codex -${selector} find it`;
    const classification = this.coordinator.classifyAndPreflightUserTurn(
      this.manager,
      text,
      { channel: "web" },
    );
    return this.coordinator.prepareUserTurn({
      manager: this.manager,
      text,
      sourceContext: { channel: "web" },
      classification,
      userMessageId: `message-${selector}-${this.nowMs}`,
    }).delegationContext!;
  }

  async spawnActiveWorker(): Promise<AgentDescriptor> {
    const context = this.prepareSelectorContext("fireflies");
    this.coordinator.activateManagerTurn(this.manager.agentId, { delegation: context });
    return this.coordinator.spawnSpecialistWorker(this.manager.agentId, {
      agentId: "codex-plugin-fireflies",
      initialMessage: "fetch meeting",
    });
  }
}

class FakeAppServer {
  private readonly snapshot = makeCatalog();
  private readonly resolver = new CodexMcpCatalog(async () => {
    throw new Error("catalog fetch should not occur");
  });
  result: CodexMcpToolCallResult = {
    auditId: "audit-1",
    selector: "fireflies/list_recent",
    serverName: "fireflies",
    toolName: "list_recent",
    ok: true,
    redactedPreview: "bounded preview",
    redactedModelContent: JSON.stringify({ meeting: "redacted full content" }),
    redactedModelContentTruncated: false,
  };
  readonly call = vi.fn(async () => this.result);
  readonly port: CodexPluginAppServerPort = {
    listCodexMcpTools: async () => this.snapshot,
    resolveCodexPluginInCatalog: (selector, catalog) => this.resolver.resolvePlugin(selector, catalog),
    resolveCodexMcpToolInCatalog: (selector, catalog) => this.resolver.resolveTool(selector, catalog),
    filterCodexMcpToolsForAuthorizedSelectors: (catalog, selectors) =>
      this.resolver.filterToolsForAuthorizedSelectors(catalog, selectors),
    callCodexMcpToolByExactTool: this.call,
  };
}

class FakeArtifactFiles implements CodexPluginArtifactFilePort {
  readonly operations: Array<{ kind: "mkdir" | "artifact" | "manifest"; path: string }> = [];
  readonly artifacts: Array<{ path: string; body: string }> = [];
  readonly manifests: Array<{ path: string; body: string }> = [];
  artifactError?: Error;
  manifestError?: Error;

  async ensureDirectory(path: string): Promise<void> {
    this.operations.push({ kind: "mkdir", path });
  }

  async writeUniqueArtifact(input: {
    directory: string;
    baseName: string;
    extension: string;
    body: string;
  }): Promise<string> {
    if (this.artifactError) throw this.artifactError;
    const path = `${input.directory}/${input.baseName}.${input.extension}`;
    this.operations.push({ kind: "artifact", path });
    this.artifacts.push({ path, body: input.body });
    return path;
  }

  async writeManifest(path: string, body: string): Promise<void> {
    if (this.manifestError) throw this.manifestError;
    this.operations.push({ kind: "manifest", path });
    this.manifests.push({ path, body });
  }
}

function makeCatalog(): CodexCatalogSnapshot {
  return {
    apps: [{ id: "fireflies", name: "Fireflies" }],
    plugins: [{
      selector: "fireflies",
      name: "fireflies",
      pluginId: "fireflies@openai-curated",
      displayName: "Fireflies",
      enabled: true,
      availability: "available",
    }],
    tools: [{
      selector: "fireflies/list_recent",
      serverName: "fireflies",
      toolName: "list_recent",
      description: "List recent meetings",
      readOnly: true,
      annotations: { readOnlyHint: true },
      inputSchema: { type: "object", properties: { limit: { type: "integer" } } },
    }],
    fetchedAt: "2026-07-13T12:00:00.000Z",
  };
}

function makeManager(agentId: string): AgentDescriptor & { role: "manager"; profileId: string } {
  return {
    agentId,
    displayName: agentId,
    role: "manager",
    managerId: agentId,
    profileId: "profile-a",
    status: "idle",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    cwd: "/repo",
    model: { provider: "test", modelId: "test", thinkingLevel: "none" },
    sessionFile: `/sessions/${agentId}.jsonl`,
  };
}

function makeWorker(
  agentId: string,
  managerId: string,
  patch: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    ...makeManager(agentId),
    role: "worker",
    managerId,
    profileId: "profile-a",
    ...patch,
  };
}
