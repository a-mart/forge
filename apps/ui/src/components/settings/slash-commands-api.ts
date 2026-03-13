import { resolveApiEndpoint } from '@/lib/api-endpoint'

export interface SlashCommand {
  id: string
  name: string
  prompt: string
  createdAt: string
  updatedAt: string
}

export async function fetchSlashCommands(wsUrl: string): Promise<SlashCommand[]> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/slash-commands')
  const response = await fetch(endpoint)
  if (!response.ok) throw new Error('Failed to fetch slash commands')
  const data = await response.json() as { commands: SlashCommand[] }
  return data.commands ?? []
}

export async function createSlashCommand(wsUrl: string, command: { name: string; prompt: string }): Promise<SlashCommand> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/slash-commands')
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) })
  if (!response.ok) { const err = await response.json().catch(() => ({})); throw new Error((err as Record<string, unknown>).error as string ?? 'Failed to create') }
  const data = await response.json() as { command: SlashCommand }
  return data.command
}

export async function updateSlashCommand(wsUrl: string, id: string, patch: { name?: string; prompt?: string }): Promise<SlashCommand> {
  const endpoint = resolveApiEndpoint(wsUrl, `/api/slash-commands/${encodeURIComponent(id)}`)
  const response = await fetch(endpoint, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
  if (!response.ok) { const err = await response.json().catch(() => ({})); throw new Error((err as Record<string, unknown>).error as string ?? 'Failed to update') }
  const data = await response.json() as { command: SlashCommand }
  return data.command
}

export async function deleteSlashCommand(wsUrl: string, id: string): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, `/api/slash-commands/${encodeURIComponent(id)}`)
  const response = await fetch(endpoint, { method: 'DELETE' })
  if (!response.ok) throw new Error('Failed to delete slash command')
}
