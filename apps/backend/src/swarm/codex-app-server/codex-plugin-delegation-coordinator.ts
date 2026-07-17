import { createHash } from "node:crypto";
import { join } from "node:path";
import type { SpecialistTargetSpace } from "@forge/protocol";
import { isNonRunningAgentStatus } from "../agent-state-machine.js";
import { sanitizePathSegment } from "../swarm-manager-utils.js";
import type { CodexTurnActivation } from "../turn-context-coordinator.js";
import type {
  AcceptedDeliveryMode,
  AgentDescriptor,
  MessageSourceContext,
  SpawnAgentInput,
  SwarmReasoningLevel,
} from "../types.js";
import type { CodexAppServerService } from "./codex-app-server-service.js";
import {
  createCodexPluginArtifactFilePort,
  type CodexPluginArtifactFilePort,
} from "./codex-plugin-artifact-files.js";
import type {
  CodexCatalogSnapshot,
  CodexMcpToolCallResult,
} from "./codex-mcp-catalog.js";
import {
  assertCodexMcpToolGateAllowed,
  buildCodexMcpToolTurnAuthorization,
  evaluateCodexMcpCatalogBrowseGate,
  evaluateCodexMcpToolGate,
  type CodexMcpToolGateEvaluation,
} from "./codex-mcp-tool-gate.js";
import {
  classifyCodexUserMessage,
  type CodexUserMessageRoute,
} from "./codex-mention-router.js";
import {
  buildCodexPluginInitialTask,
  buildCodexPluginWorkerPrompt,
  CODEX_PLUGIN_INTERNAL_WORKER_KIND,
  CODEX_PLUGIN_SPECIALIST_COLOR,
  CODEX_PLUGIN_SPECIALIST_DISPLAY_NAME,
  CODEX_PLUGIN_SPECIALIST_ID,
  CodexPluginScopeService,
  createCodexPluginDelegationId,
  isCodexPluginWorkerDescriptor,
  type CodexPluginExportFormat,
  type CodexPluginScopedExportResult,
  type CodexPluginScopeRuntimeView,
} from "./codex-plugin-scope-service.js";
import { truncateCodexPreview } from "./codex-sidecar-parent-cards.js";

const RETRY_CONTEXT_TTL_MS = 2 * 60 * 60_000;
const RETRY_AUTHORIZATION_TTL_MS = 10 * 60_000;

export type CodexPluginManager = AgentDescriptor & { role: "manager"; profileId?: string };

export interface CodexPluginDelegationTurnContext {
  contextId: string;
  managerAgentId: string;
  originalText: string;
  strippedText: string;
  selectors: string[];
  sourceContext: MessageSourceContext;
  userMessageId?: string;
}

export interface CodexPluginRetryAuthorizationContext {
  retryContextId: string;
  activeContext: CodexPluginDelegationTurnContext;
  authorizedUserMessageId?: string;
  createdAt: number;
  lastWorkerAgentId?: string;
}

export interface CodexPluginPreparedUserTurn {
  delegationContext?: CodexPluginDelegationTurnContext;
  retryAuthorizationContext?: CodexPluginRetryAuthorizationContext;
}

export interface CodexPluginSpecialistDefinition {
  specialistId: string;
  displayName: string;
  color: string;
  enabled: boolean;
  whenToUse: string;
  modelId?: string;
  provider?: string;
  reasoningLevel?: SwarmReasoningLevel;
  fallbackModelId?: string;
  fallbackProvider?: string;
  fallbackReasoningLevel?: SwarmReasoningLevel;
  webSearch?: boolean;
  promptBody: string;
  available: boolean;
  availabilityCode?: string;
  availabilityMessage?: string;
}

export interface CodexPluginDelegationHost {
  getDescriptor(agentId: string): AgentDescriptor | undefined;
  listDescriptors(): Iterable<AgentDescriptor>;
  assertDescriptorNotArchived(descriptor: AgentDescriptor): void;
  assertMentionRoutingAvailable(manager: CodexPluginManager): void;
  spawnAgent(managerAgentId: string, input: SpawnAgentInput): Promise<AgentDescriptor>;
  sendInitialTask(input: {
    managerAgentId: string;
    workerAgentId: string;
    message: string;
    planStep?: string;
  }): Promise<void>;
  getSessionDir(descriptor: CodexPluginManager): string;
  now(): string;
  logDebug(event: string, details: Record<string, unknown>): void;
}

export type CodexPluginAppServerPort = Pick<
  CodexAppServerService,
  | "listCodexMcpTools"
  | "resolveCodexPluginInCatalog"
  | "resolveCodexMcpToolInCatalog"
  | "filterCodexMcpToolsForAuthorizedSelectors"
  | "callCodexMcpToolByExactTool"
>;

export interface CodexPluginDelegationCoordinatorOptions {
  appServer: CodexPluginAppServerPort;
  host: CodexPluginDelegationHost;
  scopeService?: CodexPluginScopeService;
  artifactFiles?: CodexPluginArtifactFilePort;
  nowMs?: () => number;
}

interface PendingSpawnContext {
  delegationId: string;
  activeContext: CodexPluginDelegationTurnContext;
  task: string;
  materializedWorkerAgentIds: Set<string>;
}

interface RetryContext {
  retryContextId: string;
  activeContext: CodexPluginDelegationTurnContext;
  createdAt: number;
  lastWorkerAgentId?: string;
}

export class CodexPluginDelegationCoordinator {
  private readonly gateByManagerId = new Map<string, CodexMcpToolGateEvaluation>();
  private readonly activeDelegationByManagerId = new Map<string, CodexPluginDelegationTurnContext>();
  private readonly retryContextByManagerId = new Map<string, RetryContext>();
  private readonly retryAuthorizationByManagerId = new Map<string, CodexPluginRetryAuthorizationContext>();
  private readonly stoppedWorkerIds = new Set<string>();
  private readonly pendingSpawnByManagerId = new Map<string, PendingSpawnContext>();
  private readonly pendingSpawnByInput = new WeakMap<SpawnAgentInput, PendingSpawnContext>();
  private readonly pendingInitialTaskByWorkerId = new Map<string, string>();
  private readonly scopeService: CodexPluginScopeService;
  private readonly artifactFiles: CodexPluginArtifactFilePort;
  private readonly nowMs: () => number;

  constructor(private readonly options: CodexPluginDelegationCoordinatorOptions) {
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.scopeService = options.scopeService ?? new CodexPluginScopeService({
      nowMs: this.nowMs,
      catalog: {
        listCatalog: () => options.appServer.listCodexMcpTools(),
        resolvePlugin: (selector, catalog) =>
          options.appServer.resolveCodexPluginInCatalog(selector, catalog),
        resolveTool: (selector, catalog) =>
          options.appServer.resolveCodexMcpToolInCatalog(selector, catalog),
        filterToolsForAuthorizedSelectors: (catalog, selectors) =>
          options.appServer.filterCodexMcpToolsForAuthorizedSelectors(catalog, selectors),
      },
    });
    this.artifactFiles = options.artifactFiles ?? createCodexPluginArtifactFilePort();
  }

  classifyAndPreflightUserTurn(
    manager: CodexPluginManager,
    text: string,
    sourceContext: MessageSourceContext,
  ): CodexUserMessageRoute {
    const classification = classifyCodexUserMessage(text);
    if (classification.kind === "plugin_delegate") {
      assertCodexMcpToolGateAllowed(evaluateCodexMcpToolGate({
        manager,
        sourceContext,
        messageText: text,
        inboundSource: "user_input",
      }));
      this.options.host.assertMentionRoutingAvailable(manager);
    }
    return classification;
  }

  prepareUserTurn(input: {
    manager: CodexPluginManager;
    text: string;
    sourceContext: MessageSourceContext;
    classification: CodexUserMessageRoute;
    userMessageId?: string;
  }): CodexPluginPreparedUserTurn {
    if (input.classification.kind === "plugin_delegate") {
      return {
        delegationContext: {
          contextId: createCodexPluginDelegationId(),
          managerAgentId: input.manager.agentId,
          originalText: input.text,
          strippedText: input.classification.strippedText,
          selectors: [...input.classification.selectors],
          sourceContext: { ...input.sourceContext },
          ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
        },
      };
    }

    return {
      retryAuthorizationContext: this.createRetryAuthorizationForUserTurn(
        input.manager.agentId,
        input.text,
        input.userMessageId,
      ),
    };
  }

  buildTurnGate(
    manager: CodexPluginManager,
    sourceContext: MessageSourceContext,
    messageText: string,
    classification: CodexUserMessageRoute,
    inboundSource: "user_input" | "project_agent_input" = "user_input",
  ): CodexMcpToolGateEvaluation {
    return buildCodexMcpToolTurnAuthorization({
      surfaceGate: evaluateCodexMcpToolGate({ manager, sourceContext, messageText, inboundSource }),
      codexClassification: classification,
    });
  }

  appendManagerTurnGuidance(
    managerVisibleMessage: string,
    delegation?: CodexPluginDelegationTurnContext,
    retryAuthorization?: CodexPluginRetryAuthorizationContext,
  ): string {
    if (delegation) return appendDelegationGuidance(managerVisibleMessage, delegation);
    if (retryAuthorization) return appendRetryGuidance(managerVisibleMessage, retryAuthorization);
    return managerVisibleMessage;
  }

  recordDispatchAccepted(
    managerAgentId: string,
    input: {
      gate?: CodexMcpToolGateEvaluation;
      delegation?: CodexPluginDelegationTurnContext;
      retryAuthorization?: CodexPluginRetryAuthorizationContext;
      acceptedMode: AcceptedDeliveryMode;
    },
  ): void {
    if (input.gate) this.gateByManagerId.set(managerAgentId, input.gate);
    if (input.delegation && input.acceptedMode === "prompt") {
      this.activeDelegationByManagerId.set(managerAgentId, input.delegation);
      this.retryAuthorizationByManagerId.delete(managerAgentId);
      this.rememberRetryContext(input.delegation);
    } else if (input.retryAuthorization && input.acceptedMode === "prompt") {
      this.activeDelegationByManagerId.delete(managerAgentId);
      this.retryAuthorizationByManagerId.set(managerAgentId, input.retryAuthorization);
    }
  }

  noteRuntimeUserMessageStarted(agentId: string, descriptor: AgentDescriptor | undefined): void {
    if (isCodexPluginWorkerDescriptor(descriptor)) this.scopeService.noteWorkerTurnStarted(agentId);
  }

  activateManagerTurn(
    agentId: string,
    activation: CodexTurnActivation<
      CodexMcpToolGateEvaluation,
      CodexPluginDelegationTurnContext,
      CodexPluginRetryAuthorizationContext
    >,
  ): void {
    if (activation.gate) {
      this.gateByManagerId.set(agentId, activation.gate);
    } else if (!this.hasActiveAuthorizedGate(agentId)) {
      this.gateByManagerId.set(agentId, {
        allowed: false,
        reason: "Codex MCP tools are only available on turns with Codex tool mention tags.",
      });
    }

    if (activation.delegation) {
      this.activeDelegationByManagerId.set(agentId, activation.delegation);
      this.rememberRetryContext(activation.delegation);
    } else {
      this.activeDelegationByManagerId.delete(agentId);
      this.retryAuthorizationByManagerId.delete(agentId);
    }

    if (activation.retryAuthorization) {
      this.retryAuthorizationByManagerId.set(agentId, activation.retryAuthorization);
    } else {
      this.retryAuthorizationByManagerId.delete(agentId);
    }
  }

  completeProviderCycle(agentId: string): void {
    this.clearActiveTurn(agentId);
  }

  completeAgentTurn(agentId: string): void {
    this.clearActiveTurn(agentId);
  }

  handleRuntimeError(agentId: string, descriptor: AgentDescriptor | undefined): void {
    if (descriptor?.role === "manager") {
      this.activeDelegationByManagerId.delete(agentId);
      this.clearRetryContextForManager(agentId);
      this.scopeService.closeScopesForManager(agentId);
    } else if (isCodexPluginWorkerDescriptor(descriptor)) {
      this.scopeService.closeScopeForWorker(agentId);
    }
  }

  clearForRuntimeReset(agentId: string): void {
    this.gateByManagerId.delete(agentId);
    this.activeDelegationByManagerId.delete(agentId);
    this.clearRetryContextForManager(agentId);
    this.scopeService.closeScopesForManager(agentId);
    if (isCodexPluginWorkerDescriptor(this.options.host.getDescriptor(agentId))) {
      this.scopeService.closeScopeForWorker(agentId);
    }
  }

  recordManagerAgentEnd(agentId: string): void {
    this.activeDelegationByManagerId.delete(agentId);
    this.retryAuthorizationByManagerId.delete(agentId);
  }

  async prepareWorkerDescriptorForSpawn(input: {
    descriptor: AgentDescriptor;
    specialistId?: string;
    spawnInput: SpawnAgentInput;
  }): Promise<void> {
    if (input.specialistId !== CODEX_PLUGIN_SPECIALIST_ID) return;
    const pending = this.pendingSpawnByInput.get(input.spawnInput) ??
      this.pendingSpawnByManagerId.get(input.descriptor.managerId);
    if (!pending) return;

    const materialized = await this.scopeService.materializePendingScope({
      managerAgentId: input.descriptor.managerId,
      workerAgentId: input.descriptor.agentId,
      delegationId: pending.delegationId,
      selectors: pending.activeContext.selectors,
    });
    pending.materializedWorkerAgentIds.add(input.descriptor.agentId);
    if (this.pendingSpawnByManagerId.get(input.descriptor.managerId) === pending) {
      this.scopeService.closeScopesForManager(input.descriptor.managerId, {
        exceptWorkerAgentId: input.descriptor.agentId,
      });
    } else this.scopeService.closeScopeForWorker(input.descriptor.agentId);
    Object.assign(input.descriptor, {
      displayName: CODEX_PLUGIN_SPECIALIST_DISPLAY_NAME,
      internalWorkerKind: CODEX_PLUGIN_INTERNAL_WORKER_KIND,
      specialistId: CODEX_PLUGIN_SPECIALIST_ID,
      specialistDisplayName: CODEX_PLUGIN_SPECIALIST_DISPLAY_NAME,
      specialistColor: CODEX_PLUGIN_SPECIALIST_COLOR,
    });
    this.pendingInitialTaskByWorkerId.set(input.descriptor.agentId, buildCodexPluginInitialTask({
      managerAgentId: input.descriptor.managerId,
      task: pending.task,
      userMessage: pending.activeContext.originalText,
      strippedRequest: pending.activeContext.strippedText,
      selectors: pending.activeContext.selectors,
      allowedTools: materialized.scope.allowedTools,
    }));
  }

  async spawnSpecialistWorker(managerAgentId: string, input: SpawnAgentInput): Promise<AgentDescriptor> {
    const manager = this.requireAvailableManager(managerAgentId, "specialist");
    const activeContext = this.activeDelegationByManagerId.get(managerAgentId);
    if (!activeContext) {
      throw new Error(
        "Codex Plugin specialist is only available during an active user turn with Codex plugin selector tags.",
      );
    }
    if (activeContext.managerAgentId !== manager.agentId) {
      throw new Error("Codex Plugin specialist context is bound to a different manager session.");
    }
    return this.spawnWorkerForContext(manager, input, activeContext, "active_selector");
  }

  async retryWorker(
    managerAgentId: string,
    input: { initialMessage: string; retryContextId?: string },
  ): Promise<AgentDescriptor> {
    const manager = this.requireAvailableManager(managerAgentId, "retry");
    const retryContext = this.requireRetryContext(manager.agentId, input.retryContextId);
    this.requireActiveRetryAuthorization(manager.agentId, retryContext.retryContextId);
    const task = input.initialMessage.trim();
    if (!task) throw new Error("retry_codex_plugin_worker requires a non-empty initialMessage.");

    const spawned = await this.spawnWorkerForContext(manager, {
      agentId: this.defaultWorkerAgentId(retryContext.activeContext),
      specialist: CODEX_PLUGIN_SPECIALIST_ID,
      initialMessage: task,
    }, retryContext.activeContext, "retry");
    this.retryAuthorizationByManagerId.delete(manager.agentId);
    return spawned;
  }

  markWorkerStoppedAndCloseScope(agentId: string): void {
    if (isCodexPluginWorkerDescriptor(this.options.host.getDescriptor(agentId))) {
      this.stoppedWorkerIds.add(agentId);
    }
    this.scopeService.closeScopeForWorker(agentId);
  }

  closeManagerScopesAndRetry(managerAgentId: string): void {
    this.scopeService.closeScopesForManager(managerAgentId);
    this.clearRetryContextForManager(managerAgentId);
  }

  closeDescriptorScopes(descriptor: AgentDescriptor): void {
    if (descriptor.role === "manager") {
      this.closeManagerScopesAndRetry(descriptor.agentId);
    } else if (isCodexPluginWorkerDescriptor(descriptor)) {
      this.scopeService.closeScopeForWorker(descriptor.agentId);
    }
  }

  closeWorkerScope(agentId: string): void {
    this.scopeService.closeScopeForWorker(agentId);
  }

  assertWorkerNotUserTargetable(target: AgentDescriptor): void {
    if (!isCodexPluginWorkerDescriptor(target)) return;
    throw new Error(
      "Codex Plugin workers are scoped to the active Codex Plugin specialist worker. Ask the manager with a new @Codex selector to start a new scoped worker.",
    );
  }

  assertWorkerDeliveryAllowed(
    sender: AgentDescriptor,
    target: AgentDescriptor,
    options?: { origin?: "user" | "internal"; hasAttachments?: boolean },
  ): void {
    if (isCodexPluginWorkerDescriptor(sender)) {
      if (target.role === "manager" && target.agentId === sender.managerId) return;
      throw new Error("Codex Plugin workers can only report to their owning manager.");
    }
    if (!isCodexPluginWorkerDescriptor(target)) return;
    if (options?.origin === "user") {
      throw new Error(
        "Codex Plugin workers are scoped to the active Codex Plugin specialist worker. Ask the manager with a new @Codex selector to start a new scoped worker.",
      );
    }
    if (sender.role !== "manager" || sender.agentId !== target.managerId) {
      throw new Error(
        "Codex Plugin workers only accept follow-ups from their owning manager while their scoped worker is active.",
      );
    }
    if (!this.scopeService.getScopeForWorker(target.agentId)) {
      throw new Error(
        "Codex Plugin worker scope is no longer active. Start a new @Codex plugin selector turn to create a fresh scoped worker.",
      );
    }
    if (options?.hasAttachments) {
      throw new Error(
        "Codex Plugin workers do not accept attachment payloads. Inspect or summarize attachments in the manager turn, then pass only relevant text context to the Codex Plugin specialist.",
      );
    }
  }

  async browseCatalog(managerAgentId: string): Promise<CodexCatalogSnapshot> {
    const manager = this.requireManagerForTools(managerAgentId);
    assertCodexMcpToolGateAllowed(evaluateCodexMcpCatalogBrowseGate({ manager }));
    return this.options.appServer.listCodexMcpTools();
  }

  listRawTools(): never {
    throw new Error(
      "Raw Codex MCP tools are not available to manager runtimes. Use @Codex plugin selector mentions and spawn the visible codex-plugin specialist.",
    );
  }

  callRawTool(): never {
    throw new Error(
      "Raw Codex MCP tool calls are not available to manager runtimes. Use @Codex plugin selector mentions and spawn the visible codex-plugin specialist.",
    );
  }

  getScopeForWorker(workerAgentId: string): CodexPluginScopeRuntimeView | undefined {
    if (!isCodexPluginWorkerDescriptor(this.options.host.getDescriptor(workerAgentId))) return undefined;
    return this.scopeService.getScopeForWorker(workerAgentId);
  }

  async callScopedTool(
    workerAgentId: string,
    scopedToolName: string,
    args?: Record<string, unknown>,
  ): Promise<CodexMcpToolCallResult> {
    const { worker, manager, allowed } = this.authorizeScopedTool(workerAgentId, scopedToolName);
    return this.options.appServer.callCodexMcpToolByExactTool({
      managerAgentId: manager.agentId,
      ownerId: workerAgentId,
      cwd: manager.cwd ?? worker.cwd ?? process.cwd(),
      tool: {
        selector: `${allowed.serverName}/${allowed.toolName}`,
        serverName: allowed.serverName,
        toolName: allowed.toolName,
        description: allowed.description,
        inputSchema: allowed.inputSchema,
        readOnly: true,
        annotations: { readOnlyHint: true },
      },
      args,
    });
  }

  async exportScopedToolResult(
    workerAgentId: string,
    input: {
      scopedToolName: string;
      args?: Record<string, unknown>;
      fileName?: string;
      format: CodexPluginExportFormat;
      includePreview: boolean;
    },
  ): Promise<CodexPluginScopedExportResult> {
    const { manager, allowed, scope } = this.authorizeScopedTool(workerAgentId, input.scopedToolName);
    const result = await this.callScopedTool(workerAgentId, input.scopedToolName, input.args);
    if (!result.ok) {
      throw new Error(result.errorPreview ?? "Codex plugin scoped tool call failed; no export artifact was written.");
    }
    if (!result.redactedModelContent) {
      throw new Error(
        "Codex plugin scoped tool returned only a bounded preview; full export payload is unavailable, so no artifact was written.",
      );
    }
    if (result.redactedModelContentTruncated) {
      throw new Error(
        "Codex plugin scoped tool full payload was truncated before export; no artifact was written. Ask the user to narrow the request or use a plugin-native export if available.",
      );
    }

    const body = JSON.stringify(JSON.parse(result.redactedModelContent), null, 2);
    const baseName = sanitizePathSegment(
      input.fileName ?? `${allowed.toolName}-${this.nowMs()}`,
      allowed.toolName || "codex-plugin-result",
    ).replace(/\.(json|txt|text|md|markdown)$/i, "");
    const artifactDir = join(
      this.options.host.getSessionDir(manager),
      "artifacts",
      "codex-plugin",
      sanitizePathSegment(scope.delegationId, "delegation"),
    );
    await this.artifactFiles.ensureDirectory(artifactDir);
    const absolutePath = await this.artifactFiles.writeUniqueArtifact({
      directory: artifactDir,
      baseName,
      extension: "json",
      body,
    });
    const bytes = Buffer.byteLength(body, "utf8");
    const manifestPath = `${absolutePath}.manifest.json`;
    await this.artifactFiles.writeManifest(manifestPath, JSON.stringify({
      schemaVersion: 1,
      createdAt: this.options.host.now(),
      managerAgentId: manager.agentId,
      workerAgentId,
      delegationId: scope.delegationId,
      selector: result.selector,
      serverName: result.serverName,
      toolName: result.toolName,
      scopedToolName: input.scopedToolName,
      format: input.format,
      bytes,
      argsSha256: hashExportArgs(input.args),
      redacted: true,
      truncated: false,
      sourceAuditId: result.auditId,
      artifactPath: absolutePath,
    }, null, 2));

    return {
      ok: true,
      absolutePath,
      manifestPath,
      artifactMarkdown: formatArtifactShortcode(absolutePath),
      manifestMarkdown: formatArtifactShortcode(manifestPath),
      bytes,
      selector: result.selector,
      serverName: result.serverName,
      toolName: result.toolName,
      scopedToolName: input.scopedToolName,
      format: input.format,
      auditId: result.auditId,
      truncated: false,
      ...(input.includePreview && result.redactedPreview
        ? { preview: truncateCodexPreview(result.redactedPreview) }
        : {}),
    };
  }

  normalizeWorkersForBoot(): boolean {
    let changed = false;
    for (const descriptor of this.options.host.listDescriptors()) {
      if (!isCodexPluginWorkerDescriptor(descriptor)) continue;
      const expected = {
        specialistId: CODEX_PLUGIN_SPECIALIST_ID,
        specialistDisplayName: CODEX_PLUGIN_SPECIALIST_DISPLAY_NAME,
        specialistColor: CODEX_PLUGIN_SPECIALIST_COLOR,
        displayName: CODEX_PLUGIN_SPECIALIST_DISPLAY_NAME,
      };
      for (const [key, value] of Object.entries(expected)) {
        if (descriptor[key as keyof AgentDescriptor] !== value) {
          Object.assign(descriptor, { [key]: value });
          changed = true;
        }
      }
      if (descriptor.status === "idle" || descriptor.status === "streaming") {
        descriptor.status = "stopped";
        changed = true;
      }
    }
    return changed;
  }

  applySpecialistAvailability<T extends CodexPluginSpecialistDefinition>(
    roster: T[],
    targetSpace: SpecialistTargetSpace,
    managerAgentId: string,
  ): Array<T | CodexPluginSpecialistDefinition> {
    if (targetSpace !== "builder") return roster;
    const withoutCodex = roster.filter((entry) => entry.specialistId !== CODEX_PLUGIN_SPECIALIST_ID);
    if (
      !this.activeDelegationByManagerId.has(managerAgentId) &&
      !this.pendingSpawnByManagerId.has(managerAgentId)
    ) {
      return withoutCodex;
    }
    const configured = roster.find((entry) => entry.specialistId === CODEX_PLUGIN_SPECIALIST_ID);
    return [...withoutCodex, configured ?? createVirtualSpecialistDefinition()];
  }

  private async spawnWorkerForContext(
    manager: CodexPluginManager,
    input: SpawnAgentInput,
    activeContext: CodexPluginDelegationTurnContext,
    source: "active_selector" | "retry",
  ): Promise<AgentDescriptor> {
    if (this.pendingSpawnByManagerId.has(manager.agentId)) {
      throw new Error("A Codex Plugin specialist spawn is already in progress for this manager.");
    }
    const task = input.initialMessage?.trim() ||
      activeContext.strippedText.trim() ||
      activeContext.originalText.trim();
    if (!task) throw new Error("Codex Plugin specialist requires a non-empty initialMessage task.");

    const requestedAgentId = input.agentId?.trim() || this.defaultWorkerAgentId(activeContext);
    const delegationId = createCodexPluginDelegationId();
    const pending: PendingSpawnContext = {
      delegationId,
      activeContext,
      task,
      materializedWorkerAgentIds: new Set(),
    };
    const spawnInput: SpawnAgentInput = {
      ...input,
      agentId: requestedAgentId,
      specialist: CODEX_PLUGIN_SPECIALIST_ID,
      initialMessage: undefined,
    };
    this.pendingSpawnByManagerId.set(manager.agentId, pending);
    this.pendingSpawnByInput.set(spawnInput, pending);

    try {
      const descriptor = await this.options.host.spawnAgent(manager.agentId, spawnInput);
      const initialTask = this.pendingInitialTaskByWorkerId.get(descriptor.agentId);
      if (initialTask) {
        await this.options.host.sendInitialTask({
          managerAgentId: manager.agentId,
          workerAgentId: descriptor.agentId,
          message: initialTask,
          ...(input.planStep ? { planStep: input.planStep } : {}),
        });
        this.pendingInitialTaskByWorkerId.delete(descriptor.agentId);
      }
      this.rememberRetryContext(activeContext, descriptor.agentId);
      this.options.host.logDebug("codex_plugin:specialist_spawned", {
        managerAgentId: manager.agentId,
        workerAgentId: descriptor.agentId,
        delegationId,
        selectors: activeContext.selectors,
        toolCount: this.getScopeForWorker(descriptor.agentId)?.allowedTools.length ?? 0,
        userMessageId: activeContext.userMessageId,
        source,
      });
      return descriptor;
    } catch (error) {
      for (const workerAgentId of pending.materializedWorkerAgentIds) {
        this.scopeService.closeScopeForWorker(workerAgentId);
        this.pendingInitialTaskByWorkerId.delete(workerAgentId);
      }
      this.options.host.logDebug("codex_plugin:specialist_spawn_failed", {
        managerAgentId: manager.agentId,
        requestedAgentId,
        delegationId,
        selectors: activeContext.selectors,
        source,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      if (this.pendingSpawnByManagerId.get(manager.agentId)?.delegationId === delegationId) {
        this.pendingSpawnByManagerId.delete(manager.agentId);
      }
      this.pendingSpawnByInput.delete(spawnInput);
    }
  }

  private rememberRetryContext(
    context: CodexPluginDelegationTurnContext,
    lastWorkerAgentId?: string,
  ): void {
    const existing = this.retryContextByManagerId.get(context.managerAgentId);
    if (lastWorkerAgentId && existing?.lastWorkerAgentId && existing.lastWorkerAgentId !== lastWorkerAgentId) {
      this.stoppedWorkerIds.delete(existing.lastWorkerAgentId);
    }
    this.retryContextByManagerId.set(context.managerAgentId, {
      retryContextId: context.contextId,
      activeContext: cloneDelegationContext(context),
      createdAt: existing?.retryContextId === context.contextId ? existing.createdAt : this.nowMs(),
      lastWorkerAgentId: lastWorkerAgentId ?? existing?.lastWorkerAgentId,
    });
  }

  private clearRetryContextForManager(managerAgentId: string): void {
    const existing = this.retryContextByManagerId.get(managerAgentId);
    if (existing?.lastWorkerAgentId) this.stoppedWorkerIds.delete(existing.lastWorkerAgentId);
    this.retryContextByManagerId.delete(managerAgentId);
    this.retryAuthorizationByManagerId.delete(managerAgentId);
  }

  private requireRetryContext(managerAgentId: string, retryContextId?: string): RetryContext {
    const retryContext = this.retryContextByManagerId.get(managerAgentId);
    if (!retryContext) {
      throw new Error(
        "No Codex Plugin retry context is available. Ask the user to re-tag the request with @Codex and the desired plugin selector.",
      );
    }
    if (retryContext.activeContext.managerAgentId !== managerAgentId) {
      throw new Error(
        "Codex Plugin retry context belongs to a different manager session. Ask the user to re-tag the request.",
      );
    }
    if (retryContextId && retryContext.retryContextId !== retryContextId) {
      throw new Error(
        "Codex Plugin retry context id is unavailable or expired. Ask the user to re-tag the request.",
      );
    }
    if (this.nowMs() - retryContext.createdAt > RETRY_CONTEXT_TTL_MS) {
      this.clearRetryContextForManager(managerAgentId);
      throw new Error(
        "Codex Plugin retry context expired. Ask the user to re-tag the request with @Codex and the desired plugin selector.",
      );
    }
    return retryContext;
  }

  private createRetryAuthorizationForUserTurn(
    managerAgentId: string,
    userText: string,
    userMessageId?: string,
  ): CodexPluginRetryAuthorizationContext | undefined {
    const retryContext = this.retryContextByManagerId.get(managerAgentId);
    if (!retryContext) return undefined;
    let fresh: RetryContext;
    try {
      fresh = this.requireRetryContext(managerAgentId, retryContext.retryContextId);
    } catch {
      return undefined;
    }
    if (!isExplicitRetryContinuationText(userText) || !this.isRetryWorkerStoppedOrFailed(fresh)) {
      this.clearRetryContextForManager(managerAgentId);
      return undefined;
    }
    return {
      retryContextId: fresh.retryContextId,
      activeContext: cloneDelegationContext(fresh.activeContext),
      ...(userMessageId ? { authorizedUserMessageId: userMessageId } : {}),
      createdAt: this.nowMs(),
      ...(fresh.lastWorkerAgentId ? { lastWorkerAgentId: fresh.lastWorkerAgentId } : {}),
    };
  }

  private isRetryWorkerStoppedOrFailed(retryContext: RetryContext): boolean {
    if (!retryContext.lastWorkerAgentId) return false;
    const worker = this.options.host.getDescriptor(retryContext.lastWorkerAgentId);
    if (!worker) return true;
    if (
      !isCodexPluginWorkerDescriptor(worker) ||
      worker.managerId !== retryContext.activeContext.managerAgentId
    ) {
      return false;
    }
    return this.stoppedWorkerIds.has(worker.agentId) || isNonRunningAgentStatus(worker.status);
  }

  private requireActiveRetryAuthorization(
    managerAgentId: string,
    retryContextId?: string,
  ): CodexPluginRetryAuthorizationContext {
    const authorization = this.retryAuthorizationByManagerId.get(managerAgentId);
    if (!authorization) {
      throw new Error(
        "Codex Plugin retry is only available during the current user turn when Forge has classified that turn as an explicit retry/continuation of a stopped or failed scoped Codex Plugin worker. Ask the user to re-tag @Codex if they want a new plugin scope.",
      );
    }
    if (retryContextId && authorization.retryContextId !== retryContextId) {
      throw new Error(
        "Codex Plugin retry context id is unavailable for this user turn. Ask the user to re-tag the request.",
      );
    }
    if (this.nowMs() - authorization.createdAt > RETRY_AUTHORIZATION_TTL_MS) {
      this.retryAuthorizationByManagerId.delete(managerAgentId);
      throw new Error(
        "Codex Plugin retry authorization expired for this user turn. Ask the user to try again or re-tag @Codex.",
      );
    }
    return authorization;
  }

  private requireAvailableManager(managerAgentId: string, action: "specialist" | "retry"): CodexPluginManager {
    const manager = this.options.host.getDescriptor(managerAgentId);
    if (!manager || manager.role !== "manager") {
      throw new Error(`Codex Plugin ${action} requires a manager session: ${managerAgentId}`);
    }
    this.options.host.assertDescriptorNotArchived(manager);
    if (isNonRunningAgentStatus(manager.status)) {
      throw new Error(`Codex Plugin ${action} requires a running manager session: ${managerAgentId}`);
    }
    return manager as CodexPluginManager;
  }

  private requireManagerForTools(managerAgentId: string): CodexPluginManager {
    const manager = this.options.host.getDescriptor(managerAgentId);
    if (!manager || manager.role !== "manager") {
      throw new Error(`Codex MCP tools require a manager session: ${managerAgentId}`);
    }
    return manager as CodexPluginManager;
  }

  private authorizeScopedTool(workerAgentId: string, scopedToolName: string) {
    const worker = this.options.host.getDescriptor(workerAgentId);
    if (!isCodexPluginWorkerDescriptor(worker)) {
      throw new Error(
        "Codex plugin scoped tools are only available to scoped Codex Plugin specialist workers.",
      );
    }
    const authorization = this.scopeService.authorizeScopedToolCall(workerAgentId, scopedToolName);
    if (authorization.scope.workerAgentId !== workerAgentId) {
      throw new Error("Codex plugin scope worker mismatch.");
    }
    const manager = this.options.host.getDescriptor(authorization.scope.managerAgentId);
    if (!manager || manager.role !== "manager") {
      throw new Error("Codex plugin scoped tool is missing its owning manager session.");
    }
    if (worker.managerId !== manager.agentId) {
      throw new Error("Codex plugin worker is no longer owned by the scoped manager.");
    }
    return {
      worker,
      manager: manager as CodexPluginManager,
      allowed: authorization.tool,
      scope: authorization.scope,
    };
  }

  private hasActiveAuthorizedGate(managerAgentId: string): boolean {
    const gate = this.gateByManagerId.get(managerAgentId);
    return Boolean(gate?.allowed && gate.authorizedSelectors?.length);
  }

  private clearActiveTurn(agentId: string): void {
    this.gateByManagerId.delete(agentId);
    this.activeDelegationByManagerId.delete(agentId);
    this.retryAuthorizationByManagerId.delete(agentId);
  }

  private defaultWorkerAgentId(context: CodexPluginDelegationTurnContext | undefined): string {
    const selectorSlug = context?.selectors[0]?.replace(/[^a-z0-9_-]+/gi, "-") || "plugin";
    return `codex-plugin-${selectorSlug}`;
  }
}

function cloneDelegationContext(
  context: CodexPluginDelegationTurnContext,
): CodexPluginDelegationTurnContext {
  return {
    ...context,
    selectors: [...context.selectors],
    sourceContext: { ...context.sourceContext },
  };
}

function appendDelegationGuidance(
  message: string,
  context: CodexPluginDelegationTurnContext,
): string {
  const stripped = context.strippedText.trim() || "(No remaining request text after selector tokens.)";
  return [
    message,
    "",
    "[Codex Plugin selector context]",
    `Selected selector(s), bound server-side for this scoped Codex Plugin worker: ${context.selectors.join(", ")}`,
    `Request after removing selector tokens: ${stripped}`,
    "If plugin data or work is needed, use delegate_codex_plugin({ initialMessage: \"<task and context>\" }). The server binds only the selected scope to that worker for its lifetime; do not include or invent selectors in the worker input.",
    `Retry context id if this scoped worker is later stopped or fails: ${context.contextId}. Retry is server-authorized only on a future user turn that explicitly asks to retry/continue this request; otherwise require a fresh @Codex selector tag.`,
    "If this user turn includes attachments, inspect them in the manager context and pass only relevant text summaries to the Codex Plugin specialist; attachment payloads are not forwarded to Codex Plugin workers.",
    "Do not relay full transcripts or long connector results in chunks. Tell Codex Plugin workers to use export_scoped_codex_plugin_result for full Fireflies transcript/summary downloads, then report only artifact metadata/path and a bounded preview.",
    "Do not call raw Codex MCP tools. Do not start a plain Codex sidecar unless the user specifically requested plain @Codex sidecar behavior.",
  ].join("\n");
}

function appendRetryGuidance(
  message: string,
  authorization: CodexPluginRetryAuthorizationContext,
): string {
  const stripped = authorization.activeContext.strippedText.trim() ||
    "(No remaining request text after selector tokens.)";
  return [
    message,
    "",
    "[Codex Plugin retry authorization]",
    `Forge classified this user turn as an explicit retry/continuation of a stopped or failed scoped Codex Plugin worker. Retry context id: ${authorization.retryContextId}`,
    `Stored selector(s), bound server-side for the retried scoped worker: ${authorization.activeContext.selectors.join(", ")}`,
    `Original request after removing selector tokens: ${stripped}`,
    "Use retry_codex_plugin_worker({ initialMessage, retryContextId }) if Codex Plugin work is still needed. Do not use delegate_codex_plugin on this retry turn, and do not include, invent, or widen selectors in the retry input.",
    "If the user asks for a different plugin/scope, or this retry tool fails authorization, ask for a fresh @Codex plugin selector tag.",
    "Do not relay full transcripts or long connector results in chunks. Tell Codex Plugin workers to use export_scoped_codex_plugin_result for full Fireflies transcript/summary downloads, then report only artifact metadata/path and a bounded preview.",
  ].join("\n");
}

function isExplicitRetryContinuationText(userText: string): boolean {
  const normalized = userText.toLowerCase()
    .replace(/[^a-z0-9@:_/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;
  const continuation = /\b(retry|rerun|resume|continue|finish|re-?try)\b/.test(normalized) ||
    /\btry\s+(it|that|this|again)\b/.test(normalized) ||
    /\b(run|do)\s+(it|that|this)\s+again\b/.test(normalized) ||
    /\bagain\b/.test(normalized) ||
    /\bkeep\s+going\b/.test(normalized) ||
    /\bpick\s+(it|that|this)?\s*back\s+up\b/.test(normalized);
  const exportAction = /\b(export|download|save)\b/.test(normalized);
  if (!continuation && !exportAction) return false;
  const anaphoric = /\b(same|previous|last|that|it|again)\b/.test(normalized);
  const connector = /\b(codex|plugin|fireflies|connector)\b/.test(normalized);
  return anaphoric || connector;
}

function createVirtualSpecialistDefinition(): CodexPluginSpecialistDefinition {
  return {
    specialistId: CODEX_PLUGIN_SPECIALIST_ID,
    displayName: CODEX_PLUGIN_SPECIALIST_DISPLAY_NAME,
    color: CODEX_PLUGIN_SPECIALIST_COLOR,
    enabled: true,
    whenToUse:
      "Contextual/automatic only. Forge exposes this specialist during @Codex plugin selector turns; managers spawn it to run scoped read-only Codex plugin tools for the bound worker lifetime, then report sanitized findings back.",
    modelId: "gpt-5.5",
    provider: "openai",
    reasoningLevel: "high",
    fallbackModelId: "gpt-5.5",
    fallbackProvider: "openai",
    fallbackReasoningLevel: "medium",
    webSearch: false,
    promptBody: buildCodexPluginWorkerPrompt(),
    available: true,
  };
}

function formatArtifactShortcode(path: string): string {
  return `[artifact:${path}]`;
}

function hashExportArgs(args: Record<string, unknown> | undefined): string {
  return createHash("sha256").update(stableStringify(args ?? {})).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
