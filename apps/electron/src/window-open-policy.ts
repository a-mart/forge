export type WindowOpenAction = { action: 'allow' } | { action: 'deny' }

const UNSAFE_RENDERER_WINDOW_OPEN_PROTOCOLS = new Set([
  'blob:',
  'file:',
  'javascript:',
  'data:',
  'about:',
])

export function isUnsafeRendererWindowOpenUrl(url: string): boolean {
  const trimmed = url.trim()
  if (trimmed.length === 0) return true
  try {
    return UNSAFE_RENDERER_WINDOW_OPEN_PROTOCOLS.has(new URL(trimmed).protocol)
  } catch {
    return true
  }
}

export function handleMainRendererWindowOpen(
  url: string,
  options: {
    openExternal: (target: string) => Promise<unknown>
    handleDeepLink: (target: string) => boolean
    onExternalOpenError?: (target: string, error: unknown) => void
  },
): WindowOpenAction {
  if (options.handleDeepLink(url)) {
    return { action: 'deny' }
  }

  if (isUnsafeRendererWindowOpenUrl(url)) {
    return { action: 'deny' }
  }

  options.openExternal(url).catch((error) => {
    options.onExternalOpenError?.(url, error)
  })
  return { action: 'deny' }
}
