import { randomUUID } from 'node:crypto'
import type {
  SessionTaskDiagnosticState,
  SessionTaskStateSnapshot,
  WorkPlanItemStatus,
  WorkPlanMode,
  WorkPlanMutableStatus,
  WorkPlanSnapshot,
  WorkPlanStatus,
  WorkPlanTerminalStatus,
} from '@forge/protocol'
import type { AgentDescriptor } from '../types.js'
import {
  MAX_WORK_PLAN_MUTATION_PROVENANCE,
  MAX_WORK_PLAN_REVISION_NOTES,
  MAX_WORK_PLANS_PER_SESSION,
  WORK_PLAN_HISTORY_CAPACITY_MESSAGE,
  INTERNAL_WORK_PLAN_ITEM_STATUSES,
  SessionCoordinationStateValidationError,
  createEmptySessionCoordinationState,
  type SessionCoordinationState,
  type WorkPlanBlocker,
  type WorkPlanItem,
  type WorkPlanItemResult,
  type WorkPlanRecord,
} from './session-coordination-state.js'
import {
  SessionCoordinationStateRevisionConflictError,
  type SessionCoordinationStore,
  type SessionCoordinationStoreLoadResult,
  SessionCoordinationStoreUnavailableError,
} from './session-coordination-store.js'
import {
  type WorkPlanActorContext,
  type WorkPlanWorkerLinkInput,
  WorkPlanLinkValidationError,
  validateWorkerLinkInput,
} from './work-plan-link-validation.js'
import {
  findNonTerminalWorkPlanRecords,
  findWorkPlanRecordById,
  projectSessionTaskStateSnapshot,
  projectWorkPlanSnapshot,
} from './work-plan-snapshot.js'

export const WORK_PLAN_SERVICE_ACTIONS = ['get', 'upsert_plan', 'update_item_status', 'link', 'finish_plan'] as const
export type WorkPlanServiceAction = (typeof WORK_PLAN_SERVICE_ACTIONS)[number]

export const WORK_PLAN_SERVICE_ERROR_CODES = [
  'auth_error',
  'state_revision_conflict',
  'validation_error',
  'state_unavailable',
  'work_plan_not_found',
  'work_plan_immutable',
  'active_plan_exists',
  'item_resolution_failed',
  'invalid_link',
  'unknown_error',
] as const
export type WorkPlanServiceErrorCode = (typeof WORK_PLAN_SERVICE_ERROR_CODES)[number]

export interface WorkPlanGetResult {
  action: 'get'
  stateRevision: number
  snapshot: SessionTaskStateSnapshot
  workPlan: WorkPlanSnapshot | null
}

export interface WorkPlanUpsertItemInput {
  itemId?: string
  title: string
  phase?: string
  status?: WorkPlanItemStatus
  note?: string
  blocker?: WorkPlanBlocker
  result?: WorkPlanItemResult
}

export interface WorkPlanUpsertInput {
  expectedStateRevision?: number
  planId?: string
  title?: string
  goal?: string
  mode?: WorkPlanMode
  status?: WorkPlanMutableStatus
  items?: WorkPlanUpsertItemInput[]
  revisionNote?: string
}

export interface WorkPlanLinkInput {
  expectedStateRevision?: number
  planId: string
  itemId?: string
  link: WorkPlanWorkerLinkInput | Record<string, unknown>
}

export interface WorkPlanFinishInput {
  expectedStateRevision?: number
  planId: string
  status: WorkPlanTerminalStatus
  finalSummary: string
  warnings?: string[]
}

export interface WorkPlanUpdateItemStatusInput {
  expectedStateRevision?: number
  planId: string
  itemId: string
  status: WorkPlanItemStatus
}

export interface WorkPlanMutationResult {
  action: Exclude<WorkPlanServiceAction, 'get'>
  snapshot: SessionTaskStateSnapshot
  stateRevision: number
  previousStateRevision: number
  planId: string
  planRevision: number
  workPlan: WorkPlanSnapshot
  createdItemIds?: string[]
  updatedItemId?: string
  linkedItemId?: string
}

export interface WorkPlanServiceErrorDescriptor {
  action?: WorkPlanServiceAction
  code: WorkPlanServiceErrorCode
  message: string
  actualStateRevision?: number
  diagnosticsState?: SessionTaskDiagnosticState
}

export interface WorkPlanServiceDeps {
  store: Pick<SessionCoordinationStore, 'load' | 'update'>
  listAgents: () => AgentDescriptor[]
  now?: () => Date
  createId?: (prefix: 'plan' | 'item' | 'link') => string
}

const NON_TERMINAL_PLAN_STATUSES = new Set<WorkPlanMutableStatus>(['active', 'blocked', 'needs_attention'])
const REVISION_CONFLICT_MESSAGE = 'Active Work changed since your last snapshot. Call `task.get` to refresh, then retry with the latest `stateRevision`.'
const GENERIC_UNKNOWN_ERROR_MESSAGE = 'Active Work request failed unexpectedly.'

export class WorkPlanServiceAuthorizationError extends Error {
  readonly code = 'auth_error' satisfies WorkPlanServiceErrorCode

  constructor(message: string) {
    super(message)
    this.name = 'WorkPlanServiceAuthorizationError'
  }
}

export class WorkPlanServiceValidationError extends Error {
  readonly code = 'validation_error' satisfies WorkPlanServiceErrorCode

  constructor(message: string) {
    super(message)
    this.name = 'WorkPlanServiceValidationError'
  }
}

export class WorkPlanNotFoundError extends Error {
  readonly code = 'work_plan_not_found' satisfies WorkPlanServiceErrorCode

  constructor(planId: string) {
    super(`Work Plan not found: ${planId}`)
    this.name = 'WorkPlanNotFoundError'
  }
}

export class WorkPlanImmutableError extends Error {
  readonly code = 'work_plan_immutable' satisfies WorkPlanServiceErrorCode

  constructor(planId: string) {
    super(`Terminal Work Plans cannot be mutated in v1: ${planId}`)
    this.name = 'WorkPlanImmutableError'
  }
}

export class WorkPlanActiveInvariantError extends Error {
  readonly code = 'active_plan_exists' satisfies WorkPlanServiceErrorCode

  constructor() {
    super('Only one non-terminal Work Plan is allowed per session.')
    this.name = 'WorkPlanActiveInvariantError'
  }
}

export class WorkPlanItemResolutionError extends Error {
  readonly code = 'item_resolution_failed' satisfies WorkPlanServiceErrorCode

  constructor(message: string) {
    super(message)
    this.name = 'WorkPlanItemResolutionError'
  }
}

export class WorkPlanService {
  private readonly profileId: string
  private readonly sessionAgentId: string
  private readonly store: Pick<SessionCoordinationStore, 'load' | 'update'>
  private readonly listAgents: () => AgentDescriptor[]
  private readonly now: () => Date
  private readonly createId: (prefix: 'plan' | 'item' | 'link') => string

  constructor(options: {
    profileId: string
    sessionAgentId: string
    deps: WorkPlanServiceDeps
  }) {
    this.profileId = options.profileId
    this.sessionAgentId = options.sessionAgentId
    this.store = options.deps.store
    this.listAgents = options.deps.listAgents
    this.now = options.deps.now ?? (() => new Date())
    this.createId = options.deps.createId ?? ((prefix) => `${prefix}-${randomUUID()}`)
  }

  async loadSnapshot(): Promise<SessionTaskStateSnapshot> {
    const loaded = await this.store.load()
    return projectSnapshot({
      state: loaded.state,
      diagnostics: loaded.diagnostics,
      profileId: this.profileId,
      sessionAgentId: this.sessionAgentId,
    })
  }

  async get(actor: WorkPlanActorContext): Promise<WorkPlanGetResult> {
    this.assertActorCanAccessSession(actor)
    const loaded = await this.store.load()
    if (loaded.diagnostics.state === 'unavailable') {
      throw new SessionCoordinationStoreUnavailableError(loaded.diagnostics.message)
    }

    const snapshot = projectSnapshot({
      state: loaded.state,
      diagnostics: loaded.diagnostics,
      profileId: this.profileId,
      sessionAgentId: this.sessionAgentId,
    })

    return {
      action: 'get',
      stateRevision: snapshot.revision,
      snapshot,
      workPlan: snapshot.activeWorkPlan ?? snapshot.recentWorkPlans[0] ?? null,
    }
  }

  async upsertPlan(actor: WorkPlanActorContext, input: WorkPlanUpsertInput): Promise<WorkPlanMutationResult> {
    this.assertActorCanAccessSession(actor)

    let mutatedPlanId: string | undefined
    let createdItemIds: string[] = []
    const mutation = await this.store.update((current) => {
      const nextState = cloneState(current)
      const timestamp = this.now().toISOString()
      const existing = input.planId ? findWorkPlanRecordById(nextState, input.planId) : null

      if (!input.planId) {
        if (findNonTerminalWorkPlanRecords(nextState).length > 0) {
          throw new WorkPlanActiveInvariantError()
        }
      } else if (!existing) {
        throw new WorkPlanNotFoundError(input.planId)
      }

      if (existing && !NON_TERMINAL_PLAN_STATUSES.has(existing.status as WorkPlanMutableStatus)) {
        throw new WorkPlanImmutableError(existing.planId)
      }

      const planResult = existing
        ? this.buildUpdatedPlan(existing, input, actor, timestamp)
        : this.buildCreatedPlan(input, actor, timestamp)

      mutatedPlanId = planResult.plan.planId
      createdItemIds = planResult.createdItemIds
      replaceOrInsertPlan(nextState, planResult.plan)
      assertSingleNonTerminalPlan(nextState)
      return nextState
    }, { expectedStateRevision: input.expectedStateRevision })

    return this.toMutationResult('upsert_plan', mutation, mutatedPlanId, { createdItemIds })
  }

  async link(actor: WorkPlanActorContext, input: WorkPlanLinkInput): Promise<WorkPlanMutationResult> {
    this.assertActorCanAccessSession(actor)

    let linkedItemId: string | undefined
    const mutation = await this.store.update((current) => {
      const nextState = cloneState(current)
      const plan = findWorkPlanRecordById(nextState, input.planId)
      if (!plan) {
        throw new WorkPlanNotFoundError(input.planId)
      }
      if (!NON_TERMINAL_PLAN_STATUSES.has(plan.status as WorkPlanMutableStatus)) {
        throw new WorkPlanImmutableError(plan.planId)
      }

      const timestamp = this.now().toISOString()
      const validatedLink = validateWorkerLinkInput(actor, input.link, this.listAgents())
      const item = resolveItemForLink(plan, input.itemId)
      linkedItemId = item.itemId
      const existingLink = item.workerLinks.find((link) => link.agentId === validatedLink.agentId)
      if (existingLink) {
        existingLink.label = validatedLink.label
        existingLink.specialistId = validatedLink.specialistId
        existingLink.linkedAt = timestamp
      } else {
        item.workerLinks.push({
          type: 'worker',
          linkId: this.createId('link'),
          agentId: validatedLink.agentId,
          ...(validatedLink.label ? { label: validatedLink.label } : {}),
          ...(validatedLink.specialistId ? { specialistId: validatedLink.specialistId } : {}),
          linkedAt: timestamp,
        })
      }

      item.updatedAt = timestamp
      plan.revision += 1
      plan.updatedAt = timestamp
      appendMutationProvenance(plan, {
        action: 'link',
        actorAgentId: actor.agentId,
        mutatedAt: timestamp,
      })
      assertSingleNonTerminalPlan(nextState)
      return nextState
    }, { expectedStateRevision: input.expectedStateRevision })

    return this.toMutationResult('link', mutation, input.planId, { linkedItemId })
  }

  async finishPlan(actor: WorkPlanActorContext, input: WorkPlanFinishInput): Promise<WorkPlanMutationResult> {
    this.assertActorCanAccessSession(actor)

    const mutation = await this.store.update((current) => {
      const nextState = cloneState(current)
      const plan = findWorkPlanRecordById(nextState, input.planId)
      if (!plan) {
        throw new WorkPlanNotFoundError(input.planId)
      }
      if (!NON_TERMINAL_PLAN_STATUSES.has(plan.status as WorkPlanMutableStatus)) {
        throw new WorkPlanImmutableError(plan.planId)
      }

      const timestamp = this.now().toISOString()
      plan.items = closeItemsForTerminalPlan(plan.items, input.status, timestamp)
      plan.status = input.status
      plan.finalSummary = input.finalSummary
      plan.warnings = input.warnings ? [...input.warnings] : [...plan.warnings]
      plan.completedAt = timestamp
      plan.revision += 1
      plan.updatedAt = timestamp
      appendMutationProvenance(plan, {
        action: 'finish_plan',
        actorAgentId: actor.agentId,
        mutatedAt: timestamp,
      })
      return nextState
    }, { expectedStateRevision: input.expectedStateRevision })

    return this.toMutationResult('finish_plan', mutation, input.planId)
  }

  async updateItemStatus(actor: WorkPlanActorContext, input: WorkPlanUpdateItemStatusInput): Promise<WorkPlanMutationResult> {
    this.assertActorCanAccessSession(actor)

    if (!INTERNAL_WORK_PLAN_ITEM_STATUSES.includes(input.status)) {
      throw new WorkPlanServiceValidationError(
        `Work Plan item status must be one of: ${INTERNAL_WORK_PLAN_ITEM_STATUSES.join(', ')}.`,
      )
    }

    let updatedItemId: string | undefined
    const mutation = await this.store.update((current) => {
      const nextState = cloneState(current)
      const plan = findWorkPlanRecordById(nextState, input.planId)
      if (!plan) {
        throw new WorkPlanNotFoundError(input.planId)
      }
      if (!NON_TERMINAL_PLAN_STATUSES.has(plan.status as WorkPlanMutableStatus)) {
        throw new WorkPlanImmutableError(plan.planId)
      }

      const item = plan.items.find((candidate) => candidate.itemId === input.itemId)
      if (!item) {
        throw new WorkPlanItemResolutionError(`Work Plan item not found: ${input.itemId}`)
      }

      const timestamp = this.now().toISOString()
      item.status = input.status
      item.updatedAt = timestamp
      updatedItemId = item.itemId
      plan.revision += 1
      plan.updatedAt = timestamp
      appendMutationProvenance(plan, {
        action: 'update_item_status',
        actorAgentId: actor.agentId,
        mutatedAt: timestamp,
      })
      assertSingleNonTerminalPlan(nextState)
      return nextState
    }, { expectedStateRevision: input.expectedStateRevision })

    return this.toMutationResult('update_item_status', mutation, input.planId, { updatedItemId })
  }

  private buildCreatedPlan(
    input: WorkPlanUpsertInput,
    actor: WorkPlanActorContext,
    timestamp: string,
  ): { plan: WorkPlanRecord; createdItemIds: string[] } {
    if (!input.title || input.title.trim().length === 0) {
      throw new WorkPlanServiceValidationError('Creating a Work Plan requires a title.')
    }

    const builtItems = this.buildItems([], input.items, timestamp)
    const revision = 1
    return {
      plan: {
        planId: this.createId('plan'),
        createdByAgentId: actor.agentId,
        title: input.title,
        ...(input.goal !== undefined ? { goal: input.goal } : {}),
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
        status: input.status ?? 'active',
        createdAt: timestamp,
        updatedAt: timestamp,
        revision,
        items: builtItems.items,
        revisionNotes: input.revisionNote
          ? [{ revision, note: input.revisionNote, createdAt: timestamp }]
          : [],
        warnings: [],
        mutationProvenance: [{ action: 'upsert_plan', actorAgentId: actor.agentId, mutatedAt: timestamp }],
      },
      createdItemIds: builtItems.createdItemIds,
    }
  }

  private buildUpdatedPlan(
    existing: WorkPlanRecord,
    input: WorkPlanUpsertInput,
    actor: WorkPlanActorContext,
    timestamp: string,
  ): { plan: WorkPlanRecord; createdItemIds: string[] } {
    const revision = existing.revision + 1
    const revisionNotes = [...existing.revisionNotes]
    if (input.revisionNote) {
      revisionNotes.push({ revision, note: input.revisionNote, createdAt: timestamp })
      while (revisionNotes.length > MAX_WORK_PLAN_REVISION_NOTES) {
        revisionNotes.shift()
      }
    }

    const builtItems = input.items !== undefined
      ? this.buildItems(existing.items, input.items, timestamp)
      : { items: existing.items, createdItemIds: [] }

    return {
      plan: {
        ...existing,
        title: input.title ?? existing.title,
        goal: input.goal ?? existing.goal,
        mode: input.mode ?? existing.mode,
        status: input.status ?? existing.status,
        updatedAt: timestamp,
        revision,
        items: builtItems.items,
        revisionNotes,
        mutationProvenance: appendMutationProvenanceClone(existing, {
          action: 'upsert_plan',
          actorAgentId: actor.agentId,
          mutatedAt: timestamp,
        }),
      },
      createdItemIds: builtItems.createdItemIds,
    }
  }

  private buildItems(
    existingItems: WorkPlanItem[],
    items: WorkPlanUpsertItemInput[] | undefined,
    timestamp: string,
  ): { items: WorkPlanItem[]; createdItemIds: string[] } {
    if (!items) {
      return { items: existingItems, createdItemIds: [] }
    }

    const existingById = new Map(existingItems.map((item) => [item.itemId, item]))
    const createdItemIds: string[] = []
    const resolvedItems = items.map((itemInput) => {
      const existing = itemInput.itemId ? existingById.get(itemInput.itemId) : undefined
      const itemId = existing?.itemId ?? itemInput.itemId ?? this.createId('item')
      if (!existing) {
        createdItemIds.push(itemId)
      }
      return {
        itemId,
        title: itemInput.title,
        ...(itemInput.phase !== undefined ? { phase: itemInput.phase } : {}),
        status: itemInput.status ?? existing?.status ?? 'todo',
        ...(itemInput.note !== undefined ? { note: itemInput.note } : {}),
        ...(itemInput.blocker !== undefined ? { blocker: itemInput.blocker } : {}),
        ...(itemInput.result !== undefined ? { result: itemInput.result } : {}),
        workerLinks: existing?.workerLinks.map((link) => ({ ...link })) ?? [],
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      } satisfies WorkPlanItem
    })

    const seenItemIds = new Set<string>()
    for (const item of resolvedItems) {
      if (seenItemIds.has(item.itemId)) {
        throw new WorkPlanServiceValidationError(`Duplicate Work Plan item id: ${item.itemId}`)
      }
      seenItemIds.add(item.itemId)
    }

    return { items: resolvedItems, createdItemIds }
  }

  private toMutationResult(
    action: Exclude<WorkPlanServiceAction, 'get'>,
    mutation: SessionCoordinationStoreLoadResult & { previousRevision: number },
    planId: string | undefined,
    extras: { createdItemIds?: string[]; updatedItemId?: string; linkedItemId?: string } = {},
  ): WorkPlanMutationResult {
    if (!planId) {
      throw new WorkPlanServiceValidationError('Expected a mutated Work Plan id.')
    }

    const workPlan = this.requireProjectedPlan(mutation.state, planId)
    const snapshot = projectSnapshot({
      state: mutation.state,
      diagnostics: { state: 'ok' },
      profileId: this.profileId,
      sessionAgentId: this.sessionAgentId,
    })

    return {
      action,
      snapshot,
      stateRevision: mutation.state.revision,
      previousStateRevision: mutation.previousRevision,
      planId,
      planRevision: workPlan.revision,
      workPlan,
      ...(extras.createdItemIds && extras.createdItemIds.length > 0 ? { createdItemIds: extras.createdItemIds } : {}),
      ...(extras.updatedItemId ? { updatedItemId: extras.updatedItemId } : {}),
      ...(extras.linkedItemId ? { linkedItemId: extras.linkedItemId } : {}),
    }
  }

  private requireProjectedPlan(state: SessionCoordinationState, planId: string): WorkPlanSnapshot {
    const plan = findWorkPlanRecordById(state, planId)
    if (!plan) {
      throw new WorkPlanNotFoundError(planId)
    }

    return projectWorkPlanSnapshot(plan)
  }

  private assertActorCanAccessSession(actor: WorkPlanActorContext): void {
    if (actor.role !== 'manager') {
      throw new WorkPlanServiceAuthorizationError('Only manager sessions can access Work Plans.')
    }
    if (!actor.profileId || actor.profileId !== this.profileId) {
      throw new WorkPlanServiceAuthorizationError('Work Plans are scoped to the current profile.')
    }
    if (actor.sessionAgentId !== this.sessionAgentId) {
      throw new WorkPlanServiceAuthorizationError('Work Plans are scoped to the current manager session.')
    }
  }
}

export function toWorkPlanServiceErrorDescriptor(
  error: unknown,
  action?: WorkPlanServiceAction,
): WorkPlanServiceErrorDescriptor {
  if (error instanceof SessionCoordinationStateRevisionConflictError) {
    return {
      action,
      code: 'state_revision_conflict',
      message: REVISION_CONFLICT_MESSAGE,
      actualStateRevision: error.actualRevision,
    }
  }

  if (error instanceof SessionCoordinationStoreUnavailableError) {
    return {
      action,
      code: 'state_unavailable',
      message: error.message,
      diagnosticsState: 'unavailable',
    }
  }

  if (error instanceof WorkPlanLinkValidationError) {
    return {
      action,
      code: 'invalid_link',
      message: error.message,
    }
  }

  if (error instanceof SessionCoordinationStateValidationError) {
    return {
      action,
      code: 'validation_error',
      message: mapSessionCoordinationValidationMessage(error.message),
    }
  }

  if (isCodedWorkPlanError(error)) {
    return {
      action,
      code: error.code,
      message: error.message,
    }
  }

  return {
    action,
    code: 'unknown_error',
    message: GENERIC_UNKNOWN_ERROR_MESSAGE,
  }
}

function isCodedWorkPlanError(error: unknown): error is Error & { code: WorkPlanServiceErrorCode } {
  if (!(error instanceof Error) || !('code' in error) || typeof (error as { code?: unknown }).code !== 'string') {
    return false
  }

  return WORK_PLAN_SERVICE_ERROR_CODES.includes((error as { code: WorkPlanServiceErrorCode }).code)
}

function replaceOrInsertPlan(state: SessionCoordinationState, plan: WorkPlanRecord): void {
  const index = state.workPlans.findIndex((candidate) => candidate.planId === plan.planId)
  if (index >= 0) {
    state.workPlans[index] = plan
    return
  }

  state.workPlans.push(plan)
  pruneTerminalWorkPlanHistoryToCapacity(state, plan.planId)
}

function pruneTerminalWorkPlanHistoryToCapacity(state: SessionCoordinationState, protectedPlanId: string): void {
  while (state.workPlans.length > MAX_WORK_PLANS_PER_SESSION) {
    const pruneIndex = findOldestTerminalWorkPlanIndex(state, protectedPlanId)
    if (pruneIndex < 0) {
      throw new WorkPlanServiceValidationError(WORK_PLAN_HISTORY_CAPACITY_MESSAGE)
    }
    state.workPlans.splice(pruneIndex, 1)
  }
}

function findOldestTerminalWorkPlanIndex(state: SessionCoordinationState, protectedPlanId: string): number {
  let oldestIndex = -1
  let oldestTimestamp = Number.POSITIVE_INFINITY
  let oldestPlanId = ''

  state.workPlans.forEach((plan, index) => {
    if (plan.planId === protectedPlanId || isNonTerminalWorkPlanStatus(plan.status)) {
      return
    }

    const timestamp = parseWorkPlanPruneTimestamp(plan)
    if (
      oldestIndex < 0
      || timestamp < oldestTimestamp
      || (timestamp === oldestTimestamp && plan.planId.localeCompare(oldestPlanId) < 0)
    ) {
      oldestIndex = index
      oldestTimestamp = timestamp
      oldestPlanId = plan.planId
    }
  })

  return oldestIndex
}

function parseWorkPlanPruneTimestamp(plan: WorkPlanRecord): number {
  const parsed = Date.parse(plan.completedAt ?? plan.updatedAt ?? plan.createdAt)
  return Number.isFinite(parsed) ? parsed : 0
}

function isNonTerminalWorkPlanStatus(status: WorkPlanStatus): boolean {
  return NON_TERMINAL_PLAN_STATUSES.has(status as WorkPlanMutableStatus)
}

function mapSessionCoordinationValidationMessage(message: string): string {
  if (message === `workPlans must contain at most ${MAX_WORK_PLANS_PER_SESSION} items`) {
    return WORK_PLAN_HISTORY_CAPACITY_MESSAGE
  }

  return message
}

function resolveItemForLink(plan: WorkPlanRecord, itemId: string | undefined): WorkPlanItem {
  if (itemId) {
    const item = plan.items.find((candidate) => candidate.itemId === itemId)
    if (!item) {
      throw new WorkPlanItemResolutionError(`Work Plan item not found: ${itemId}`)
    }
    return item
  }

  if (plan.items.length === 1) {
    return plan.items[0]!
  }

  throw new WorkPlanItemResolutionError('Linking a worker requires itemId when the Work Plan has multiple items.')
}

function assertSingleNonTerminalPlan(state: SessionCoordinationState): void {
  if (findNonTerminalWorkPlanRecords(state).length > 1) {
    throw new WorkPlanActiveInvariantError()
  }
}

function closeItemsForTerminalPlan(
  items: WorkPlanItem[],
  planStatus: WorkPlanTerminalStatus,
  timestamp: string,
): WorkPlanItem[] {
  return items.map((item) => {
    const nextStatus = resolveTerminalItemStatus(item.status, planStatus)
    if (nextStatus === item.status) {
      return item
    }

    return {
      ...item,
      status: nextStatus,
      updatedAt: timestamp,
    }
  })
}

function resolveTerminalItemStatus(
  itemStatus: WorkPlanItemStatus,
  planStatus: WorkPlanTerminalStatus,
): WorkPlanItemStatus {
  if (planStatus === 'completed') {
    if (itemStatus === 'done' || itemStatus === 'skipped' || itemStatus === 'failed' || itemStatus === 'unknown') {
      return itemStatus
    }
    return 'done'
  }

  if (planStatus === 'completed_with_warnings') {
    if (itemStatus === 'done' || itemStatus === 'skipped' || itemStatus === 'failed' || itemStatus === 'unknown') {
      return itemStatus
    }
    return itemStatus === 'active' ? 'done' : 'skipped'
  }

  return itemStatus
}

function appendMutationProvenance(plan: WorkPlanRecord, entry: WorkPlanRecord['mutationProvenance'][number]): void {
  plan.mutationProvenance = appendMutationProvenanceClone(plan, entry)
}

function appendMutationProvenanceClone(
  plan: WorkPlanRecord,
  entry: WorkPlanRecord['mutationProvenance'][number],
): WorkPlanRecord['mutationProvenance'] {
  return [...plan.mutationProvenance, entry].slice(-MAX_WORK_PLAN_MUTATION_PROVENANCE)
}

function cloneState(state: SessionCoordinationState): SessionCoordinationState {
  return {
    ...createEmptySessionCoordinationState(),
    revision: state.revision,
    updatedAt: state.updatedAt,
    workPlans: state.workPlans.map((plan) => ({
      ...plan,
      items: plan.items.map((item) => ({
        ...item,
        ...(item.blocker ? { blocker: { ...item.blocker } } : {}),
        ...(item.result ? { result: { ...item.result } } : {}),
        workerLinks: item.workerLinks.map((link) => ({ ...link })),
      })),
      revisionNotes: plan.revisionNotes.map((note) => ({ ...note })),
      warnings: [...plan.warnings],
      ...(plan.lifecycle ? { lifecycle: { ...plan.lifecycle } } : {}),
      mutationProvenance: plan.mutationProvenance.map((entry) => ({ ...entry })),
    })),
  }
}

function projectSnapshot(params: {
  state: SessionCoordinationState
  diagnostics: { state: SessionTaskDiagnosticState; message?: string }
  profileId: string
  sessionAgentId: string
}): SessionTaskStateSnapshot {
  return projectSessionTaskStateSnapshot({
    state: params.state,
    diagnostics: params.diagnostics,
    profileId: params.profileId,
    sessionAgentId: params.sessionAgentId,
  })
}

export { WorkPlanLinkValidationError }
