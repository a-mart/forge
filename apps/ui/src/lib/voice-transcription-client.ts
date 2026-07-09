export const MAX_VOICE_UPLOAD_BYTES = 4_000_000

function resolveFileExtension(mimeType: string): string {
  if (mimeType.includes('webm')) return 'webm'
  if (mimeType.includes('mp4')) return 'mp4'
  if (mimeType.includes('mpeg')) return 'mp3'
  if (mimeType.includes('wav')) return 'wav'
  if (mimeType.includes('ogg')) return 'ogg'
  return 'webm'
}

function getErrorMessage(status: number, fallback?: string): string {
  if (status === 400 && fallback) return fallback
  if (status === 401 || status === 403) return 'OpenAI API key required \u2014 add it in Settings.'
  if (status === 413) return 'Recording is too large. Try a shorter clip.'
  if (status === 415) return 'Unsupported audio format. Try recording again.'
  if (status === 504) return 'Transcription timed out. Try a shorter clip.'
  if (fallback && fallback.trim().length > 0) return fallback
  return 'Voice transcription failed. Please try again.'
}

export async function transcribeVoice(blob: Blob, endpoint = '/api/transcribe'): Promise<{ text: string }> {
  if (blob.size === 0) {
    throw new Error('Recording is empty. Try again.')
  }

  if (blob.size > MAX_VOICE_UPLOAD_BYTES) {
    throw new Error('Recording is too large. Try a shorter clip.')
  }

  const mimeType = blob.type || 'audio/webm'
  const extension = resolveFileExtension(mimeType)
  const file = new File([blob], `voice-input.${extension}`, { type: mimeType })

  const payload = new FormData()
  payload.set('file', file)

  const response = await fetch(endpoint, {
    method: 'POST',
    credentials: 'include',
    body: payload,
  })

  const body = (await response.json().catch(() => null)) as { error?: unknown; text?: unknown } | null

  if (!response.ok) {
    const message = typeof body?.error === 'string' ? body.error : undefined
    throw new Error(getErrorMessage(response.status, message))
  }

  if (!body || typeof body.text !== 'string') {
    throw new Error('Invalid transcription response.')
  }

  return { text: body.text }
}
