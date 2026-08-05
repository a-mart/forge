import { existsSync } from "node:fs";
import type { RuntimeShutdownOptions, SwarmAgentRuntime } from "./runtime-contracts.js";
import {
  buildProjectExecutableTrustPlan,
  resolveProjectExecutableTrustPlan,
  type ProjectExecutableTrustPlan,
} from "./project-executable-trust.js";
import { ProjectResourceSettingsStore } from "./project-resource-settings.js";
import {
  ProjectWorkspaceResolver,
  type ProjectWorkspaceResolution,
  type ResolveProjectWorkspaceOptions,
} from "./project-workspace-resolver.js";
import type { ManagerRuntimeRecycleReason } from "./runtime/runtime-recovery-state.js";
import type {
  AgentContextUsage,
  AgentDescriptor,
  ChoiceAnswer,
  ChoiceQuestion,
  SwarmConfig,
} from "./types.js";

const TRUST_RUNTIME_TERMINATION_OPTIONS: RuntimeShutdownOptions = {
  abort: true,
  shutdownTimeoutMs: 2_000,
};
const TRUST_RUNTIME_TERMINATION_BOUND_MS = 2_250;

export type ProjectExecutableTrustManager = AgentDescriptor & { role: "manager" };

export interface ProjectExecutableTrustSettingsPort {
  getDismissedExecutablePrompt(
    key: string,
  ): Promise<{ signature: string; dismissedAt: string } | undefined>;
  setTrust(key: string, action: "trust" | "block" | "reset", label?: string): Promise<unknown>;
  dismissExecutablePrompt(key: string, signature: string): Promise<unknown>;
}

export interface ProjectExecutableTrustResolverPort {
  resolve(options: ResolveProjectWorkspaceOptions): Promise<ProjectWorkspaceResolution>;
}

export interface ProjectExecutableTrustResourceAccess {
  settings: ProjectExecutableTrustSettingsPort;
  resolver: ProjectExecutableTrustResolverPort;
}

export interface ProjectExecutableTrustRuntimeRecoveryPort {
  hasPendingManagerRuntimeRecycle(agentId: string): boolean;
  getPendingManagerRuntimeRecycleReason(agentId: string): ManagerRuntimeRecycleReason | undefined;
  setPendingManagerRuntimeRecycle(agentId: string, reason: ManagerRuntimeRecycleReason): void;
  clearPendingManagerRuntimeRecycle(agentId: string): void;
}

export interface ProjectExecutableTrustDeferredPlanPort {
  setDeferredProjectExecutableTrustPlan(trustKey: string, plan: ProjectExecutableTrustPlan): void;
  clearDeferredProjectExecutableTrustPlan(trustKey: string): void;
}

export interface ProjectExecutableTrustCoordinatorHost {
  listDescriptors(): Iterable<AgentDescriptor>;
  requestUserChoice(agentId: string, questions: ChoiceQuestion[]): Promise<ChoiceAnswer[]>;
  applyBaseManagerRuntimeRecyclePolicy(
    agentId: string,
    reason: ManagerRuntimeRecycleReason,
  ): Promise<"recycled" | "deferred" | "none">;
  terminateDescriptor(
    descriptor: AgentDescriptor,
    options: { abort: boolean; emitStatus: boolean },
  ): Promise<void>;
  getRuntime(agentId: string): Pick<SwarmAgentRuntime, "terminate"> | undefined;
  getRuntimeToken(agentId: string): number | undefined;
  getRuntimeCreationPromise(agentId: string): Promise<unknown> | undefined;
  deleteRuntimeCreationPromise(agentId: string): void;
  clearRuntimeToken(agentId: string, runtimeToken?: number): void;
  suppressIntentionalStopRuntimeCallbacks(agentId: string, runtimeToken?: number): void;
  clearIntentionalStopRuntimeCallbackSuppression(agentId: string, runtimeToken?: number): void;
  detachRuntime(agentId: string, runtimeToken?: number): boolean;
  upsertDescriptorInLiveMaps(descriptor: AgentDescriptor): void;
  emitStatus(
    agentId: string,
    status: AgentDescriptor["status"],
    pendingCount: number,
    contextUsage?: AgentContextUsage,
  ): void;
  emitTrustRuntimeRestartMessage(agentId: string, timestamp: string): void;
  saveStore(): Promise<void>;
  emitAgentsSnapshot(): void;
  now(): string;
  logDebug(event: string, data: Record<string, unknown>): void;
}

export interface ProjectExecutableTrustCoordinatorOptions {
  config: SwarmConfig;
  host: ProjectExecutableTrustCoordinatorHost;
  runtimeRecovery: ProjectExecutableTrustRuntimeRecoveryPort;
  deferredPlans: ProjectExecutableTrustDeferredPlanPort;
  createResourceAccess?: () => ProjectExecutableTrustResourceAccess;
  resolveRuntimePlan?: (options: {
    descriptor: AgentDescriptor;
    sessionDescriptor?: AgentDescriptor;
  }) => Promise<ProjectExecutableTrustPlan>;
  pathExists?: (pathValue: string) => boolean;
}

interface DeferredTrustActivation {
  preActivationPlan: ProjectExecutableTrustPlan;
  pendingManagerIds: Set<string>;
  protectAllRuntimeCreations: boolean;
}

export class ProjectExecutableTrustCoordinator {
  private readonly pendingPromptTrustKeys = new Set<string>();
  private readonly pendingRuntimeRecycleApplicationsByManagerId = new Map<
    string,
    Promise<"recycled" | "deferred" | "none">
  >();
  private readonly deferredActivationsByTrustKey = new Map<string, DeferredTrustActivation>();
  private readonly pendingActivationTrustKeyByManagerId = new Map<string, string>();
  private readonly pendingWorkerInvalidationTrustKeyByManagerId = new Map<string, string>();
  private readonly createResourceAccess: () => ProjectExecutableTrustResourceAccess;
  private readonly resolveRuntimePlan: NonNullable<ProjectExecutableTrustCoordinatorOptions["resolveRuntimePlan"]>;
  private readonly pathExists: (pathValue: string) => boolean;

  constructor(private readonly options: ProjectExecutableTrustCoordinatorOptions) {
    this.createResourceAccess = options.createResourceAccess ?? (() => {
      const settings = new ProjectResourceSettingsStore(options.config.paths.dataDir);
      return {
        settings,
        resolver: new ProjectWorkspaceResolver({
          dataDir: options.config.paths.dataDir,
          settingsStore: settings,
        }),
      };
    });
    this.resolveRuntimePlan = options.resolveRuntimePlan ?? ((input) => resolveProjectExecutableTrustPlan({
      config: options.config,
      ...input,
    }));
    this.pathExists = options.pathExists ?? existsSync;
  }

  schedulePromptsForAllManagers(): void {
    for (const descriptor of this.options.host.listDescriptors()) {
      if (descriptor.role === "manager") {
        this.schedulePrompt(descriptor as ProjectExecutableTrustManager);
      }
    }
  }

  schedulePrompt(descriptor: ProjectExecutableTrustManager): void {
    if (descriptor.collab) return;
    void this.maybePrompt(descriptor).catch((error) => {
      this.options.host.logDebug("project_resources:trust_prompt:error", {
        agentId: descriptor.agentId,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async maybePrompt(descriptor: ProjectExecutableTrustManager): Promise<void> {
    const resources = this.createResourceAccess();
    const resolution = await resources.resolver.resolve(toWorkspaceResolveOptions(descriptor));
    const trustKey = resolution.trust.key;
    if (!trustKey || resolution.trust.state !== "untrusted") return;
    if (!hasExistingExecutableSurface(resolution, this.pathExists)) return;

    const dismissed = await resources.settings.getDismissedExecutablePrompt(trustKey);
    if (dismissed?.signature === resolution.signature) return;
    if (this.pendingPromptTrustKeys.has(trustKey)) return;

    this.pendingPromptTrustKeys.add(trustKey);
    try {
      const answers = await this.options.host.requestUserChoice(
        descriptor.agentId,
        buildExecutableTrustQuestions(resolution),
      );
      const selected = answers[0]?.selectedOptionIds[0];
      const currentResolution = await resources.resolver.resolve(toWorkspaceResolveOptions(descriptor));
      const currentDismissed = currentResolution.trust.key
        ? await resources.settings.getDismissedExecutablePrompt(currentResolution.trust.key)
        : undefined;
      const promptStillCurrent =
        this.pendingPromptTrustKeys.has(trustKey) &&
        currentResolution.trust.key === trustKey &&
        currentResolution.trust.state === "untrusted" &&
        currentResolution.signature === resolution.signature &&
        currentDismissed?.signature !== currentResolution.signature;
      if (!promptStillCurrent) return;

      if (selected === "trust") {
        const preActivationPlan = buildProjectExecutableTrustPlan({ resolution, cwd: descriptor.cwd });
        this.beginDeferredActivation(trustKey, preActivationPlan);
        let trustWritten = false;
        try {
          await resources.settings.setTrust(trustKey, "trust");
          trustWritten = true;
          await this.markActivationPending(trustKey, preActivationPlan);
        } catch (error) {
          if (!trustWritten) {
            this.clearDeferredActivationForTrustKey(trustKey);
          }
          throw error;
        }
      } else if (selected === "block") {
        await resources.settings.setTrust(trustKey, "block");
      } else if (selected === "manage_later") {
        await resources.settings.dismissExecutablePrompt(trustKey, resolution.signature);
      }
    } finally {
      this.pendingPromptTrustKeys.delete(trustKey);
    }
  }

  async applyTrustChange(trustKey: string): Promise<void> {
    this.pendingPromptTrustKeys.delete(trustKey);
    this.clearDeferredActivationForTrustKey(trustKey);
    await this.applyRuntimeBoundaryChange((resolution) => resolution.trust.key === trustKey);
  }

  async applyWorkspaceChange(workspaceKey: string): Promise<void> {
    const affectedManagerIds = await this.resolveWorkspaceManagerIds(workspaceKey);
    await this.applyRuntimeBoundaryChange((resolution) => resolution.workspaceKey === workspaceKey);
    this.clearDeferredActivationsForManagers(affectedManagerIds);
  }

  async applyManagerRuntimeRecyclePolicy(
    agentId: string,
    reason: ManagerRuntimeRecycleReason,
  ): Promise<"recycled" | "deferred" | "none"> {
    while (true) {
      const inFlight = this.pendingRuntimeRecycleApplicationsByManagerId.get(agentId);
      if (inFlight) {
        const disposition = await inFlight;
        if (reason === "idle_transition") {
          if (disposition === "deferred") return disposition;
          if (!this.options.runtimeRecovery.hasPendingManagerRuntimeRecycle(agentId)) return "none";
        }
        continue;
      }

      const application = this.applyManagerRuntimeRecyclePolicyOnce(agentId, reason);
      this.pendingRuntimeRecycleApplicationsByManagerId.set(agentId, application);
      try {
        return await application;
      } finally {
        if (this.pendingRuntimeRecycleApplicationsByManagerId.get(agentId) === application) {
          this.pendingRuntimeRecycleApplicationsByManagerId.delete(agentId);
        }
      }
    }
  }

  private async applyManagerRuntimeRecyclePolicyOnce(
    agentId: string,
    reason: ManagerRuntimeRecycleReason,
  ): Promise<"recycled" | "deferred" | "none"> {
    const disposition = await this.options.host.applyBaseManagerRuntimeRecyclePolicy(agentId, reason);
    let finalized = false;
    if (disposition !== "deferred") {
      finalized = await this.finalizePendingActivationBoundary(agentId);
    }
    if (finalized || (reason === "idle_transition" && disposition === "recycled")) {
      await this.options.host.saveStore();
      this.options.host.emitAgentsSnapshot();
    }
    return disposition;
  }

  async applyPendingManagerRuntimeRecycleBeforeRuntimeUse(
    descriptor: ProjectExecutableTrustManager,
  ): Promise<void> {
    const agentId = descriptor.agentId;
    while (
      this.pendingRuntimeRecycleApplicationsByManagerId.has(agentId) ||
      this.options.runtimeRecovery.hasPendingManagerRuntimeRecycle(agentId)
    ) {
      // This boundary runs outside the runtime's own event callback queue. The
      // policy's single-flight holds every runtime acquisition until the old
      // manager has been detached.
      const disposition = await this.applyManagerRuntimeRecyclePolicy(agentId, "idle_transition");
      if (disposition === "deferred") return;
    }
  }

  forgetManager(agentId: string): void {
    this.clearPendingActivationForManager(agentId);
    this.pendingWorkerInvalidationTrustKeyByManagerId.delete(agentId);
  }

  async resolvePlanForRuntime(options: {
    descriptor: AgentDescriptor;
    sessionDescriptor?: AgentDescriptor;
  }): Promise<ProjectExecutableTrustPlan> {
    let plan: ProjectExecutableTrustPlan;
    try {
      plan = await this.resolveRuntimePlan(options);
    } catch (error) {
      this.options.host.logDebug("project_resources:runtime_trust_plan:error", {
        agentId: options.descriptor.agentId,
        role: options.descriptor.role,
        message: error instanceof Error ? error.message : String(error),
      });
      return emptyTrustPlan();
    }

    const trustKey = plan.resolution?.trust.key;
    const activation = trustKey ? this.deferredActivationsByTrustKey.get(trustKey) : undefined;
    if (!activation) return plan;

    const managerId = options.descriptor.role === "manager"
      ? options.descriptor.agentId
      : options.sessionDescriptor?.agentId ?? options.descriptor.managerId;
    const managerHasPendingActivation =
      this.pendingActivationTrustKeyByManagerId.get(managerId) === trustKey;
    return activation.protectAllRuntimeCreations || managerHasPendingActivation
      ? activation.preActivationPlan
      : plan;
  }

  private beginDeferredActivation(trustKey: string, preActivationPlan: ProjectExecutableTrustPlan): void {
    const existing = this.deferredActivationsByTrustKey.get(trustKey);
    if (existing) {
      existing.preActivationPlan = preActivationPlan;
      existing.protectAllRuntimeCreations = true;
      this.options.deferredPlans.setDeferredProjectExecutableTrustPlan(trustKey, preActivationPlan);
      return;
    }

    this.deferredActivationsByTrustKey.set(trustKey, {
      preActivationPlan,
      pendingManagerIds: new Set(),
      protectAllRuntimeCreations: true,
    });
    this.options.deferredPlans.setDeferredProjectExecutableTrustPlan(trustKey, preActivationPlan);
  }

  private clearDeferredActivationForTrustKey(trustKey: string): void {
    this.deferredActivationsByTrustKey.delete(trustKey);
    this.options.deferredPlans.clearDeferredProjectExecutableTrustPlan(trustKey);

    for (const [managerId, pendingTrustKey] of Array.from(
      this.pendingActivationTrustKeyByManagerId.entries(),
    )) {
      if (pendingTrustKey !== trustKey) continue;
      this.pendingActivationTrustKeyByManagerId.delete(managerId);
      if (
        this.options.runtimeRecovery.getPendingManagerRuntimeRecycleReason(managerId) ===
        "project_resource_trust_change"
      ) {
        this.options.runtimeRecovery.clearPendingManagerRuntimeRecycle(managerId);
      }
    }

    for (const [managerId, pendingTrustKey] of Array.from(
      this.pendingWorkerInvalidationTrustKeyByManagerId.entries(),
    )) {
      if (pendingTrustKey === trustKey) {
        this.pendingWorkerInvalidationTrustKeyByManagerId.delete(managerId);
      }
    }
  }

  private clearDeferredActivationsForManagers(managerIds: Iterable<string>): void {
    for (const managerId of managerIds) {
      this.pendingWorkerInvalidationTrustKeyByManagerId.delete(managerId);
      this.clearPendingActivationForManager(managerId);
      if (
        this.options.runtimeRecovery.getPendingManagerRuntimeRecycleReason(managerId) ===
        "project_resource_trust_change"
      ) {
        this.options.runtimeRecovery.clearPendingManagerRuntimeRecycle(managerId);
      }
    }
  }

  private async resolveWorkspaceManagerIds(workspaceKey: string): Promise<Set<string>> {
    const managerIds = new Set<string>();
    const resolver = this.createResourceAccess().resolver;
    for (const descriptor of this.options.host.listDescriptors()) {
      if (descriptor.role !== "manager" || descriptor.collab) continue;
      try {
        const resolution = await resolver.resolve(
          toWorkspaceResolveOptions(descriptor as ProjectExecutableTrustManager),
        );
        if (resolution.workspaceKey === workspaceKey) managerIds.add(descriptor.agentId);
      } catch (error) {
        this.options.host.logDebug("project_resources:workspace_change:resolve_error", {
          agentId: descriptor.agentId,
          workspaceKey,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return managerIds;
  }

  private setPendingActivationForManager(managerId: string, trustKey: string): void {
    this.pendingActivationTrustKeyByManagerId.set(managerId, trustKey);
    this.pendingWorkerInvalidationTrustKeyByManagerId.set(managerId, trustKey);
    this.deferredActivationsByTrustKey.get(trustKey)?.pendingManagerIds.add(managerId);
  }

  private clearPendingActivationForManager(managerId: string): void {
    const trustKey = this.pendingActivationTrustKeyByManagerId.get(managerId);
    if (!trustKey) return;

    this.pendingActivationTrustKeyByManagerId.delete(managerId);
    const activation = this.deferredActivationsByTrustKey.get(trustKey);
    activation?.pendingManagerIds.delete(managerId);
    if (activation && activation.pendingManagerIds.size === 0) {
      this.deferredActivationsByTrustKey.delete(trustKey);
      this.options.deferredPlans.clearDeferredProjectExecutableTrustPlan(trustKey);
    }
  }

  private async markActivationPending(
    trustKey: string,
    preActivationPlan: ProjectExecutableTrustPlan,
  ): Promise<void> {
    this.beginDeferredActivation(trustKey, preActivationPlan);
    const resolver = this.createResourceAccess().resolver;
    const activation = this.deferredActivationsByTrustKey.get(trustKey);
    if (activation) activation.protectAllRuntimeCreations = true;

    for (const descriptor of this.options.host.listDescriptors()) {
      if (descriptor.role !== "manager" || descriptor.collab) continue;
      try {
        const resolution = await resolver.resolve(
          toWorkspaceResolveOptions(descriptor as ProjectExecutableTrustManager),
        );
        if (resolution.trust.key !== trustKey) continue;
        this.options.runtimeRecovery.setPendingManagerRuntimeRecycle(
          descriptor.agentId,
          "project_resource_trust_change",
        );
        this.setPendingActivationForManager(descriptor.agentId, trustKey);
      } catch (error) {
        this.options.host.logDebug("project_resources:trust_activation:resolve_error", {
          agentId: descriptor.agentId,
          trustKey,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const markedActivation = this.deferredActivationsByTrustKey.get(trustKey);
    if (markedActivation) {
      markedActivation.protectAllRuntimeCreations = false;
      if (markedActivation.pendingManagerIds.size === 0) {
        this.deferredActivationsByTrustKey.delete(trustKey);
        this.options.deferredPlans.clearDeferredProjectExecutableTrustPlan(trustKey);
      }
    }
  }

  private async applyRuntimeBoundaryChange(
    matches: (resolution: ProjectWorkspaceResolution) => boolean | Promise<boolean>,
  ): Promise<void> {
    const affectedManagers: ProjectExecutableTrustManager[] = [];
    for (const descriptor of this.options.host.listDescriptors()) {
      if (descriptor.role !== "manager" || descriptor.collab) continue;
      const resolution = await this.createResourceAccess().resolver.resolve(
        toWorkspaceResolveOptions(descriptor as ProjectExecutableTrustManager),
      );
      if (await matches(resolution)) {
        affectedManagers.push(descriptor as ProjectExecutableTrustManager);
      }
    }

    const affectedManagerIds = new Set(affectedManagers.map((manager) => manager.agentId));
    const affectedWorkers = Array.from(this.options.host.listDescriptors()).filter(
      (descriptor) => descriptor.role === "worker" && affectedManagerIds.has(descriptor.managerId),
    );

    const workerResults = await Promise.allSettled(
      affectedWorkers.map((worker) =>
        this.options.host.terminateDescriptor(worker, { abort: true, emitStatus: true })),
    );
    const managerResults = await Promise.allSettled(
      affectedManagers.map((manager) => this.forceEvictManagerRuntime(manager)),
    );
    this.logPropagationFailures(affectedWorkers, workerResults, affectedManagers, managerResults);
    await this.options.host.saveStore();
    this.options.host.emitAgentsSnapshot();
  }

  private async forceEvictManagerRuntime(descriptor: ProjectExecutableTrustManager): Promise<void> {
    this.options.runtimeRecovery.clearPendingManagerRuntimeRecycle(descriptor.agentId);
    const inFlightCreation = this.options.host.getRuntimeCreationPromise(descriptor.agentId);
    if (inFlightCreation) {
      this.options.host.deleteRuntimeCreationPromise(descriptor.agentId);
      this.options.host.clearRuntimeToken(descriptor.agentId);
      void inFlightCreation.catch(() => undefined);
    }

    const runtime = this.options.host.getRuntime(descriptor.agentId);
    const runtimeToken = this.options.host.getRuntimeToken(descriptor.agentId);
    if (!runtime) {
      this.options.host.clearRuntimeToken(descriptor.agentId);
      if (descriptor.status === "streaming") {
        this.markStreamingManagerIdle(descriptor, false);
      }
      return;
    }

    this.options.host.suppressIntentionalStopRuntimeCallbacks(descriptor.agentId, runtimeToken);
    this.options.host.detachRuntime(descriptor.agentId, runtimeToken);
    if (descriptor.status === "streaming") {
      this.markStreamingManagerIdle(descriptor, true);
    }

    try {
      await withBoundedTrustRuntimeTermination(
        runtime.terminate(TRUST_RUNTIME_TERMINATION_OPTIONS),
        TRUST_RUNTIME_TERMINATION_BOUND_MS,
      );
    } finally {
      this.options.host.clearIntentionalStopRuntimeCallbackSuppression(
        descriptor.agentId,
        runtimeToken,
      );
    }
  }

  private markStreamingManagerIdle(
    descriptor: ProjectExecutableTrustManager,
    emitRestartMessage: boolean,
  ): void {
    descriptor.status = "idle";
    descriptor.streamingStartedAt = undefined;
    descriptor.updatedAt = this.options.host.now();
    this.options.host.upsertDescriptorInLiveMaps(descriptor);
    this.options.host.emitStatus(descriptor.agentId, "idle", 0, descriptor.contextUsage);
    if (emitRestartMessage) {
      this.options.host.emitTrustRuntimeRestartMessage(descriptor.agentId, this.options.host.now());
    }
  }

  private logPropagationFailures(
    workers: AgentDescriptor[],
    workerResults: Array<PromiseSettledResult<unknown>>,
    managers: ProjectExecutableTrustManager[],
    managerResults: Array<PromiseSettledResult<unknown>>,
  ): void {
    const workerFailures = collectPropagationFailures(workers, workerResults);
    const managerFailures = collectPropagationFailures(managers, managerResults);
    if (workerFailures.length === 0 && managerFailures.length === 0) return;
    this.options.host.logDebug("project_resources:trust_change:propagation_errors", {
      workerFailures: workerFailures.map((entry) => ({
        agentId: entry.agentId,
        message: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
      })),
      managerFailures: managerFailures.map((entry) => ({
        agentId: entry.agentId,
        message: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
      })),
    });
  }

  private async finalizePendingActivationBoundary(agentId: string): Promise<boolean> {
    const hadPendingActivation = this.pendingActivationTrustKeyByManagerId.has(agentId);
    const workersInvalidated = await this.invalidatePendingWorkers(agentId);
    if (hadPendingActivation) this.clearPendingActivationForManager(agentId);
    return hadPendingActivation || workersInvalidated;
  }

  private async invalidatePendingWorkers(agentId: string): Promise<boolean> {
    const trustKey = this.pendingWorkerInvalidationTrustKeyByManagerId.get(agentId);
    if (!trustKey) return false;

    const workers = Array.from(this.options.host.listDescriptors()).filter(
      (descriptor) => descriptor.role === "worker" && descriptor.managerId === agentId,
    );
    if (workers.length === 0) {
      this.pendingWorkerInvalidationTrustKeyByManagerId.delete(agentId);
      return false;
    }

    const results = await Promise.allSettled(
      workers.map((worker) =>
        this.options.host.terminateDescriptor(worker, { abort: true, emitStatus: true })),
    );
    this.logPropagationFailures(workers, results, [], []);
    if (results.every((result) => result.status === "fulfilled")) {
      this.pendingWorkerInvalidationTrustKeyByManagerId.delete(agentId);
    }
    return results.some((result) => result.status === "fulfilled");
  }
}

function toWorkspaceResolveOptions(descriptor: ProjectExecutableTrustManager): ResolveProjectWorkspaceOptions {
  return {
    profileId: descriptor.profileId ?? descriptor.agentId,
    sessionAgentId: descriptor.agentId,
    cwd: descriptor.cwd,
  };
}

function buildExecutableTrustQuestions(resolution: ProjectWorkspaceResolution): ChoiceQuestion[] {
  return [
    {
      id: "repo_executable_trust",
      header: "Repository executable resources",
      question: `This repository has executable Forge/Pi resources under ${resolution.effectiveForgeDirRealpath}. Trust them for this repository?`,
      options: [
        {
          id: "trust",
          label: "Trust",
          description: "Enable repository .forge extensions and Pi package extensions.",
        },
        {
          id: "block",
          label: "Block",
          description: "Keep executable repository resources disabled. Skills and reference docs stay available.",
        },
        {
          id: "manage_later",
          label: "Manage later",
          description: "Keep disabled for now and ask again if executable resources change.",
        },
      ],
    },
  ];
}

function hasExistingExecutableSurface(
  resolution: ProjectWorkspaceResolution,
  pathExists: (pathValue: string) => boolean,
): boolean {
  return [
    resolution.repoRootResources.forgeExtensionsDir,
    resolution.repoRootResources.piExtensionsDir,
    resolution.repoRootResources.piSettingsPath,
    ...resolution.legacyExecutableSurfaces
      .filter((surface) => surface.activeToday)
      .map((surface) => surface.path),
  ].some((pathValue) => Boolean(pathValue && pathExists(pathValue)));
}

function emptyTrustPlan(): ProjectExecutableTrustPlan {
  return {
    trusted: false,
    trustedForgeExtensionDirs: [],
    trustedPiExtensionDirs: [],
    trustedPiSettingsPaths: [],
  };
}

async function withBoundedTrustRuntimeTermination(
  operation: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    void operation.catch(() => undefined);
  }
}

function collectPropagationFailures(
  descriptors: Array<{ agentId: string }>,
  results: Array<PromiseSettledResult<unknown>>,
): Array<{ agentId: string | undefined; reason: unknown }> {
  const failures: Array<{ agentId: string | undefined; reason: unknown }> = [];
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      failures.push({ agentId: descriptors[index]?.agentId, reason: result.reason });
    }
  });
  return failures;
}
