import type {
  WorkPlanBlockerSnapshot,
  WorkPlanItemResultSnapshot,
  WorkPlanItemResultStatus,
  WorkPlanItemStatus,
  WorkPlanLifecycleReason,
  WorkPlanMode,
  WorkPlanStatus,
  WorkPlanTerminalStatus,
  WorkPlanLinkType
} from "@forge/protocol";

export const SESSION_COORDINATION_SCHEMA_VERSION = 1;

export const INTERNAL_WORK_PLAN_STATUSES = [
  "active",
  "blocked",
  "needs_attention",
  "stopped",
  "completed",
  "completed_with_warnings",
  "failed",
  "interrupted"
] as const satisfies readonly WorkPlanStatus[];

export const INTERNAL_WORK_PLAN_ITEM_STATUSES = [
  "todo",
  "up_next",
  "active",
  "blocked",
  "needs_attention",
  "done",
  "skipped",
  "failed",
  "unknown"
] as const satisfies readonly WorkPlanItemStatus[];

export const INTERNAL_WORK_PLAN_MODES = ["quick", "standard", "deep"] as const satisfies readonly WorkPlanMode[];
export const INTERNAL_WORK_PLAN_ITEM_RESULT_STATUSES = [
  "done",
  "partial",
  "failed",
  "skipped",
  "unknown"
] as const satisfies readonly WorkPlanItemResultStatus[];
export const INTERNAL_WORK_PLAN_TERMINAL_STATUSES = [
  "completed",
  "completed_with_warnings",
  "failed",
  "stopped",
  "interrupted"
] as const satisfies readonly WorkPlanTerminalStatus[];
export const INTERNAL_WORK_PLAN_LIFECYCLE_REASONS = [
  "manual_stop",
  "archived",
  "conversation_cleared"
] as const satisfies readonly WorkPlanLifecycleReason[];
export const INTERNAL_WORK_PLAN_LINK_TYPES = ["worker"] as const satisfies readonly WorkPlanLinkType[];

export const WORK_PLAN_MUTATION_ACTIONS = ["upsert_plan", "update_item_status", "link", "finish_plan", "system"] as const;
export type WorkPlanMutationAction = (typeof WORK_PLAN_MUTATION_ACTIONS)[number];

export const MAX_WORK_PLANS_PER_SESSION = 8;
export const MAX_WORK_PLAN_ITEMS = 25;
export const MAX_WORK_PLAN_WORKER_LINKS = 8;
export const MAX_WORK_PLAN_REVISION_NOTES = 20;
export const MAX_WORK_PLAN_WARNINGS = 10;
export const MAX_WORK_PLAN_MUTATION_PROVENANCE = 32;
export const MAX_IDENTIFIER_LENGTH = 120;
export const MAX_WORK_PLAN_TITLE_LENGTH = 200;
export const MAX_WORK_PLAN_GOAL_LENGTH = 2_000;
export const MAX_WORK_PLAN_PHASE_LENGTH = 120;
export const MAX_WORK_PLAN_NOTE_LENGTH = 2_000;
export const MAX_WORK_PLAN_BLOCKER_REASON_LENGTH = 1_000;
export const MAX_WORK_PLAN_RESULT_SUMMARY_LENGTH = 2_000;
export const MAX_WORK_PLAN_REVISION_NOTE_LENGTH = 1_000;
export const MAX_WORK_PLAN_WARNING_LENGTH = 500;
export const MAX_WORK_PLAN_FINAL_SUMMARY_LENGTH = 4_000;
export const MAX_WORK_PLAN_LINK_LABEL_LENGTH = 120;
export const MAX_WORK_PLAN_LINK_SPECIALIST_ID_LENGTH = 120;

export interface SessionCoordinationState {
  schemaVersion: typeof SESSION_COORDINATION_SCHEMA_VERSION;
  revision: number;
  /**
   * Null only for the in-memory default before the first successful persisted write.
   * Normalized persisted `tasks.json` state always carries an ISO timestamp string.
   */
  updatedAt: string | null;
  workPlans: WorkPlanRecord[];
}

export interface WorkPlanRecord {
  planId: string;
  createdByAgentId: string;
  title: string;
  goal?: string;
  mode?: WorkPlanMode;
  status: WorkPlanStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  revision: number;
  items: WorkPlanItem[];
  revisionNotes: WorkPlanRevisionNote[];
  warnings: string[];
  finalSummary?: string;
  lifecycle?: WorkPlanLifecycleState;
  mutationProvenance: WorkPlanMutationProvenance[];
}

export interface WorkPlanItem {
  itemId: string;
  title: string;
  phase?: string;
  status: WorkPlanItemStatus;
  note?: string;
  blocker?: WorkPlanBlocker;
  result?: WorkPlanItemResult;
  workerLinks: WorkPlanWorkerLink[];
  createdAt: string;
  updatedAt: string;
}

export type WorkPlanBlocker = WorkPlanBlockerSnapshot;
export type WorkPlanItemResult = WorkPlanItemResultSnapshot;

export interface WorkPlanWorkerLink {
  type: WorkPlanLinkType;
  linkId: string;
  agentId: string;
  label?: string;
  specialistId?: string;
  linkedAt: string;
}

export interface WorkPlanRevisionNote {
  revision: number;
  note: string;
  createdAt: string;
}

export interface WorkPlanLifecycleState {
  reason: WorkPlanLifecycleReason;
  changedAt: string;
}

export interface WorkPlanMutationProvenance {
  action: WorkPlanMutationAction;
  actorAgentId: string;
  mutatedAt: string;
  toolCallId?: string;
}

export class SessionCoordinationStateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionCoordinationStateValidationError";
  }
}

/**
 * Returns the pre-persistence default state used when the sidecar is missing or unreadable.
 * `updatedAt` remains null until a successful store mutation writes the first persisted snapshot.
 */
export function createEmptySessionCoordinationState(): SessionCoordinationState {
  return {
    schemaVersion: SESSION_COORDINATION_SCHEMA_VERSION,
    revision: 0,
    updatedAt: null,
    workPlans: []
  };
}

export function cloneSessionCoordinationState(state: SessionCoordinationState): SessionCoordinationState {
  return {
    schemaVersion: state.schemaVersion,
    revision: state.revision,
    updatedAt: state.updatedAt,
    workPlans: state.workPlans.map((plan) => ({
      ...plan,
      items: plan.items.map((item) => ({
        ...item,
        blocker: item.blocker ? { ...item.blocker } : undefined,
        result: item.result ? { ...item.result } : undefined,
        workerLinks: item.workerLinks.map((link) => ({ ...link }))
      })),
      revisionNotes: plan.revisionNotes.map((note) => ({ ...note })),
      warnings: [...plan.warnings],
      lifecycle: plan.lifecycle ? { ...plan.lifecycle } : undefined,
      mutationProvenance: plan.mutationProvenance.map((entry) => ({ ...entry }))
    }))
  };
}

export function normalizeSessionCoordinationState(value: unknown): SessionCoordinationState {
  if (!value || typeof value !== "object") {
    throw new SessionCoordinationStateValidationError("Session coordination state must be an object");
  }

  const state = value as Partial<SessionCoordinationState> & { workPlans?: unknown };
  if (state.schemaVersion !== SESSION_COORDINATION_SCHEMA_VERSION) {
    throw new SessionCoordinationStateValidationError(
      `Unsupported session coordination schema version: ${String(state.schemaVersion)}`
    );
  }

  return {
    schemaVersion: SESSION_COORDINATION_SCHEMA_VERSION,
    revision: normalizeNonNegativeInteger(state.revision, "revision"),
    updatedAt: normalizeRequiredIsoTimestamp(state.updatedAt, "updatedAt"),
    workPlans: normalizeArray(state.workPlans, "workPlans", MAX_WORK_PLANS_PER_SESSION, normalizeWorkPlanRecord)
  };
}

function normalizeWorkPlanRecord(value: unknown, path: string): WorkPlanRecord {
  if (!value || typeof value !== "object") {
    throw new SessionCoordinationStateValidationError(`${path} must be an object`);
  }

  const record = value as Partial<WorkPlanRecord> & {
    items?: unknown;
    revisionNotes?: unknown;
    warnings?: unknown;
    lifecycle?: unknown;
    mutationProvenance?: unknown;
  };

  return {
    planId: normalizeRequiredString(record.planId, `${path}.planId`, MAX_IDENTIFIER_LENGTH),
    createdByAgentId: normalizeRequiredString(record.createdByAgentId, `${path}.createdByAgentId`, MAX_IDENTIFIER_LENGTH),
    title: normalizeRequiredString(record.title, `${path}.title`, MAX_WORK_PLAN_TITLE_LENGTH),
    goal: normalizeOptionalString(record.goal, `${path}.goal`, MAX_WORK_PLAN_GOAL_LENGTH),
    mode: normalizeOptionalEnum(record.mode, INTERNAL_WORK_PLAN_MODES, `${path}.mode`),
    status: normalizeRequiredEnum(record.status, INTERNAL_WORK_PLAN_STATUSES, `${path}.status`),
    createdAt: normalizeRequiredIsoTimestamp(record.createdAt, `${path}.createdAt`),
    updatedAt: normalizeRequiredIsoTimestamp(record.updatedAt, `${path}.updatedAt`),
    completedAt: normalizeOptionalIsoTimestamp(record.completedAt, `${path}.completedAt`),
    revision: normalizeNonNegativeInteger(record.revision, `${path}.revision`),
    items: normalizeArray(record.items, `${path}.items`, MAX_WORK_PLAN_ITEMS, normalizeWorkPlanItem),
    revisionNotes: normalizeArray(
      record.revisionNotes,
      `${path}.revisionNotes`,
      MAX_WORK_PLAN_REVISION_NOTES,
      normalizeWorkPlanRevisionNote
    ),
    warnings: normalizeStringArray(record.warnings, `${path}.warnings`, MAX_WORK_PLAN_WARNINGS, MAX_WORK_PLAN_WARNING_LENGTH),
    finalSummary: normalizeOptionalString(record.finalSummary, `${path}.finalSummary`, MAX_WORK_PLAN_FINAL_SUMMARY_LENGTH),
    lifecycle: normalizeOptionalObject(record.lifecycle, `${path}.lifecycle`, normalizeWorkPlanLifecycle),
    mutationProvenance: normalizeArray(
      record.mutationProvenance,
      `${path}.mutationProvenance`,
      MAX_WORK_PLAN_MUTATION_PROVENANCE,
      normalizeWorkPlanMutationProvenance
    )
  };
}

function normalizeWorkPlanItem(value: unknown, path: string): WorkPlanItem {
  if (!value || typeof value !== "object") {
    throw new SessionCoordinationStateValidationError(`${path} must be an object`);
  }

  const item = value as Partial<WorkPlanItem> & { workerLinks?: unknown; blocker?: unknown; result?: unknown };
  return {
    itemId: normalizeRequiredString(item.itemId, `${path}.itemId`, MAX_IDENTIFIER_LENGTH),
    title: normalizeRequiredString(item.title, `${path}.title`, MAX_WORK_PLAN_TITLE_LENGTH),
    phase: normalizeOptionalString(item.phase, `${path}.phase`, MAX_WORK_PLAN_PHASE_LENGTH),
    status: normalizeRequiredEnum(item.status, INTERNAL_WORK_PLAN_ITEM_STATUSES, `${path}.status`),
    note: normalizeOptionalString(item.note, `${path}.note`, MAX_WORK_PLAN_NOTE_LENGTH),
    blocker: normalizeOptionalObject(item.blocker, `${path}.blocker`, normalizeWorkPlanBlocker),
    result: normalizeOptionalObject(item.result, `${path}.result`, normalizeWorkPlanItemResult),
    workerLinks: normalizeArray(item.workerLinks, `${path}.workerLinks`, MAX_WORK_PLAN_WORKER_LINKS, normalizeWorkPlanWorkerLink),
    createdAt: normalizeRequiredIsoTimestamp(item.createdAt, `${path}.createdAt`),
    updatedAt: normalizeRequiredIsoTimestamp(item.updatedAt, `${path}.updatedAt`)
  };
}

function normalizeWorkPlanBlocker(value: unknown, path: string): WorkPlanBlocker {
  if (!value || typeof value !== "object") {
    throw new SessionCoordinationStateValidationError(`${path} must be an object`);
  }

  const blocker = value as Partial<WorkPlanBlocker>;
  const needsUser = blocker.needsUser;
  if (needsUser !== undefined && typeof needsUser !== "boolean") {
    throw new SessionCoordinationStateValidationError(`${path}.needsUser must be a boolean when provided`);
  }

  return {
    reason: normalizeRequiredString(blocker.reason, `${path}.reason`, MAX_WORK_PLAN_BLOCKER_REASON_LENGTH),
    ...(needsUser === undefined ? {} : { needsUser })
  };
}

function normalizeWorkPlanItemResult(value: unknown, path: string): WorkPlanItemResult {
  if (!value || typeof value !== "object") {
    throw new SessionCoordinationStateValidationError(`${path} must be an object`);
  }

  const result = value as Partial<WorkPlanItemResult>;
  return {
    summary: normalizeRequiredString(result.summary, `${path}.summary`, MAX_WORK_PLAN_RESULT_SUMMARY_LENGTH),
    status: normalizeRequiredEnum(result.status, INTERNAL_WORK_PLAN_ITEM_RESULT_STATUSES, `${path}.status`)
  };
}

function normalizeWorkPlanWorkerLink(value: unknown, path: string): WorkPlanWorkerLink {
  if (!value || typeof value !== "object") {
    throw new SessionCoordinationStateValidationError(`${path} must be an object`);
  }

  const link = value as Partial<WorkPlanWorkerLink>;
  return {
    type: normalizeRequiredEnum(link.type, INTERNAL_WORK_PLAN_LINK_TYPES, `${path}.type`),
    linkId: normalizeRequiredString(link.linkId, `${path}.linkId`, MAX_IDENTIFIER_LENGTH),
    agentId: normalizeRequiredString(link.agentId, `${path}.agentId`, MAX_IDENTIFIER_LENGTH),
    label: normalizeOptionalString(link.label, `${path}.label`, MAX_WORK_PLAN_LINK_LABEL_LENGTH),
    specialistId: normalizeOptionalString(link.specialistId, `${path}.specialistId`, MAX_WORK_PLAN_LINK_SPECIALIST_ID_LENGTH),
    linkedAt: normalizeRequiredIsoTimestamp(link.linkedAt, `${path}.linkedAt`)
  };
}

function normalizeWorkPlanRevisionNote(value: unknown, path: string): WorkPlanRevisionNote {
  if (!value || typeof value !== "object") {
    throw new SessionCoordinationStateValidationError(`${path} must be an object`);
  }

  const note = value as Partial<WorkPlanRevisionNote>;
  return {
    revision: normalizeNonNegativeInteger(note.revision, `${path}.revision`),
    note: normalizeRequiredString(note.note, `${path}.note`, MAX_WORK_PLAN_REVISION_NOTE_LENGTH),
    createdAt: normalizeRequiredIsoTimestamp(note.createdAt, `${path}.createdAt`)
  };
}

function normalizeWorkPlanLifecycle(value: unknown, path: string): WorkPlanLifecycleState {
  if (!value || typeof value !== "object") {
    throw new SessionCoordinationStateValidationError(`${path} must be an object`);
  }

  const lifecycle = value as Partial<WorkPlanLifecycleState>;
  return {
    reason: normalizeRequiredEnum(lifecycle.reason, INTERNAL_WORK_PLAN_LIFECYCLE_REASONS, `${path}.reason`),
    changedAt: normalizeRequiredIsoTimestamp(lifecycle.changedAt, `${path}.changedAt`)
  };
}

function normalizeWorkPlanMutationProvenance(value: unknown, path: string): WorkPlanMutationProvenance {
  if (!value || typeof value !== "object") {
    throw new SessionCoordinationStateValidationError(`${path} must be an object`);
  }

  const provenance = value as Partial<WorkPlanMutationProvenance>;
  return {
    action: normalizeRequiredEnum(provenance.action, WORK_PLAN_MUTATION_ACTIONS, `${path}.action`),
    actorAgentId: normalizeRequiredString(provenance.actorAgentId, `${path}.actorAgentId`, MAX_IDENTIFIER_LENGTH),
    mutatedAt: normalizeRequiredIsoTimestamp(provenance.mutatedAt, `${path}.mutatedAt`),
    toolCallId: normalizeOptionalString(provenance.toolCallId, `${path}.toolCallId`, MAX_IDENTIFIER_LENGTH)
  };
}

function normalizeArray<T>(
  value: unknown,
  path: string,
  maxLength: number,
  itemNormalizer: (value: unknown, path: string) => T
): T[] {
  if (!Array.isArray(value)) {
    throw new SessionCoordinationStateValidationError(`${path} must be an array`);
  }

  if (value.length > maxLength) {
    throw new SessionCoordinationStateValidationError(`${path} must contain at most ${maxLength} items`);
  }

  return value.map((item, index) => itemNormalizer(item, `${path}[${index}]`));
}

function normalizeStringArray(value: unknown, path: string, maxLength: number, itemMaxLength: number): string[] {
  if (!Array.isArray(value)) {
    throw new SessionCoordinationStateValidationError(`${path} must be an array`);
  }

  if (value.length > maxLength) {
    throw new SessionCoordinationStateValidationError(`${path} must contain at most ${maxLength} items`);
  }

  return value.map((item, index) => normalizeRequiredString(item, `${path}[${index}]`, itemMaxLength));
}

function normalizeRequiredString(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new SessionCoordinationStateValidationError(`${path} must be a string`);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new SessionCoordinationStateValidationError(`${path} must not be empty`);
  }

  if (trimmed.length > maxLength) {
    throw new SessionCoordinationStateValidationError(`${path} must be at most ${maxLength} characters`);
  }

  return trimmed;
}

function normalizeOptionalString(value: unknown, path: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return normalizeRequiredString(value, path, maxLength);
}

function normalizeNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new SessionCoordinationStateValidationError(`${path} must be a non-negative integer`);
  }

  return value;
}

function normalizeRequiredEnum<T extends readonly string[]>(value: unknown, allowedValues: T, path: string): T[number] {
  if (typeof value !== "string" || !allowedValues.includes(value as T[number])) {
    throw new SessionCoordinationStateValidationError(`${path} must be one of: ${allowedValues.join(", ")}`);
  }

  return value as T[number];
}

function normalizeOptionalEnum<T extends readonly string[]>(
  value: unknown,
  allowedValues: T,
  path: string
): T[number] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return normalizeRequiredEnum(value, allowedValues, path);
}

function normalizeOptionalObject<T>(
  value: unknown,
  path: string,
  normalizer: (value: unknown, path: string) => T
): T | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return normalizer(value, path);
}

function normalizeRequiredIsoTimestamp(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || Number.isNaN(Date.parse(value))) {
    throw new SessionCoordinationStateValidationError(`${path} must be an ISO timestamp string`);
  }

  return value;
}

function normalizeOptionalIsoTimestamp(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return normalizeRequiredIsoTimestamp(value, path);
}
