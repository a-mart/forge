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

export type CodexCatalogFetchResult =
  | { status: 'ok'; snapshot: CodexCatalogSnapshot }
  | { status: 'error' }

export async function fetchCodexCatalog(
  wsUrl: string | undefined,
  managerAgentId: string,
): Promise<CodexCatalogFetchResult> {
  const url = resolveApiEndpoint(
    wsUrl,
    `/api/codex-app-server/catalog?managerAgentId=${encodeURIComponent(managerAgentId)}`,
  )

  try {
    const response = await fetch(url)
    if (!response.ok) {
      return { status: 'error' }
    }

    return { status: 'ok', snapshot: (await response.json()) as CodexCatalogSnapshot }
  } catch {
    return { status: 'error' }
  }
}
