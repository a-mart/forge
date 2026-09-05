import {
  isContextMode,
  type ContextMode,
  type ProjectContextModeSnapshot,
  type SessionContextModeSnapshot,
  type UpdateProjectContextModeRequest,
  type UpdateSessionContextModeRequest,
} from '@forge/protocol'
import type { SettingsApiClient } from './settings-api-client'
import { createBuilderSettingsApiClient } from './settings-api-client'

function resolveClient(clientOrWsUrl: SettingsApiClient | string | undefined): SettingsApiClient {
  return typeof clientOrWsUrl === 'string' || clientOrWsUrl === undefined
    ? createBuilderSettingsApiClient(clientOrWsUrl ?? '')
    : clientOrWsUrl
}

function projectContextModePath(profileId: string): string {
  return `/api/profiles/${encodeURIComponent(profileId)}/context-mode`
}

function sessionContextModePath(agentId: string): string {
  return `/api/agents/${encodeURIComponent(agentId)}/context-mode`
}

export function parseProjectContextModeSnapshot(value: unknown): ProjectContextModeSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid project context-mode response.')
  }
  const payload = value as { profileId?: unknown; mode?: unknown }
  if (typeof payload.profileId !== 'string' || payload.profileId.trim().length === 0) {
    throw new Error('Invalid project context-mode response.')
  }
  if (!isContextMode(payload.mode)) {
    throw new Error('Invalid project context-mode response.')
  }
  return { profileId: payload.profileId, mode: payload.mode }
}

export function parseSessionContextModeSnapshot(value: unknown): SessionContextModeSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid session context-mode response.')
  }
  const payload = value as {
    sessionAgentId?: unknown
    profileId?: unknown
    projectDefault?: unknown
    sessionOverride?: unknown
    effectiveMode?: unknown
    freshSupported?: unknown
    unsupportedReason?: unknown
  }
  if (typeof payload.sessionAgentId !== 'string' || payload.sessionAgentId.trim().length === 0) {
    throw new Error('Invalid session context-mode response.')
  }
  if (typeof payload.profileId !== 'string' || payload.profileId.trim().length === 0) {
    throw new Error('Invalid session context-mode response.')
  }
  if (!isContextMode(payload.projectDefault) || !isContextMode(payload.effectiveMode)) {
    throw new Error('Invalid session context-mode response.')
  }
  if (typeof payload.freshSupported !== 'boolean') {
    throw new Error('Invalid session context-mode response.')
  }
  if (payload.sessionOverride !== undefined && !isContextMode(payload.sessionOverride)) {
    throw new Error('Invalid session context-mode response.')
  }
  if (payload.unsupportedReason !== undefined && typeof payload.unsupportedReason !== 'string') {
    throw new Error('Invalid session context-mode response.')
  }

  const snapshot: SessionContextModeSnapshot = {
    sessionAgentId: payload.sessionAgentId,
    profileId: payload.profileId,
    projectDefault: payload.projectDefault,
    effectiveMode: payload.effectiveMode,
    freshSupported: payload.freshSupported,
  }
  if (isContextMode(payload.sessionOverride)) {
    snapshot.sessionOverride = payload.sessionOverride
  }
  if (typeof payload.unsupportedReason === 'string' && payload.unsupportedReason.trim().length > 0) {
    snapshot.unsupportedReason = payload.unsupportedReason
  }
  return snapshot
}

export async function fetchProjectContextMode(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  profileId: string,
): Promise<ProjectContextModeSnapshot> {
  const client = resolveClient(clientOrWsUrl)
  const response = await client.fetch(projectContextModePath(profileId), { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(await client.readApiError(response))
  }
  return parseProjectContextModeSnapshot(await response.json())
}

export async function updateProjectContextMode(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  profileId: string,
  mode: ContextMode,
): Promise<ProjectContextModeSnapshot> {
  const client = resolveClient(clientOrWsUrl)
  const body: UpdateProjectContextModeRequest = { mode }
  const response = await client.fetch(projectContextModePath(profileId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(await client.readApiError(response))
  }
  return parseProjectContextModeSnapshot(await response.json())
}

export async function fetchSessionContextMode(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  agentId: string,
): Promise<SessionContextModeSnapshot> {
  const client = resolveClient(clientOrWsUrl)
  const response = await client.fetch(sessionContextModePath(agentId), { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(await client.readApiError(response))
  }
  return parseSessionContextModeSnapshot(await response.json())
}

export async function updateSessionContextMode(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  agentId: string,
  mode: ContextMode | null,
): Promise<SessionContextModeSnapshot> {
  const client = resolveClient(clientOrWsUrl)
  const body: UpdateSessionContextModeRequest = { mode }
  const response = await client.fetch(sessionContextModePath(agentId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(await client.readApiError(response))
  }
  return parseSessionContextModeSnapshot(await response.json())
}
