import { existsSync } from 'node:fs'
import path from 'node:path'

export function validateAbsoluteLocalFilePath(filePath: unknown): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { ok: false, error: 'Invalid file path' }
  }

  const normalized = path.normalize(filePath)
  if (!path.isAbsolute(normalized)) {
    return { ok: false, error: 'Path must be absolute' }
  }

  if (!existsSync(normalized)) {
    return { ok: false, error: 'File not found' }
  }

  return { ok: true, path: normalized }
}
