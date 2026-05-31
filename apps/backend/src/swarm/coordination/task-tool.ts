import { Type } from '@sinclair/typebox'
import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import {
  WORK_PLAN_ITEM_STATUSES,
  WORK_PLAN_MODES,
  WORK_PLAN_MUTABLE_STATUSES,
  WORK_PLAN_TERMINAL_STATUSES,
  type SessionTaskStateSnapshot,
  type WorkPlanItemStatus,
  type WorkPlanMode,
  type WorkPlanMutableStatus,
  type WorkPlanTerminalStatus,
} from '@forge/protocol'
import type { SwarmToolHost } from '../swarm-tool-host.js'
import type { AgentDescriptor } from '../types.js'
import {
  MAX_WORK_PLAN_ITEMS,
  MAX_WORK_PLAN_TITLE_LENGTH,
} from './session-coordination-state.js'
import { WorkPlanServiceValidationError } from './work-plan-service.js'

export const TASK_TOOL_NAME = 'task'

const TASK_TOOL_ACTIONS = ['get', 'upsert_plan', 'update_item_status', 'link', 'finish_plan'] as const
const ITEMS_TEXT_LINE_PATTERN = /^(?:(?:[-*]|\d+\.)\s*)?(?:\[(?<status>[a-z_]+)\]\s*)?(?<title>.+)$/iu
const JSON_LIKE_ITEMS_TEXT_PATTERN = /^\s*(?:\[(?:\s*[\[{"])|\{)/u
const JSON_LIKE_ITEMS_TEXT_TITLE_PATTERN = /^\s*(?:\[(?:\s*[\[{"])|\{)/u
const JSON_FRAGMENT_IN_ITEMS_TEXT_TITLE_PATTERN = /(?:^|\s)(?:\[(?:\s*(?:[\[{"]|(?:-?\d+(?:\.\d+)?|true|false|null)(?=\s*(?:,|\]))))|\{[^\n{}]*:[^\n{}]*\})/u
const DISALLOWED_ITEMS_TEXT_PATTERN = /```|https?:\/\/|file:\/\/|\]\(|\b(?:agentId|artifactId|messageId|choiceId|itemId|planId)\s*:|(?:^|\s)(?:\/Users\/|~\/|[A-Za-z]:\\)|\s(?:->|=>)\s/iu
const MAX_TASK_TOOL_ITEMS_TEXT_LENGTH = MAX_WORK_PLAN_ITEMS * (MAX_WORK_PLAN_TITLE_LENGTH + 24)

export type TaskToolInput =
  | TaskToolGetInput
  | TaskToolUpsertPlanInput
  | TaskToolUpdateItemStatusInput
  | TaskToolLinkInput
  | TaskToolFinishPlanInput

export interface TaskToolGetInput {
  action: 'get'
}

export interface TaskToolUpsertPlanItemInput {
  itemId?: string
  title: string
  phase?: string
  status?: WorkPlanItemStatus
  note?: string
  blocker?: {
    reason: string
    needsUser?: boolean
  }
  result?: {
    summary: string
    status: 'done' | 'partial' | 'failed' | 'skipped' | 'unknown'
  }
}

export interface TaskToolUpsertPlanInput {
  action: 'upsert_plan'
  expectedStateRevision?: number
  planId?: string
  title?: string
  goal?: string
  mode?: WorkPlanMode
  status?: WorkPlanMutableStatus
  /** Internal normalized items derived from create-time `itemsText`. Not accepted from provider tool calls. */
  items?: TaskToolUpsertPlanItemInput[]
  itemsText?: string
  revisionNote?: string
}

export interface TaskToolUpdateItemStatusInput {
  action: 'update_item_status'
  expectedStateRevision?: number
  planId: string
  itemId: string
  status: WorkPlanItemStatus
}

export interface TaskToolLinkInput {
  action: 'link'
  expectedStateRevision?: number
  planId: string
  itemId?: string
  link: {
    type: 'worker'
    agentId: string
    label?: string
    specialistId?: string
  }
}

export interface TaskToolFinishPlanInput {
  action: 'finish_plan'
  expectedStateRevision?: number
  planId: string
  status: WorkPlanTerminalStatus
  finalSummary: string
  warnings?: string[]
}

export type TaskToolResult = TaskToolGetResult | TaskToolMutationResult

export interface TaskToolGetResult {
  action: 'get'
  stateRevision: number
  snapshot: SessionTaskStateSnapshot
}

export interface TaskToolMutationResult {
  action: 'upsert_plan' | 'update_item_status' | 'link' | 'finish_plan'
  stateRevision: number
  planId: string
  planRevision: number
  snapshot: SessionTaskStateSnapshot
  createdItemIds?: string[]
  updatedItemId?: string
  linkedItemId?: string
}

export function buildTaskTool(host: SwarmToolHost, descriptor: AgentDescriptor): ToolDefinition {
  return {
    name: TASK_TOOL_NAME,
    label: 'Task',
    description:
      'Manage the current session\'s Active Work plan. Manager-only. This is coordination state, not execution; when the next step is clear, pair plan creation with immediate real work/delegation in the same turn. Call exactly one action: `get`, `upsert_plan`, `update_item_status`, `link`, or `finish_plan`. Provider-facing `upsert_plan` supports top-level plan fields plus create-time `itemsText` only: one item per line like `[active] Investigate logs`. Use `update_item_status` for status-only item progress after create. Use `link` for worker evidence and `finish_plan` for the final outcome. Do not send nested item arrays or stringified JSON arrays from model-generated tool calls.',
    parameters: taskToolSchema,
    async execute(toolCallId, params) {
      const result = await host.runTaskTool(descriptor.agentId, toolCallId, params as TaskToolInput)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
        details: result,
      }
    },
  }
}

function literalUnion<const T extends readonly string[]>(values: T) {
  return Type.Union(values.map((value) => Type.Literal(value)))
}

function literalUnionFromValues(values: readonly string[]) {
  return Type.Union(values.map((value) => Type.Literal(value)))
}

const expectedStateRevisionSchema = Type.Optional(
  Type.Integer({
    minimum: 0,
    description:
      'Optional compare-and-swap revision from the latest task.get or mutation response. Must be a non-negative integer.',
  }),
)
const workPlanModeSchema = literalUnion(WORK_PLAN_MODES)
const taskToolStatusSchema = literalUnionFromValues(
  Array.from(new Set([...WORK_PLAN_ITEM_STATUSES, ...WORK_PLAN_TERMINAL_STATUSES])),
)

const taskToolWorkerLinkSchema = Type.Object(
  {
    type: Type.Literal('worker', {
      description: 'Only worker links are supported in Active Work v1.',
    }),
    agentId: Type.String({ minLength: 1, description: 'Worker agent id to attach as evidence.' }),
    label: Type.Optional(Type.String({ minLength: 1, description: 'Optional short label for the worker link.' })),
    specialistId: Type.Optional(
      Type.String({ minLength: 1, description: 'Optional specialist handle associated with that worker.' }),
    ),
  },
  {
    additionalProperties: false,
    description: 'Worker link object. Do not use artifact, message, or choice refs here.',
  },
)

export const taskToolSchema = Type.Object(
  {
    action: Type.Unsafe<(typeof TASK_TOOL_ACTIONS)[number]>({
      ...literalUnion(TASK_TOOL_ACTIONS),
      description: `Exactly one action: ${TASK_TOOL_ACTIONS.join(', ')}.`,
    }),
    expectedStateRevision: expectedStateRevisionSchema,
    planId: Type.Optional(
      Type.String({
        minLength: 1,
        description: 'Existing plan id for upsert_plan, update_item_status, link, or finish_plan.',
      }),
    ),
    title: Type.Optional(Type.String({ minLength: 1, description: 'Short plan title for upsert_plan.' })),
    goal: Type.Optional(Type.String({ minLength: 1, description: 'User-visible goal for upsert_plan.' })),
    mode: Type.Optional(
      Type.Unsafe<WorkPlanMode>({
        ...workPlanModeSchema,
        description: `Optional plan size for upsert_plan. One of: ${WORK_PLAN_MODES.join(', ')}.`,
      }),
    ),
    status: Type.Optional(
      Type.Unsafe<WorkPlanMutableStatus | WorkPlanItemStatus | WorkPlanTerminalStatus>({
        ...taskToolStatusSchema,
        description:
          `Action-specific status. For upsert_plan use ${WORK_PLAN_MUTABLE_STATUSES.join(', ')}; `
          + `for update_item_status use ${WORK_PLAN_ITEM_STATUSES.join(', ')}; `
          + `for finish_plan use ${WORK_PLAN_TERMINAL_STATUSES.join(', ')}.`,
      }),
    ),
    itemsText: Type.Optional(
      Type.String({
        maxLength: MAX_TASK_TOOL_ITEMS_TEXT_LENGTH,
        description:
          'For upsert_plan create only. Multiline plain text with one item per line. Preferred format is `[status] title`, for example `[done] Create plan` or `[active] Observe backend-fed UI snapshot`. Optional list prefixes like `- ` or `1. ` are allowed. If no `[status]` prefix is present, the item defaults to `todo`. Do not send JSON, links, or reference syntax here.',
      }),
    ),
    itemId: Type.Optional(
      Type.String({
        minLength: 1,
        description: 'Existing item id for update_item_status or optional item id for link.',
      }),
    ),
    link: Type.Optional(taskToolWorkerLinkSchema),
    finalSummary: Type.Optional(
      Type.String({ minLength: 1, description: 'Short final outcome summary for finish_plan.' }),
    ),
    warnings: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        description: 'Optional warnings for finish_plan. Required when status is completed_with_warnings.',
      }),
    ),
    revisionNote: Type.Optional(
      Type.String({ minLength: 1, description: 'Optional short note describing what changed in this upsert.' }),
    ),
  },
  {
    additionalProperties: false,
    description:
      'Arguments for the manager-only task tool. This tool records coordination state only; it does not count as investigating, patching, or validating. Provider-facing upsert_plan supports top-level plan fields plus create-time itemsText; it does not expose structured items arrays. Example: {"action":"upsert_plan","title":"Investigate bug","itemsText":"[active] Trace failure\\n[todo] Patch shared state"}.',
  },
)

export function normalizeTaskToolInput(input: unknown): TaskToolInput {
  const raw = asPlainObject(input)
  const action = raw.action

  if (!isTaskToolAction(action)) {
    throw new WorkPlanServiceValidationError(
      `task action must be one of: ${TASK_TOOL_ACTIONS.join(', ')}.`,
    )
  }

  switch (action) {
    case 'get':
      assertAllowedFields(raw, 'get', ['action'])
      return { action: 'get' }
    case 'upsert_plan':
      return normalizeUpsertPlanInput(raw)
    case 'update_item_status':
      return normalizeUpdateItemStatusInput(raw)
    case 'link':
      return normalizeLinkInput(raw)
    case 'finish_plan':
      return normalizeFinishPlanInput(raw)
  }
}

function normalizeUpsertPlanInput(raw: Record<string, unknown>): TaskToolUpsertPlanInput {
  assertAllowedFields(raw, 'upsert_plan', [
    'action',
    'expectedStateRevision',
    'planId',
    'title',
    'goal',
    'mode',
    'status',
    'items',
    'itemsText',
    'revisionNote',
  ])

  const itemsValue = raw.items === null ? undefined : raw.items
  const itemsText = normalizeOptionalString(raw.itemsText)
  if (itemsValue !== undefined) {
    if (typeof itemsValue === 'string') {
      throw new WorkPlanServiceValidationError(
        'task.upsert_plan no longer accepts items as a string. Use itemsText with one item per line, for example `[active] Investigate logs`.',
      )
    }
    throw new WorkPlanServiceValidationError(
      'task.upsert_plan no longer accepts structured items arrays. Use create-time itemsText or task.update_item_status for item status changes.',
    )
  }
  if (itemsText !== undefined && itemsText.length > MAX_TASK_TOOL_ITEMS_TEXT_LENGTH) {
    throw new WorkPlanServiceValidationError(
      `task.upsert_plan itemsText must be at most ${MAX_TASK_TOOL_ITEMS_TEXT_LENGTH} characters.`,
    )
  }
  if (itemsText !== undefined && raw.planId !== undefined) {
    throw new WorkPlanServiceValidationError(
      'task.upsert_plan itemsText is only allowed when creating a new plan. Provider-facing task calls cannot revise an existing plan item list in v1.',
    )
  }

  const status = raw.status
  if (status !== undefined && !WORK_PLAN_MUTABLE_STATUSES.includes(status as WorkPlanMutableStatus)) {
    throw new WorkPlanServiceValidationError(
      `For task.upsert_plan, status must be one of: ${WORK_PLAN_MUTABLE_STATUSES.join(', ')}.`,
    )
  }

  return {
    action: 'upsert_plan',
    expectedStateRevision: normalizeOptionalNonNegativeInteger(raw.expectedStateRevision, 'expectedStateRevision'),
    planId: normalizeOptionalString(raw.planId),
    title: normalizeOptionalString(raw.title),
    goal: normalizeOptionalString(raw.goal),
    mode: normalizeOptionalEnum(raw.mode, WORK_PLAN_MODES, 'mode'),
    status: status as WorkPlanMutableStatus | undefined,
    items: itemsText !== undefined
      ? parseItemsText(itemsText)
      : (itemsValue as TaskToolUpsertPlanItemInput[] | undefined),
    ...(itemsText !== undefined ? { itemsText } : {}),
    revisionNote: normalizeOptionalString(raw.revisionNote),
  }
}

function normalizeUpdateItemStatusInput(raw: Record<string, unknown>): TaskToolUpdateItemStatusInput {
  assertAllowedFields(raw, 'update_item_status', [
    'action',
    'expectedStateRevision',
    'planId',
    'itemId',
    'status',
  ])

  const status = raw.status
  if (!WORK_PLAN_ITEM_STATUSES.includes(status as WorkPlanItemStatus)) {
    throw new WorkPlanServiceValidationError(
      `For task.update_item_status, status must be one of: ${WORK_PLAN_ITEM_STATUSES.join(', ')}.`,
    )
  }

  return {
    action: 'update_item_status',
    expectedStateRevision: normalizeOptionalNonNegativeInteger(raw.expectedStateRevision, 'expectedStateRevision'),
    planId: normalizeRequiredString(raw.planId, 'planId'),
    itemId: normalizeRequiredString(raw.itemId, 'itemId'),
    status: status as WorkPlanItemStatus,
  }
}

function normalizeLinkInput(raw: Record<string, unknown>): TaskToolLinkInput {
  assertAllowedFields(raw, 'link', [
    'action',
    'expectedStateRevision',
    'planId',
    'itemId',
    'link',
  ])

  if (!raw.link || typeof raw.link !== 'object' || Array.isArray(raw.link)) {
    throw new WorkPlanServiceValidationError('task.link requires a worker link object.')
  }

  return {
    action: 'link',
    expectedStateRevision: normalizeOptionalNonNegativeInteger(raw.expectedStateRevision, 'expectedStateRevision'),
    planId: normalizeRequiredString(raw.planId, 'planId'),
    itemId: normalizeOptionalString(raw.itemId),
    link: raw.link as TaskToolLinkInput['link'],
  }
}

function normalizeFinishPlanInput(raw: Record<string, unknown>): TaskToolFinishPlanInput {
  assertAllowedFields(raw, 'finish_plan', [
    'action',
    'expectedStateRevision',
    'planId',
    'status',
    'finalSummary',
    'warnings',
  ])

  const status = raw.status
  if (!WORK_PLAN_TERMINAL_STATUSES.includes(status as WorkPlanTerminalStatus)) {
    throw new WorkPlanServiceValidationError(
      `For task.finish_plan, status must be one of: ${WORK_PLAN_TERMINAL_STATUSES.join(', ')}.`,
    )
  }

  return {
    action: 'finish_plan',
    expectedStateRevision: normalizeOptionalNonNegativeInteger(raw.expectedStateRevision, 'expectedStateRevision'),
    planId: normalizeRequiredString(raw.planId, 'planId'),
    status: status as WorkPlanTerminalStatus,
    finalSummary: normalizeRequiredString(raw.finalSummary, 'finalSummary'),
    warnings: normalizeOptionalStringArray(raw.warnings, 'warnings'),
  }
}

function parseItemsText(itemsText: string): TaskToolUpsertPlanItemInput[] {
  if (JSON_LIKE_ITEMS_TEXT_PATTERN.test(itemsText)) {
    throw new WorkPlanServiceValidationError(
      'task.upsert_plan itemsText must be plain one-item-per-line text, not JSON. Use lines like `[active] Investigate logs`.',
    )
  }
  if (DISALLOWED_ITEMS_TEXT_PATTERN.test(itemsText)) {
    throw new WorkPlanServiceValidationError('task.upsert_plan itemsText cannot contain JSON, links, or reference syntax.')
  }

  const lines = itemsText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  if (lines.length === 0) {
    throw new WorkPlanServiceValidationError('task.upsert_plan itemsText must contain at least one non-empty line.')
  }
  if (lines.length > MAX_WORK_PLAN_ITEMS) {
    throw new WorkPlanServiceValidationError(
      `task.upsert_plan itemsText must contain at most ${MAX_WORK_PLAN_ITEMS} non-empty lines.`,
    )
  }

  return lines.map((line, index) => parseItemsTextLine(line, index + 1))
}

function parseItemsTextLine(line: string, lineNumber: number): TaskToolUpsertPlanItemInput {
  const match = ITEMS_TEXT_LINE_PATTERN.exec(line)
  if (!match?.groups) {
    throw new WorkPlanServiceValidationError(`task.upsert_plan itemsText line ${lineNumber} must contain an item title.`)
  }

  const rawStatus = match.groups.status?.trim().toLowerCase()
  const title = match.groups.title?.trim()
  if (!title) {
    throw new WorkPlanServiceValidationError(`task.upsert_plan itemsText line ${lineNumber} must contain an item title.`)
  }
  if (
    JSON_LIKE_ITEMS_TEXT_TITLE_PATTERN.test(title)
    || JSON_FRAGMENT_IN_ITEMS_TEXT_TITLE_PATTERN.test(title)
  ) {
    throw new WorkPlanServiceValidationError(
      `task.upsert_plan itemsText line ${lineNumber} cannot contain JSON-like item text. Use plain item titles only.`,
    )
  }
  if (title.length > MAX_WORK_PLAN_TITLE_LENGTH) {
    throw new WorkPlanServiceValidationError(
      `task.upsert_plan itemsText line ${lineNumber} title must be at most ${MAX_WORK_PLAN_TITLE_LENGTH} characters.`,
    )
  }

  if (rawStatus && !WORK_PLAN_ITEM_STATUSES.includes(rawStatus as WorkPlanItemStatus)) {
    throw new WorkPlanServiceValidationError(
      `task.upsert_plan itemsText line ${lineNumber} uses unknown item status \`${rawStatus}\`. Use one of: ${WORK_PLAN_ITEM_STATUSES.join(', ')}.`,
    )
  }

  return rawStatus
    ? { title, status: rawStatus as WorkPlanItemStatus }
    : { title, status: 'todo' }
}

function asPlainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkPlanServiceValidationError('task input must be an object.')
  }
  return value as Record<string, unknown>
}

function isTaskToolAction(value: unknown): value is (typeof TASK_TOOL_ACTIONS)[number] {
  return typeof value === 'string' && TASK_TOOL_ACTIONS.includes(value as (typeof TASK_TOOL_ACTIONS)[number])
}

function assertAllowedFields(raw: Record<string, unknown>, action: (typeof TASK_TOOL_ACTIONS)[number], allowed: readonly string[]): void {
  const allowedSet = new Set(allowed)
  for (const [field, value] of Object.entries(raw)) {
    if (value === undefined) {
      continue
    }
    if (!allowedSet.has(field)) {
      throw new WorkPlanServiceValidationError(`task.${action} does not accept ${field}.`)
    }
  }
}

function normalizeOptionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new WorkPlanServiceValidationError(`${field} must be a non-negative integer`)
  }
  return value
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new WorkPlanServiceValidationError('Expected a string value.')
  }
  return value
}

function normalizeRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WorkPlanServiceValidationError(`${field} is required.`)
  }
  return value
}

function normalizeOptionalEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): T[number] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string' || !allowed.includes(value as T[number])) {
    throw new WorkPlanServiceValidationError(`${field} must be one of: ${allowed.join(', ')}.`)
  }
  return value as T[number]
}

function normalizeOptionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new WorkPlanServiceValidationError(`${field} must be an array of non-empty strings.`)
  }
  return value as string[]
}
