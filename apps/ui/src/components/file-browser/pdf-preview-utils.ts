export function formatPdfPreviewError(error: unknown): string {
  if (error instanceof Error && error.name === 'PasswordException') {
    return 'This PDF is password-protected and cannot be previewed.'
  }

  const message = error instanceof Error ? error.message : 'Unknown error'
  return message.length > 120 ? `${message.slice(0, 117)}…` : message
}

export function computeFitWidthScale(pageWidth: number, containerWidth: number, padding = 32): number {
  const availableWidth = Math.max(containerWidth - padding, 1)
  return Math.max(availableWidth / Math.max(pageWidth, 1), 0.1)
}

export function clampPageNumber(page: number, numPages: number): number {
  if (numPages <= 0) {
    return 1
  }

  return Math.min(Math.max(page, 1), numPages)
}
