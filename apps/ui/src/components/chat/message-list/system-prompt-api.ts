import { resolveApiEndpoint } from '@/lib/api-endpoint'

export interface AgentSystemPromptResponse {
  agentId: string
  role: 'manager' | 'worker'
  systemPrompt: string | null
  model: string | null
  archetypeId: string | null
}

export async function fetchAgentSystemPrompt(
  wsUrl: string | undefined,
  agentId: string,
): Promise<AgentSystemPromptResponse> {
  const endpoint = resolveApiEndpoint(
    wsUrl,
    `/api/agents/${encodeURIComponent(agentId)}/system-prompt`,
  )
  const response = await fetch(endpoint)
  if (!response.ok) {
    throw new Error(await formatSystemPromptFetchError(response))
  }
  return response.json()
}

async function formatSystemPromptFetchError(response: Response): Promise<string> {
  const fallback = `Failed to fetch system prompt: ${response.status}`

  try {
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      const payload = (await response.json()) as { error?: unknown }
      return typeof payload.error === 'string' && payload.error.trim() ? payload.error : fallback
    }

    const text = await response.text()
    return text.trim() || fallback
  } catch {
    return fallback
  }
}
