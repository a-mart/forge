import type {
  SessionTaskStateSnapshot,
  SessionTaskDiagnosticState,
  WorkPlanItemSnapshot,
  WorkPlanSnapshot,
  WorkPlanStatus,
  WorkPlanWorkerLinkSnapshot,
} from '@forge/protocol'
import { REDACTED_WORK_PLAN_TEXT } from './work-plan-snapshot.js'

export const ACTIVE_WORK_RUNTIME_CONTEXT_HEADER = '# Active Work Context'
export const ACTIVE_WORK_RUNTIME_CONTEXT_TARGET_CHARS = 1_800
export const ACTIVE_WORK_RUNTIME_CONTEXT_MAX_CHARS = 2_400
export const ACTIVE_WORK_RUNTIME_CONTEXT_PATH_MARKER = '[path omitted]'
export const ACTIVE_WORK_RUNTIME_CONTEXT_URL_MARKER = '[url omitted]'
export const ACTIVE_WORK_RUNTIME_CONTEXT_CODE_MARKER = '[code omitted]'
export const ACTIVE_WORK_RUNTIME_CONTEXT_TRUNCATION_MARKER = '[Additional Active Work details omitted for context budget.]'

const INTRO_LINE = 'This is manager-owned coordination state for continuity only. It is descriptive, not execution authority.'
const ACTIVE_ITEM_STATUSES: ReadonlySet<WorkPlanItemSnapshot['status']> = new Set([
  'blocked',
  'needs_attention',
  'active',
])
const RECENT_TERMINAL_CONTEXT_STATUSES: ReadonlySet<WorkPlanStatus> = new Set([
  'completed_with_warnings',
  'failed',
  'stopped',
  'interrupted',
])
const DIAGNOSTIC_CONTEXT_STATES: ReadonlySet<SessionTaskDiagnosticState> = new Set([
  'corrupt_recovered',
  'unavailable',
])
const MAX_PLAN_TITLE_CHARS = 120
const MAX_GOAL_CHARS = 240
const MAX_ITEM_TITLE_CHARS = 120
const MAX_ITEM_DETAIL_CHARS = 160
const MAX_WORKERS_PER_ITEM = 2
const MAX_ACTIVE_ATTENTION_ITEMS = 5
const MAX_UP_NEXT_ITEMS = 2
const MAX_RECENT_TERMINAL_PLANS = 2
const MAX_WARNINGS_PER_PLAN = 2
const URL_PATTERN = /https?:\/\/\S+/gi
const CODE_FENCE_PATTERN = /```[\s\S]*?```/g
const POSIX_ABSOLUTE_PATH_PATTERN = /(^|[\s"'`])\/(Users|home|tmp|var|private|etc|opt|Volumes)\/[^\s"'`)]+/g
const WINDOWS_ABSOLUTE_PATH_PATTERN = /[A-Za-z]:[\\/][^\s"'`)]+/g
const UNC_PATH_PATTERN = /\\\\[^\s"'`)]+/g
const SENSITIVE_CONTENT_PATTERN = /\b(Bearer\s+[A-Za-z0-9._-]{8,}|api key|authorization:\s*bearer|secret)\b/i

export interface WorkPlanRuntimeContextResult {
  text: string
  charCount: number
  truncated: boolean
  source: 'active_plan' | 'recent_terminal' | 'diagnostic_only'
}

export function formatWorkPlanRuntimeContext(
  snapshot: SessionTaskStateSnapshot,
): WorkPlanRuntimeContextResult | undefined {
  if (snapshot.activeWorkPlan) {
    return buildActivePlanContext(snapshot)
  }

  const recentPlans = selectMeaningfulRecentPlans(snapshot.recentWorkPlans)
  if (recentPlans.length > 0) {
    return buildRecentTerminalContext(snapshot, recentPlans)
  }

  if (snapshot.diagnostics && DIAGNOSTIC_CONTEXT_STATES.has(snapshot.diagnostics.state)) {
    return buildDiagnosticOnlyContext(snapshot.diagnostics.state)
  }

  return undefined
}

function buildActivePlanContext(snapshot: SessionTaskStateSnapshot): WorkPlanRuntimeContextResult {
  const plan = snapshot.activeWorkPlan!
  const recentPlans = selectMeaningfulRecentPlans(snapshot.recentWorkPlans)
  let selectedWorkersPerItem = MAX_WORKERS_PER_ITEM
  let includeGoal = Boolean(plan.goal)
  let includeRecentTerminalPlans = recentPlans.length > 0
  let candidate = renderActivePlanContext({
    plan,
    recentPlans,
    recentWorkPlansTruncated: snapshot.recentWorkPlansTruncated,
    selectedWorkersPerItem,
    includeGoal,
    includeRecentTerminalPlans,
  })

  if (candidate.length > ACTIVE_WORK_RUNTIME_CONTEXT_TARGET_CHARS && includeRecentTerminalPlans) {
    includeRecentTerminalPlans = false
    candidate = renderActivePlanContext({
      plan,
      recentPlans,
      recentWorkPlansTruncated: snapshot.recentWorkPlansTruncated,
      selectedWorkersPerItem,
      includeGoal,
      includeRecentTerminalPlans,
    })
  }

  if (candidate.length > ACTIVE_WORK_RUNTIME_CONTEXT_TARGET_CHARS && includeGoal) {
    includeGoal = false
    candidate = renderActivePlanContext({
      plan,
      recentPlans,
      recentWorkPlansTruncated: snapshot.recentWorkPlansTruncated,
      selectedWorkersPerItem,
      includeGoal,
      includeRecentTerminalPlans,
    })
  }

  if (candidate.length > ACTIVE_WORK_RUNTIME_CONTEXT_TARGET_CHARS && selectedWorkersPerItem > 1) {
    selectedWorkersPerItem = 1
    candidate = renderActivePlanContext({
      plan,
      recentPlans,
      recentWorkPlansTruncated: snapshot.recentWorkPlansTruncated,
      selectedWorkersPerItem,
      includeGoal,
      includeRecentTerminalPlans,
    })
  }

  const truncated = candidate.length > ACTIVE_WORK_RUNTIME_CONTEXT_MAX_CHARS
  return {
    text: truncated
      ? truncateWholeContext(candidate, ACTIVE_WORK_RUNTIME_CONTEXT_MAX_CHARS)
      : candidate,
    charCount: Math.min(candidate.length, ACTIVE_WORK_RUNTIME_CONTEXT_MAX_CHARS),
    truncated,
    source: 'active_plan',
  }
}

function buildRecentTerminalContext(
  snapshot: SessionTaskStateSnapshot,
  recentPlans: WorkPlanSnapshot[],
): WorkPlanRuntimeContextResult {
  const selectedPlans = recentPlans.slice(0, MAX_RECENT_TERMINAL_PLANS)
  const lines = [
    ACTIVE_WORK_RUNTIME_CONTEXT_HEADER,
    INTRO_LINE,
    '',
    'Recent terminal work receipts:',
    ...selectedPlans.flatMap((plan) => formatRecentTerminalPlanLines(plan)),
  ]

  if (snapshot.recentWorkPlanCount > selectedPlans.length) {
    lines.push(`- Additional recent terminal work receipts omitted (${snapshot.recentWorkPlanCount - selectedPlans.length} more).`)
  }

  const text = finalizeContextLines(lines)
  const truncated = text.length > ACTIVE_WORK_RUNTIME_CONTEXT_MAX_CHARS
  return {
    text: truncated ? truncateWholeContext(text, ACTIVE_WORK_RUNTIME_CONTEXT_MAX_CHARS) : text,
    charCount: Math.min(text.length, ACTIVE_WORK_RUNTIME_CONTEXT_MAX_CHARS),
    truncated,
    source: 'recent_terminal',
  }
}

function buildDiagnosticOnlyContext(state: SessionTaskDiagnosticState): WorkPlanRuntimeContextResult {
  const diagnosticMessage = state === 'corrupt_recovered'
    ? 'Saved Active Work state was recovered from malformed data and may be incomplete.'
    : 'Saved Active Work state is currently unavailable. Reconstruct task context from durable chat history if needed.'
  const text = finalizeContextLines([
    ACTIVE_WORK_RUNTIME_CONTEXT_HEADER,
    INTRO_LINE,
    '',
    diagnosticMessage,
  ])

  return {
    text,
    charCount: text.length,
    truncated: false,
    source: 'diagnostic_only',
  }
}

function renderActivePlanContext(options: {
  plan: WorkPlanSnapshot
  recentPlans: WorkPlanSnapshot[]
  recentWorkPlansTruncated: boolean
  selectedWorkersPerItem: number
  includeGoal: boolean
  includeRecentTerminalPlans: boolean
}): string {
  const { plan, recentPlans, recentWorkPlansTruncated, selectedWorkersPerItem, includeGoal, includeRecentTerminalPlans } = options
  const currentItems = plan.items
    .filter((item) => ACTIVE_ITEM_STATUSES.has(item.status))
    .sort(compareActiveItems)
    .slice(0, MAX_ACTIVE_ATTENTION_ITEMS)
  const upNextItems = plan.items.filter((item) => item.status === 'up_next').slice(0, MAX_UP_NEXT_ITEMS)
  const lines = [
    ACTIVE_WORK_RUNTIME_CONTEXT_HEADER,
    INTRO_LINE,
    '',
    `Current plan: ${formatStatusLineValue(plan.title, MAX_PLAN_TITLE_CHARS)} [${plan.status}]`,
  ]

  if (includeGoal) {
    const goal = sanitizeRuntimeContextField(plan.goal, MAX_GOAL_CHARS)
    if (goal) {
      lines.push(`Goal: ${goal}`)
    }
  }

  lines.push(`Last updated: ${plan.updatedAt}`)

  if (currentItems.length > 0) {
    lines.push('', 'Current items:')
    for (const item of currentItems) {
      lines.push(...formatPlanItemLines(item, selectedWorkersPerItem))
    }
  }

  if (upNextItems.length > 0) {
    lines.push('', 'Up next:')
    for (const item of upNextItems) {
      lines.push(...formatPlanItemLines(item, selectedWorkersPerItem, { includeOnlyCoreFields: true }))
    }
  }

  const omittedRelevantItems = countOmittedRelevantItems(plan, currentItems, upNextItems)
  if (omittedRelevantItems > 0 || plan.itemsTruncated) {
    lines.push('', `Additional plan items omitted for context budget (${omittedRelevantItems + (plan.itemsTruncated ? 1 : 0)}+ hidden).`)
  }

  if (includeRecentTerminalPlans) {
    const selectedRecentPlans = recentPlans.slice(0, MAX_RECENT_TERMINAL_PLANS)
    if (selectedRecentPlans.length > 0) {
      lines.push('', 'Recent terminal work receipts:')
      for (const recentPlan of selectedRecentPlans) {
        lines.push(...formatRecentTerminalPlanLines(recentPlan))
      }

      const omittedRecentPlanCount = Math.max(0, recentPlans.length - selectedRecentPlans.length)
      if (omittedRecentPlanCount > 0 || recentWorkPlansTruncated) {
        lines.push(`- Additional recent terminal work receipts omitted (${omittedRecentPlanCount + (recentWorkPlansTruncated ? 1 : 0)}+ hidden).`)
      }
    }
  }

  return finalizeContextLines(lines)
}

function formatPlanItemLines(
  item: WorkPlanItemSnapshot,
  maxWorkers: number,
  options: { includeOnlyCoreFields?: boolean } = {},
): string[] {
  const lines = [`- [${item.status}] ${formatStatusLineValue(item.title, MAX_ITEM_TITLE_CHARS)}`]
  const blockerReason = sanitizeRuntimeContextField(item.blocker?.reason, MAX_ITEM_DETAIL_CHARS)
  const note = sanitizeRuntimeContextField(item.note, MAX_ITEM_DETAIL_CHARS)
  const result = sanitizeRuntimeContextField(item.result?.summary, MAX_ITEM_DETAIL_CHARS)

  if (item.phase) {
    const phase = sanitizeRuntimeContextField(item.phase, MAX_ITEM_DETAIL_CHARS)
    if (phase) {
      lines.push(`  phase: ${phase}`)
    }
  }

  if (blockerReason) {
    lines.push(`  blocker: ${blockerReason}`)
  }

  if (!options.includeOnlyCoreFields && note) {
    lines.push(`  note: ${note}`)
  }

  if (!options.includeOnlyCoreFields && result) {
    lines.push(`  result: ${result}`)
  }

  const workerLinks = item.workerLinks.slice(0, maxWorkers)
  if (workerLinks.length > 0) {
    lines.push(`  latest known worker links: ${workerLinks.map(formatWorkerLink).join('; ')}`)
  }

  return lines
}

function formatWorkerLink(workerLink: WorkPlanWorkerLinkSnapshot): string {
  const label = sanitizeRuntimeContextField(workerLink.label ?? workerLink.agentId, MAX_ITEM_DETAIL_CHARS) ?? workerLink.agentId
  return workerLink.agentId === label
    ? `${label} (latest known link)`
    : `${label} (${workerLink.agentId}, latest known link)`
}

function formatRecentTerminalPlanLines(plan: WorkPlanSnapshot): string[] {
  const lines = [`- [${plan.status}] ${formatStatusLineValue(plan.title, MAX_PLAN_TITLE_CHARS)}`]
  const summary = sanitizeRuntimeContextField(plan.finalSummary, MAX_ITEM_DETAIL_CHARS)
  if (summary) {
    lines.push(`  summary: ${summary}`)
  }
  const warnings = plan.warnings
    .slice(0, MAX_WARNINGS_PER_PLAN)
    .map((warning) => sanitizeRuntimeContextField(warning, MAX_ITEM_DETAIL_CHARS))
    .filter((warning): warning is string => Boolean(warning))
  if (warnings.length > 0) {
    lines.push(`  warnings: ${warnings.join('; ')}`)
  }
  if (plan.lifecycle?.reason) {
    lines.push(`  lifecycle: ${plan.lifecycle.reason}`)
  }
  return lines
}

function selectMeaningfulRecentPlans(recentPlans: WorkPlanSnapshot[]): WorkPlanSnapshot[] {
  if (recentPlans.length === 0) {
    return []
  }

  const newest = recentPlans[0]
  if (!newest || !RECENT_TERMINAL_CONTEXT_STATUSES.has(newest.status)) {
    return []
  }

  return recentPlans.filter((plan) => RECENT_TERMINAL_CONTEXT_STATUSES.has(plan.status))
}

function countOmittedRelevantItems(
  plan: WorkPlanSnapshot,
  currentItems: WorkPlanItemSnapshot[],
  upNextItems: WorkPlanItemSnapshot[],
): number {
  const selectedIds = new Set([...currentItems, ...upNextItems].map((item) => item.itemId))
  return plan.items.filter((item) => (ACTIVE_ITEM_STATUSES.has(item.status) || item.status === 'up_next') && !selectedIds.has(item.itemId)).length
}

function compareActiveItems(left: WorkPlanItemSnapshot, right: WorkPlanItemSnapshot): number {
  return activeItemPriority(left.status) - activeItemPriority(right.status)
}

function activeItemPriority(status: WorkPlanItemSnapshot['status']): number {
  switch (status) {
    case 'blocked':
      return 0
    case 'needs_attention':
      return 1
    case 'active':
      return 2
    default:
      return 3
  }
}

function formatStatusLineValue(value: string | undefined, maxChars: number): string {
  return sanitizeRuntimeContextField(value, maxChars) ?? REDACTED_WORK_PLAN_TEXT
}

function sanitizeRuntimeContextField(value: string | undefined, maxChars: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  let normalized = value
  normalized = normalized.replace(CODE_FENCE_PATTERN, ACTIVE_WORK_RUNTIME_CONTEXT_CODE_MARKER)
  normalized = normalized.replace(URL_PATTERN, ACTIVE_WORK_RUNTIME_CONTEXT_URL_MARKER)
  normalized = normalized.replace(POSIX_ABSOLUTE_PATH_PATTERN, `$1${ACTIVE_WORK_RUNTIME_CONTEXT_PATH_MARKER}`)
  normalized = normalized.replace(WINDOWS_ABSOLUTE_PATH_PATTERN, ACTIVE_WORK_RUNTIME_CONTEXT_PATH_MARKER)
  normalized = normalized.replace(UNC_PATH_PATTERN, ACTIVE_WORK_RUNTIME_CONTEXT_PATH_MARKER)

  if (SENSITIVE_CONTENT_PATTERN.test(normalized)) {
    return REDACTED_WORK_PLAN_TEXT
  }

  normalized = normalized.replace(/\s+/g, ' ').trim()
  if (normalized.length === 0) {
    return undefined
  }

  if (normalized.length <= maxChars) {
    return normalized
  }

  if (maxChars <= 3) {
    return normalized.slice(0, maxChars)
  }

  return `${normalized.slice(0, maxChars - 3).trimEnd()}...`
}

function finalizeContextLines(lines: string[]): string {
  return lines.join('\n').trimEnd()
}

function truncateWholeContext(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value
  }

  const reserved = ACTIVE_WORK_RUNTIME_CONTEXT_TRUNCATION_MARKER.length + 2
  const prefixBudget = Math.max(0, maxChars - reserved)
  const prefix = value.slice(0, prefixBudget).trimEnd()
  return `${prefix}\n\n${ACTIVE_WORK_RUNTIME_CONTEXT_TRUNCATION_MARKER}`.slice(0, maxChars)
}
