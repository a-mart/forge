import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  OPEN_PDF_IN_DEFAULT_APP_CHANNEL,
  createManagedPdfTempStore,
  installOpenPdfIpc,
  openPdfIpcRequest,
  openValidatedPdfPath,
  validateAbsoluteLocalPdfFilePath,
} from '../open-pdf.js'
import { handleMainRendererWindowOpen } from '../window-open-policy.js'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'forge-open-pdf-'))
  tempRoots.push(root)
  return root
}

function writePdf(root: string, name = 'spec.pdf', contents = '%PDF-1.4\n'): string {
  const filePath = path.join(root, name)
  writeFileSync(filePath, contents)
  return realpathSync(filePath)
}

describe('validateAbsoluteLocalPdfFilePath', () => {
  it('accepts an existing absolute regular PDF and rejects directories, executables, and non-PDF content', () => {
    const root = tempRoot()
    const pdfPath = writePdf(root)
    expect(validateAbsoluteLocalPdfFilePath(pdfPath)).toEqual({ ok: true, path: pdfPath })

    expect(validateAbsoluteLocalPdfFilePath('relative/spec.pdf')).toEqual({ ok: false, error: 'Path must be absolute' })
    expect(validateAbsoluteLocalPdfFilePath('')).toEqual({ ok: false, error: 'Invalid file path' })
    expect(validateAbsoluteLocalPdfFilePath(path.join(root, 'missing.pdf'))).toEqual({
      ok: false,
      error: 'File not found',
    })
    expect(validateAbsoluteLocalPdfFilePath(root)).toEqual({ ok: false, error: 'Not a PDF file' })

    const pdfDirectory = path.join(root, 'folder.pdf')
    mkdirSync(pdfDirectory)
    expect(validateAbsoluteLocalPdfFilePath(pdfDirectory)).toEqual({ ok: false, error: 'Not a PDF file' })

    const executable = path.join(root, 'tool.sh')
    writeFileSync(executable, '#!/bin/sh\n')
    chmodSync(executable, 0o755)
    expect(validateAbsoluteLocalPdfFilePath(executable)).toEqual({ ok: false, error: 'Not a PDF file' })

    const disguised = writePdf(root, 'notes.pdf', 'not a pdf')
    expect(validateAbsoluteLocalPdfFilePath(disguised)).toEqual({ ok: false, error: 'Not a PDF file' })
  })

  it('follows a PDF symlink only when the real path remains a regular PDF', () => {
    const root = tempRoot()
    const pdfPath = writePdf(root)
    const alias = path.join(root, 'alias.pdf')
    symlinkSync(pdfPath, alias)
    expect(validateAbsoluteLocalPdfFilePath(alias)).toEqual({ ok: true, path: pdfPath })

    const directoryAlias = path.join(root, 'dir.pdf')
    symlinkSync(root, directoryAlias)
    expect(validateAbsoluteLocalPdfFilePath(directoryAlias)).toEqual({ ok: false, error: 'Not a PDF file' })
  })

  it('returns a structured failure when PDF header inspection races with deletion or permission errors', () => {
    const root = tempRoot()
    const pdfPath = writePdf(root)
    chmodSync(pdfPath, 0o000)
    try {
      expect(validateAbsoluteLocalPdfFilePath(pdfPath)).toEqual({ ok: false, error: 'Not a PDF file' })
    } finally {
      chmodSync(pdfPath, 0o644)
    }
  })
})

describe('openValidatedPdfPath', () => {
  it('opens a validated PDF and never invokes the opener for rejected paths', async () => {
    const root = tempRoot()
    const pdfPath = writePdf(root)
    const openPath = vi.fn(async () => '')
    await expect(openValidatedPdfPath(pdfPath, openPath)).resolves.toEqual({ success: true })
    expect(openPath).toHaveBeenCalledWith(pdfPath)

    openPath.mockClear()
    await expect(openValidatedPdfPath(root, openPath)).resolves.toEqual({
      success: false,
      error: 'Not a PDF file',
    })
    expect(openPath).not.toHaveBeenCalled()
  })
})

describe('openPdfIpcRequest', () => {
  it('materializes authorized PDF bytes into a managed temporary file and cleans it up on opener failure', async () => {
    const tmpdir = tempRoot()
    const store = createManagedPdfTempStore({ tmpdir, ttlMs: 60_000 })
    const openPath = vi.fn(async (target: string) => {
      expect(readFileSync(target, 'utf8')).toBe('%PDF-1.4\n')
      expect(path.extname(target)).toBe('.pdf')
      expect(target.startsWith(path.join(tmpdir, 'forge-open-pdf'))).toBe(true)
      return 'No application found'
    })

    await expect(openPdfIpcRequest(
      { bytes: Buffer.from('%PDF-1.4\n'), fileName: 'spec.pdf' },
      openPath,
      store,
    )).resolves.toEqual({
      success: false,
      error: 'No application found',
    })
    expect(openPath).toHaveBeenCalledTimes(1)
    expect(existsSync(openPath.mock.calls[0]![0])).toBe(false)
    store.dispose()
  })

  it('rejects oversized or non-PDF byte payloads without writing a temp file', async () => {
    const tmpdir = tempRoot()
    const store = createManagedPdfTempStore({ tmpdir })
    const openPath = vi.fn(async () => '')
    await expect(openPdfIpcRequest({ bytes: Buffer.from('hello') }, openPath, store)).resolves.toEqual({
      success: false,
      error: 'Invalid PDF bytes',
    })
    expect(openPath).not.toHaveBeenCalled()
    store.dispose()
  })
})

describe('installOpenPdfIpc', () => {
  it('restricts PDF opening to the trusted renderer and only regular PDF files', async () => {
    const root = tempRoot()
    const pdfPath = writePdf(root)
    const handlers = new Map<string, (event: unknown, request: unknown) => unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, listener: (event: unknown, request: unknown) => unknown) => {
        handlers.set(channel, listener)
      }),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    }
    const openPath = vi.fn(async () => '')
    const trustedEvent = { sender: 'trusted' }
    const dispose = installOpenPdfIpc({
      ipcMain,
      isTrustedSender: (event) => event === trustedEvent,
      openPath,
      tmpdir: root,
    })
    const invoke = handlers.get(OPEN_PDF_IN_DEFAULT_APP_CHANNEL)
    if (!invoke) throw new Error('Expected PDF open IPC handler')

    await expect(invoke({ sender: 'guest' }, { filePath: pdfPath })).resolves.toEqual({
      success: false,
      error: 'Unauthorized',
    })
    expect(openPath).not.toHaveBeenCalled()

    await expect(invoke(trustedEvent, { filePath: pdfPath })).resolves.toEqual({ success: true })
    expect(openPath).toHaveBeenCalledWith(pdfPath)

    openPath.mockClear()
    await expect(invoke(trustedEvent, { filePath: '/bin/sh' })).resolves.toEqual({
      success: false,
      error: 'Not a PDF file',
    })
    await expect(invoke(trustedEvent, { filePath: root })).resolves.toEqual({
      success: false,
      error: 'Not a PDF file',
    })
    expect(openPath).not.toHaveBeenCalled()

    dispose()
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(OPEN_PDF_IN_DEFAULT_APP_CHANNEL)
  })

  it('expires materialized PDF temps on the scoped lifecycle timer', async () => {
    const tmpdir = tempRoot()
    const timers: Array<{ id: number; callback: () => void }> = []
    let nextId = 1
    const store = createManagedPdfTempStore({
      tmpdir,
      setTimeoutFn: (callback) => {
        const id = nextId++
        timers.push({ id, callback })
        return id
      },
      clearTimeoutFn: (id) => {
        const index = timers.findIndex((timer) => timer.id === id)
        if (index >= 0) timers.splice(index, 1)
      },
    })
    const openPath = vi.fn(async () => '')
    const result = await openPdfIpcRequest({ bytes: Buffer.from('%PDF-1.4\n') }, openPath, store)
    expect(result).toEqual({ success: true })
    const opened = openPath.mock.calls[0]![0]
    expect(existsSync(opened)).toBe(true)
    expect(timers).toHaveLength(1)
    timers[0]!.callback()
    expect(existsSync(opened)).toBe(false)
    store.dispose()
  })
})

describe('window-open PDF policy', () => {
  it('denies renderer blob, file, and javascript URLs and never forwards them to shell.openExternal', () => {
    const openExternal = vi.fn(async () => undefined)
    for (const url of [
      'blob:https://forge.example.test/pdf',
      'file:///tmp/spec.pdf',
      'javascript:alert(1)',
    ]) {
      expect(handleMainRendererWindowOpen(url, {
        openExternal,
        handleDeepLink: () => false,
      })).toEqual({ action: 'deny' })
    }
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('still opens trusted http(s) renderer windows through the external handler', () => {
    const openExternal = vi.fn(async () => undefined)
    expect(handleMainRendererWindowOpen('https://forge.example.test/api/files/raw?path=spec.pdf', {
      openExternal,
      handleDeepLink: () => false,
    })).toEqual({ action: 'deny' })
    expect(openExternal).toHaveBeenCalledWith('https://forge.example.test/api/files/raw?path=spec.pdf')
  })
})

describe('main-process PDF open wiring', () => {
  it('installs the trusted PDF-only IPC and window-open policy instead of a generic path launcher', async () => {
    const mainSource = await readFile(new URL('../main.ts', import.meta.url), 'utf8')
    const preloadSource = await readFile(new URL('../preload.ts', import.meta.url), 'utf8')

    expect(mainSource).toContain("installOpenPdfIpc({")
    expect(mainSource).toContain('isTrustedSender: isTrustedMainRenderer')
    expect(mainSource).toContain('handleMainRendererWindowOpen(url')
    expect(mainSource).toContain('isUnsafeRendererWindowOpenUrl(url)')
    expect(mainSource).not.toContain('open-path-in-default-app')
    expect(mainSource).not.toContain('openValidatedPathInDefaultApp')
    expect(preloadSource).toContain("from './open-pdf-ipc.js'")
    expect(preloadSource).toContain('ipcRenderer.invoke(OPEN_PDF_IN_DEFAULT_APP_CHANNEL, request)')
    expect(preloadSource).not.toContain("from './open-pdf.js'")
    expect(preloadSource).not.toContain('open-path-in-default-app')
    expect(preloadSource).not.toContain('openPathInDefaultApp')
  })
})
