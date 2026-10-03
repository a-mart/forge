import { realpathSync, statSync } from 'node:fs'
import path from 'node:path'

export const OPEN_HTML_IN_BROWSER_CHANNEL = 'open-html-in-browser'

export type OpenHtmlIpcResult =
  | { success: true }
  | { success: false; error: string }

type IpcMainPort = {
  handle: (channel: string, listener: (event: unknown, request: unknown) => unknown) => void
  removeHandler: (channel: string) => void
}

const HTML_EXTENSIONS = new Set(['.html', '.htm'])

/**
 * Validates a local HTML file before handing it to the OS. Both the requested and the
 * resolved path must be HTML so an `.html`-named symlink cannot launch another file type.
 */
export function validateLocalHtmlFilePath(
  filePath: unknown,
): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof filePath !== 'string' || filePath.trim().length === 0 || filePath.includes('\0')) {
    return { ok: false, error: 'Invalid file path' }
  }

  const normalized = path.normalize(filePath.trim())
  if (!path.isAbsolute(normalized)) {
    return { ok: false, error: 'Path must be absolute' }
  }

  let resolved: string
  try {
    resolved = realpathSync(normalized)
  } catch {
    return { ok: false, error: 'File not found' }
  }

  if (!hasHtmlExtension(normalized) || !hasHtmlExtension(resolved)) {
    return { ok: false, error: 'Not an HTML file' }
  }
  try {
    if (!statSync(resolved).isFile()) {
      return { ok: false, error: 'Not an HTML file' }
    }
  } catch {
    return { ok: false, error: 'File not found' }
  }

  return { ok: true, path: resolved }
}

export function installOpenHtmlIpc(options: {
  ipcMain: IpcMainPort
  isTrustedSender: (event: unknown) => boolean
  openPath: (target: string) => Promise<string>
}): () => void {
  options.ipcMain.handle(OPEN_HTML_IN_BROWSER_CHANNEL, async (event, filePath): Promise<OpenHtmlIpcResult> => {
    if (!options.isTrustedSender(event)) {
      return { success: false, error: 'Unauthorized' }
    }
    const validated = validateLocalHtmlFilePath(filePath)
    if (!validated.ok) {
      return { success: false, error: validated.error }
    }
    const error = await options.openPath(validated.path)
    return error ? { success: false, error } : { success: true }
  })

  return () => {
    options.ipcMain.removeHandler(OPEN_HTML_IN_BROWSER_CHANNEL)
  }
}

function hasHtmlExtension(filePath: string): boolean {
  return HTML_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}
