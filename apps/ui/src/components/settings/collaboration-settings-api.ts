/* ------------------------------------------------------------------ */
/*  Collaboration settings API helpers                                */
/* ------------------------------------------------------------------ */

import type { CollaborationStatus } from '@forge/protocol'
import { resolveCollaborationApiBaseUrl } from '@/lib/collaboration-endpoints'

export async function fetchCollaborationStatus(): Promise<CollaborationStatus> {
  const endpoint = new URL('/api/collaboration/status', resolveCollaborationApiBaseUrl()).toString()
  const response = await fetch(endpoint, { credentials: 'include' })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text || `Request failed (${response.status})`)
  }

  const payload = (await response.json()) as CollaborationStatus
  return payload
}
