import type { CaptureForkRunnerAdapter } from "./capture-check.js";
import {
  countUserTurnsSinceWatermark,
  evaluateCaptureCadence,
  invokeCaptureJudge,
  readCaptureDeltaFromSessionFile,
  runCaptureCheckFork,
  type CaptureCadenceInput,
} from "./capture-check.js";
import { readSessionMeta, writeSessionMeta } from "./session-manifest.js";
import { previewForLog } from "./swarm-manager-utils.js";
import type { AgentDescriptor } from "./types.js";

export type CaptureCascadeTrigger = NonNullable<CaptureCadenceInput["trigger"]>;

export type CaptureCascadeDescriptor = Pick<
  AgentDescriptor,
  "agentId" | "profileId" | "role" | "sessionFile" | "sessionPurpose" | "updatedAt"
>;

export interface CaptureCascadeHost extends CaptureForkRunnerAdapter {
  getDescriptor(agentId: string): CaptureCascadeDescriptor | undefined;
  executeJudgePrompt(prompt: string): Promise<string>;
}

export interface CaptureCascadeCoordinatorOptions {
  dataDir: string;
  isEnabled(): boolean;
  host: CaptureCascadeHost;
  now(): string;
  logDebug(message: string, details?: Record<string, unknown>): void;
}

/**
 * Owns the knowledge-capture cadence, watermark, judge, and temporary-fork state machine.
 *
 * The host retains only the manager operations that cross subsystem boundaries. Keeping those
 * operations explicit makes the temporary capture session lifecycle reviewable without coupling
 * this coordinator to SwarmManager itself.
 */
export class CaptureCascadeCoordinator {
  constructor(private readonly options: CaptureCascadeCoordinatorOptions) {}

  async handleFeedbackSignal(profileId: string, sessionId: string): Promise<void> {
    const descriptor = this.options.host.getDescriptor(sessionId);
    if (!descriptor || descriptor.profileId !== profileId || descriptor.role !== "manager") {
      return;
    }

    await this.run(sessionId, "feedback");
  }

  async noteLearningSaved(agentId: string): Promise<void> {
    await this.advanceWatermark(agentId, this.options.now());
  }

  async run(agentId: string, trigger: CaptureCascadeTrigger): Promise<void> {
    if (!this.options.isEnabled()) {
      return;
    }

    const descriptor = this.options.host.getDescriptor(agentId);
    if (
      !descriptor ||
      descriptor.role !== "manager" ||
      !descriptor.profileId ||
      descriptor.sessionPurpose === "capture_check"
    ) {
      return;
    }

    const meta = await readSessionMeta(this.options.dataDir, descriptor.profileId, descriptor.agentId);
    if (!meta) {
      return;
    }

    const messages = await readCaptureDeltaFromSessionFile(descriptor.sessionFile, {
      lastCaptureCheckAt: meta.cortexCaptureLastCheckedAt,
    }).catch((error) => {
      this.options.logDebug("cortex:capture:read_delta_error", {
        agentId,
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    });

    const today = this.options.now().slice(0, 10);
    const dailyForksUsed = meta.cortexCaptureForksDay === today ? (meta.cortexCaptureForksToday ?? 0) : 0;
    const decision = evaluateCaptureCadence({
      enabled: true,
      userTurnsSinceWatermark: countUserTurnsSinceWatermark(messages),
      lastCaptureCheckAt: meta.cortexCaptureLastCheckedAt,
      trigger,
      idleGapMs: trigger === "idle" ? this.resolveIdleGapMs(descriptor) : undefined,
      dailyForksUsed,
      saveLearningAdvancedWatermark: false,
    });

    if (!decision.shouldJudge && !decision.shouldForkDirectly) {
      this.options.logDebug("cortex:capture:skipped", {
        agentId,
        trigger,
        skippedReason: decision.skippedReason,
      });
      return;
    }

    let judgePointer: string | undefined;
    if (decision.shouldJudge) {
      if (messages.length === 0) {
        await this.advanceWatermark(agentId, this.options.now());
        return;
      }

      try {
        const judge = await invokeCaptureJudge(
          { complete: (prompt) => this.options.host.executeJudgePrompt(prompt) },
          messages,
        );
        if (!judge.shouldFork) {
          await this.advanceWatermark(agentId, this.options.now());
          this.options.logDebug("cortex:capture:judge_no", {
            agentId,
            trigger,
            raw: previewForLog(judge.raw),
          });
          return;
        }
        judgePointer = judge.pointer;
      } catch (error) {
        this.options.logDebug("cortex:capture:judge_error", {
          agentId,
          trigger,
          message: error instanceof Error ? error.message : String(error),
        });
        await this.advanceWatermark(agentId, this.options.now());
        return;
      }
    }

    const fromMessageId = [...messages].reverse().find((message) => message.id)?.id;
    try {
      await runCaptureCheckFork({
        enabled: true,
        sourceAgentId: agentId,
        fromMessageId,
        judgePointer: decision.reason === "feedback" ? "user feedback signal" : judgePointer,
        adapter: this.options.host,
      });
      await this.recordFork(agentId, today, dailyForksUsed + 1);
      this.options.logDebug("cortex:capture:forked", {
        agentId,
        trigger,
        reason: decision.reason,
        fromMessageId,
      });
    } catch (error) {
      this.options.logDebug("cortex:capture:fork_error", {
        agentId,
        trigger,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private resolveIdleGapMs(descriptor: CaptureCascadeDescriptor): number | undefined {
    if (!descriptor.updatedAt) {
      return undefined;
    }
    return Math.max(0, Date.parse(this.options.now()) - Date.parse(descriptor.updatedAt));
  }

  private async advanceWatermark(agentId: string, at: string): Promise<void> {
    const descriptor = this.options.host.getDescriptor(agentId);
    if (!descriptor?.profileId) {
      return;
    }
    const meta = await readSessionMeta(this.options.dataDir, descriptor.profileId, agentId);
    if (!meta) {
      return;
    }
    meta.cortexCaptureLastCheckedAt = at;
    meta.updatedAt = this.options.now();
    await writeSessionMeta(this.options.dataDir, meta);
  }

  private async recordFork(agentId: string, day: string, forksToday: number): Promise<void> {
    const descriptor = this.options.host.getDescriptor(agentId);
    if (!descriptor?.profileId) {
      return;
    }
    const meta = await readSessionMeta(this.options.dataDir, descriptor.profileId, agentId);
    if (!meta) {
      return;
    }
    meta.cortexCaptureLastCheckedAt = this.options.now();
    meta.cortexCaptureForksDay = day;
    meta.cortexCaptureForksToday = forksToday;
    meta.updatedAt = this.options.now();
    await writeSessionMeta(this.options.dataDir, meta);
  }
}
