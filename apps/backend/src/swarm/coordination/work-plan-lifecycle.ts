import { WORK_PLAN_MUTABLE_STATUSES, WORK_PLAN_TERMINAL_STATUSES, type WorkPlanLifecycleReason } from "@forge/protocol";
import {
  MAX_WORK_PLAN_MUTATION_PROVENANCE,
  createEmptySessionCoordinationState,
  type WorkPlanRecord,
} from "./session-coordination-state.js";
import {
  SessionCoordinationStore,
  SessionCoordinationStoreUnavailableError,
} from "./session-coordination-store.js";

const NON_TERMINAL_WORK_PLAN_STATUSES = new Set<string>(WORK_PLAN_MUTABLE_STATUSES);
const TERMINAL_WORK_PLAN_STATUSES = new Set<string>(WORK_PLAN_TERMINAL_STATUSES);
const MANUAL_STOP_FINAL_SUMMARY = "Work stopped. Partial progress was preserved.";

class NoWorkPlanLifecycleChangeError extends Error {
  constructor() {
    super("No non-terminal Work Plan required a lifecycle transition.");
    this.name = "NoWorkPlanLifecycleChangeError";
  }
}

export interface WorkPlanLifecycleTransitionOptions {
  dataDir: string;
  profileId: string;
  sessionAgentId: string;
  actorAgentId: string;
  reason: WorkPlanLifecycleReason;
  now?: () => Date;
}

export interface WorkPlanForkCopyOptions {
  dataDir: string;
  profileId: string;
  sourceSessionAgentId: string;
  targetSessionAgentId: string;
  fromMessageId?: string;
  now?: () => Date;
}

export type WorkPlanLifecycleTransitionResult = "changed" | "noop" | "unavailable";

export async function transitionSessionWorkPlansForLifecycle(
  options: WorkPlanLifecycleTransitionOptions,
): Promise<WorkPlanLifecycleTransitionResult> {
  const store = new SessionCoordinationStore({
    dataDir: options.dataDir,
    profileId: options.profileId,
    sessionAgentId: options.sessionAgentId,
    deps: options.now ? { now: options.now } : undefined,
  });

  try {
    await store.update((current) => {
      const timestamp = (options.now ?? (() => new Date()))().toISOString();
      let mutated = false;

      for (const workPlan of current.workPlans) {
        if (!NON_TERMINAL_WORK_PLAN_STATUSES.has(workPlan.status)) {
          continue;
        }

        mutated = true;
        applyLifecycleTransition(workPlan, options.reason, options.actorAgentId, timestamp);
      }

      if (!mutated) {
        throw new NoWorkPlanLifecycleChangeError();
      }

      return current;
    });
    return "changed";
  } catch (error) {
    if (error instanceof NoWorkPlanLifecycleChangeError) {
      return "noop";
    }
    if (error instanceof SessionCoordinationStoreUnavailableError) {
      return "unavailable";
    }
    throw error;
  }
}

export async function copySessionWorkPlansForFork(options: WorkPlanForkCopyOptions): Promise<boolean> {
  if (options.fromMessageId) {
    return false;
  }

  const sourceStore = new SessionCoordinationStore({
    dataDir: options.dataDir,
    profileId: options.profileId,
    sessionAgentId: options.sourceSessionAgentId,
    deps: options.now ? { now: options.now } : undefined,
  });
  const loaded = await sourceStore.load();
  if (loaded.diagnostics.state === "unavailable") {
    return false;
  }

  const terminalWorkPlans = loaded.state.workPlans
    .filter((workPlan) => TERMINAL_WORK_PLAN_STATUSES.has(workPlan.status))
    .map((workPlan) => createForkTerminalSummaryRecord(workPlan, options.targetSessionAgentId));
  if (terminalWorkPlans.length === 0) {
    return false;
  }

  const targetStore = new SessionCoordinationStore({
    dataDir: options.dataDir,
    profileId: options.profileId,
    sessionAgentId: options.targetSessionAgentId,
    deps: options.now ? { now: options.now } : undefined,
  });

  await targetStore.replace({
    ...createEmptySessionCoordinationState(),
    updatedAt: (options.now ?? (() => new Date()))().toISOString(),
    workPlans: terminalWorkPlans,
  });

  return true;
}

function applyLifecycleTransition(
  workPlan: WorkPlanRecord,
  reason: WorkPlanLifecycleReason,
  actorAgentId: string,
  timestamp: string,
): void {
  workPlan.status = reason === "manual_stop" ? "stopped" : "interrupted";
  workPlan.updatedAt = timestamp;
  workPlan.completedAt = timestamp;
  workPlan.revision += 1;
  workPlan.lifecycle = {
    reason,
    changedAt: timestamp,
  };
  if (reason === "manual_stop") {
    workPlan.finalSummary = MANUAL_STOP_FINAL_SUMMARY;
  }
  workPlan.mutationProvenance = [
    ...workPlan.mutationProvenance,
    {
      action: "system" as const,
      actorAgentId,
      mutatedAt: timestamp,
    },
  ].slice(-MAX_WORK_PLAN_MUTATION_PROVENANCE);
}

function createForkTerminalSummaryRecord(
  workPlan: WorkPlanRecord,
  targetSessionAgentId: string,
): WorkPlanRecord {
  return {
    planId: workPlan.planId,
    createdByAgentId: targetSessionAgentId,
    title: workPlan.title,
    status: workPlan.status,
    createdAt: workPlan.createdAt,
    updatedAt: workPlan.updatedAt,
    ...(workPlan.completedAt === undefined ? {} : { completedAt: workPlan.completedAt }),
    revision: 1,
    items: [],
    revisionNotes: [],
    warnings: [...workPlan.warnings],
    ...(workPlan.finalSummary === undefined ? {} : { finalSummary: workPlan.finalSummary }),
    ...(workPlan.lifecycle === undefined ? {} : { lifecycle: { ...workPlan.lifecycle } }),
    mutationProvenance: [],
  };
}
