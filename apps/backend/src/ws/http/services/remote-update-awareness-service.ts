import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  isSystemProfile,
  type RemoteUpdateAwarenessIncomingCommitSummary,
  type RemoteUpdateAwarenessIncomingInspection,
  type RemoteUpdateAwarenessProjectChangedEvent,
  type RemoteUpdateAwarenessProjectClearedEvent,
  type RemoteUpdateAwarenessProjectOverride,
  type RemoteUpdateAwarenessProjectSnapshot,
  type RemoteUpdateAwarenessSettingsSnapshot,
} from "@forge/protocol";
import { isBuilderRuntimeTarget } from "../../../runtime-target.js";
import {
  closeRemoteUpdateAwarenessDb,
  getOrCreateRemoteUpdateAwarenessDb,
} from "../../../swarm/remote-update-awareness/remote-update-awareness-db.js";
import { RemoteUpdateAwarenessScheduler } from "../../../swarm/remote-update-awareness/remote-update-awareness-scheduler.js";
import { RemoteUpdateAwarenessService as CoreRemoteUpdateAwarenessService } from "../../../swarm/remote-update-awareness/remote-update-awareness-service.js";
import { RemoteUpdateAwarenessStore } from "../../../swarm/remote-update-awareness/remote-update-awareness-store.js";
import type {
  RemoteUpdateObservationState,
  RemoteUpdateProjectSnapshot as InternalProjectSnapshot,
} from "../../../swarm/remote-update-awareness/types.js";
import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import { GitCli } from "../../../versioning/git-cli.js";
import { RemoteUpdateGitError } from "../../../versioning/remote-update-awareness-git.js";
import { isValidGitRemoteNameShape } from "../../../versioning/git-source-control-helpers.js";

const INCOMING_COMMIT_LIMIT = 20;
const INCOMING_CHANGED_FILE_LIMIT = 500;
const INCOMING_SUBJECT_LIMIT = 200;
const INSPECTION_MAX_OUTPUT_BYTES = 128 * 1024;
const INSPECTION_TIMEOUT_MS = 15_000;
const ACTIVE_FRESHNESS_MS = 15 * 60 * 1000;
const REGISTRY_GIT_CHECK_TIMEOUT_MS = 5_000;
const REGISTRY_GIT_CHECK_MAX_OUTPUT_BYTES = 8 * 1024;

type ProjectEvent = RemoteUpdateAwarenessProjectChangedEvent | RemoteUpdateAwarenessProjectClearedEvent;

export interface LocalRemoteUpdateAwarenessServiceOptions {
  swarmManager: SwarmManager;
  coreService?: CoreRemoteUpdateAwarenessService;
  scheduler?: RemoteUpdateAwarenessScheduler;
  broadcastProjectEvent?: (projectId: string, event: ProjectEvent) => void;
  gitFactory?: (cwd: string) => GitCli;
  isGitProject?: (cwd: string) => Promise<boolean>;
  openDatabase?: typeof getOrCreateRemoteUpdateAwarenessDb;
  closeDatabase?: typeof closeRemoteUpdateAwarenessDb;
}

/** Local Builder composition adapter. Collaboration runtimes never construct it. */
export class LocalRemoteUpdateAwarenessService {
  private core: CoreRemoteUpdateAwarenessService | null;
  private scheduler: RemoteUpdateAwarenessScheduler | null;
  private readonly projects = new Map<string, { projectId: string; cwd: string }>();
  private readonly gitFactory: (cwd: string) => GitCli;
  private readonly isGitProject: (cwd: string) => Promise<boolean>;
  private reconciliationGeneration = 0;
  private started = false;
  private stopping = false;
  private startupPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(private readonly options: LocalRemoteUpdateAwarenessServiceOptions) {
    if (!isBuilderRuntimeTarget(options.swarmManager.getConfig().runtimeTarget)) {
      throw new Error("Remote update awareness is available only in the local Builder runtime");
    }
    this.core = options.coreService ?? null;
    this.scheduler = options.scheduler ?? null;
    this.gitFactory = options.gitFactory ?? ((cwd) => new GitCli({ cwd }));
    this.isGitProject = options.isGitProject ?? ((cwd) => verifyLocalGitProject(this.gitFactory(cwd), cwd));
  }

  start(): Promise<void> {
    if (this.started) return Promise.resolve();
    if (this.stopping) return Promise.reject(new Error("Remote update awareness is stopping"));
    if (this.startupPromise) return this.startupPromise;
    this.startupPromise = this.startInternal();
    return this.startupPromise;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.reconciliationGeneration += 1;
    this.core?.stop().catch(() => undefined);
    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  private async startInternal(): Promise<void> {
    if (!this.core) {
      const openDatabase = this.options.openDatabase ?? getOrCreateRemoteUpdateAwarenessDb;
      const database = await openDatabase(this.options.swarmManager.getConfig());
      if (this.stopping) return;
      this.core = new CoreRemoteUpdateAwarenessService(new RemoteUpdateAwarenessStore(database));
    }
    if (this.stopping) return;
    if (!this.scheduler) this.scheduler = this.createScheduler(this.requireCore());
    await this.reconcileProjects();
    if (this.stopping) return;
    this.scheduler.start();
    this.started = true;
  }

  private async stopInternal(): Promise<void> {
    await this.startupPromise?.catch(() => undefined);
    await this.scheduler?.stop();
    if (!this.options.coreService) {
      const closeDatabase = this.options.closeDatabase ?? closeRemoteUpdateAwarenessDb;
      await closeDatabase(this.options.swarmManager.getConfig());
      this.core = null;
      this.scheduler = null;
    }
    this.started = false;
  }

  async reconcileProjects(): Promise<void> {
    const generation = ++this.reconciliationGeneration;
    const candidates = this.resolveRegistryProjects();

    // Registry removal, archive, and CWD changes take effect synchronously,
    // before any bounded Git eligibility checks can finish.
    for (const [projectId, registered] of this.projects) {
      const candidate = candidates.get(projectId);
      if (!candidate || candidate.cwd !== registered.cwd) this.unregisterProject(projectId);
    }

    await Promise.all([...candidates.values()].map(async (project) => {
      const eligible = await this.isGitProject(project.cwd).catch(() => false);
      if (generation !== this.reconciliationGeneration || this.stopping) return;

      const current = this.resolveRegistryProject(project.projectId);
      if (!current || current.cwd !== project.cwd) return;
      if (!eligible) {
        if (this.projects.get(project.projectId)?.cwd === project.cwd) {
          this.unregisterProject(project.projectId);
        }
        return;
      }

      const existing = this.projects.get(project.projectId);
      if (existing?.cwd === project.cwd) return;
      this.projects.set(project.projectId, project);
      this.scheduler?.registerProject(project);
    }));
  }

  async registerProject(projectId: string): Promise<void> {
    const project = this.resolveRegistryProject(projectId);
    if (!project) {
      this.unregisterProject(projectId);
      return;
    }
    await this.reconcileProjects();
  }

  unregisterProject(projectId: string): void {
    this.projects.delete(projectId);
    this.scheduler?.unregisterProject(projectId);
    this.options.broadcastProjectEvent?.(projectId, {
      type: "remote_update_awareness_project_cleared",
      projectId,
    });
  }

  getSettingsSnapshot(): RemoteUpdateAwarenessSettingsSnapshot {
    const core = this.requireCore();
    const settings = core.getSettings();
    return {
      settings: { globalEnabled: settings.globalEnabled, updatedAt: settings.updatedAt },
      projects: [...this.projects.keys()].sort().map((projectId) => {
        const snapshot = core.getProjectSnapshot(projectId, true);
        return {
          projectId,
          override: snapshot.override,
          effectiveEnabled: snapshot.effectiveEnabled,
        };
      }),
    };
  }

  setGlobalEnabled(enabled: boolean): RemoteUpdateAwarenessSettingsSnapshot {
    this.requireCore().setGlobalEnabled(enabled);
    this.scheduler?.reconcileEligibility();
    this.emitActiveProjection();
    return this.getSettingsSnapshot();
  }

  setProjectOverride(
    projectId: string,
    override: RemoteUpdateAwarenessProjectOverride
  ): RemoteUpdateAwarenessProjectSnapshot {
    this.requireRegistryProject(projectId);
    this.requireCore().setProjectOverride(projectId, override);
    this.scheduler?.reconcileEligibility();
    const snapshot = this.getProjectSnapshot(projectId);
    if (this.scheduler?.activeProject === projectId) this.emitChanged(projectId, snapshot);
    return snapshot;
  }

  getProjectSnapshot(projectId: string): RemoteUpdateAwarenessProjectSnapshot {
    this.requireRegistryProject(projectId);
    return projectSnapshotToWire(this.requireCore().getProjectSnapshot(projectId, true));
  }

  activateProject(projectId: string): RemoteUpdateAwarenessProjectSnapshot {
    this.requireRegistryProject(projectId);
    this.scheduler?.activateProject(projectId);
    const snapshot = this.getProjectSnapshot(projectId);
    this.emitChanged(projectId, snapshot);
    return snapshot;
  }

  async refreshProject(projectId: string): Promise<RemoteUpdateAwarenessProjectSnapshot> {
    this.requireRegistryProject(projectId);
    await this.requireScheduler().refreshProject(projectId);
    return this.getProjectSnapshot(projectId);
  }

  dismissProject(projectId: string, generation: number): RemoteUpdateAwarenessProjectSnapshot {
    this.requireRegistryProject(projectId);
    const core = this.requireCore();
    const current = core.getProjectSnapshot(projectId, true);
    if (
      current.generation !== generation ||
      !current.monitorKey || !current.ref || !current.tipOid
    ) {
      throw new RemoteUpdateAwarenessConflictError("The remote update dismissal target is stale");
    }
    const dismissed = core.dismissExact({
      projectId,
      monitorKey: current.monitorKey,
      ref: current.ref,
      tipOid: current.tipOid,
      generation,
    });
    if (!dismissed) throw new RemoteUpdateAwarenessConflictError("The remote update dismissal target is stale");
    const snapshot = projectSnapshotToWire(dismissed);
    if (this.scheduler?.activeProject === projectId) this.emitChanged(projectId, snapshot);
    return snapshot;
  }

  async getIncoming(projectId: string): Promise<RemoteUpdateAwarenessIncomingInspection> {
    const project = this.requireRegistryProject(projectId);
    const core = this.requireCore();
    const internal = core.getProjectSnapshot(projectId, true);
    const wire = projectSnapshotToWire(internal);
    const monitor = internal.monitorKey ? core.getMonitor(internal.monitorKey) : null;
    const generation = internal.generation;
    const empty = emptyIncomingCommits();
    let commits = empty;
    let fileChanges: RemoteUpdateAwarenessIncomingInspection["fileChanges"] = null;

    if (monitor && internal.tipOid && isInspectableState(internal.state)) {
      const git = this.gitFactory(project.cwd);
      commits = await inspectIncomingCommits(git, internal.tipOid);
      fileChanges = await inspectIncomingFileChanges(git, internal.tipOid);
    }

    const observedAt = internal.lastCompletedObservedAt;
    return {
      projectId,
      remoteDisplayName: sanitizeDisplayLabel(monitor?.remoteName ?? null),
      defaultBranchDisplay: sanitizeDisplayLabel(
        monitor?.targetRef.replace(/^refs\/heads\//, "") ?? null
      ),
      observedTipOid: internal.tipOid,
      generation,
      observedAt,
      freshnessCheckedAt: observedAt,
      staleAfter: observedAt
        ? new Date(Date.parse(observedAt) + ACTIVE_FRESHNESS_MS).toISOString()
        : null,
      state: wire.state,
      failureCode: wire.failureCode,
      attentionRequired: wire.attentionRequired,
      commits,
      fileChanges,
    };
  }

  private createScheduler(core: CoreRemoteUpdateAwarenessService): RemoteUpdateAwarenessScheduler {
    return new RemoteUpdateAwarenessScheduler({
      observeProject: (project) => core.observeProject({
        projectId: project.projectId,
        cwd: project.cwd,
        resolveRemoteName: (signal) => this.resolveRemoteName(project.cwd, signal),
        shouldCommit: () => this.isScheduledProjectEligible(project, core),
        getEligibleProjectIds: (monitorKey) => this.getEligibleProjectsForMonitor(
          monitorKey,
          core,
          project
        ),
      }),
      getProjectRecord: (projectId) => core.getProjectRecord(projectId),
      isProjectEligible: (projectId) => {
        if (!this.projects.has(projectId)) return false;
        return core.getProjectSnapshot(projectId, true).effectiveEnabled;
      },
      persistSchedule: (projectId, schedule) => {
        if (this.projects.has(projectId)) core.updateProjectSchedule(projectId, schedule);
      },
      cancelProject: (projectId) => this.cancelProjectObservation(projectId, core),
      stopObservations: () => core.stop(),
      onObservation: (projectId, _result, active) => {
        if (!active || !this.projects.has(projectId)) return;
        this.emitChanged(projectId, this.getProjectSnapshot(projectId));
      },
    });
  }

  private async resolveRemoteName(cwd: string, signal: AbortSignal): Promise<string> {
    const git = this.gitFactory(cwd);
    const symbolic = await git.run(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      inspectionOptions(signal)
    );
    if (symbolic.exitCode === 0 && symbolic.stdout.trim()) {
      const configured = await git.run(
        ["config", "--get", `branch.${symbolic.stdout.trim()}.remote`],
        inspectionOptions(signal)
      );
      const remoteName = configured.stdout.trim();
      if (configured.exitCode === 0 && remoteName !== "." && isValidGitRemoteNameShape(remoteName)) {
        return remoteName;
      }
    }
    const remoteResult = await git.run(["remote"], inspectionOptions(signal));
    const remotes = remoteResult.exitCode === 0
      ? remoteResult.stdout.split("\n").map((value) => value.trim()).filter(Boolean).sort()
      : [];
    if (remotes.length === 1) return remotes[0]!;
    if (signal.aborted) throw new RemoteUpdateGitError("aborted");
    return "";
  }

  private resolveRegistryProjects(): Map<string, { projectId: string; cwd: string }> {
    const projects = new Map<string, { projectId: string; cwd: string }>();
    for (const profile of this.options.swarmManager.listProfiles()) {
      if (profile.archivedAt || isSystemProfile(profile)) continue;
      const descriptor = this.options.swarmManager.getAgent(profile.defaultSessionAgentId);
      if (!descriptor || descriptor.role !== "manager" || !descriptor.cwd.trim()) continue;
      projects.set(profile.profileId, { projectId: profile.profileId, cwd: descriptor.cwd });
    }
    return projects;
  }

  private resolveRegistryProject(projectId: string): { projectId: string; cwd: string } | null {
    return this.resolveRegistryProjects().get(projectId) ?? null;
  }

  private requireRegistryProject(projectId: string): { projectId: string; cwd: string } {
    const project = this.projects.get(projectId);
    if (!project) throw new RemoteUpdateAwarenessNotFoundError("Unknown, archived, or non-Git local project");
    return project;
  }

  private isScheduledProjectEligible(
    project: { projectId: string; cwd: string },
    core: CoreRemoteUpdateAwarenessService
  ): boolean {
    if (this.stopping || this.projects.get(project.projectId)?.cwd !== project.cwd) return false;
    return core.getProjectSnapshot(project.projectId, true).effectiveEnabled;
  }

  private getEligibleProjectsForMonitor(
    monitorKey: string,
    core: CoreRemoteUpdateAwarenessService,
    originatingProject?: { projectId: string; cwd: string }
  ): string[] {
    if (this.stopping) return [];
    const eligible: string[] = [];
    for (const project of this.projects.values()) {
      if (
        originatingProject &&
        project.projectId === originatingProject.projectId &&
        project.cwd !== originatingProject.cwd
      ) {
        continue;
      }
      const record = core.getProjectRecord(project.projectId);
      if (record?.monitorKey !== monitorKey) continue;
      if (core.getProjectSnapshot(project.projectId, true).effectiveEnabled) {
        eligible.push(project.projectId);
      }
    }
    return eligible.sort();
  }

  private cancelProjectObservation(
    projectId: string,
    core: CoreRemoteUpdateAwarenessService
  ): void {
    core.cancelProjectResolution(projectId);
    const monitorKey = core.getProjectRecord(projectId)?.monitorKey;
    if (!monitorKey) return;
    if (this.getEligibleProjectsForMonitor(monitorKey, core).length > 0) return;
    core.cancelMonitor(monitorKey);
  }

  private emitActiveProjection(): void {
    const active = this.scheduler?.activeProject;
    if (active && this.projects.has(active)) this.emitChanged(active, this.getProjectSnapshot(active));
  }

  private emitChanged(projectId: string, snapshot: RemoteUpdateAwarenessProjectSnapshot): void {
    this.options.broadcastProjectEvent?.(projectId, {
      type: "remote_update_awareness_project_changed",
      snapshot,
    });
  }

  private requireCore(): CoreRemoteUpdateAwarenessService {
    if (!this.core) throw new Error("Remote update awareness has not started");
    return this.core;
  }

  private requireScheduler(): RemoteUpdateAwarenessScheduler {
    if (!this.scheduler) throw new Error("Remote update awareness has not started");
    return this.scheduler;
  }
}

export class RemoteUpdateAwarenessNotFoundError extends Error {}
export class RemoteUpdateAwarenessConflictError extends Error {}

export function projectSnapshotToWire(snapshot: InternalProjectSnapshot): RemoteUpdateAwarenessProjectSnapshot {
  const failureCode = failureCodeToWire(snapshot.state);
  return {
    projectId: snapshot.projectId,
    override: snapshot.override,
    globalEnabled: snapshot.globalEnabled,
    effectiveEnabled: snapshot.effectiveEnabled,
    state: snapshot.effectiveEnabled ? observationStateToWire(snapshot.state) : "disabled",
    lastObservedAt: snapshot.lastCompletedObservedAt,
    failureCode,
    attentionRequired: snapshot.hasUndismissedUpdate,
    dismissalTarget:
      snapshot.monitorKey && snapshot.ref && snapshot.tipOid && snapshot.generation > 0
        ? { generation: snapshot.generation }
        : null,
  };
}

function observationStateToWire(
  state: RemoteUpdateObservationState | null
): RemoteUpdateAwarenessProjectSnapshot["state"] {
  switch (state) {
    case null: return "unobserved";
    case "equal": return "up_to_date";
    case "remote_ahead": return "update_available";
    case "local_ahead": return "local_ahead";
    case "diverged": return "diverged";
    case "rewound": return "rewound";
    case "missing": return "missing";
    case "detached": return "detached";
    case "unresolved": return "unresolved";
    case "unknown": return "unknown";
    case "ref_integrity_error": return "stale";
    case "invalid_repository": return "not_git";
    case "auth_error":
    case "transport_error":
    case "timeout":
    case "aborted": return "error";
  }
}

function failureCodeToWire(
  state: RemoteUpdateObservationState | null
): RemoteUpdateAwarenessProjectSnapshot["failureCode"] {
  switch (state) {
    case "auth_error": return "auth";
    case "transport_error": return "transport";
    case "timeout": return "timeout";
    case "invalid_repository": return null;
    case "ref_integrity_error":
    case "unresolved": return "invalid_target";
    case "aborted": return "unknown";
    default: return null;
  }
}

function isInspectableState(state: RemoteUpdateObservationState | null): boolean {
  return state === "remote_ahead" || state === "diverged" || state === "rewound" || state === "unknown";
}

async function inspectIncomingCommits(git: GitCli, tipOid: string) {
  const result = await git.run([
    "log",
    `--max-count=${INCOMING_COMMIT_LIMIT + 1}`,
    "--format=%ct%x00%s",
    "-z",
    `HEAD..${tipOid}`,
    "--",
  ], inspectionOptions());
  if (result.exitCode !== 0) return emptyIncomingCommits();
  const fields = result.stdout.split("\0");
  const summaries: RemoteUpdateAwarenessIncomingCommitSummary[] = [];
  for (let index = 0; index + 1 < fields.length && summaries.length <= INCOMING_COMMIT_LIMIT; index += 2) {
    const seconds = Number.parseInt(fields[index] ?? "", 10);
    const subject = sanitizeSubject(fields[index + 1] ?? "");
    if (!subject) continue;
    summaries.push({
      subject,
      committedAt: Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null,
    });
  }
  const hasMore = summaries.length > INCOMING_COMMIT_LIMIT;
  const commits = summaries.slice(0, INCOMING_COMMIT_LIMIT);
  return { commitCount: commits.length, commitLimit: INCOMING_COMMIT_LIMIT, hasMore, commits };
}

async function inspectIncomingFileChanges(git: GitCli, tipOid: string) {
  const result = await git.run([
    "diff", "--name-status", "-z", `HEAD...${tipOid}`, "--",
  ], inspectionOptions());
  if (result.exitCode !== 0) return null;
  const fields = result.stdout.split("\0");
  let changedFileCount = 0;
  let addedCount = 0;
  let modifiedCount = 0;
  let deletedCount = 0;
  let renamedCount = 0;
  for (let index = 0; index < fields.length && changedFileCount <= INCOMING_CHANGED_FILE_LIMIT; ) {
    const status = fields[index++] ?? "";
    if (!status) continue;
    index += status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    changedFileCount += 1;
    if (changedFileCount > INCOMING_CHANGED_FILE_LIMIT) break;
    if (status.startsWith("A")) addedCount += 1;
    else if (status.startsWith("D")) deletedCount += 1;
    else if (status.startsWith("R")) renamedCount += 1;
    else modifiedCount += 1;
  }
  const hasMore = changedFileCount > INCOMING_CHANGED_FILE_LIMIT;
  return {
    changedFileCount: Math.min(changedFileCount, INCOMING_CHANGED_FILE_LIMIT),
    changedFileCountLimit: INCOMING_CHANGED_FILE_LIMIT,
    hasMore,
    addedCount,
    modifiedCount,
    deletedCount,
    renamedCount,
  };
}

function emptyIncomingCommits() {
  return {
    commitCount: 0,
    commitLimit: INCOMING_COMMIT_LIMIT,
    hasMore: false,
    commits: [] as RemoteUpdateAwarenessIncomingCommitSummary[],
  };
}

function inspectionOptions(signal?: AbortSignal) {
  return {
    allowFailure: true,
    timeoutMs: INSPECTION_TIMEOUT_MS,
    maxBufferBytes: INSPECTION_MAX_OUTPUT_BYTES,
    nonInteractive: true,
    ...(signal ? { signal } : {}),
  } as const;
}

async function verifyLocalGitProject(git: GitCli, cwd: string): Promise<boolean> {
  const result = await git.run(["rev-parse", "--git-common-dir"], {
    allowFailure: true,
    timeoutMs: REGISTRY_GIT_CHECK_TIMEOUT_MS,
    maxBufferBytes: REGISTRY_GIT_CHECK_MAX_OUTPUT_BYTES,
    nonInteractive: true,
  });
  if (result.exitCode !== 0) return false;

  const reported = result.stdout.trim();
  if (!reported) return false;
  try {
    const commonDir = await realpath(isAbsolute(reported) ? reported : resolve(cwd, reported));
    return (await stat(commonDir)).isDirectory();
  } catch {
    return false;
  }
}

function sanitizeSubject(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, INCOMING_SUBJECT_LIMIT);
}

function sanitizeDisplayLabel(value: string | null): string | null {
  if (!value) return null;
  const sanitized = value.replace(/[\u0000-\u001f\u007f]+/g, "").trim().slice(0, 120);
  return sanitized || null;
}
