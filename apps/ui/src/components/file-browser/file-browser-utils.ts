/* ------------------------------------------------------------------ */
/*  Shared file-browser utilities                                      */
/* ------------------------------------------------------------------ */

/**
 * Format a byte count as a human-readable size string (B / KB / MB).
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
])

export const PDF_EXTENSIONS = new Set(['pdf'])

export function isImageFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_EXTENSIONS.has(ext)
}

export function isPdfFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  return PDF_EXTENSIONS.has(ext)
}

export function doesDeleteAffectOpenFile(
  deletePath: string,
  entryType: 'file' | 'directory',
  openFilePath: string | null,
): boolean {
  if (!openFilePath) {
    return false
  }

  if (entryType === 'file') {
    return openFilePath === deletePath
  }

  return openFilePath === deletePath || openFilePath.startsWith(`${deletePath}/`)
}
