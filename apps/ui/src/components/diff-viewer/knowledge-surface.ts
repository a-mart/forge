import type { GitCommitMetadata, GitFileStatus } from '@forge/protocol'

export type KnowledgeSurfaceId =
  | 'common-knowledge'
  | 'cortex-notes'
  | 'cortex-worker-prompts'
  | 'profile-knowledge'
  | 'profile-memory'
  | 'reference-docs'
  | 'prompt-overrides'
  | 'other-tracked'

export interface KnowledgeSurfaceDefinition {
  id: KnowledgeSurfaceId
  label: string
}

export type KnowledgeQuickFilterId =
  | 'all'
  | 'shared-knowledge'
  | 'profile-memory'
  | 'reference-docs'
  | 'prompt-overrides'

export interface KnowledgeQuickFilterDefinition {
  id: KnowledgeQuickFilterId
  label: string
  pathLabel: string
}

const SURFACES: Record<KnowledgeSurfaceId, KnowledgeSurfaceDefinition> = {
  'common-knowledge': { id: 'common-knowledge', label: 'Common Knowledge' },
  'cortex-notes': { id: 'cortex-notes', label: 'Cortex Notes' },
  'cortex-worker-prompts': { id: 'cortex-worker-prompts', label: 'Cortex Worker Prompts' },
  'profile-knowledge': { id: 'profile-knowledge', label: 'Profile Knowledge (legacy)' },
  'profile-memory': { id: 'profile-memory', label: 'Profile Memory' },
  'reference-docs': { id: 'reference-docs', label: 'Reference Docs' },
  'prompt-overrides': { id: 'prompt-overrides', label: 'Prompt Overrides' },
  'other-tracked': { id: 'other-tracked', label: 'Other Tracked' },
}

const SURFACE_ORDER: KnowledgeSurfaceId[] = [
  'common-knowledge',
  'cortex-notes',
  'cortex-worker-prompts',
  'profile-knowledge',
  'profile-memory',
  'reference-docs',
  'prompt-overrides',
  'other-tracked',
]

export const KNOWLEDGE_QUICK_FILTERS: KnowledgeQuickFilterDefinition[] = [
  { id: 'all', label: 'All tracked', pathLabel: 'All tracked paths' },
  { id: 'shared-knowledge', label: 'Shared knowledge', pathLabel: 'shared/knowledge/*' },
  {
    id: 'profile-memory',
    label: 'Profile memory',
    pathLabel: 'profiles/*/memory.md, profiles/*/sessions/*/memory.md',
  },
  { id: 'reference-docs', label: 'Reference docs', pathLabel: 'profiles/*/reference/*' },
  { id: 'prompt-overrides', label: 'Prompt overrides', pathLabel: 'profiles/*/prompts/*' },
]

export function classifyKnowledgeSurface(path: string): KnowledgeSurfaceDefinition {
  const normalizedPath = normalizePath(path)

  if (normalizedPath === 'shared/knowledge/common.md') {
    return SURFACES['common-knowledge']
  }

  if (normalizedPath === 'shared/knowledge/.cortex-notes.md') {
    return SURFACES['cortex-notes']
  }

  if (normalizedPath === 'shared/knowledge/.cortex-worker-prompts.md') {
    return SURFACES['cortex-worker-prompts']
  }

  if (/^shared\/knowledge\/profiles\/[^/]+\.md$/u.test(normalizedPath)) {
    return SURFACES['profile-knowledge']
  }

  if (
    /^profiles\/[^/]+\/memory\.md$/u.test(normalizedPath) ||
    /^profiles\/[^/]+\/sessions\/[^/]+\/memory\.md$/u.test(normalizedPath)
  ) {
    return SURFACES['profile-memory']
  }

  if (/^profiles\/[^/]+\/reference\//u.test(normalizedPath)) {
    return SURFACES['reference-docs']
  }

  if (/^profiles\/[^/]+\/prompts\//u.test(normalizedPath)) {
    return SURFACES['prompt-overrides']
  }

  return SURFACES['other-tracked']
}

export function groupFilesByKnowledgeSurface<T extends Pick<GitFileStatus, 'path'>>(
  files: T[],
): Array<{ surface: KnowledgeSurfaceDefinition; files: T[] }> {
  const grouped = new Map<KnowledgeSurfaceId, T[]>()

  for (const file of files) {
    const surface = classifyKnowledgeSurface(file.path)
    const bucket = grouped.get(surface.id)
    if (bucket) {
      bucket.push(file)
    } else {
      grouped.set(surface.id, [file])
    }
  }

  return SURFACE_ORDER.flatMap((surfaceId) => {
    const groupFiles = grouped.get(surfaceId)
    if (!groupFiles?.length) {
      return []
    }

    return [{ surface: SURFACES[surfaceId], files: groupFiles }]
  })
}

export function matchesKnowledgeQuickFilter(path: string, quickFilter: KnowledgeQuickFilterId): boolean {
  const normalizedPath = normalizePath(path)

  switch (quickFilter) {
    case 'all':
      return true
    case 'shared-knowledge':
      return normalizedPath.startsWith('shared/knowledge/')
    case 'profile-memory':
      return (
        /^profiles\/[^/]+\/memory\.md$/u.test(normalizedPath) ||
        /^profiles\/[^/]+\/sessions\/[^/]+\/memory\.md$/u.test(normalizedPath)
      )
    case 'reference-docs':
      return /^profiles\/[^/]+\/reference\//u.test(normalizedPath)
    case 'prompt-overrides':
      return /^profiles\/[^/]+\/prompts\//u.test(normalizedPath)
    default:
      return true
  }
}

export function commitMatchesKnowledgeQuickFilter(
  metadata: GitCommitMetadata | null | undefined,
  quickFilter: KnowledgeQuickFilterId,
): boolean {
  if (quickFilter === 'all') {
    return true
  }

  const paths = metadata?.paths ?? []
  if (paths.length === 0) {
    return false
  }

  return paths.some((path) => matchesKnowledgeQuickFilter(path, quickFilter))
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//u, '')
}
