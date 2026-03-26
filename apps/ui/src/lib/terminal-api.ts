import type {
  TerminalCreateRequest,
  TerminalCreateResponse,
  TerminalDeleteRequest,
  TerminalIssueTicketRequest,
  TerminalIssueTicketResponse,
  TerminalListResponse,
  TerminalRenameRequest,
  TerminalRenameResponse,
  TerminalResizeRequest,
  TerminalResizeResponse,
} from '@forge/protocol'
import { resolveApiEndpoint } from '@/lib/api-endpoint'

async function readApiError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown; message?: unknown; code?: unknown }
    if (typeof payload.error === 'string' && payload.error.trim()) return payload.error
    if (typeof payload.message === 'string' && payload.message.trim()) return payload.message
    if (typeof payload.code === 'string' && payload.code.trim()) return payload.code
  } catch {
    // Ignore JSON parse failures and fall back to text/status.
  }

  try {
    const text = await response.text()
    if (text.trim().length > 0) return text
  } catch {
    // Ignore text read failures.
  }

  return `Request failed (${response.status})`
}

export async function listTerminals(
  wsUrl: string,
  sessionAgentId: string,
): Promise<TerminalListResponse> {
  const params = new URLSearchParams({ sessionAgentId })
  const endpoint = resolveApiEndpoint(wsUrl, `/api/terminals?${params.toString()}`)
  const response = await fetch(endpoint)
  if (!response.ok) throw new Error(await readApiError(response))

  const payload = (await response.json()) as Partial<TerminalListResponse>
  if (!Array.isArray(payload.terminals)) {
    throw new Error('Invalid terminal list response from backend.')
  }

  return { terminals: payload.terminals }
}

export async function createTerminal(
  wsUrl: string,
  request: TerminalCreateRequest,
): Promise<TerminalCreateResponse> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/terminals')
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!response.ok) throw new Error(await readApiError(response))

  const payload = (await response.json()) as Partial<TerminalCreateResponse>
  if (!payload.terminal || typeof payload.ticket !== 'string' || typeof payload.ticketExpiresAt !== 'string') {
    throw new Error('Invalid terminal create response from backend.')
  }

  return payload as TerminalCreateResponse
}

export async function renameTerminal(
  wsUrl: string,
  terminalId: string,
  request: TerminalRenameRequest,
): Promise<TerminalRenameResponse> {
  const endpoint = resolveApiEndpoint(wsUrl, `/api/terminals/${encodeURIComponent(terminalId)}`)
  const response = await fetch(endpoint, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!response.ok) throw new Error(await readApiError(response))

  const payload = (await response.json()) as Partial<TerminalRenameResponse>
  if (!payload.terminal) {
    throw new Error('Invalid terminal rename response from backend.')
  }

  return payload as TerminalRenameResponse
}

export async function resizeTerminal(
  wsUrl: string,
  terminalId: string,
  request: TerminalResizeRequest,
): Promise<TerminalResizeResponse> {
  const endpoint = resolveApiEndpoint(wsUrl, `/api/terminals/${encodeURIComponent(terminalId)}/resize`)
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!response.ok) throw new Error(await readApiError(response))

  const payload = (await response.json()) as Partial<TerminalResizeResponse>
  if (!payload.terminal) {
    throw new Error('Invalid terminal resize response from backend.')
  }

  return payload as TerminalResizeResponse
}

export async function closeTerminal(
  wsUrl: string,
  terminalId: string,
  request: TerminalDeleteRequest,
): Promise<void> {
  const params = new URLSearchParams({ sessionAgentId: request.sessionAgentId })
  const endpoint = resolveApiEndpoint(
    wsUrl,
    `/api/terminals/${encodeURIComponent(terminalId)}?${params.toString()}`,
  )
  const response = await fetch(endpoint, { method: 'DELETE' })
  if (!response.ok) throw new Error(await readApiError(response))
}

export async function issueTerminalTicket(
  wsUrl: string,
  terminalId: string,
  request: TerminalIssueTicketRequest,
): Promise<TerminalIssueTicketResponse> {
  const endpoint = resolveApiEndpoint(wsUrl, `/api/terminals/${encodeURIComponent(terminalId)}/ticket`)
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!response.ok) throw new Error(await readApiError(response))

  const payload = (await response.json()) as Partial<TerminalIssueTicketResponse>
  if (typeof payload.ticket !== 'string' || typeof payload.ticketExpiresAt !== 'string') {
    throw new Error('Invalid terminal ticket response from backend.')
  }

  return payload as TerminalIssueTicketResponse
}
