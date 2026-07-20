import { createHash, randomUUID } from 'node:crypto'
import {
  WORK_GRAPH_ATTEMPT_STATUSES,
  WORK_GRAPH_EFFORTS,
  WORK_GRAPH_NODE_KINDS,
  WORK_GRAPH_NODE_STATUSES,
  type PlanStep,
  type WorkGraphAttempt,
  type WorkGraphEffort,
  type WorkGraphNode,
  type WorkGraphNodeKind,
  type WorkGraphNodeStatus,
  type WorkGraphSnapshot,
} from '@forge/protocol'

export const MAX_WORK_GRAPH_NODES = 32
export const MAX_WORK_GRAPH_CONCURRENCY = 8
export const DEFAULT_WORK_GRAPH_CONCURRENCY = 4
export const MAX_WORK_GRAPH_ID_LENGTH = 64
export const MAX_WORK_GRAPH_TITLE_LENGTH = 160
export const MAX_WORK_GRAPH_TASK_LENGTH = 4_000
export const MAX_WORK_GRAPH_ACCEPTANCE_LENGTH = 1_000
export const MAX_WORK_GRAPH_RESULT_SUMMARY_LENGTH = 1_000
export const MAX_WORK_GRAPH_DEPENDENCY_CONTEXT_LENGTH = 6_000

export interface WorkGraphNodeInput {
  id: string
  title: string
  task: string
  kind?: WorkGraphNodeKind
  status: WorkGraphNodeStatus
  dependsOn?: string[]
  acceptanceCriteria?: string
  effort?: WorkGraphEffort
}

export interface UpdateWorkGraphInput {
  explanation?: string
  maxConcurrency?: number
  nodes: WorkGraphNodeInput[]
}

export interface WorkGraphDispatchClaim {
  nodeId: string
  attemptId: string
  agentId: string
  title: string
  task: string
  acceptanceCriteria?: string
  dependencyContext?: string
  behaviorMode: WorkGraphAttempt['behaviorMode']
  executionPolicy: WorkGraphAttempt['executionPolicy']
}

export class WorkGraphValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkGraphValidationError'
  }
}

export function normalizePersistedWorkGraphSnapshot(value: unknown): WorkGraphSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkGraphValidationError('workGraph must be an object.')
  }
  const raw = value as { maxConcurrency?: unknown; nodes?: unknown }
  if (!Array.isArray(raw.nodes)) {
    throw new WorkGraphValidationError('workGraph.nodes must be an array.')
  }
  const attemptsById = new Map<string, WorkGraphAttempt[]>()
  const currentNodes = raw.nodes.map((node, index) => {
    const record = node && typeof node === 'object' && !Array.isArray(node)
      ? node as Record<string, unknown>
      : {}
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    const attempts = normalizeAttempts(record.attempts, index)
    attemptsById.set(id, attempts)
    return {
      id,
      status: record.status,
      attempts,
    } as unknown as WorkGraphNode
  })
  const normalized = normalizeWorkGraphInput(
    value,
    {
      maxConcurrency: typeof raw.maxConcurrency === 'number'
        ? raw.maxConcurrency
        : DEFAULT_WORK_GRAPH_CONCURRENCY,
      nodes: currentNodes,
    },
    { enforceRunningNodeImmutability: false },
  )
  const graph = {
    ...normalized,
    nodes: normalized.nodes.map((node) => ({
      ...node,
      attempts: attemptsById.get(node.id) ?? [],
    })),
  }
  for (const [index, node] of graph.nodes.entries()) {
    const attempt = currentAttempt(node)
    if (
      node.status === 'running'
      && attempt?.status !== 'running'
      && attempt?.status !== 'dispatching'
    ) {
      throw new WorkGraphValidationError(
        `workGraph.nodes[${index}] is running without an active attempt.`,
      )
    }
    if (node.status === 'awaiting_review' && attempt?.status !== 'succeeded') {
      throw new WorkGraphValidationError(
        `workGraph.nodes[${index}] awaits review without a succeeded attempt.`,
      )
    }
  }
  return graph
}

export function normalizeWorkGraphInput(
  value: unknown,
  current?: WorkGraphSnapshot,
  options: { enforceRunningNodeImmutability?: boolean } = {},
): { maxConcurrency: number; nodes: WorkGraphNode[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkGraphValidationError('update_work_graph input must be an object.')
  }
  const input = value as { maxConcurrency?: unknown; nodes?: unknown }
  const maxConcurrency = input.maxConcurrency === undefined
    ? current?.maxConcurrency ?? DEFAULT_WORK_GRAPH_CONCURRENCY
    : normalizeInteger(
        input.maxConcurrency,
        'maxConcurrency',
        1,
        MAX_WORK_GRAPH_CONCURRENCY,
      )
  if (!Array.isArray(input.nodes)) {
    throw new WorkGraphValidationError('nodes must be an array.')
  }
  if (input.nodes.length === 0) {
    throw new WorkGraphValidationError('nodes must contain at least one node.')
  }
  if (input.nodes.length > MAX_WORK_GRAPH_NODES) {
    throw new WorkGraphValidationError(
      `nodes must contain at most ${MAX_WORK_GRAPH_NODES} nodes.`,
    )
  }

  const currentById = new Map(current?.nodes.map((node) => [node.id, node]) ?? [])
  const nodes = input.nodes.map((node, index) => normalizeNode(
    node,
    index,
    currentById.get(
      typeof node === 'object' && node !== null && !Array.isArray(node)
        ? String((node as { id?: unknown }).id ?? '').trim()
        : '',
    ),
    options.enforceRunningNodeImmutability !== false,
  ))
  validateGraph(nodes)
  return { maxConcurrency, nodes }
}

export function projectWorkGraphPlan(graph: WorkGraphSnapshot): PlanStep[] {
  return graph.nodes
    .filter((node) => node.status !== 'cancelled')
    .map((node) => ({
      step: node.title,
      status: node.status === 'completed'
        ? 'completed'
        : node.status === 'running' || node.status === 'awaiting_review'
          ? 'in_progress'
          : 'pending',
    }))
}

export function findRunningWorkersToCancel(
  current: WorkGraphSnapshot | undefined,
  next: WorkGraphSnapshot,
): string[] {
  if (!current) return []
  const nextById = new Map(next.nodes.map((node) => [node.id, node]))
  const workerIds = new Set<string>()
  for (const currentNode of current.nodes) {
    if (currentNode.status !== 'running') continue
    const nextNode = nextById.get(currentNode.id)
    if (nextNode?.status === 'running') continue
    const workerId = currentAttempt(currentNode)?.workerId
    if (workerId) workerIds.add(workerId)
  }
  return Array.from(workerIds)
}

export function claimReadyWorkGraphNodes(
  graph: WorkGraphSnapshot,
  options: {
    now: () => string
    randomId?: () => string
  },
): { graph: WorkGraphSnapshot; claims: WorkGraphDispatchClaim[] } {
  const completed = new Set(
    graph.nodes.filter((node) => node.status === 'completed').map((node) => node.id),
  )
  const runningCount = graph.nodes.filter((node) => node.status === 'running').length
  const available = Math.max(0, graph.maxConcurrency - runningCount)
  if (available === 0) return { graph, claims: [] }

  const ready = graph.nodes.filter((node) => (
    node.status === 'pending'
    && node.kind !== 'decision'
    && node.dependsOn.every((dependency) => completed.has(dependency))
  )).slice(0, available)
  if (ready.length === 0) return { graph, claims: [] }

  const readyIds = new Set(ready.map((node) => node.id))
  const claims: WorkGraphDispatchClaim[] = []
  const now = options.now()
  const nodes = graph.nodes.map((node) => {
    if (!readyIds.has(node.id)) return node
    const route = resolveWorkGraphRoute(node)
    const attemptId = (options.randomId ?? randomUUID)()
    const attempt: WorkGraphAttempt = {
      id: attemptId,
      number: node.attempts.length + 1,
      status: 'dispatching',
      startedAt: now,
      behaviorMode: route.behaviorMode,
      executionPolicy: route.executionPolicy,
    }
    claims.push({
      nodeId: node.id,
      attemptId,
      agentId: graphWorkerAgentId(node.id, attempt.number),
      title: node.title,
      task: node.task,
      ...(node.acceptanceCriteria ? { acceptanceCriteria: node.acceptanceCriteria } : {}),
      ...buildDependencyContext(node, graph),
      ...route,
    })
    return { ...node, status: 'running' as const, attempts: [...node.attempts, attempt] }
  })
  return { graph: { ...graph, nodes }, claims }
}

function buildDependencyContext(
  node: WorkGraphNode,
  graph: WorkGraphSnapshot,
): Pick<WorkGraphDispatchClaim, 'dependencyContext'> {
  if (node.dependsOn.length === 0) return {}
  const dependencies = node.dependsOn
    .map((dependencyId) => graph.nodes.find((candidate) => candidate.id === dependencyId))
    .filter((dependency): dependency is WorkGraphNode => Boolean(dependency))
  if (dependencies.length === 0) return {}

  const labels = dependencies.map((dependency) => (
    `[${dependency.id}: ${truncateWithEllipsis(dependency.title, 48)}]`
  ))
  const separatorLength = Math.max(0, dependencies.length - 1) * 2
  const fixedLength = labels.reduce((total, label) => total + label.length + 1, 0)
  const perDependencyLimit = Math.min(
    MAX_WORK_GRAPH_RESULT_SUMMARY_LENGTH,
    Math.max(
      0,
      Math.floor(
        (MAX_WORK_GRAPH_DEPENDENCY_CONTEXT_LENGTH - separatorLength - fixedLength)
          / dependencies.length,
      ),
    ),
  )
  const dependencyContext = dependencies.map((dependency, index) => {
    const summary = currentAttempt(dependency)?.summary?.trim()
      || 'Accepted by the manager without a worker result summary.'
    return [
      labels[index],
      truncateWithEllipsis(summary, perDependencyLimit),
    ].join('\n')
  }).join('\n\n')

  return { dependencyContext }
}

export function recordWorkGraphWorkerStarted(
  graph: WorkGraphSnapshot,
  nodeId: string,
  attemptId: string,
  workerId: string,
): WorkGraphSnapshot {
  return updateAttempt(graph, nodeId, attemptId, (node, attempt) => ({
    ...node,
    status: 'running',
    attempts: replaceAttempt(node.attempts, attemptId, {
      ...attempt,
      status: 'running',
      workerId,
    }),
  }))
}

export function recordWorkGraphDispatchFailure(
  graph: WorkGraphSnapshot,
  nodeId: string,
  attemptId: string,
  error: unknown,
  now: () => string,
): WorkGraphSnapshot {
  const summary = truncateSummary(error instanceof Error ? error.message : String(error))
  return updateAttempt(graph, nodeId, attemptId, (node, attempt) => ({
    ...node,
    status: 'blocked',
    attempts: replaceAttempt(node.attempts, attemptId, {
      ...attempt,
      status: 'blocked',
      completedAt: now(),
      summary,
    }),
  }))
}

export function recordWorkGraphWorkerResult(
  graph: WorkGraphSnapshot,
  workerId: string,
  resultText: string,
  now: () => string,
): { graph: WorkGraphSnapshot; nodeId?: string } {
  const node = graph.nodes.find((candidate) => (
    candidate.status === 'running'
    && currentAttempt(candidate)?.workerId === workerId
  ))
  if (!node) return { graph }
  const attempt = currentAttempt(node)!
  const succeeded = /^status:\s*done(?:\s|$)/i.test(resultText.trim())
  const summary = truncateSummary(resultText)
  return {
    nodeId: node.id,
    graph: updateAttempt(graph, node.id, attempt.id, (current, currentRun) => ({
      ...current,
      status: succeeded ? 'awaiting_review' : 'blocked',
      attempts: replaceAttempt(current.attempts, attempt.id, {
        ...currentRun,
        status: succeeded ? 'succeeded' : 'blocked',
        completedAt: now(),
        summary,
      }),
    })),
  }
}

export function recoverInterruptedWorkGraphDispatches(
  graph: WorkGraphSnapshot,
  now: () => string,
  options?: {
    isWorkerActive?: (workerId: string) => boolean
  },
): { graph: WorkGraphSnapshot; changed: boolean } {
  let changed = false
  const nodes = graph.nodes.map((node) => {
    if (node.status !== 'running') return node
    const attempt = currentAttempt(node)
    if (!attempt) return node
    const workerId = attempt.workerId
    const interruptedBeforeDispatch = attempt.status === 'dispatching' && !attempt.workerId
    const interruptedAfterDispatch = attempt.status === 'running'
      && workerId !== undefined
      && options?.isWorkerActive !== undefined
      && !options.isWorkerActive(workerId)
    if (!interruptedBeforeDispatch && !interruptedAfterDispatch) return node
    changed = true
    return {
      ...node,
      status: 'blocked' as const,
      attempts: replaceAttempt(node.attempts, attempt.id, {
        ...attempt,
        status: 'blocked',
        completedAt: now(),
        summary: interruptedBeforeDispatch
          ? 'Forge restarted before worker dispatch was durably confirmed.'
          : 'Forge restarted after the worker stopped before its graph result was recorded. Retry this node.',
      }),
    }
  })
  return { graph: changed ? { ...graph, nodes } : graph, changed }
}

export function blockInterruptedWorkGraphWorkers(
  graph: WorkGraphSnapshot,
  workerIds: ReadonlySet<string>,
  now: () => string,
): { graph: WorkGraphSnapshot; changedNodeIds: string[] } {
  const changedNodeIds: string[] = []
  const nodes = graph.nodes.map((node) => {
    if (node.status !== 'running') return node
    const attempt = currentAttempt(node)
    if (
      !attempt?.workerId
      || attempt.status !== 'running'
      || !workerIds.has(attempt.workerId)
    ) return node
    changedNodeIds.push(node.id)
    return {
      ...node,
      status: 'blocked' as const,
      attempts: replaceAttempt(node.attempts, attempt.id, {
        ...attempt,
        status: 'blocked',
        completedAt: now(),
        summary: 'Restart recovery was dismissed before this interrupted worker resumed. Retry this node.',
      }),
    }
  })
  return {
    graph: changedNodeIds.length > 0 ? { ...graph, nodes } : graph,
    changedNodeIds,
  }
}

export function resolveWorkGraphRoute(node: WorkGraphNode): {
  behaviorMode: WorkGraphAttempt['behaviorMode']
  executionPolicy: WorkGraphAttempt['executionPolicy']
} {
  const behaviorMode = node.kind === 'research'
    ? 'research'
    : node.kind === 'review'
      ? 'correctness-review'
      : 'general'
  const lastAttempt = currentAttempt(node)
  const executionPolicy = node.effort !== 'auto'
    ? node.effort
    : lastAttempt?.status === 'blocked'
      ? 'deep'
      : node.kind === 'research'
        ? 'support'
        : 'routine'
  return { behaviorMode, executionPolicy }
}

export function isWorkGraphComplete(graph: WorkGraphSnapshot): boolean {
  const relevant = graph.nodes.filter((node) => node.status !== 'cancelled')
  return relevant.length > 0 && relevant.every((node) => node.status === 'completed')
}

function normalizeNode(
  value: unknown,
  index: number,
  current: WorkGraphNode | undefined,
  enforceRunningNodeImmutability: boolean,
): WorkGraphNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkGraphValidationError(`nodes[${index}] must be an object.`)
  }
  const node = value as Record<string, unknown>
  const id = normalizeRequiredText(node.id, `nodes[${index}].id`, MAX_WORK_GRAPH_ID_LENGTH)
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    throw new WorkGraphValidationError(
      `nodes[${index}].id must use lowercase letters, digits, hyphens, or underscores.`,
    )
  }
  const title = normalizeRequiredText(
    node.title,
    `nodes[${index}].title`,
    MAX_WORK_GRAPH_TITLE_LENGTH,
  )
  const task = normalizeRequiredText(
    node.task,
    `nodes[${index}].task`,
    MAX_WORK_GRAPH_TASK_LENGTH,
  )
  const kind = node.kind === undefined ? 'task' : node.kind
  if (typeof kind !== 'string' || !WORK_GRAPH_NODE_KINDS.includes(kind as WorkGraphNodeKind)) {
    throw new WorkGraphValidationError(
      `nodes[${index}].kind must be one of: ${WORK_GRAPH_NODE_KINDS.join(', ')}.`,
    )
  }
  const status = node.status
  if (
    typeof status !== 'string'
    || !WORK_GRAPH_NODE_STATUSES.includes(status as WorkGraphNodeStatus)
  ) {
    throw new WorkGraphValidationError(
      `nodes[${index}].status must be one of: ${WORK_GRAPH_NODE_STATUSES.join(', ')}.`,
    )
  }
  if (
    (status === 'running' || status === 'awaiting_review')
    && current?.status !== status
  ) {
    throw new WorkGraphValidationError(
      `nodes[${index}].status=${status} is runtime-owned and may only preserve the current state.`,
    )
  }
  const dependsOn = normalizeDependencies(node.dependsOn, index)
  const acceptanceCriteria = normalizeOptionalText(
    node.acceptanceCriteria,
    `nodes[${index}].acceptanceCriteria`,
    MAX_WORK_GRAPH_ACCEPTANCE_LENGTH,
  )
  const effort = node.effort === undefined ? 'auto' : node.effort
  if (typeof effort !== 'string' || !WORK_GRAPH_EFFORTS.includes(effort as WorkGraphEffort)) {
    throw new WorkGraphValidationError(
      `nodes[${index}].effort must be one of: ${WORK_GRAPH_EFFORTS.join(', ')}.`,
    )
  }
  if (kind === 'decision' && status === 'pending') {
    throw new WorkGraphValidationError(
      `nodes[${index}] is a decision gate and must use status=waiting until resolved.`,
    )
  }
  if (
    enforceRunningNodeImmutability
    && current?.status === 'running'
    && status === 'running'
    && (
      task !== current.task
      || kind !== current.kind
      || !sameValues(dependsOn, current.dependsOn)
      || acceptanceCriteria !== current.acceptanceCriteria
      || effort !== current.effort
    )
  ) {
    throw new WorkGraphValidationError(
      `nodes[${index}] cannot change execution fields while status=running; cancel or reset it first.`,
    )
  }
  const attempts = current?.attempts.map((attempt) => ({ ...attempt })) ?? []
  if (
    current?.status === 'running'
    && (status === 'cancelled' || status === 'pending')
  ) {
    const activeAttempt = attempts.at(-1)
    if (activeAttempt?.status === 'running' || activeAttempt?.status === 'dispatching') {
      attempts[attempts.length - 1] = { ...activeAttempt, status: 'cancelled' }
    }
  }
  return {
    id,
    title,
    task,
    kind: kind as WorkGraphNodeKind,
    status: status as WorkGraphNodeStatus,
    dependsOn,
    ...(acceptanceCriteria ? { acceptanceCriteria } : {}),
    effort: effort as WorkGraphEffort,
    attempts,
  }
}

function normalizeAttempts(value: unknown, nodeIndex: number): WorkGraphAttempt[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new WorkGraphValidationError(`workGraph.nodes[${nodeIndex}].attempts must be an array.`)
  }
  return value.map((attempt, attemptIndex) => {
    if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) {
      throw new WorkGraphValidationError(
        `workGraph.nodes[${nodeIndex}].attempts[${attemptIndex}] must be an object.`,
      )
    }
    const record = attempt as Record<string, unknown>
    const field = `workGraph.nodes[${nodeIndex}].attempts[${attemptIndex}]`
    const id = normalizeRequiredText(record.id, `${field}.id`, 100)
    const number = normalizeInteger(record.number, `${field}.number`, 1, 10_000)
    if (number !== attemptIndex + 1) {
      throw new WorkGraphValidationError(`${field}.number must be ${attemptIndex + 1}.`)
    }
    if (
      typeof record.status !== 'string'
      || !WORK_GRAPH_ATTEMPT_STATUSES.includes(record.status as WorkGraphAttempt['status'])
    ) {
      throw new WorkGraphValidationError(
        `${field}.status must be one of: ${WORK_GRAPH_ATTEMPT_STATUSES.join(', ')}.`,
      )
    }
    const startedAt = normalizeTimestamp(record.startedAt, `${field}.startedAt`)
    const completedAt = record.completedAt === undefined
      ? undefined
      : normalizeTimestamp(record.completedAt, `${field}.completedAt`)
    const workerId = normalizeOptionalText(record.workerId, `${field}.workerId`, 160)
    if (
      record.behaviorMode !== 'general'
      && record.behaviorMode !== 'correctness-review'
      && record.behaviorMode !== 'research'
    ) {
      throw new WorkGraphValidationError(`${field}.behaviorMode is not supported.`)
    }
    if (
      record.executionPolicy !== 'support'
      && record.executionPolicy !== 'routine'
      && record.executionPolicy !== 'deep'
    ) {
      throw new WorkGraphValidationError(`${field}.executionPolicy is not supported.`)
    }
    const summary = normalizeOptionalText(
      record.summary,
      `${field}.summary`,
      MAX_WORK_GRAPH_RESULT_SUMMARY_LENGTH,
    )
    return {
      id,
      number,
      status: record.status as WorkGraphAttempt['status'],
      startedAt,
      ...(completedAt ? { completedAt } : {}),
      ...(workerId ? { workerId } : {}),
      behaviorMode: record.behaviorMode,
      executionPolicy: record.executionPolicy,
      ...(summary ? { summary } : {}),
    }
  })
}

function validateGraph(nodes: WorkGraphNode[]): void {
  const byId = new Map<string, WorkGraphNode>()
  const titles = new Set<string>()
  for (const node of nodes) {
    if (byId.has(node.id)) throw new WorkGraphValidationError(`Duplicate node id: ${node.id}.`)
    if (titles.has(node.title)) {
      throw new WorkGraphValidationError(`Duplicate node title: ${node.title}.`)
    }
    byId.set(node.id, node)
    titles.add(node.title)
  }
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (dependency === node.id) {
        throw new WorkGraphValidationError(`Node ${node.id} cannot depend on itself.`)
      }
      if (!byId.has(dependency)) {
        throw new WorkGraphValidationError(
          `Node ${node.id} depends on unknown node ${dependency}.`,
        )
      }
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new WorkGraphValidationError(`Work graph contains a cycle at ${id}.`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of byId.keys()) visit(id)
}

function updateAttempt(
  graph: WorkGraphSnapshot,
  nodeId: string,
  attemptId: string,
  update: (node: WorkGraphNode, attempt: WorkGraphAttempt) => WorkGraphNode,
): WorkGraphSnapshot {
  let found = false
  const nodes = graph.nodes.map((node) => {
    if (node.id !== nodeId) return node
    const attempt = node.attempts.find((candidate) => candidate.id === attemptId)
    if (!attempt) throw new Error(`Unknown work graph attempt ${attemptId} for node ${nodeId}.`)
    found = true
    return update(node, attempt)
  })
  if (!found) throw new Error(`Unknown work graph node: ${nodeId}.`)
  return { ...graph, nodes }
}

function replaceAttempt(
  attempts: WorkGraphAttempt[],
  attemptId: string,
  replacement: WorkGraphAttempt,
): WorkGraphAttempt[] {
  return attempts.map((attempt) => attempt.id === attemptId ? replacement : attempt)
}

function currentAttempt(node: WorkGraphNode): WorkGraphAttempt | undefined {
  return node.attempts[node.attempts.length - 1]
}

function graphWorkerAgentId(nodeId: string, attemptNumber: number): string {
  const digest = createHash('sha256').update(nodeId).digest('hex').slice(0, 8)
  // Keep the full hash and the largest valid attempt number inside normalizeAgentId's 48-char cap.
  const base = nodeId.replace(/_/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 27) || 'work'
  return `graph-${base}-${digest}-${attemptNumber}`
}

function sameValues(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function truncateWithEllipsis(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  if (maxLength <= 0) return ''
  if (maxLength === 1) return '…'
  return `${value.slice(0, maxLength - 1)}…`
}

function normalizeDependencies(value: unknown, index: number): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new WorkGraphValidationError(`nodes[${index}].dependsOn must be an array.`)
  }
  const dependencies = value.map((dependency, dependencyIndex) => normalizeRequiredText(
    dependency,
    `nodes[${index}].dependsOn[${dependencyIndex}]`,
    MAX_WORK_GRAPH_ID_LENGTH,
  ))
  if (new Set(dependencies).size !== dependencies.length) {
    throw new WorkGraphValidationError(`nodes[${index}].dependsOn contains duplicates.`)
  }
  return dependencies
}

function normalizeInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new WorkGraphValidationError(`${field} must be an integer from ${minimum} to ${maximum}.`)
  }
  return value as number
}

function normalizeTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new WorkGraphValidationError(`${field} must be an ISO timestamp.`)
  }
  return value
}

function normalizeRequiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WorkGraphValidationError(`${field} must be a non-empty string.`)
  }
  const normalized = value.trim()
  if (normalized.length > maxLength) {
    throw new WorkGraphValidationError(`${field} must be at most ${maxLength} characters.`)
  }
  return normalized
}

function normalizeOptionalText(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined
  return normalizeRequiredText(value, field, maxLength)
}

function truncateSummary(value: string): string {
  const normalized = value.trim()
  if (normalized.length <= MAX_WORK_GRAPH_RESULT_SUMMARY_LENGTH) return normalized
  return `${normalized.slice(0, MAX_WORK_GRAPH_RESULT_SUMMARY_LENGTH - 1).trimEnd()}…`
}
