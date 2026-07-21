import type Database from "better-sqlite3";
import {
  REMOTE_UPDATE_PROJECT_OVERRIDES,
  type RecordRemoteUpdateObservationResult,
  type RemoteUpdateDismissal,
  type RemoteUpdateGitObservation,
  type RemoteUpdateMonitorRecord,
  type RemoteUpdateObservationState,
  type RemoteUpdateProjectOverride,
  type RemoteUpdateProjectRecord,
  type RemoteUpdateProjectSnapshot,
  type RemoteUpdateSettings,
  type ResolvedRemoteUpdateTarget
} from "./types.js";

const ATTENTION_STATES = new Set<RemoteUpdateObservationState>([
  "remote_ahead",
  "diverged",
  "rewound",
  "unknown"
]);

export class RemoteUpdateAwarenessStore {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => Date = () => new Date()
  ) {}

  getSettings(): RemoteUpdateSettings {
    const row = this.database.prepare(
      "SELECT global_enabled, created_at, updated_at FROM remote_update_settings WHERE id = 1"
    ).get() as SettingsRow | undefined;
    if (!row) {
      throw new Error("Remote update awareness settings are not initialized");
    }
    return mapSettings(row);
  }

  setGlobalEnabled(enabled: boolean): RemoteUpdateSettings {
    this.database.prepare(
      "UPDATE remote_update_settings SET global_enabled = ?, updated_at = ? WHERE id = 1"
    ).run(enabled ? 1 : 0, this.timestamp());
    return this.getSettings();
  }

  getOrCreateProject(projectId: string): RemoteUpdateProjectRecord {
    this.ensureProject(projectId);
    return this.requireProject(projectId);
  }

  setProjectOverride(projectId: string, override: RemoteUpdateProjectOverride): RemoteUpdateProjectRecord {
    if (!REMOTE_UPDATE_PROJECT_OVERRIDES.includes(override)) {
      throw new Error("Invalid remote update project override");
    }
    this.ensureProject(projectId);
    this.database.prepare(
      "UPDATE remote_update_project SET override = ?, updated_at = ? WHERE project_id = ?"
    ).run(override, this.timestamp(), projectId);
    return this.requireProject(projectId);
  }

  associateProject(projectId: string, target: ResolvedRemoteUpdateTarget): RemoteUpdateProjectRecord {
    return this.database.transaction(() => {
      this.ensureProject(projectId);
      const now = this.timestamp();
      this.database.prepare(`
        INSERT INTO remote_update_monitor (
          monitor_key, common_dir, remote_name, target_ref, remote_fingerprint,
          latest_state, latest_tip_oid, generation, last_observed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, NULL, ?, ?)
        ON CONFLICT(monitor_key) DO UPDATE SET
          common_dir = excluded.common_dir,
          remote_name = excluded.remote_name,
          target_ref = excluded.target_ref,
          remote_fingerprint = excluded.remote_fingerprint,
          updated_at = excluded.updated_at
      `).run(
        target.monitorKey,
        target.commonDir,
        target.remoteName,
        target.targetRef,
        target.remoteFingerprint,
        now,
        now
      );

      const current = this.requireProject(projectId);
      if (current.monitorKey !== target.monitorKey || current.remoteFingerprint !== target.remoteFingerprint) {
        this.database.prepare(`
          UPDATE remote_update_project SET
            monitor_key = ?, remote_fingerprint = ?, generation = generation + 1,
            attention_generation = NULL, last_tip_oid = NULL, last_state = NULL,
            last_completed_observed_at = NULL, failure_count = 0,
            backoff_until = NULL, updated_at = ?
          WHERE project_id = ?
        `).run(target.monitorKey, target.remoteFingerprint, now, projectId);
        this.database.prepare("DELETE FROM remote_update_dismissal WHERE project_id = ?").run(projectId);
      }
      return this.requireProject(projectId);
    })();
  }

  getProject(projectId: string): RemoteUpdateProjectRecord | null {
    const row = this.database.prepare(
      "SELECT * FROM remote_update_project WHERE project_id = ?"
    ).get(projectId) as ProjectRow | undefined;
    return row ? mapProject(row) : null;
  }

  updateProjectSchedule(
    projectId: string,
    schedule: { nextDueAt: string | null; backoffUntil: string | null }
  ): RemoteUpdateProjectRecord {
    this.ensureProject(projectId);
    this.database.prepare(`
      UPDATE remote_update_project SET next_due_at = ?, backoff_until = ?, updated_at = ?
      WHERE project_id = ?
    `).run(schedule.nextDueAt, schedule.backoffUntil, this.timestamp(), projectId);
    return this.requireProject(projectId);
  }

  getMonitor(monitorKey: string): RemoteUpdateMonitorRecord | null {
    const row = this.database.prepare(
      "SELECT * FROM remote_update_monitor WHERE monitor_key = ?"
    ).get(monitorKey) as MonitorRow | undefined;
    return row ? mapMonitor(row) : null;
  }

  listProjectsForMonitor(monitorKey: string): RemoteUpdateProjectRecord[] {
    return (this.database.prepare(
      "SELECT * FROM remote_update_project WHERE monitor_key = ? ORDER BY project_id"
    ).all(monitorKey) as ProjectRow[]).map(mapProject);
  }

  recordObservation(
    projectId: string,
    target: ResolvedRemoteUpdateTarget,
    observation: RemoteUpdateGitObservation,
    eligibleProjectIds?: readonly string[]
  ): RecordRemoteUpdateObservationResult {
    return this.database.transaction(() => {
      this.associateProject(projectId, target);
      const requestedBefore = this.requireProject(projectId);
      const monitorBefore = this.getMonitor(target.monitorKey);
      const monitorChanged = monitorBefore?.latestTipOid !== null && (
        monitorBefore?.latestTipOid !== observation.tipOid || monitorBefore.latestState !== observation.state
      );
      const monitorGeneration = (monitorBefore?.generation ?? 0) + (monitorChanged ? 1 : 0);
      const now = observation.observedAt;

      this.database.prepare(`
        UPDATE remote_update_monitor SET
          latest_state = ?, latest_tip_oid = ?, generation = ?, last_observed_at = ?, updated_at = ?
        WHERE monitor_key = ?
      `).run(observation.state, observation.tipOid, monitorGeneration, now, now, target.monitorKey);

      const eligible = new Set(
        eligibleProjectIds ?? this.listProjectsForMonitor(target.monitorKey).map((project) => project.projectId)
      );
      const projects = this.listProjectsForMonitor(target.monitorKey)
        .filter((project) => eligible.has(project.projectId));
      for (const project of projects) {
        const baseline = project.lastTipOid === null;
        const changed = !baseline && (
          project.lastTipOid !== observation.tipOid || project.lastState !== observation.state
        );
        const generation = project.generation + (changed ? 1 : 0);
        const attentionGeneration = changed && ATTENTION_STATES.has(observation.state)
          ? generation
          : changed ? null : project.attentionGeneration;
        this.database.prepare(`
          UPDATE remote_update_project SET
            last_completed_observed_at = ?, failure_count = 0, backoff_until = NULL,
            generation = ?, attention_generation = ?, last_tip_oid = ?, last_state = ?, updated_at = ?
          WHERE project_id = ?
        `).run(
          now, generation, attentionGeneration, observation.tipOid, observation.state, now, project.projectId
        );
        if (changed) {
          this.database.prepare("DELETE FROM remote_update_dismissal WHERE project_id = ?").run(project.projectId);
        }
      }

      const baseline = requestedBefore.lastTipOid === null;
      const changed = projects.some((project) => project.projectId === projectId) && !baseline && (
        requestedBefore.lastTipOid !== observation.tipOid || requestedBefore.lastState !== observation.state
      );
      const snapshot = this.getProjectSnapshot(projectId);
      return {
        baseline,
        changed,
        generation: snapshot.generation,
        snapshot,
        affectedProjectIds: projects.map((project) => project.projectId)
      };
    })();
  }

  recordMonitorFailure(
    target: ResolvedRemoteUpdateTarget,
    state: RemoteUpdateObservationState,
    observedAt = this.timestamp(),
    eligibleProjectIds: readonly string[] = this.listProjectsForMonitor(target.monitorKey).map((project) => project.projectId)
  ): string[] {
    return this.database.transaction(() => {
      const monitor = this.getMonitor(target.monitorKey);
      if (!monitor) return [];
      const eligible = new Set(eligibleProjectIds);
      const projects = this.listProjectsForMonitor(target.monitorKey)
        .filter((project) => eligible.has(project.projectId));
      if (projects.length === 0) return [];
      const monitorChanged = monitor.latestState !== state;
      this.database.prepare(`
        UPDATE remote_update_monitor SET
          latest_state = ?, generation = ?, last_observed_at = ?, updated_at = ?
        WHERE monitor_key = ?
      `).run(state, monitor.generation + (monitorChanged ? 1 : 0), observedAt, observedAt, target.monitorKey);

      for (const project of projects) {
        const changed = project.lastState !== null && project.lastState !== state;
        this.database.prepare(`
          UPDATE remote_update_project SET
            last_completed_observed_at = ?, failure_count = failure_count + 1,
            generation = ?, attention_generation = ?, last_state = ?, updated_at = ?
          WHERE project_id = ?
        `).run(
          observedAt, project.generation + (changed ? 1 : 0),
          changed ? null : project.attentionGeneration, state, observedAt, project.projectId
        );
        if (changed) {
          this.database.prepare("DELETE FROM remote_update_dismissal WHERE project_id = ?").run(project.projectId);
        }
      }
      return projects.map((project) => project.projectId);
    })();
  }

  recordProjectFailure(
    projectId: string,
    state: RemoteUpdateObservationState,
    observedAt = this.timestamp()
  ): RemoteUpdateProjectSnapshot {
    return this.database.transaction(() => {
      this.ensureProject(projectId);
      const project = this.requireProject(projectId);
      const changed = project.lastState !== null && project.lastState !== state;
      this.database.prepare(`
        UPDATE remote_update_project SET
          last_completed_observed_at = ?, failure_count = failure_count + 1,
          generation = ?, attention_generation = ?, last_state = ?, updated_at = ?
        WHERE project_id = ?
      `).run(
        observedAt, project.generation + (changed ? 1 : 0),
        changed ? null : project.attentionGeneration, state, observedAt, projectId
      );
      if (changed) {
        this.database.prepare("DELETE FROM remote_update_dismissal WHERE project_id = ?").run(projectId);
      }
      return this.getProjectSnapshot(projectId);
    })();
  }

  dismissExact(input: Omit<RemoteUpdateDismissal, "dismissedAt">): boolean {
    const project = this.getProject(input.projectId);
    const monitor = project?.monitorKey ? this.getMonitor(project.monitorKey) : null;
    if (
      !project || !monitor ||
      project.monitorKey !== input.monitorKey ||
      monitor.targetRef !== input.ref ||
      project.lastTipOid !== input.tipOid ||
      project.generation !== input.generation
    ) {
      return false;
    }

    this.database.prepare(`
      INSERT INTO remote_update_dismissal (
        project_id, monitor_key, ref, tip_oid, generation, dismissed_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        monitor_key = excluded.monitor_key,
        ref = excluded.ref,
        tip_oid = excluded.tip_oid,
        generation = excluded.generation,
        dismissed_at = excluded.dismissed_at
    `).run(
      input.projectId,
      input.monitorKey,
      input.ref,
      input.tipOid,
      input.generation,
      this.timestamp()
    );
    return true;
  }

  getDismissal(projectId: string): RemoteUpdateDismissal | null {
    const row = this.database.prepare(
      "SELECT * FROM remote_update_dismissal WHERE project_id = ?"
    ).get(projectId) as DismissalRow | undefined;
    return row ? {
      projectId: row.project_id,
      monitorKey: row.monitor_key,
      ref: row.ref,
      tipOid: row.tip_oid,
      generation: row.generation,
      dismissedAt: row.dismissed_at
    } : null;
  }

  getProjectSnapshot(projectId: string, registryEligible = true): RemoteUpdateProjectSnapshot {
    const settings = this.getSettings();
    const project = this.getOrCreateProject(projectId);
    const monitor = project.monitorKey ? this.getMonitor(project.monitorKey) : null;
    const dismissal = this.getDismissal(projectId);
    const dismissed = Boolean(
      dismissal && monitor &&
      dismissal.monitorKey === project.monitorKey &&
      dismissal.ref === monitor.targetRef &&
      dismissal.tipOid === project.lastTipOid &&
      dismissal.generation === project.generation
    );
    const effectiveEnabled = registryEligible && settings.globalEnabled && project.override !== "off";
    const hasAttentionState = project.lastState ? ATTENTION_STATES.has(project.lastState) : false;

    return {
      projectId,
      globalEnabled: settings.globalEnabled,
      override: project.override,
      effectiveEnabled,
      monitorKey: project.monitorKey,
      ref: monitor?.targetRef ?? null,
      tipOid: project.lastTipOid,
      state: project.lastState,
      generation: project.generation,
      dismissed,
      hasUndismissedUpdate: effectiveEnabled && project.attentionGeneration === project.generation && hasAttentionState && !dismissed,
      lastCompletedObservedAt: project.lastCompletedObservedAt
    };
  }

  private ensureProject(projectId: string): void {
    if (!projectId.trim()) {
      throw new Error("Project ID is required");
    }
    const now = this.timestamp();
    this.database.prepare(`
      INSERT OR IGNORE INTO remote_update_project (
        project_id, override, monitor_key, remote_fingerprint,
        last_completed_observed_at, next_due_at, failure_count, backoff_until,
        generation, attention_generation, last_tip_oid, last_state, created_at, updated_at
      ) VALUES (?, 'inherit', NULL, NULL, NULL, NULL, 0, NULL, 0, NULL, NULL, NULL, ?, ?)
    `).run(projectId, now, now);
  }

  private requireProject(projectId: string): RemoteUpdateProjectRecord {
    const project = this.getProject(projectId);
    if (!project) {
      throw new Error("Remote update project record is missing");
    }
    return project;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

interface SettingsRow { global_enabled: number; created_at: string; updated_at: string }
interface ProjectRow {
  project_id: string; override: RemoteUpdateProjectOverride; monitor_key: string | null;
  remote_fingerprint: string | null; last_completed_observed_at: string | null;
  next_due_at: string | null; failure_count: number; backoff_until: string | null;
  generation: number; attention_generation: number | null;
  last_tip_oid: string | null; last_state: RemoteUpdateObservationState | null;
  created_at: string; updated_at: string;
}
interface MonitorRow {
  monitor_key: string; common_dir: string; remote_name: string; target_ref: string;
  remote_fingerprint: string; latest_state: RemoteUpdateObservationState | null;
  latest_tip_oid: string | null; generation: number; last_observed_at: string | null;
  created_at: string; updated_at: string;
}
interface DismissalRow {
  project_id: string; monitor_key: string; ref: string; tip_oid: string;
  generation: number; dismissed_at: string;
}

function mapSettings(row: SettingsRow): RemoteUpdateSettings {
  return { globalEnabled: row.global_enabled === 1, createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapProject(row: ProjectRow): RemoteUpdateProjectRecord {
  return {
    projectId: row.project_id, override: row.override, monitorKey: row.monitor_key,
    remoteFingerprint: row.remote_fingerprint, lastCompletedObservedAt: row.last_completed_observed_at,
    nextDueAt: row.next_due_at, failureCount: row.failure_count, backoffUntil: row.backoff_until,
    generation: row.generation, attentionGeneration: row.attention_generation,
    lastTipOid: row.last_tip_oid, lastState: row.last_state,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}
function mapMonitor(row: MonitorRow): RemoteUpdateMonitorRecord {
  return {
    monitorKey: row.monitor_key, commonDir: row.common_dir, remoteName: row.remote_name,
    targetRef: row.target_ref, remoteFingerprint: row.remote_fingerprint,
    latestState: row.latest_state, latestTipOid: row.latest_tip_oid, generation: row.generation,
    lastObservedAt: row.last_observed_at, createdAt: row.created_at, updatedAt: row.updated_at
  };
}
