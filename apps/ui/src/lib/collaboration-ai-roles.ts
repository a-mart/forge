/**
 * Shared UI constants for Collaboration AI Roles.
 *
 * The canonical role union lives in @forge/protocol (`CollaborationAiRole`).
 * This module adds display labels, descriptions, and configuration types
 * consumed by channel/category settings UI and the AI Roles settings panel.
 */

import type { BuiltinCollaborationAiRoleId, CollaborationAiRole, CollaborationAiRoleId } from '@forge/protocol'
import { COLLABORATION_AI_ROLE_IDS } from '@forge/protocol'

export { COLLABORATION_AI_ROLE_IDS }
export type { BuiltinCollaborationAiRoleId, CollaborationAiRole, CollaborationAiRoleId }

/* ------------------------------------------------------------------ */
/*  Role option descriptors (for selects / cards)                     */
/* ------------------------------------------------------------------ */

export interface AiRoleOption {
  value: CollaborationAiRoleId
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

/** Map a role ID to its display label. Falls back to the raw ID for custom roles. */
export function aiRoleLabel(role: CollaborationAiRoleId): string {
  return AI_ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role
}

/** The default role assigned to new channels / categories. */
export const DEFAULT_AI_ROLE: BuiltinCollaborationAiRoleId = 'channel_assistant'

/* ------------------------------------------------------------------ */
/*  AI Role usage summary (from backend)                              */
/* ------------------------------------------------------------------ */

export interface AiRoleUsageSummary {
  workspaceDefault: boolean
  categoryCount: number
  channelCount: number
  totalAssignments: number
  inUse: boolean
}

/* ------------------------------------------------------------------ */
/*  AI Role configuration (settings panel model)                      */
/* ------------------------------------------------------------------ */

/**
 * Full configuration record for an AI role as returned by the settings API.
 * Matches the backend `CollaborationAiRoleLibraryEntry` shape.
 *
 * Builtins are read-only in the UI (clone-only); custom roles are fully
 * editable.
 */
export interface AiRoleConfig {
  roleId: string
  name: string
  description: string | null
  prompt: string
  builtin: boolean
  workspaceId?: string
  createdByUserId?: string | null
  createdAt?: string
  updatedAt?: string
  usage: AiRoleUsageSummary
}

/** Parameters for cloning an AI role (the primary way to create custom roles). */
export interface CloneAiRoleParams {
  roleId: string
  name?: string
  description?: string | null
  prompt?: string
}

/** Parameters for creating a custom role from scratch. */
export interface CreateAiRoleParams {
  roleId: string
  name: string
  description?: string | null
  prompt: string
}

/** Parameters for updating an existing custom role. */
export interface UpdateAiRoleParams {
  name?: string
  description?: string | null
  prompt?: string
}
