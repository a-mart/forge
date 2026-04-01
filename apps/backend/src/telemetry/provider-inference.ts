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

  if (normalized.includes('/')) {
    const [providerPrefix, ...modelParts] = normalized.split('/')
    const suffix = modelParts.join('/').trim()
    if (suffix.length > 0) {
      const suffixCatalogProvider = inferCatalogProvider(suffix)
      if (suffixCatalogProvider) {
        return suffixCatalogProvider
      }
    }

    const normalizedPrefix = normalizeProviderPrefix(providerPrefix)
    if (normalizedPrefix) {
      return normalizedPrefix
    }
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

function normalizeProviderPrefix(value: string): string | null {
  const normalized = value.trim().toLowerCase()
  if (normalized.length === 0) {
    return null
  }

  if (normalized === 'openai') {
    return 'openai-codex'
  }

  if (
    normalized === 'anthropic' ||
    normalized === 'openai-codex' ||
    normalized === 'openai-codex-app-server' ||
    normalized === 'xai'
  ) {
    return normalized
  }

  return null
}
