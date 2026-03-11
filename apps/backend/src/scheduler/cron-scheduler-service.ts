import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { CronExpressionParser } from "cron-parser";
import { renameWithRetry } from "../swarm/retry-rename.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const MIN_POLL_INTERVAL_MS = 5_000;

export interface ScheduledTask {
  id: string;
  name: string;
  cron: string;
  message: string;
  oneShot: boolean;
  timezone: string;
  createdAt: string;
  nextFireAt: string;
  lastFiredAt?: string;
}

interface SchedulesFile {
  schedules: ScheduledTask[];
}

interface CronSchedulerServiceOptions {
  swarmManager: SwarmManager;
  schedulesFile: string;
  managerId: string;
  pollIntervalMs?: number;
  now?: () => Date;
}

export class CronSchedulerService {
  private readonly swarmManager: SwarmManager;
  private readonly schedulesFile: string;
  private readonly managerId: string;
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;

  private running = false;
  private processing = false;
  private pendingProcess = false;
  private pollTimer?: NodeJS.Timeout;
  private watcher?: FSWatcher;
  private watchDebounceTimer?: NodeJS.Timeout;
  private activeRunPromise?: Promise<void>;
  private readonly firedOccurrenceKeys = new Set<string>();

  constructor(options: CronSchedulerServiceOptions) {
    this.swarmManager = options.swarmManager;
    this.schedulesFile = options.schedulesFile;
    this.managerId = options.managerId;
    this.pollIntervalMs = normalizePollIntervalMs(options.pollIntervalMs);
    this.now = options.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    await this.ensureSchedulesFile();
    await this.processDueSchedules("startup");
    this.startWatcher();
    this.startPolling();
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    if (this.watchDebounceTimer) {
      clearTimeout(this.watchDebounceTimer);
      this.watchDebounceTimer = undefined;
    }

    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }

    await this.activeRunPromise;
  }

  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      this.requestProcess("poll");
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  private startWatcher(): void {
    const schedulesDir = dirname(this.schedulesFile);
    const schedulesBasename = basename(this.schedulesFile);

    this.watcher = watch(schedulesDir, (eventType, fileName) => {
      if (!this.running) {
        return;
      }

      if (!fileName || fileName.toString() === schedulesBasename) {
        clearTimeout(this.watchDebounceTimer);
        this.watchDebounceTimer = setTimeout(() => this.requestProcess(`watch:${eventType}`), 150);
        this.watchDebounceTimer.unref?.();
      }
    });

    this.watcher.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[scheduler] File watcher error: ${message}`);
    });
  }

  private requestProcess(reason: string): void {
    if (!this.running) {
      return;
    }

    if (this.processing) {
      this.pendingProcess = true;
      return;
    }

    this.processing = true;
    const run = this.processDueSchedules(reason)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[scheduler] Processing failed (${reason}): ${message}`);
      })
      .finally(() => {
        this.processing = false;
        if (this.pendingProcess && this.running) {
          this.pendingProcess = false;
          this.requestProcess("pending");
        }
      });

    this.activeRunPromise = run.finally(() => {
      if (this.activeRunPromise === run) {
        this.activeRunPromise = undefined;
      }
    });
  }

  private async processDueSchedules(_reason: string): Promise<void> {
    const snapshot = await this.readSchedulesFile();
    if (snapshot.schedules.length === 0) {
      return;
    }

    const now = this.now();
    const updates = new Map<string, ScheduledTask>();
    const removals = new Set<string>();

    for (const schedule of snapshot.schedules) {
      const normalized = this.ensureValidNextFireAt(schedule, now);
      let activeSchedule = normalized.schedule;

      if (normalized.changed) {
        updates.set(activeSchedule.id, activeSchedule);
      }

      const scheduledFor = parseIsoDate(activeSchedule.nextFireAt);
      if (!scheduledFor) {
        continue;
      }

      if (scheduledFor.getTime() > now.getTime()) {
        continue;
      }

      const scheduledForIso = scheduledFor.toISOString();
      const occurrenceKey = buildOccurrenceKey(activeSchedule.id, scheduledForIso);
      if (
        activeSchedule.lastFiredAt === scheduledForIso ||
        this.firedOccurrenceKeys.has(occurrenceKey)
      ) {
        if (activeSchedule.oneShot) {
          removals.add(activeSchedule.id);
          updates.delete(activeSchedule.id);
        } else {
          activeSchedule = this.advanceRecurringSchedule(activeSchedule, scheduledFor);
          updates.set(activeSchedule.id, activeSchedule);
        }
        continue;
      }

      const fired = await this.dispatchSchedule(activeSchedule, scheduledForIso);
      if (!fired) {
        continue;
      }

      this.firedOccurrenceKeys.add(occurrenceKey);
      if (this.firedOccurrenceKeys.size > 10_000) {
        this.firedOccurrenceKeys.clear();
      }

      if (activeSchedule.oneShot) {
        removals.add(activeSchedule.id);
        updates.delete(activeSchedule.id);
        continue;
      }

      activeSchedule = this.advanceRecurringSchedule(activeSchedule, scheduledFor);
      updates.set(activeSchedule.id, activeSchedule);
    }

    if (updates.size === 0 && removals.size === 0) {
      return;
    }

    await this.applyMutations(updates, removals);
  }

  private async dispatchSchedule(schedule: ScheduledTask, scheduledForIso: string): Promise<boolean> {
    const scheduleContext = {
      scheduleId: schedule.id,
      name: schedule.name,
      cron: schedule.cron,
      timezone: schedule.timezone,
      oneShot: schedule.oneShot,
      scheduledFor: scheduledForIso
    };

    const message = [
      `[Scheduled Task: ${schedule.name}]`,
      `[scheduleContext] ${JSON.stringify(scheduleContext)}`,
      "",
      schedule.message
    ].join("\n");

    try {
      await this.swarmManager.handleUserMessage(message, {
        targetAgentId: this.managerId,
        sourceContext: { channel: "web" }
      });

      console.log(
        `[scheduler] Fired schedule ${schedule.id} (${schedule.name}) for ${scheduledForIso}`
      );
      return true;
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      console.error(
        `[scheduler] Failed to dispatch schedule ${schedule.id} (${schedule.name}): ${messageText}`
      );
      return false;
    }
  }

  private advanceRecurringSchedule(schedule: ScheduledTask, scheduledFor: Date): ScheduledTask {
    const nextAfter = new Date(scheduledFor.getTime() + 1_000);
    const fallbackAfter = new Date(this.now().getTime() + 60_000);

    let nextFireAt: string;
    try {
      nextFireAt = computeNextFireAt(schedule.cron, schedule.timezone, nextAfter);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[scheduler] Failed to compute next run for ${schedule.id} (${schedule.name}): ${message}`
      );
      nextFireAt = computeNextFireAt(schedule.cron, schedule.timezone, fallbackAfter);
    }

    return {
      ...schedule,
      nextFireAt,
      lastFiredAt: scheduledFor.toISOString()
    };
  }

  private ensureValidNextFireAt(
    schedule: ScheduledTask,
    now: Date
  ): { schedule: ScheduledTask; changed: boolean } {
    if (parseIsoDate(schedule.nextFireAt)) {
      return { schedule, changed: false };
    }

    try {
      return {
        schedule: {
          ...schedule,
          nextFireAt: computeNextFireAt(schedule.cron, schedule.timezone, now)
        },
        changed: true
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[scheduler] Invalid schedule ${schedule.id}: ${message}`);
      return { schedule, changed: false };
    }
  }

  private async applyMutations(
    updates: Map<string, ScheduledTask>,
    removals: Set<string>
  ): Promise<void> {
    const latest = await this.readSchedulesFile();
    const nextSchedules: ScheduledTask[] = [];
    let changed = false;

    for (const schedule of latest.schedules) {
      if (removals.has(schedule.id)) {
        changed = true;
        continue;
      }

      const updated = updates.get(schedule.id);
      if (updated) {
        nextSchedules.push(updated);
        updates.delete(schedule.id);
        if (!areSchedulesEqual(schedule, updated)) {
          changed = true;
        }
        continue;
      }

      nextSchedules.push(schedule);
    }

    if (!changed) {
      return;
    }

    await this.writeSchedulesFile({ schedules: nextSchedules });
  }

  private async ensureSchedulesFile(): Promise<void> {
    try {
      await readFile(this.schedulesFile, "utf8");
      return;
    } catch (error) {
      if (!isEnoentError(error)) {
        throw error;
      }
    }

    await this.writeSchedulesFile({ schedules: [] });
  }

  private async readSchedulesFile(): Promise<SchedulesFile> {
    try {
      const raw = await readFile(this.schedulesFile, "utf8");
      const parsed = JSON.parse(raw) as { schedules?: unknown };

      if (!parsed || !Array.isArray(parsed.schedules)) {
        return { schedules: [] };
      }

      const schedules = parsed.schedules
        .map((entry) => normalizeScheduledTask(entry))
        .filter((entry): entry is ScheduledTask => entry !== undefined);

      return { schedules };
    } catch (error) {
      if (isEnoentError(error)) {
        return { schedules: [] };
      }

      const message = error instanceof Error ? error.message : String(error);
      console.error(`[scheduler] Failed to read schedules file: ${message}`);
      return { schedules: [] };
    }
  }

  private async writeSchedulesFile(payload: SchedulesFile): Promise<void> {
    const target = this.schedulesFile;
    const temp = `${target}.tmp`;

    await mkdir(dirname(target), { recursive: true });
    await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await renameWithRetry(temp, target, { retries: 8, baseDelayMs: 15 });
  }
}

function normalizePollIntervalMs(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) {
    return DEFAULT_POLL_INTERVAL_MS;
  }

  return Math.max(MIN_POLL_INTERVAL_MS, Math.floor(value));
}

function normalizeScheduledTask(entry: unknown): ScheduledTask | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return undefined;
  }

  const maybe = entry as Partial<ScheduledTask>;
  const id = normalizeRequiredString(maybe.id);
  const name = normalizeRequiredString(maybe.name);
  const cron = normalizeRequiredString(maybe.cron);
  const message = normalizeRequiredString(maybe.message);
  const timezone = normalizeRequiredString(maybe.timezone);
  const createdAt = normalizeRequiredString(maybe.createdAt);
  const nextFireAt = normalizeRequiredString(maybe.nextFireAt);
  const oneShot = typeof maybe.oneShot === "boolean" ? maybe.oneShot : false;
  const lastFiredAt =
    typeof maybe.lastFiredAt === "string" && maybe.lastFiredAt.trim().length > 0
      ? maybe.lastFiredAt
      : undefined;

  if (!id || !name || !cron || !message || !timezone || !createdAt || !nextFireAt) {
    return undefined;
  }

  if (!isValidTimezone(timezone)) {
    return undefined;
  }

  try {
    // Validate cron expression early so invalid rows are ignored.
    computeNextFireAt(cron, timezone, new Date());
  } catch {
    return undefined;
  }

  return {
    id,
    name,
    cron,
    message,
    oneShot,
    timezone,
    createdAt,
    nextFireAt,
    lastFiredAt
  };
}

function normalizeRequiredString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function parseIsoDate(value: string | undefined): Date | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return undefined;
  }

  return new Date(timestamp);
}

function buildOccurrenceKey(scheduleId: string, scheduledForIso: string): string {
  return `${scheduleId}:${scheduledForIso}`;
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function computeNextFireAt(cron: string, timezone: string, afterDate: Date): string {
  const iterator = CronExpressionParser.parse(cron, {
    currentDate: afterDate,
    tz: timezone
  });
  return iterator.next().toDate().toISOString();
}

function areSchedulesEqual(left: ScheduledTask, right: ScheduledTask): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.cron === right.cron &&
    left.message === right.message &&
    left.oneShot === right.oneShot &&
    left.timezone === right.timezone &&
    left.createdAt === right.createdAt &&
    left.nextFireAt === right.nextFireAt &&
    left.lastFiredAt === right.lastFiredAt
  );
}
