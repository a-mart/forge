const COLLAB_AUTHOR_COLORS = [
  '#4f5d95',
  '#2f6f67',
  '#7851a9',
  '#8a4d67',
  '#8b6138',
  '#3b6f52',
  '#406b8a',
  '#7a557a',
  '#6c6a43',
  '#7b4a4a',
] as const

export function getAuthorInitials(displayName: string): string {
  const trimmedName = displayName.trim()
  if (!trimmedName) {
    return '?'
  }

  const nameParts = trimmedName
    .split(/[\s._-]+/)
    .map((part) => part.trim())
    .filter(Boolean)

  if (nameParts.length === 0) {
    return '?'
  }

  if (nameParts.length === 1) {
    return Array.from(nameParts[0])
      .slice(0, 2)
      .join('')
      .toUpperCase()
  }

  const firstInitial = Array.from(nameParts[0])[0] ?? ''
  const lastInitial = Array.from(nameParts[nameParts.length - 1])[0] ?? ''

  return `${firstInitial}${lastInitial}`.toUpperCase() || '?'
}

export function getAuthorColor(userId: string): string {
  if (!userId) {
    return COLLAB_AUTHOR_COLORS[0]
  }

  let hash = 0
  for (const char of userId) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0
  }

  return COLLAB_AUTHOR_COLORS[Math.abs(hash) % COLLAB_AUTHOR_COLORS.length]
}
