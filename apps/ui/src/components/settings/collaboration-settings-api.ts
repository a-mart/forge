/* ------------------------------------------------------------------ */
/*  Collaboration settings API helpers                                */
/* ------------------------------------------------------------------ */

import type { CollaborationStatus } from '@forge/protocol'
import { resolveApiEndpoint } from '@/lib/api-endpoint'

export async function fetchCollaborationStatus(wsUrl: string): Promise<CollaborationStatus> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/collaboration/status')
  const response = await fetch(endpoint, { credentials: 'include' })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text || `Request failed (${response.status})`)
  }

  const payload = (await response.json()) as CollaborationStatus
  return payload
}
