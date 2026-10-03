import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OPEN_HTML_IN_BROWSER_CHANNEL, installOpenHtmlIpc, validateLocalHtmlFilePath } from '../open-html.js'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'forge-open-html-')))
  tempRoots.push(root)
  return root
}

function fakeIpcMain() {
  const handlers = new Map<string, (event: unknown, request: unknown) => unknown>()
  return {
    handlers,
    handle: (channel: string, listener: (event: unknown, request: unknown) => unknown) => { handlers.set(channel, listener) },
    removeHandler: (channel: string) => { handlers.delete(channel) },
  }
}

describe('validateLocalHtmlFilePath', () => {
  it('accepts existing absolute .html and .htm files', () => {
    const root = tempRoot()
    for (const name of ['report.html', 'legacy.HTM']) {
      const filePath = path.join(root, name)
      writeFileSync(filePath, '<html></html>')
      expect(validateLocalHtmlFilePath(filePath)).toEqual({ ok: true, path: filePath })
    }
  })

  it('rejects relative, missing, directory, non-HTML, and HTML-named symlinks to non-HTML targets', () => {
    const root = tempRoot()
    const script = path.join(root, 'payload.command')
    writeFileSync(script, '#!/bin/sh\n')
    const disguised = path.join(root, 'innocent.html')
    symlinkSync(script, disguised)
    const directory = path.join(root, 'folder.html')
    mkdirSync(directory)

    expect(validateLocalHtmlFilePath('report.html')).toEqual({ ok: false, error: 'Path must be absolute' })
    expect(validateLocalHtmlFilePath(path.join(root, 'missing.html'))).toEqual({ ok: false, error: 'File not found' })
    expect(validateLocalHtmlFilePath(directory)).toEqual({ ok: false, error: 'Not an HTML file' })
    expect(validateLocalHtmlFilePath(script)).toEqual({ ok: false, error: 'Not an HTML file' })
    expect(validateLocalHtmlFilePath(disguised)).toEqual({ ok: false, error: 'Not an HTML file' })
    expect(validateLocalHtmlFilePath('')).toEqual({ ok: false, error: 'Invalid file path' })
    expect(validateLocalHtmlFilePath(`${root}/a\0.html`)).toEqual({ ok: false, error: 'Invalid file path' })
    expect(validateLocalHtmlFilePath(42)).toEqual({ ok: false, error: 'Invalid file path' })
  })
})

describe('installOpenHtmlIpc', () => {
  it('opens a validated file for trusted senders only and reports open failures', async () => {
    const root = tempRoot()
    const filePath = path.join(root, 'report.html')
    writeFileSync(filePath, '<html></html>')
    const ipcMain = fakeIpcMain()
    const openPath = vi.fn(async () => '')
    const dispose = installOpenHtmlIpc({ ipcMain, isTrustedSender: (event) => event === 'trusted', openPath })
    const handler = ipcMain.handlers.get(OPEN_HTML_IN_BROWSER_CHANNEL)!

    expect(await handler('untrusted', filePath)).toEqual({ success: false, error: 'Unauthorized' })
    expect(openPath).not.toHaveBeenCalled()
    expect(await handler('trusted', path.join(root, 'missing.html'))).toEqual({ success: false, error: 'File not found' })
    expect(await handler('trusted', filePath)).toEqual({ success: true })
    expect(openPath).toHaveBeenCalledWith(filePath)

    openPath.mockResolvedValueOnce('No application')
    expect(await handler('trusted', filePath)).toEqual({ success: false, error: 'No application' })

    dispose()
    expect(ipcMain.handlers.has(OPEN_HTML_IN_BROWSER_CHANNEL)).toBe(false)
  })
})
