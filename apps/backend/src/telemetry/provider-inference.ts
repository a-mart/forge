import { inferCatalogProvider } from '@forge/protocol'

export function inferProviderFromModelId(modelId: string): string | null {
  const normalized = modelId.trim().toLowerCase()
  if (normalized.length === 0) {
    return null
  }

  const exactCatalogProvider = inferCatalogProvider(normalized)
  if (exactCatalogProvider) {
    return exactCatalogProvider
  }

  if (isSlashScopedOpenRouterModelId(normalized)) {
    return 'openrouter'
  }

  if (normalized.startsWith('claude') || normalized.includes('anthropic')) {
    return 'anthropic'
  }

  if (normalized.startsWith('grok') || normalized.includes('xai')) {
    return 'xai'
  }

  if (
    normalized.startsWith('gpt-') ||
    normalized.startsWith('o1') ||
    normalized.startsWith('o3') ||
    normalized.startsWith('o4') ||
    normalized.includes('openai')
  ) {
    return 'openai-codex'
  }

  return null
}

function isSlashScopedOpenRouterModelId(modelId: string): boolean {
  const slashIndex = modelId.indexOf('/')
  return slashIndex > 0 && slashIndex < modelId.length - 1
}
