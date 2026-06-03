/**
 * Contextual settings backend target abstraction.
 *
 * Settings can target the local Builder backend or a remote Collab backend.
 * The target is determined by route context only — no manual toggle in v1.
 */

import { resolveApiEndpoint } from '@/lib/api-endpoint'
import { resolveCollaborationApiBaseUrl } from '@/lib/collaboration-endpoints'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type SettingsBackendKind = 'builder' | 'collab'

export type SettingsTab =
  | 'general'
  | 'appearance'
  | 'notifications'
  | 'auth'
  | 'models'
  | 'integrations'
  | 'skills'
  | 'prompts'
  | 'specialists'
  | 'project-resources'
  | 'slash-commands'
  | 'extensions'
  | 'cli-access'
  | 'collaboration'
  | 'about'

export interface SettingsBackendTarget {
  kind: SettingsBackendKind
  label: string
  description: string
  wsUrl: string
  apiBaseUrl: string
  fetchCredentials: RequestCredentials
  requiresAdmin: boolean
  availableTabs: SettingsTab[]
}

/* ------------------------------------------------------------------ */
/*  Tab lists                                                          */
/* ------------------------------------------------------------------ */

const BUILDER_TABS: SettingsTab[] = [
  'general',
  'appearance',
  'notifications',
  'auth',
  'models',
  'integrations',
  'skills',
  'prompts',
  'specialists',
  'project-resources',
  'slash-commands',
  'extensions',
  'cli-access',
  'collaboration',
  'about',
]

const COLLAB_TABS: SettingsTab[] = [
  'general',
  'appearance',
  'auth',
  'models',
  'integrations',
  'skills',
  'prompts',
  'specialists',
  'slash-commands',
  'extensions',
  'collaboration',
  'about',
]

/* ------------------------------------------------------------------ */
/*  Factory functions                                                  */
/* ------------------------------------------------------------------ */

export function createBuilderSettingsTarget(localWsUrl: string): SettingsBackendTarget {
  return {
    kind: 'builder',
    label: 'Builder backend',
    description: 'Local Forge Builder backend on this machine.',
    wsUrl: localWsUrl,
    apiBaseUrl: resolveApiEndpoint(localWsUrl, '/'),
    fetchCredentials: 'same-origin',
    requiresAdmin: false,
    availableTabs: BUILDER_TABS,
  }
}

export function createCollabSettingsTarget(
  collabWsUrl: string,
  /** Explicit API base URL.  When omitted, resolves via the default connection. */
  explicitApiBaseUrl?: string,
): SettingsBackendTarget {
  return {
    kind: 'collab',
    label: 'Collab backend',
    description: 'Connected remote collaboration backend.',
    wsUrl: collabWsUrl,
    apiBaseUrl: explicitApiBaseUrl ?? resolveCollaborationApiBaseUrl(),
    fetchCredentials: 'include',
    requiresAdmin: true,
    availableTabs: COLLAB_TABS,
  }
}
