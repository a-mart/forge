/**
 * Client-side helpers for Create Project → Clone repository.
 * Server remains authoritative for validation.
 */

export function deriveRepositoryFolderFromUrl(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return null

  try {
    if (!trimmed.includes('://') && trimmed.includes(':')) {
      const pathPart = trimmed.split(':').slice(1).join(':')
      return leafFromPath(pathPart)
    }
    const parsed = new URL(trimmed)
    return leafFromPath(parsed.pathname)
  } catch {
    return null
  }
}

function leafFromPath(pathPart: string): string | null {
  const cleaned = pathPart.replace(/\\/g, '/').replace(/\/+$/, '')
  const segments = cleaned.split('/').filter(Boolean)
  const last = segments[segments.length - 1]
  if (!last) return null
  let decoded = last
  try {
    decoded = decodeURIComponent(last)
  } catch {
    decoded = last
  }
  const withoutGit = decoded.replace(/\.git$/i, '')
  return withoutGit || null
}

export function joinRepositoryDestination(basePath: string, folder: string): string {
  const base = basePath.replace(/[/\\]+$/, '')
  const leaf = folder.trim()
  if (!base || !leaf) return ''
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return `${base}${sep}${leaf}`
}

export function formatCloneStageLabel(
  stage: 'validating' | 'cloning' | 'publishing' | 'creating_manager' | null,
  percent?: number,
): string {
  switch (stage) {
    case 'validating':
      return 'Validating…'
    case 'cloning':
      return percent !== undefined ? `Cloning repository… ${percent}%` : 'Cloning repository…'
    case 'publishing':
      return 'Publishing repository…'
    case 'creating_manager':
      return 'Creating project…'
    default:
      return 'Working…'
  }
}
