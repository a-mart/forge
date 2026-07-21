import {
  RemoteUpdateGitError,
  RemoteUpdateGitObserver,
  type ResolveRemoteUpdateTargetInput
} from "../../versioning/remote-update-awareness-git.js";
import { RemoteUpdateAwarenessCoordinator } from "./remote-update-awareness-coordinator.js";
import { RemoteUpdateAwarenessStore } from "./remote-update-awareness-store.js";
import type {
  RecordRemoteUpdateObservationResult,
  RemoteUpdateDismissal,
  RemoteUpdateProjectOverride,
  RemoteUpdateProjectRecord,
  RemoteUpdateProjectSnapshot,
  RemoteUpdateSettings,
  RemoteUpdateMonitorRecord,
  ResolvedRemoteUpdateTarget
} from "./types.js";

export interface ObserveRemoteUpdateProjectInput
  extends Omit<ResolveRemoteUpdateTargetInput, "remoteName" | "targetRef" | "signal"> {
  projectId: string;
  remoteName?: string;
  targetRef?: string;
  /** Resolves a new association only when no persisted configured target is usable. */
  resolveRemoteName?: (signal: AbortSignal) => Promise<string>;
  /** Rechecked immediately before project-specific durable commits. */
  shouldCommit?: () => boolean;
  /** Returns every currently registered and effectively enabled association for a shared commit. */
  getEligibleProjectIds?: (monitorKey: string) => string[];
}

export type ObserveRemoteUpdateProjectResult =
  | ({ ok: true } & RecordRemoteUpdateObservationResult)
  | {
    ok: false;
    error: RemoteUpdateGitError["code"];
    snapshot: RemoteUpdateProjectSnapshot;
    affectedProjectIds: string[];
  };

interface SharedObservationOutcome {
  ok: true;
  observation: Awaited<ReturnType<RemoteUpdateGitObserver["observe"]>>;
  affectedProjectIds: string[];
}

interface SharedFailureOutcome {
  ok: false;
  error: RemoteUpdateGitError["code"];
  affectedProjectIds: string[];
}

export class RemoteUpdateAwarenessService {
  constructor(
    private readonly store: RemoteUpdateAwarenessStore,
    private readonly observer = new RemoteUpdateGitObserver(),
    private readonly coordinator = new RemoteUpdateAwarenessCoordinator()
  ) {}

  getSettings(): RemoteUpdateSettings {
    return this.store.getSettings();
  }

  setGlobalEnabled(enabled: boolean): RemoteUpdateSettings {
    return this.store.setGlobalEnabled(enabled);
  }

  setProjectOverride(projectId: string, override: RemoteUpdateProjectOverride): RemoteUpdateProjectSnapshot {
    this.store.setProjectOverride(projectId, override);
    return this.store.getProjectSnapshot(projectId);
  }

  getProjectSnapshot(projectId: string, registryEligible = true): RemoteUpdateProjectSnapshot {
    return this.store.getProjectSnapshot(projectId, registryEligible);
  }

  getProjectRecord(projectId: string): RemoteUpdateProjectRecord | null {
    return this.store.getProject(projectId);
  }

  updateProjectSchedule(
    projectId: string,
    schedule: { nextDueAt: string | null; backoffUntil: string | null }
  ): RemoteUpdateProjectRecord {
    return this.store.updateProjectSchedule(projectId, schedule);
  }

  getMonitor(monitorKey: string): RemoteUpdateMonitorRecord | null {
    return this.store.getMonitor(monitorKey);
  }

  dismissExact(input: Omit<RemoteUpdateDismissal, "dismissedAt">): RemoteUpdateProjectSnapshot | null {
    return this.store.dismissExact(input) ? this.store.getProjectSnapshot(input.projectId) : null;
  }

  async observeProject(input: ObserveRemoteUpdateProjectInput): Promise<ObserveRemoteUpdateProjectResult> {
    let target: ResolvedRemoteUpdateTarget;
    try {
      target = await this.coordinator.run(this.resolutionKey(input.projectId), async (signal) => {
        const configured = this.configuredTarget(input.projectId);
        const remoteName = configured?.remoteName
          ?? input.remoteName
          ?? await input.resolveRemoteName?.(signal)
          ?? "";
        const targetRef = configured?.targetRef ?? input.targetRef;
        const resolved = await this.observer.resolveTarget({
          cwd: input.cwd,
          remoteName,
          ...(targetRef ? { targetRef } : {}),
          signal
        });
        if (input.shouldCommit?.() === false) return resolved;
        this.store.associateProject(input.projectId, resolved);
        return resolved;
      });
      if (input.shouldCommit?.() === false) {
        return this.unchangedResult(input.projectId);
      }
    } catch (error) {
      const code = error instanceof RemoteUpdateGitError ? error.code : "transport_error";
      if (input.shouldCommit?.() === false || code === "aborted") {
        return {
          ok: false,
          error: code,
          snapshot: this.store.getProjectSnapshot(input.projectId, false),
          affectedProjectIds: []
        };
      }
      return this.recordSafeFailure(input.projectId, error);
    }

    const before = this.store.getProject(input.projectId);
    const outcome = await this.coordinator.run<SharedObservationOutcome | SharedFailureOutcome>(
      target.monitorKey,
      async (signal) => {
        try {
          const previousTipOid = this.store.getMonitor(target.monitorKey)?.latestTipOid;
          const observation = await this.observer.observe({
            cwd: input.cwd,
            target,
            previousTipOid,
            signal
          });
          const eligibleProjectIds = this.eligibleProjectIds(input, target.monitorKey);
          if (eligibleProjectIds.length > 0) {
            this.store.recordObservation(input.projectId, target, observation, eligibleProjectIds);
          }
          return { ok: true, observation, affectedProjectIds: eligibleProjectIds };
        } catch (error) {
          const code = error instanceof RemoteUpdateGitError ? error.code : "transport_error";
          const eligibleProjectIds = this.eligibleProjectIds(input, target.monitorKey);
          const affectedProjectIds = eligibleProjectIds.length > 0
            ? this.store.recordMonitorFailure(target, code, undefined, eligibleProjectIds)
            : [];
          return { ok: false, error: code, affectedProjectIds };
        }
      }
    );

    if (!outcome.ok) {
      return {
        ok: false,
        error: outcome.error,
        snapshot: this.store.getProjectSnapshot(input.projectId),
        affectedProjectIds: outcome.affectedProjectIds
      };
    }

    const after = this.store.getProjectSnapshot(input.projectId);
    const affected = outcome.affectedProjectIds.includes(input.projectId);
    const baseline = before?.lastTipOid == null;
    return {
      ok: true,
      baseline,
      changed: affected && !baseline && (
        before?.lastTipOid !== outcome.observation.tipOid || before.lastState !== outcome.observation.state
      ),
      generation: after.generation,
      snapshot: after,
      affectedProjectIds: outcome.affectedProjectIds
    };
  }

  cancelMonitor(monitorKey: string): void {
    this.coordinator.cancel(monitorKey);
  }

  cancelProjectResolution(projectId: string): void {
    this.coordinator.cancel(this.resolutionKey(projectId));
  }

  stop(): Promise<void> {
    return this.coordinator.stop();
  }

  private configuredTarget(projectId: string): RemoteUpdateMonitorRecord | null {
    const record = this.store.getProject(projectId);
    if (!record?.monitorKey || !record.remoteFingerprint) return null;
    const monitor = this.store.getMonitor(record.monitorKey);
    if (!monitor || monitor.remoteFingerprint !== record.remoteFingerprint) return null;
    return monitor;
  }

  private eligibleProjectIds(input: ObserveRemoteUpdateProjectInput, monitorKey: string): string[] {
    const ids = input.getEligibleProjectIds?.(monitorKey)
      ?? (input.shouldCommit?.() === false ? [] : [input.projectId]);
    return [...new Set(ids)].sort();
  }

  private unchangedResult(projectId: string): ObserveRemoteUpdateProjectResult {
    const snapshot = this.store.getProjectSnapshot(projectId, false);
    return {
      ok: true,
      baseline: snapshot.tipOid === null,
      changed: false,
      generation: snapshot.generation,
      snapshot,
      affectedProjectIds: []
    };
  }

  private recordSafeFailure(projectId: string, error: unknown): ObserveRemoteUpdateProjectResult {
    const code = error instanceof RemoteUpdateGitError ? error.code : "transport_error";
    return {
      ok: false,
      error: code,
      snapshot: this.store.recordProjectFailure(projectId, code),
      affectedProjectIds: [projectId]
    };
  }

  private resolutionKey(projectId: string): string {
    return `resolve:${projectId}`;
  }
}
