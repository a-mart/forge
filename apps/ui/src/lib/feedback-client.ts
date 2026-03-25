import { resolveApiEndpoint } from '@/lib/api-endpoint'
import { resolveBackendWsUrl } from '@/lib/backend-url'
import type { FeedbackEvent, FeedbackState } from '@/lib/feedback-types'

function apiUrl(path: string): string {
  return resolveApiEndpoint(resolveBackendWsUrl(), path)
}

async function readApiError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string } | null
    if (body?.error) return body.error
  } catch {
    // ignore
  }
  return `Request failed (${response.status})`
}

export async function submitFeedback(params: {
  profileId: string
  sessionId: string
  scope: 'message' | 'session'
  targetId: string
  value: FeedbackEvent['value']
  reasonCodes?: string[]
  comment?: string
  channel?: FeedbackEvent['channel']
  clearKind?: 'vote' | 'comment'
}): Promise<FeedbackEvent> {
  const { profileId, sessionId, ...body } = params
  const endpoint = apiUrl(
    `/api/v1/profiles/${encodeURIComponent(profileId)}/sessions/${encodeURIComponent(sessionId)}/feedback`,
  )

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scope: body.scope,
      targetId: body.targetId,
      value: body.value,
      reasonCodes: body.reasonCodes ?? [],
      comment: body.comment ?? '',
      channel: body.channel ?? 'web',
      ...(body.clearKind ? { clearKind: body.clearKind } : {}),
    }),
  })

  if (!response.ok) {
    throw new Error(await readApiError(response))
  }

  const payload = (await response.json()) as { feedback: FeedbackEvent }
  return payload.feedback
}

export async function fetchFeedbackStates(
  profileId: string,
  sessionId: string,
): Promise<FeedbackState[]> {
  const endpoint = apiUrl(
    `/api/v1/profiles/${encodeURIComponent(profileId)}/sessions/${encodeURIComponent(sessionId)}/feedback/state`,
  )

  const response = await fetch(endpoint)

  if (!response.ok) {
    throw new Error(await readApiError(response))
  }

  const payload = (await response.json()) as { states?: FeedbackState[] }
  return payload.states ?? []
}
