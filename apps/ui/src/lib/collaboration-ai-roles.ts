/**
 * Shared UI constants for Collaboration AI Roles.
 *
 * The canonical role union lives in @forge/protocol (`CollaborationAiRole`).
 * This module adds display labels and descriptions consumed by channel and
 * category settings UI.
 */

import type { CollaborationAiRole } from '@forge/protocol'
import { COLLABORATION_AI_ROLES } from '@forge/protocol'

export { COLLABORATION_AI_ROLES }
export type { CollaborationAiRole }

export interface AiRoleOption {
  value: CollaborationAiRole
  label: string
  description: string
}

export const AI_ROLE_OPTIONS: readonly AiRoleOption[] = [
  {
    value: 'channel_assistant',
    label: 'Channel Assistant',
    description: 'General-purpose helper — answers questions and follows channel instructions.',
  },
  {
    value: 'work_coordinator',
    label: 'Work Coordinator',
    description: 'Plans and delegates tasks across workers, tracks progress.',
  },
  {
    value: 'facilitator_scribe',
    label: 'Facilitator & Scribe',
    description: 'Summarises discussions, captures decisions, and keeps the conversation on track.',
  },
] as const

/** Map a role value to its display label. */
export function aiRoleLabel(role: CollaborationAiRole): string {
  return AI_ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role
}

/** The default role assigned to new channels / categories. */
export const DEFAULT_AI_ROLE: CollaborationAiRole = 'channel_assistant'
