export const COLLABORATION_AI_ROLE_IDS = [
  'channel_assistant',
  'work_coordinator',
  'facilitator_scribe',
] as const

export type BuiltinCollaborationAiRoleId = (typeof COLLABORATION_AI_ROLE_IDS)[number]

/** Canonical collaboration AI role IDs may reference builtin or custom workspace roles. */
export type CollaborationAiRoleId = string

/** @deprecated Builtin-only compatibility alias. Prefer CollaborationAiRoleId for canonical IDs. */
export type CollaborationAiRole = BuiltinCollaborationAiRoleId
