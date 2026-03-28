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
    throw new Error(`Failed to fetch system prompt: ${response.status}`)
  }
  return response.json()
}
