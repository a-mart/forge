import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { PlanStep, TokenUsageTotals } from '@forge/protocol'
import { appendJsonl } from '../../utils/atomic-files.js'
import { isRecord } from '../../stats/stats-shared.js'
import { getSessionPlanUsagePath } from '../storage/data-paths.js'
import {
  scanManagerTokenUsage,
  scanWorkerTokenUsage,
  type TokenUsageEvent as UsageEvent,
  type TokenUsageScanResult as UsageScanResult,
  type WorkerTokenUsageEvent as WorkerUsageEvent,
} from '../session/session-token-usage.js'
import type { AcceptedDeliveryMode } from '../types.js'
import type { SessionPlanState } from './session-plan-state.js'

const PLAN_USAGE_VERSION = 1
const planUsageLocks = new Map<string, Promise<void>>()

export type PlanUsageCoverage = 'complete' | 'estimated' | 'partial' | 'unknown'
export type PlanUsageCoverageReason =
  | 'recovered_run'
  | 'recovered_completion'
  | 'delayed_completion'
  | 'missing_timestamps'
  | 'unassigned_worker_usage'
  | 'busy_assignment_boundary'

export interface PlanStepAssignment {
  planRunId: string
  stepKey: string
  step: string
}

interface PlanUsageBaseRecord {
  version: typeof PLAN_USAGE_VERSION
  type: string
  planRunId: string
  recordedAt: string
}

interface PlanStartedRecord extends PlanUsageBaseRecord {
  type: 'plan_started'
  sessionAgentId: string
  profileId: string
  planRevision: number
  startedAt: string
  recovered: boolean
  steps: Array<{ stepKey: string; step: string }>
}

interface WorkerAssignedRecord extends PlanUsageBaseRecord {
  type: 'worker_assigned'
  workerId: string
  stepKey: string
  step: string
  assignedAt: string
  source: 'spawn_agent' | 'send_message_to_agent'
  deliveryId?: string
  acceptedMode?: AcceptedDeliveryMode
}

interface StepCompletedRecord extends PlanUsageBaseRecord {
  type: 'step_completed'
  planRevision: number
  stepKey: string
  step: string
  startedAt: string
  completedAt: string
  usage: TokenUsageTotals
  workers: WorkerUsageBreakdown[]
  coverage: PlanUsageCoverage
  coverageReasons: PlanUsageCoverageReason[]
}

interface PlanCompletionRequestedRecord extends PlanUsageBaseRecord {
  type: 'plan_completion_requested'
  planRevision: number
  completedAt: string
  steps: Array<{ stepKey: string; step: string }>
}

interface PlanCompletedRecord extends PlanUsageBaseRecord {
  type: 'plan_completed'
  planRevision: number
  startedAt: string
  completedAt: string
  accountedThrough: string
  managerUsage: TokenUsageTotals
  workerUsage: TokenUsageTotals
  totalUsage: TokenUsageTotals
  steps: StepUsageBreakdown[]
  unassignedWorkerUsage: TokenUsageTotals
  unassignedWorkers: WorkerUsageBreakdown[]
  coverage: PlanUsageCoverage
  coverageReasons: PlanUsageCoverageReason[]
}

interface PlanAbandonedRecord extends PlanUsageBaseRecord {
  type: 'plan_abandoned'
  abandonedAt: string
  planRevision: number
}

type PlanUsageRecord =
  | PlanStartedRecord
  | WorkerAssignedRecord
  | StepCompletedRecord
  | PlanCompletionRequestedRecord
  | PlanCompletedRecord
  | PlanAbandonedRecord

interface WorkerUsageBreakdown {
  workerId: string
  usage: TokenUsageTotals
}

interface StepUsageBreakdown {
  stepKey: string
  step: string
  usage: TokenUsageTotals
  workers: WorkerUsageBreakdown[]
}

export class SessionPlanUsageTracker {
  readonly filePath: string

  constructor(private readonly options: {
    dataDir: string
    profileId: string
    sessionAgentId: string
    now?: () => string
    randomId?: () => string
    appendRecord?: typeof appendJsonl
  }) {
    this.filePath = getSessionPlanUsagePath(
      options.dataDir,
      options.profileId,
      options.sessionAgentId,
    )
  }

  async recordPlanTransition(
    outgoing: SessionPlanState,
    snapshot: SessionPlanState,
  ): Promise<void> {
    await withPlanUsageLock(this.filePath, async () => {
      const records = await this.readRecords()
      let run = findOpenRun(records)
      const now = this.now()

      if (run && findCompletionRequest(records, run.planRunId) && plansDiffer(outgoing.plan, snapshot.plan)) {
        const completion = findCompletionRequest(records, run.planRunId)!
        const completed = await this.appendPlanCompleted(records, run, {
          accountedThrough: completion.completedAt,
          uncertainCompletionReason: 'delayed_completion',
        })
        if (completed) records.push(completed)
        run = undefined
      }

      if (!run && outgoing.plan.length > 0 && !isCompletePlan(outgoing.plan)) {
        run = await this.appendPlanStarted(records, outgoing, true)
      }

      if (!run && snapshot.plan.length > 0) {
        run = await this.appendPlanStarted(records, snapshot, false)
      }

      if (!run) return

      if (snapshot.plan.length === 0) {
        await this.append({
          version: PLAN_USAGE_VERSION,
          type: 'plan_abandoned',
          planRunId: run.planRunId,
          recordedAt: now,
          abandonedAt: now,
          planRevision: snapshot.revision,
        } satisfies PlanAbandonedRecord)
        return
      }

      const completedStepKeys = new Set(
        records
          .filter((record): record is StepCompletedRecord => (
            record.type === 'step_completed' && record.planRunId === run.planRunId
          ))
          .map((record) => record.stepKey),
      )

      for (const step of snapshot.plan) {
        if (step.status !== 'completed') continue
        const stepKey = createStepKey(run.planRunId, step.step)
        const outgoingStep = outgoing.plan.find((candidate) => candidate.step === step.step)
        if (outgoingStep?.status === 'completed' || completedStepKeys.has(stepKey)) continue

        const receipt = await this.buildStepCompletedReceipt(
          records,
          run,
          snapshot.revision,
          step,
          snapshot.updatedAt ?? now,
        )
        await this.append(receipt)
        records.push(receipt)
      }

      if (
        isCompletePlan(snapshot.plan)
        && !findCompletionRequest(records, run.planRunId)
      ) {
        const completion: PlanCompletionRequestedRecord = {
          version: PLAN_USAGE_VERSION,
          type: 'plan_completion_requested',
          planRunId: run.planRunId,
          recordedAt: now,
          planRevision: snapshot.revision,
          completedAt: snapshot.updatedAt ?? now,
          steps: snapshot.plan.map((step) => ({
            stepKey: createStepKey(run.planRunId, step.step),
            step: step.step,
          })),
        }
        await this.append(completion)
      }
    })
  }

  async resolveAssignment(
    state: SessionPlanState,
    requestedStep: string,
  ): Promise<PlanStepAssignment> {
    const stepText = requestedStep.trim()
    if (!stepText) throw new Error('planStep must be non-empty when provided.')

    const matches = state.plan.filter((step) => step.step === stepText)
    if (matches.length === 0) {
      throw new Error(`planStep must exactly match a current plan step: "${stepText}".`)
    }
    if (matches.length > 1) {
      throw new Error(`planStep is ambiguous because the current plan contains duplicate text: "${stepText}".`)
    }
    if (matches[0]?.status === 'completed') {
      throw new Error(`planStep cannot reference a completed plan step: "${stepText}".`)
    }

    return withPlanUsageLock(this.filePath, async () => {
      const records = await this.readRecords()
      let run = findOpenRun(records)
      if (!run) {
        run = await this.appendPlanStarted(records, state, true)
      }
      if (findCompletionRequest(records, run.planRunId)) {
        throw new Error('planStep cannot be assigned after the current plan has completed.')
      }
      return {
        planRunId: run.planRunId,
        stepKey: createStepKey(run.planRunId, stepText),
        step: stepText,
      }
    })
  }

  async recordWorkerAssignment(input: PlanStepAssignment & {
    workerId: string
    source: WorkerAssignedRecord['source']
    deliveryId?: string
    acceptedMode?: AcceptedDeliveryMode
  }): Promise<void> {
    await withPlanUsageLock(this.filePath, async () => {
      const records = await this.readRecords()
      const run = findOpenRun(records)
      if (!run || run.planRunId !== input.planRunId || findCompletionRequest(records, input.planRunId)) {
        throw new Error('The plan changed before the worker assignment could be recorded.')
      }
      const assignedAt = this.now()
      await this.append({
        version: PLAN_USAGE_VERSION,
        type: 'worker_assigned',
        planRunId: input.planRunId,
        recordedAt: assignedAt,
        workerId: input.workerId,
        stepKey: input.stepKey,
        step: input.step,
        assignedAt,
        source: input.source,
        ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
        ...(input.acceptedMode ? { acceptedMode: input.acceptedMode } : {}),
      } satisfies WorkerAssignedRecord)
    })
  }

  async finalizePendingPlan(options: { recovered?: boolean } = {}): Promise<void> {
    await withPlanUsageLock(this.filePath, async () => {
      const records = await this.readRecords()
      const run = findOpenRun(records)
      if (!run || !findCompletionRequest(records, run.planRunId)) return
      const completion = findCompletionRequest(records, run.planRunId)!
      await this.appendPlanCompleted(records, run, {
        accountedThrough: options.recovered === true ? completion.completedAt : this.now(),
        ...(options.recovered === true
          ? { uncertainCompletionReason: 'recovered_completion' as const }
          : {}),
      })
    })
  }

  private async appendPlanStarted(
    records: PlanUsageRecord[],
    state: SessionPlanState,
    recovered: boolean,
  ): Promise<PlanStartedRecord> {
    const planRunId = (this.options.randomId ?? randomUUID)()
    const recordedAt = this.now()
    const startedAt = state.updatedAt ?? recordedAt
    const record: PlanStartedRecord = {
      version: PLAN_USAGE_VERSION,
      type: 'plan_started',
      planRunId,
      recordedAt,
      sessionAgentId: this.options.sessionAgentId,
      profileId: this.options.profileId,
      planRevision: state.revision,
      startedAt,
      recovered,
      steps: state.plan.map((step) => ({
        stepKey: createStepKey(planRunId, step.step),
        step: step.step,
      })),
    }
    await this.append(record)
    records.push(record)
    return record
  }

  private async buildStepCompletedReceipt(
    records: PlanUsageRecord[],
    run: PlanStartedRecord,
    planRevision: number,
    step: PlanStep,
    completedAt: string,
  ): Promise<StepCompletedRecord> {
    const stepKey = createStepKey(run.planRunId, step.step)
    const assignments = workerAssignments(records, run.planRunId)
    const scan = await this.scanWorkerUsage(run.startedAt, completedAt)
    const knownStepKeys = new Set(assignments.map((assignment) => assignment.stepKey))
    const attribution = attributeWorkerUsage(scan.events, assignments, knownStepKeys)
    const stepUsage = attribution.byStep.get(stepKey) ?? emptyStepUsage(stepKey, step.step)
    const stepAssignments = assignments.filter((assignment) => assignment.stepKey === stepKey)
    const firstAssignmentAt = assignments
      .filter((assignment) => assignment.stepKey === stepKey)
      .map((assignment) => assignment.assignedAt)
      .sort()[0]

    const coverage = resolveCoverage({
      recovered: run.recovered,
      missingTimestampCount: scan.missingTimestampCount,
      unassignedUsage: emptyUsage(),
      assignments: stepAssignments,
    })
    return {
      version: PLAN_USAGE_VERSION,
      type: 'step_completed',
      planRunId: run.planRunId,
      recordedAt: this.now(),
      planRevision,
      stepKey,
      step: step.step,
      startedAt: firstAssignmentAt ?? run.startedAt,
      completedAt,
      usage: stepUsage.usage,
      workers: stepUsage.workers,
      coverage: coverage.coverage,
      coverageReasons: coverage.reasons,
    }
  }

  private async appendPlanCompleted(
    records: PlanUsageRecord[],
    run: PlanStartedRecord,
    options: {
      accountedThrough: string
      uncertainCompletionReason?: 'recovered_completion' | 'delayed_completion'
    },
  ): Promise<PlanCompletedRecord | undefined> {
    const completion = findCompletionRequest(records, run.planRunId)
    if (!completion) return undefined

    const assignments = workerAssignments(records, run.planRunId)
    const managerScan = await this.scanManagerUsage(run.startedAt, options.accountedThrough)
    const workerScan = await this.scanWorkerUsage(run.startedAt, options.accountedThrough)
    const allowedSteps = new Set(completion.steps.map((step) => step.stepKey))
    const attribution = attributeWorkerUsage(workerScan.events, assignments, allowedSteps)
    const workerUsage = sumUsage(workerScan.events.map((event) => event.usage))
    const managerUsage = sumUsage(managerScan.events.map((event) => event.usage))
    const stepMeta = new Map(completion.steps.map((step) => [step.stepKey, step.step]))
    const steps = completion.steps.map(({ stepKey, step }) => (
      attribution.byStep.get(stepKey) ?? emptyStepUsage(stepKey, step)
    ))
    for (const [stepKey, usage] of attribution.byStep) {
      if (!stepMeta.has(stepKey)) continue
      usage.step = stepMeta.get(stepKey) ?? usage.step
    }

    const coverage = resolveCoverage({
      recovered: run.recovered,
      uncertainCompletionReason: options.uncertainCompletionReason,
      missingTimestampCount:
        managerScan.missingTimestampCount + workerScan.missingTimestampCount,
      unassignedUsage: attribution.unassigned,
      assignments,
    })
    const record: PlanCompletedRecord = {
      version: PLAN_USAGE_VERSION,
      type: 'plan_completed',
      planRunId: run.planRunId,
      recordedAt: this.now(),
      planRevision: completion.planRevision,
      startedAt: run.startedAt,
      completedAt: completion.completedAt,
      accountedThrough: options.accountedThrough,
      managerUsage,
      workerUsage,
      totalUsage: addUsage(managerUsage, workerUsage),
      steps,
      unassignedWorkerUsage: attribution.unassigned,
      unassignedWorkers: attribution.unassignedWorkers,
      coverage: coverage.coverage,
      coverageReasons: coverage.reasons,
    }
    await this.append(record)
    return record
  }

  private async scanManagerUsage(startAt: string, endAt: string): Promise<UsageScanResult<UsageEvent>> {
    return scanManagerTokenUsage({
      dataDir: this.options.dataDir,
      profileId: this.options.profileId,
      sessionAgentId: this.options.sessionAgentId,
      startAt,
      endAt,
    })
  }

  private async scanWorkerUsage(startAt: string, endAt: string): Promise<UsageScanResult<WorkerUsageEvent>> {
    return scanWorkerTokenUsage({
      dataDir: this.options.dataDir,
      profileId: this.options.profileId,
      sessionAgentId: this.options.sessionAgentId,
      startAt,
      endAt,
    })
  }

  private async readRecords(): Promise<PlanUsageRecord[]> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return []
      throw error
    }

    const records: PlanUsageRecord[] = []
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as unknown
        if (isPlanUsageRecord(parsed)) records.push(parsed)
      } catch {
        // Keep append-only accounting usable when a single historical line is malformed.
      }
    }
    return records
  }

  private async append(record: PlanUsageRecord): Promise<void> {
    await (this.options.appendRecord ?? appendJsonl)(this.filePath, record)
  }

  private now(): string {
    return (this.options.now ?? (() => new Date().toISOString()))()
  }

}

function attributeWorkerUsage(
  events: WorkerUsageEvent[],
  assignments: WorkerAssignedRecord[],
  allowedStepKeys: Set<string>,
): {
  byStep: Map<string, StepUsageBreakdown>
  unassigned: TokenUsageTotals
  unassignedWorkers: WorkerUsageBreakdown[]
} {
  const byWorker = new Map<string, WorkerAssignedRecord[]>()
  for (const assignment of assignments) {
    const current = byWorker.get(assignment.workerId) ?? []
    current.push(assignment)
    byWorker.set(assignment.workerId, current)
  }
  for (const workerAssignments of byWorker.values()) {
    workerAssignments.sort((left, right) => Date.parse(left.assignedAt) - Date.parse(right.assignedAt))
  }

  const byStepWorker = new Map<string, Map<string, TokenUsageTotals>>()
  const unassignedByWorker = new Map<string, TokenUsageTotals>()
  const unassigned = emptyUsage()
  for (const event of events) {
    const workerAssignments = byWorker.get(event.workerId) ?? []
    const assignment = findAssignmentAt(workerAssignments, event.timestampMs)
    if (!assignment || !allowedStepKeys.has(assignment.stepKey)) {
      mergeUsage(unassigned, event.usage)
      const workerUsage = unassignedByWorker.get(event.workerId) ?? emptyUsage()
      mergeUsage(workerUsage, event.usage)
      unassignedByWorker.set(event.workerId, workerUsage)
      continue
    }
    const workers = byStepWorker.get(assignment.stepKey) ?? new Map<string, TokenUsageTotals>()
    const usage = workers.get(event.workerId) ?? emptyUsage()
    mergeUsage(usage, event.usage)
    workers.set(event.workerId, usage)
    byStepWorker.set(assignment.stepKey, workers)
  }

  const stepTextByKey = new Map(assignments.map((assignment) => [assignment.stepKey, assignment.step]))
  const byStep = new Map<string, StepUsageBreakdown>()
  for (const [stepKey, workers] of byStepWorker) {
    const workerBreakdown = Array.from(workers, ([workerId, usage]) => ({ workerId, usage }))
    byStep.set(stepKey, {
      stepKey,
      step: stepTextByKey.get(stepKey) ?? stepKey,
      usage: sumUsage(workerBreakdown.map((worker) => worker.usage)),
      workers: workerBreakdown,
    })
  }
  return {
    byStep,
    unassigned,
    unassignedWorkers: Array.from(
      unassignedByWorker,
      ([workerId, usage]) => ({ workerId, usage }),
    ),
  }
}

function findAssignmentAt(
  assignments: WorkerAssignedRecord[],
  timestampMs: number,
): WorkerAssignedRecord | undefined {
  let match: WorkerAssignedRecord | undefined
  for (const assignment of assignments) {
    if (Date.parse(assignment.assignedAt) > timestampMs) break
    match = assignment
  }
  return match
}

function resolveCoverage(input: {
  recovered: boolean
  uncertainCompletionReason?: 'recovered_completion' | 'delayed_completion'
  missingTimestampCount: number
  unassignedUsage: TokenUsageTotals
  assignments: WorkerAssignedRecord[]
}): { coverage: PlanUsageCoverage; reasons: PlanUsageCoverageReason[] } {
  const reasons: PlanUsageCoverageReason[] = []
  if (input.recovered) reasons.push('recovered_run')
  if (input.uncertainCompletionReason) reasons.push(input.uncertainCompletionReason)
  if (input.missingTimestampCount > 0) reasons.push('missing_timestamps')
  if (input.unassignedUsage.total > 0) reasons.push('unassigned_worker_usage')
  if (hasBusyAssignmentBoundary(input.assignments)) {
    reasons.push('busy_assignment_boundary')
  }
  if (reasons.some((reason) => reason !== 'busy_assignment_boundary')) {
    return { coverage: 'partial', reasons }
  }
  if (reasons.length > 0) return { coverage: 'estimated', reasons }
  return { coverage: 'complete', reasons }
}

function hasBusyAssignmentBoundary(assignments: WorkerAssignedRecord[]): boolean {
  const byWorker = new Map<string, WorkerAssignedRecord[]>()
  for (const assignment of assignments) {
    const current = byWorker.get(assignment.workerId) ?? []
    current.push(assignment)
    byWorker.set(assignment.workerId, current)
  }
  for (const workerAssignments of byWorker.values()) {
    workerAssignments.sort((left, right) => Date.parse(left.assignedAt) - Date.parse(right.assignedAt))
    let previousStepKey: string | undefined
    for (const assignment of workerAssignments) {
      if (
        assignment.acceptedMode !== undefined
        && assignment.acceptedMode !== 'prompt'
        && assignment.stepKey !== previousStepKey
      ) {
        return true
      }
      previousStepKey = assignment.stepKey
    }
  }
  return false
}

function workerAssignments(records: PlanUsageRecord[], planRunId: string): WorkerAssignedRecord[] {
  return records.filter((record): record is WorkerAssignedRecord => (
    record.type === 'worker_assigned' && record.planRunId === planRunId
  ))
}

function findOpenRun(records: PlanUsageRecord[]): PlanStartedRecord | undefined {
  const closed = new Set(
    records
      .filter((record) => record.type === 'plan_completed' || record.type === 'plan_abandoned')
      .map((record) => record.planRunId),
  )
  return records
    .filter((record): record is PlanStartedRecord => record.type === 'plan_started')
    .reverse()
    .find((record) => !closed.has(record.planRunId))
}

function findCompletionRequest(
  records: PlanUsageRecord[],
  planRunId: string,
): PlanCompletionRequestedRecord | undefined {
  return records.find((record): record is PlanCompletionRequestedRecord => (
    record.type === 'plan_completion_requested' && record.planRunId === planRunId
  ))
}

function createStepKey(planRunId: string, step: string): string {
  return createHash('sha256').update(`${planRunId}\0${step}`).digest('hex').slice(0, 16)
}

function isCompletePlan(plan: readonly PlanStep[]): boolean {
  return plan.length > 0 && plan.every((step) => step.status === 'completed')
}

function plansDiffer(left: readonly PlanStep[], right: readonly PlanStep[]): boolean {
  if (left.length !== right.length) return true
  return left.some((step, index) => {
    const other = right[index]
    return !other || step.step !== other.step || step.status !== other.status
  })
}

function emptyStepUsage(stepKey: string, step: string): StepUsageBreakdown {
  return { stepKey, step, usage: emptyUsage(), workers: [] }
}

function emptyUsage(): TokenUsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

function addUsage(left: TokenUsageTotals, right: TokenUsageTotals): TokenUsageTotals {
  const result = { ...left }
  mergeUsage(result, right)
  return result
}

function sumUsage(values: TokenUsageTotals[]): TokenUsageTotals {
  const result = emptyUsage()
  for (const value of values) mergeUsage(result, value)
  return result
}

function mergeUsage(target: TokenUsageTotals, source: TokenUsageTotals): void {
  target.input += source.input
  target.output += source.output
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
  target.total += source.total
}

function isPlanUsageRecord(value: unknown): value is PlanUsageRecord {
  return isRecord(value)
    && value.version === PLAN_USAGE_VERSION
    && typeof value.type === 'string'
    && typeof value.planRunId === 'string'
    && typeof value.recordedAt === 'string'
}

async function withPlanUsageLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = planUsageLocks.get(key) ?? Promise.resolve()
  let release: (() => void) | undefined
  const current = new Promise<void>((resolveCurrent) => { release = resolveCurrent })
  const queued = previous.catch(() => {}).then(() => current)
  planUsageLocks.set(key, queued)
  await previous.catch(() => {})
  try {
    return await operation()
  } finally {
    release?.()
    if (planUsageLocks.get(key) === queued) planUsageLocks.delete(key)
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: string }).code === code
}
