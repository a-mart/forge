import { resolveApiEndpoint } from '@/lib/api-endpoint'

export interface CodexCatalogApp {
  id: string
  name: string
  description?: string
}

export interface CodexCatalogMcpTool {
  selector: string
  serverName: string
  toolName: string
  appId?: string
  appName?: string
  description?: string
}

export interface CodexCatalogSnapshot {
  apps: CodexCatalogApp[]
  tools: CodexCatalogMcpTool[]
  fetchedAt: string
}

export async function fetchCodexCatalog(
  wsUrl: string | undefined,
  managerAgentId: string,
): Promise<CodexCatalogSnapshot | null> {
  const url = resolveApiEndpoint(
    wsUrl,
    `/api/codex-app-server/catalog?managerAgentId=${encodeURIComponent(managerAgentId)}`,
  )

  try {
    const response = await fetch(url)
    if (!response.ok) {
      return null
    }

    return (await response.json()) as CodexCatalogSnapshot
  } catch {
    return null
  }
}
