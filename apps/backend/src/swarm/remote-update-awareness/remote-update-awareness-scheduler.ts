import type { ObserveRemoteUpdateProjectResult } from "./remote-update-awareness-service.js";
import type { RemoteUpdateProjectRecord } from "./types.js";

export const REMOTE_UPDATE_ACTIVE_INTERVAL_MS = 15 * 60 * 1000;
export const REMOTE_UPDATE_INACTIVE_INTERVAL_MS = 60 * 60 * 1000;
export const REMOTE_UPDATE_ACTIVE_JITTER_MS = 2 * 60 * 1000;
export const REMOTE_UPDATE_INACTIVE_JITTER_MS = 10 * 60 * 1000;
export const REMOTE_UPDATE_FAILURE_BACKOFF_MS = [5, 15, 60].map((minutes) => minutes * 60 * 1000);
export const REMOTE_UPDATE_MAX_FAILURE_BACKOFF_MS = 6 * 60 * 60 * 1000;

export interface RemoteUpdateScheduledProject {
  projectId: string;
  cwd: string;
}

export interface RemoteUpdateAwarenessSchedulerOptions {
  observeProject: (project: RemoteUpdateScheduledProject) => Promise<ObserveRemoteUpdateProjectResult>;
  getProjectRecord: (projectId: string) => RemoteUpdateProjectRecord | null;
  isProjectEligible: (projectId: string) => boolean;
  persistSchedule?: (
    projectId: string,
    schedule: { nextDueAt: string | null; backoffUntil: string | null }
  ) => void;
  cancelProject?: (projectId: string) => void;
  stopObservations?: () => Promise<void>;
  onObservation?: (
    projectId: string,
    result: ObserveRemoteUpdateProjectResult,
    active: boolean
  ) => void;
  now?: () => number;
  random?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  concurrency?: number;
}

type QueuePriority = "manual" | "active" | "due";

interface QueuedProject {
  projectId: string;
  priority: QueuePriority;
  sequence: number;
  waiters: Array<{
    resolve: (result: ObserveRemoteUpdateProjectResult) => void;
    reject: (error: unknown) => void;
  }>;
}

/**
 * Forge-open-only remote observation scheduler. It owns cadence and work
 * selection; the coordinator below the service remains the monitor-key
 * coalescing/abort boundary.
 */
export class RemoteUpdateAwarenessScheduler {
  private readonly projects = new Map<string, RemoteUpdateScheduledProject>();
  private readonly nextDueAt = new Map<string, number>();
  private readonly backoffUntil = new Map<string, number>();
  private readonly queue = new Map<string, QueuedProject>();
  private readonly running = new Map<string, QueuedProject>();
  private readonly eligibility = new Map<string, boolean>();
  private readonly options: Required<Pick<RemoteUpdateAwarenessSchedulerOptions, "now" | "random" | "setTimer" | "clearTimer" | "concurrency">> & RemoteUpdateAwarenessSchedulerOptions;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activeProjectId: string | null = null;
  private sequence = 0;
  private started = false;
  private stopping = false;

  constructor(options: RemoteUpdateAwarenessSchedulerOptions) {
    this.options = {
      ...options,
      now: options.now ?? Date.now,
      random: options.random ?? Math.random,
      setTimer: options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs)),
      clearTimer: options.clearTimer ?? clearTimeout,
      concurrency: Math.max(1, options.concurrency ?? 2),
    };
  }

  start(): void {
    if (this.started || this.stopping) return;
    this.started = true;
    for (const projectId of this.projects.keys()) {
      this.ensureInactiveDue(projectId);
    }
    this.armTimer();
  }

  registerProject(project: RemoteUpdateScheduledProject): void {
    if (this.stopping) return;
    this.projects.set(project.projectId, project);
    this.eligibility.set(project.projectId, this.options.isProjectEligible(project.projectId));
    this.hydrateSchedule(project.projectId);
    this.armTimer();
  }

  unregisterProject(projectId: string): void {
    this.projects.delete(projectId);
    this.nextDueAt.delete(projectId);
    this.backoffUntil.delete(projectId);
    this.eligibility.delete(projectId);
    const queued = this.queue.get(projectId);
    this.queue.delete(projectId);
    for (const waiter of queued?.waiters ?? []) {
      waiter.reject(new Error("Remote update project is no longer eligible"));
    }
    if (this.activeProjectId === projectId) this.activeProjectId = null;
    this.options.cancelProject?.(projectId);
    this.persist(projectId, null, null);
    this.armTimer();
  }

  activateProject(projectId: string): boolean {
    if (!this.projects.has(projectId)) return false;
    const previousActive = this.activeProjectId;
    this.activeProjectId = projectId;
    if (previousActive && previousActive !== projectId && this.projects.has(previousActive)) {
      this.scheduleFromNow(previousActive, false);
    }

    if (!this.options.isProjectEligible(projectId)) {
      this.armTimer();
      return false;
    }

    const record = this.options.getProjectRecord(projectId);
    const lastCompletedAt = parseTimestamp(record?.lastCompletedObservedAt);
    const stale = lastCompletedAt === null || this.options.now() - lastCompletedAt >= REMOTE_UPDATE_ACTIVE_INTERVAL_MS;
    const backedOffUntil = this.resolveBackoff(projectId, record);
    if (backedOffUntil !== null && backedOffUntil > this.options.now()) return false;
    if (stale) {
      this.enqueue(projectId, "active");
      return true;
    }

    this.scheduleFromNow(projectId, true);
    return false;
  }

  refreshProject(projectId: string): Promise<ObserveRemoteUpdateProjectResult> {
    if (!this.canSchedule(projectId)) {
      return Promise.reject(new Error("Remote update project is not eligible"));
    }
    return new Promise((resolve, reject) => {
      this.enqueue(projectId, "manual", { resolve, reject });
    });
  }

  reconcileEligibility(): void {
    for (const projectId of this.projects.keys()) {
      const wasEligible = this.eligibility.get(projectId) ?? false;
      const isEligible = this.options.isProjectEligible(projectId);
      this.eligibility.set(projectId, isEligible);
      if (!isEligible) {
        const queued = this.queue.get(projectId);
        this.queue.delete(projectId);
        for (const waiter of queued?.waiters ?? []) {
          waiter.reject(new Error("Remote update project is not eligible"));
        }
        this.options.cancelProject?.(projectId);
        continue;
      }
      if (!wasEligible && this.activeProjectId === projectId) {
        this.queueStaleActiveProject(projectId);
      }
    }
    this.pump();
    this.armTimer();
  }

  get activeProject(): string | null {
    return this.activeProjectId;
  }

  get queuedCount(): number {
    return this.queue.size;
  }

  get runningCount(): number {
    return this.running.size;
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.started = false;
    if (this.timer) {
      this.options.clearTimer(this.timer);
      this.timer = null;
    }
    for (const item of this.queue.values()) {
      for (const waiter of item.waiters) {
        waiter.reject(new Error("Remote update awareness scheduler is stopping"));
      }
    }
    this.queue.clear();
    await this.options.stopObservations?.();
    while (this.running.size > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  private enqueue(
    projectId: string,
    priority: QueuePriority,
    waiter?: QueuedProject["waiters"][number]
  ): void {
    if (this.stopping || !this.canSchedule(projectId)) {
      waiter?.reject(new Error("Remote update project is not eligible"));
      return;
    }
    const running = this.running.get(projectId);
    if (running) {
      if (waiter) running.waiters.push(waiter);
      return;
    }
    const existing = this.queue.get(projectId);
    if (existing) {
      if (priorityRank(priority) < priorityRank(existing.priority)) existing.priority = priority;
      if (waiter) existing.waiters.push(waiter);
    } else {
      this.queue.set(projectId, {
        projectId,
        priority,
        sequence: this.sequence++,
        waiters: waiter ? [waiter] : [],
      });
    }
    this.pump();
  }

  private pump(): void {
    if (!this.started || this.stopping) return;
    this.enqueueDueProjects();
    while (this.running.size < this.options.concurrency) {
      const next = [...this.queue.values()]
        .filter((item) => !this.running.has(item.projectId))
        .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority) || left.sequence - right.sequence)[0];
      if (!next) break;
      this.queue.delete(next.projectId);
      if (!this.canSchedule(next.projectId)) {
        for (const waiter of next.waiters) waiter.reject(new Error("Remote update project is not eligible"));
        continue;
      }
      this.running.set(next.projectId, next);
      void this.run(next);
    }
    this.armTimer();
  }

  private async run(item: QueuedProject): Promise<void> {
    const project = this.projects.get(item.projectId);
    if (!project) {
      this.running.delete(item.projectId);
      return;
    }
    try {
      const result = await this.options.observeProject(project);
      for (const projectId of result.affectedProjectIds) {
        if (!this.projects.has(projectId) || !this.options.isProjectEligible(projectId)) continue;
        const record = this.options.getProjectRecord(projectId);
        if (result.ok) {
          this.backoffUntil.delete(projectId);
          this.scheduleFromNow(projectId, this.activeProjectId === projectId);
        } else {
          const failureCount = Math.max(1, record?.failureCount ?? 1);
          const until = this.options.now() + this.failureDelay(failureCount);
          this.backoffUntil.set(projectId, until);
          this.nextDueAt.set(projectId, until);
          this.persist(projectId, until, until);
        }
        this.options.onObservation?.(projectId, result, this.activeProjectId === projectId);
      }
      for (const waiter of item.waiters) waiter.resolve(result);
    } catch (error) {
      for (const waiter of item.waiters) waiter.reject(error);
    } finally {
      this.running.delete(item.projectId);
      this.pump();
    }
  }

  private enqueueDueProjects(): void {
    const now = this.options.now();
    const due = [...this.nextDueAt.entries()]
      .filter(([projectId, at]) => at <= now && this.canSchedule(projectId))
      .sort(([leftId, leftAt], [rightId, rightAt]) => {
        const activeOrder = Number(rightId === this.activeProjectId) - Number(leftId === this.activeProjectId);
        return activeOrder || leftAt - rightAt;
      });
    for (const [projectId] of due) {
      const backoff = this.backoffUntil.get(projectId);
      if (backoff && backoff > now) continue;
      this.nextDueAt.delete(projectId);
      this.enqueue(projectId, projectId === this.activeProjectId ? "active" : "due");
    }
  }

  private armTimer(): void {
    if (!this.started || this.stopping) return;
    if (this.timer) {
      this.options.clearTimer(this.timer);
      this.timer = null;
    }
    const next = Math.min(...[...this.nextDueAt.entries()]
      .filter(([projectId]) => this.canSchedule(projectId))
      .map(([, dueAt]) => dueAt));
    if (!Number.isFinite(next)) return;
    this.timer = this.options.setTimer(() => {
      this.timer = null;
      this.pump();
    }, Math.max(0, next - this.options.now()));
    this.timer.unref?.();
  }

  private scheduleFromNow(projectId: string, active: boolean): void {
    const dueAt = this.options.now() + (active ? this.activeDelay() : this.inactiveDelay());
    this.nextDueAt.set(projectId, dueAt);
    this.persist(projectId, dueAt, null);
  }

  private ensureInactiveDue(projectId: string): void {
    if (!this.nextDueAt.has(projectId)) this.hydrateSchedule(projectId);
  }

  private hydrateSchedule(projectId: string): void {
    if (this.nextDueAt.has(projectId)) return;
    const now = this.options.now();
    const record = this.options.getProjectRecord(projectId);
    const persistedBackoff = parseTimestamp(record?.backoffUntil);
    const persistedDue = parseTimestamp(record?.nextDueAt);
    if (persistedBackoff !== null && persistedBackoff > now) {
      this.backoffUntil.set(projectId, persistedBackoff);
      this.nextDueAt.set(projectId, Math.max(persistedBackoff, persistedDue ?? persistedBackoff));
      return;
    }
    if (persistedDue !== null && persistedDue > now) {
      this.nextDueAt.set(projectId, persistedDue);
      return;
    }
    this.scheduleFromNow(projectId, projectId === this.activeProjectId);
  }

  private queueStaleActiveProject(projectId: string): boolean {
    const record = this.options.getProjectRecord(projectId);
    const now = this.options.now();
    const lastCompletedAt = parseTimestamp(record?.lastCompletedObservedAt);
    const stale = lastCompletedAt === null || now - lastCompletedAt >= REMOTE_UPDATE_ACTIVE_INTERVAL_MS;
    const backedOffUntil = this.resolveBackoff(projectId, record);
    if (backedOffUntil !== null && backedOffUntil > now) return false;
    if (stale) {
      this.enqueue(projectId, "active");
      return true;
    }
    this.scheduleFromNow(projectId, true);
    return false;
  }

  private activeDelay(): number {
    return REMOTE_UPDATE_ACTIVE_INTERVAL_MS + this.options.random() * REMOTE_UPDATE_ACTIVE_JITTER_MS;
  }

  private inactiveDelay(): number {
    return REMOTE_UPDATE_INACTIVE_INTERVAL_MS + (this.options.random() * 2 - 1) * REMOTE_UPDATE_INACTIVE_JITTER_MS;
  }

  private failureDelay(failureCount: number): number {
    const base = REMOTE_UPDATE_FAILURE_BACKOFF_MS[failureCount - 1]
      ?? Math.min(
        REMOTE_UPDATE_MAX_FAILURE_BACKOFF_MS,
        REMOTE_UPDATE_FAILURE_BACKOFF_MS.at(-1)! * 2 ** (failureCount - REMOTE_UPDATE_FAILURE_BACKOFF_MS.length)
      );
    return Math.min(REMOTE_UPDATE_MAX_FAILURE_BACKOFF_MS, base * (0.9 + this.options.random() * 0.2));
  }

  private resolveBackoff(projectId: string, record: RemoteUpdateProjectRecord | null): number | null {
    return this.backoffUntil.get(projectId) ?? parseTimestamp(record?.backoffUntil);
  }

  private canSchedule(projectId: string): boolean {
    return this.projects.has(projectId) && this.options.isProjectEligible(projectId);
  }

  private persist(projectId: string, nextDueAt: number | null, backoffUntil: number | null): void {
    this.options.persistSchedule?.(projectId, {
      nextDueAt: nextDueAt === null ? null : new Date(nextDueAt).toISOString(),
      backoffUntil: backoffUntil === null ? null : new Date(backoffUntil).toISOString(),
    });
  }
}

function priorityRank(priority: QueuePriority): number {
  return priority === "manual" ? 0 : priority === "active" ? 1 : 2;
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
