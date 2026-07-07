import { resolveApiEndpoint } from '@/lib/api-endpoint'

export interface CodexCatalogApp {
  id: string
  name: string
  description?: string
}

export interface CodexCatalogPlugin {
  selector: string
  pluginId?: string
  uri?: string
  displayName: string
  description?: string
  enabled?: boolean
  accessState?: string
  icon?: string
  riskHints?: string[]
  category?: string
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
  plugins: CodexCatalogPlugin[]
  tools: CodexCatalogMcpTool[]
  fetchedAt: string
}

export type CodexCatalogFetchResult =
  | { status: 'ok'; snapshot: CodexCatalogSnapshot }
  | { status: 'error'; error?: string }

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
      let error: string | undefined
      try {
        const body = (await response.json()) as { error?: unknown }
        error = typeof body.error === 'string' ? body.error : undefined
      } catch {
        // Non-JSON error bodies should not hide the catalog failure.
      }
      return { status: 'error', error }
    }

    return { status: 'ok', snapshot: (await response.json()) as CodexCatalogSnapshot }
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}
