const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'file:', 'ftp:'])

export type RestrictedTargetReason = 'missing-url' | 'browser-internal' | 'extension-page' | 'devtools' | 'unsupported-scheme'

export function restrictedTargetReason(url: string | undefined): RestrictedTargetReason | null {
  if (url === undefined || url.length === 0) return 'missing-url'
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'unsupported-scheme'
  }
  if (parsed.protocol === 'devtools:') return 'devtools'
  if (parsed.protocol === 'chrome-extension:') return 'extension-page'
  if (parsed.protocol === 'chrome:' || parsed.protocol === 'chrome-untrusted:' || parsed.protocol === 'edge:' || parsed.protocol === 'about:') {
    return 'browser-internal'
  }
  return ALLOWED_PROTOCOLS.has(parsed.protocol) ? null : 'unsupported-scheme'
}

export function candidateOrigin(url: string | undefined): string {
  if (url === undefined) return ''
  try {
    const parsed = new URL(url)
    return parsed.origin === 'null' ? `${parsed.protocol}//` : parsed.origin
  } catch {
    return ''
  }
}
