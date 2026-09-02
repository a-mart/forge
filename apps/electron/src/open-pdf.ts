import { closeSync, mkdirSync, openSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { CHAT_ARTIFACT_MAX_PDF_BYTES } from '@forge/protocol'
import { OPEN_PDF_IN_DEFAULT_APP_CHANNEL, type OpenPdfIpcResult } from './open-pdf-ipc.js'

export { OPEN_PDF_IN_DEFAULT_APP_CHANNEL } from './open-pdf-ipc.js'
export type { OpenPdfIpcRequest, OpenPdfIpcResult } from './open-pdf-ipc.js'
export const OPEN_PDF_TEMP_TTL_MS = 10 * 60 * 1000
export const OPEN_PDF_MAX_BYTES = CHAT_ARTIFACT_MAX_PDF_BYTES
const PDF_MAGIC = Buffer.from('%PDF', 'ascii')
const MAX_TRACKED_TEMP_PDFS = 16

type IpcMainPort = {
  handle: (channel: string, listener: (event: unknown, request: unknown) => unknown) => void
  removeHandler: (channel: string) => void
}

export type OpenPdfIpcDependencies = {
  ipcMain: IpcMainPort
  isTrustedSender: (event: unknown) => boolean
  openPath: (target: string) => Promise<string>
  tmpdir?: string
  now?: () => number
  setTimeoutFn?: (callback: () => void, delay: number) => unknown
  clearTimeoutFn?: (id: unknown) => void
}

export function validateAbsoluteLocalPdfFilePath(
  filePath: unknown,
): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof filePath !== 'string' || filePath.trim().length === 0 || filePath.includes('\0')) {
    return { ok: false, error: 'Invalid file path' }
  }

  const normalized = path.normalize(filePath.trim())
  if (!path.isAbsolute(normalized)) {
    return { ok: false, error: 'Path must be absolute' }
  }
  if (!hasPdfExtension(normalized)) {
    return { ok: false, error: 'Not a PDF file' }
  }

  let resolved: string
  try {
    resolved = realpathSync(normalized)
  } catch {
    return { ok: false, error: 'File not found' }
  }

  let stats: ReturnType<typeof statSync>
  try {
    stats = statSync(resolved)
  } catch {
    return { ok: false, error: 'File not found' }
  }

  if (!stats.isFile()) {
    return { ok: false, error: 'Not a PDF file' }
  }
  if (!hasPdfExtension(resolved)) {
    return { ok: false, error: 'Not a PDF file' }
  }
  if (!fileStartsWithPdfMagic(resolved)) {
    return { ok: false, error: 'Not a PDF file' }
  }

  return { ok: true, path: resolved }
}

export async function openValidatedPdfPath(
  filePath: unknown,
  openPath: (target: string) => Promise<string>,
): Promise<OpenPdfIpcResult> {
  const validated = validateAbsoluteLocalPdfFilePath(filePath)
  if (!validated.ok) {
    return { success: false, error: validated.error }
  }

  const error = await openPath(validated.path)
  if (error) {
    return { success: false, error }
  }
  return { success: true }
}

export function createManagedPdfTempStore(options: {
  tmpdir?: string
  now?: () => number
  setTimeoutFn?: (callback: () => void, delay: number) => unknown
  clearTimeoutFn?: (id: unknown) => void
  ttlMs?: number
}): {
  writeAndTrack: (bytes: Buffer, fileName?: string) => string
  forget: (filePath: string) => void
  dispose: () => void
} {
  const tmpRoot = path.join(options.tmpdir ?? os.tmpdir(), 'forge-open-pdf')
  const now = options.now ?? Date.now
  const setTimeoutFn = options.setTimeoutFn ?? ((callback, delay) => setTimeout(callback, delay))
  const clearTimeoutFn = options.clearTimeoutFn ?? ((id) => clearTimeout(id as NodeJS.Timeout))
  const ttlMs = options.ttlMs ?? OPEN_PDF_TEMP_TTL_MS
  const tracked = new Map<string, { timer: unknown; createdAt: number }>()

  const forget = (filePath: string): void => {
    const entry = tracked.get(filePath)
    if (entry) {
      clearTimeoutFn(entry.timer)
      tracked.delete(filePath)
    }
    rmSync(filePath, { force: true })
  }

  const evictOldestIfNeeded = (): void => {
    while (tracked.size >= MAX_TRACKED_TEMP_PDFS) {
      let oldestPath: string | null = null
      let oldestCreatedAt = Number.POSITIVE_INFINITY
      for (const [filePath, entry] of tracked) {
        if (entry.createdAt < oldestCreatedAt) {
          oldestCreatedAt = entry.createdAt
          oldestPath = filePath
        }
      }
      if (!oldestPath) break
      forget(oldestPath)
    }
  }

  return {
    writeAndTrack(bytes, fileName) {
      mkdirSync(tmpRoot, { recursive: true })
      evictOldestIfNeeded()
      const target = path.join(tmpRoot, createTempPdfFileName(fileName))
      writeFileSync(target, bytes)
      const createdAt = now()
      const timer = setTimeoutFn(() => {
        forget(target)
      }, ttlMs)
      tracked.set(target, { timer, createdAt })
      return target
    },
    forget,
    dispose() {
      for (const filePath of [...tracked.keys()]) {
        forget(filePath)
      }
      rmSync(tmpRoot, { recursive: true, force: true })
    },
  }
}

export async function openPdfIpcRequest(
  request: unknown,
  openPath: (target: string) => Promise<string>,
  tempStore: ReturnType<typeof createManagedPdfTempStore>,
): Promise<OpenPdfIpcResult> {
  const parsed = parseOpenPdfIpcRequest(request)
  if (!parsed.ok) {
    return { success: false, error: parsed.error }
  }

  if (parsed.kind === 'path') {
    return openValidatedPdfPath(parsed.filePath, openPath)
  }

  const target = tempStore.writeAndTrack(parsed.bytes, parsed.fileName)
  const error = await openPath(target)
  if (error) {
    tempStore.forget(target)
    return { success: false, error }
  }
  return { success: true }
}

export function installOpenPdfIpc(options: OpenPdfIpcDependencies): () => void {
  const tempStore = createManagedPdfTempStore({
    tmpdir: options.tmpdir,
    now: options.now,
    setTimeoutFn: options.setTimeoutFn,
    clearTimeoutFn: options.clearTimeoutFn,
  })

  options.ipcMain.handle(OPEN_PDF_IN_DEFAULT_APP_CHANNEL, async (event, request) => {
    if (!options.isTrustedSender(event)) {
      return { success: false, error: 'Unauthorized' } satisfies OpenPdfIpcResult
    }
    return openPdfIpcRequest(request, options.openPath, tempStore)
  })

  return () => {
    options.ipcMain.removeHandler(OPEN_PDF_IN_DEFAULT_APP_CHANNEL)
    tempStore.dispose()
  }
}

function parseOpenPdfIpcRequest(
  request: unknown,
):
  | { ok: true; kind: 'path'; filePath: string }
  | { ok: true; kind: 'bytes'; bytes: Buffer; fileName?: string }
  | { ok: false; error: string } {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return { ok: false, error: 'Invalid PDF open request' }
  }

  const record = request as { filePath?: unknown; bytes?: unknown; fileName?: unknown }
  if (record.bytes !== undefined) {
    const bytes = asPdfBytes(record.bytes)
    if (!bytes) {
      return { ok: false, error: 'Invalid PDF bytes' }
    }
    if (typeof record.fileName === 'string' && record.fileName.length > 0) {
      return { ok: true, kind: 'bytes', bytes, fileName: record.fileName }
    }
    return { ok: true, kind: 'bytes', bytes }
  }

  if (typeof record.filePath === 'string') {
    return { ok: true, kind: 'path', filePath: record.filePath }
  }

  return { ok: false, error: 'Invalid PDF open request' }
}

function asPdfBytes(value: unknown): Buffer | null {
  let bytes: Buffer
  if (value instanceof Uint8Array) {
    bytes = Buffer.from(value)
  } else if (value instanceof ArrayBuffer) {
    bytes = Buffer.from(value)
  } else {
    return null
  }

  if (bytes.byteLength === 0 || bytes.byteLength > OPEN_PDF_MAX_BYTES) {
    return null
  }
  if (!bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    return null
  }
  return bytes
}

function hasPdfExtension(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.pdf'
}

function fileStartsWithPdfMagic(filePath: string): boolean {
  const fd = openSync(filePath, 'r')
  try {
    const header = Buffer.alloc(PDF_MAGIC.length)
    const bytesRead = readSync(fd, header, 0, PDF_MAGIC.length, 0)
    return bytesRead >= PDF_MAGIC.length && header.equals(PDF_MAGIC)
  } catch {
    return false
  } finally {
    closeSync(fd)
  }
}

function createTempPdfFileName(fileName?: string): string {
  const unique = randomBytes(16).toString('hex')
  const stem = sanitizePdfStem(fileName)
  return stem ? `${stem}-${unique}.pdf` : `${unique}.pdf`
}

function sanitizePdfStem(fileName?: string): string {
  if (!fileName) return ''
  const base = path.basename(fileName).replace(/\.pdf$/i, '')
  const stem = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64)
  return stem
}
