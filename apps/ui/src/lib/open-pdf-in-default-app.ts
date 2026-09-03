import { CHAT_ARTIFACT_MAX_PDF_BYTES } from '@forge/protocol'
import { isElectron } from '@/lib/electron-bridge'

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-zA-Z]:[\\/]/
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46] as const

export function isAbsoluteLocalFilePath(filePath: string): boolean {
  const trimmed = filePath.trim()
  return trimmed.startsWith('/') || WINDOWS_ABSOLUTE_PATH_PATTERN.test(trimmed)
}

export type OpenPdfInDefaultAppResult =
  | { opened: 'native' }
  | { opened: 'fallback' }
  | { opened: 'none'; error: string }

export async function openPdfInDefaultApp(options: {
  filePath?: string | null
  fallbackUrl?: string | null
  fileName?: string | null
}): Promise<OpenPdfInDefaultAppResult> {
  const filePath = options.filePath?.trim() || ''
  const fallbackUrl = options.fallbackUrl?.trim() || ''
  const fileName = options.fileName?.trim() || ''
  const nativeOpen = isElectron() ? window.electronBridge?.openPdfInDefaultApp : undefined

  if (nativeOpen) {
    if (isAbsoluteLocalFilePath(filePath)) {
      const result = await nativeOpen({ filePath })
      if (result.success) {
        return { opened: 'native' }
      }
      if (!fallbackUrl) {
        return { opened: 'none', error: result.error || 'Unable to open PDF in the default app.' }
      }
    }

    if (isBlobUrl(fallbackUrl)) {
      try {
        const bytes = await readAuthorizedPdfBytes(fallbackUrl)
        const result = await nativeOpen({
          bytes,
          ...(fileName ? { fileName } : {}),
        })
        if (result.success) {
          return { opened: 'native' }
        }
        return { opened: 'none', error: result.error || 'Unable to open PDF in the default app.' }
      } catch (error) {
        return {
          opened: 'none',
          error: error instanceof Error ? error.message : 'Unable to open PDF in the default app.',
        }
      }
    }

    if (isHttpUrl(fallbackUrl)) {
      window.open(fallbackUrl, '_blank', 'noopener,noreferrer')
      return { opened: 'fallback' }
    }

    return { opened: 'none', error: 'Unable to open PDF in the default app.' }
  }

  if (fallbackUrl && (isHttpUrl(fallbackUrl) || isBlobUrl(fallbackUrl))) {
    window.open(fallbackUrl, '_blank', 'noopener,noreferrer')
    return { opened: 'fallback' }
  }

  return { opened: 'none', error: 'Unable to open PDF.' }
}

function isBlobUrl(url: string): boolean {
  return url.startsWith('blob:')
}

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

async function readAuthorizedPdfBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error('Unable to load PDF.')
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0 || bytes.byteLength > CHAT_ARTIFACT_MAX_PDF_BYTES) {
    throw new Error('This PDF is too large to open.')
  }
  if (
    bytes[0] !== PDF_MAGIC[0]
    || bytes[1] !== PDF_MAGIC[1]
    || bytes[2] !== PDF_MAGIC[2]
    || bytes[3] !== PDF_MAGIC[3]
  ) {
    throw new Error('Not a PDF file.')
  }
  return bytes
}
