import type { AgentDescriptor } from '../types.js'
import { containsUnsafeWorkPlanText } from './work-plan-text-safety.js'

export interface WorkPlanActorContext {
  agentId: string
  role: 'manager' | 'worker'
  profileId?: string
  sessionAgentId: string
}

export interface WorkPlanWorkerLinkInput {
  type: 'worker'
  agentId: string
  label?: string
  specialistId?: string
}

export interface ValidatedWorkPlanWorkerLinkInput extends WorkPlanWorkerLinkInput {
  label?: string
  specialistId?: string
}

export class WorkPlanLinkValidationError extends Error {
  readonly code = 'invalid_link'

  constructor(message: string) {
    super(message)
    this.name = 'WorkPlanLinkValidationError'
  }
}

export function validateWorkerLinkInput(
  actor: WorkPlanActorContext,
  link: unknown,
  agents: AgentDescriptor[],
): ValidatedWorkPlanWorkerLinkInput {
  if (!link || typeof link !== 'object') {
    throw new WorkPlanLinkValidationError('Task links must be objects.')
  }

  const candidate = link as Record<string, unknown>
  rejectUnsupportedReferenceFields(candidate)

  if (candidate.type !== 'worker') {
    throw new WorkPlanLinkValidationError('Only worker links are supported in v1.')
  }

  if (typeof candidate.agentId !== 'string' || candidate.agentId.trim().length === 0) {
    throw new WorkPlanLinkValidationError('Worker links require a non-empty agentId.')
  }

  const agentId = candidate.agentId.trim()
  if (looksLikeUrl(agentId) || looksLikeAbsolutePath(agentId)) {
    throw new WorkPlanLinkValidationError('Worker links must reference a session worker agentId, not a path or URL.')
  }

  const worker = agents.find((candidateAgent) => candidateAgent.agentId === agentId)
  if (!worker || worker.role !== 'worker') {
    throw new WorkPlanLinkValidationError('Worker links must target an existing worker in the current session.')
  }

  if (worker.managerId !== actor.sessionAgentId) {
    throw new WorkPlanLinkValidationError('Worker links must target a worker owned by the current manager session.')
  }

  if (actor.profileId && worker.profileId && worker.profileId !== actor.profileId) {
    throw new WorkPlanLinkValidationError('Worker links must stay within the current profile.')
  }

  const label = normalizeOptionalText(candidate.label, worker.displayName)
  const specialistId = normalizeOptionalText(candidate.specialistId, worker.specialistId)

  if (typeof candidate.label === 'string' && label && containsUnsafeWorkPlanText(label)) {
    throw new WorkPlanLinkValidationError('Worker link labels must not include raw paths, URLs, or sensitive text.')
  }

  if (typeof candidate.specialistId === 'string' && specialistId && containsUnsafeWorkPlanText(specialistId)) {
    throw new WorkPlanLinkValidationError('Worker link specialistId must not include raw paths, URLs, or sensitive text.')
  }

  return {
    type: 'worker',
    agentId: worker.agentId,
    label,
    specialistId,
  }
}

function rejectUnsupportedReferenceFields(candidate: Record<string, unknown>): void {
  for (const key of ['choiceId', 'messageId', 'artifactId']) {
    if (typeof candidate[key] === 'string' && candidate[key]!.trim().length > 0) {
      throw new WorkPlanLinkValidationError('Choice, message, and artifact links are not supported in v1.')
    }
  }

  for (const key of ['path', 'filePath', 'artifactPath', 'url', 'href']) {
    const value = candidate[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      throw new WorkPlanLinkValidationError('Task links must not use raw filesystem paths or URLs.')
    }
  }
}

function normalizeOptionalText(value: unknown, fallback: string | undefined): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : fallback
  }

  return fallback
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function looksLikeAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}
