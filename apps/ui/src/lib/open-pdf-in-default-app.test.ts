/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { isAbsoluteLocalFilePath, openPdfInDefaultApp } from './open-pdf-in-default-app'

afterEach(() => {
  Reflect.deleteProperty(window, 'electronBridge')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('isAbsoluteLocalFilePath', () => {
  it('accepts POSIX and Windows absolute paths only', () => {
    expect(isAbsoluteLocalFilePath('/tmp/spec.pdf')).toBe(true)
    expect(isAbsoluteLocalFilePath('D:/docs/spec.pdf')).toBe(true)
    expect(isAbsoluteLocalFilePath('docs/spec.pdf')).toBe(false)
  })
})

describe('openPdfInDefaultApp', () => {
  it('opens an absolute path through the desktop PDF bridge when available', async () => {
    const openPdfInDefaultAppBridge = vi.fn(async () => ({ success: true as const }))
    Object.defineProperty(window, 'electronBridge', {
      configurable: true,
      value: {
        windowRole: 'main',
        backendWsUrl: 'ws://127.0.0.1/socket',
        openPdfInDefaultApp: openPdfInDefaultAppBridge,
      },
    })

    await expect(openPdfInDefaultApp({
      filePath: '/tmp/spec.pdf',
      fallbackUrl: 'https://forge.example.test/api/files/raw?path=spec.pdf',
    })).resolves.toEqual({ opened: 'native' })
    expect(openPdfInDefaultAppBridge).toHaveBeenCalledWith({ filePath: '/tmp/spec.pdf' })
  })

  it('falls back to a new tab for http(s) URLs in the web app', async () => {
    const windowOpen = vi.fn()
    vi.stubGlobal('open', windowOpen)

    await expect(openPdfInDefaultApp({
      filePath: 'docs/spec.pdf',
      fallbackUrl: 'https://forge.example.test/api/files/raw?path=spec.pdf',
    })).resolves.toEqual({ opened: 'fallback' })
    expect(windowOpen).toHaveBeenCalledWith(
      'https://forge.example.test/api/files/raw?path=spec.pdf',
      '_blank',
      'noopener,noreferrer',
    )
  })

  it('keeps a working new-tab fallback for web blob URLs', async () => {
    const windowOpen = vi.fn()
    vi.stubGlobal('open', windowOpen)

    await expect(openPdfInDefaultApp({
      fallbackUrl: 'blob:https://forge.example.test/pdf',
    })).resolves.toEqual({ opened: 'fallback' })
    expect(windowOpen).toHaveBeenCalledWith(
      'blob:https://forge.example.test/pdf',
      '_blank',
      'noopener,noreferrer',
    )
  })

  it('materializes Electron blob bytes through the PDF-only bridge instead of window.open', async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])
    const openPdfInDefaultAppBridge = vi.fn(async () => ({ success: true as const }))
    const windowOpen = vi.fn()
    Object.defineProperty(window, 'electronBridge', {
      configurable: true,
      value: {
        windowRole: 'main',
        backendWsUrl: 'ws://127.0.0.1/socket',
        openPdfInDefaultApp: openPdfInDefaultAppBridge,
      },
    })
    vi.stubGlobal('open', windowOpen)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(pdfBytes, {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    })))

    await expect(openPdfInDefaultApp({
      fallbackUrl: 'blob:https://forge.example.test/pdf',
      fileName: 'spec.pdf',
    })).resolves.toEqual({ opened: 'native' })
    expect(openPdfInDefaultAppBridge).toHaveBeenCalledWith({
      bytes: pdfBytes,
      fileName: 'spec.pdf',
    })
    expect(windowOpen).not.toHaveBeenCalled()
  })

  it('surfaces a genuine Electron blob-open failure instead of claiming success', async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])
    const openPdfInDefaultAppBridge = vi.fn(async () => ({ success: false as const, error: 'No application found' }))
    const windowOpen = vi.fn()
    Object.defineProperty(window, 'electronBridge', {
      configurable: true,
      value: {
        windowRole: 'main',
        backendWsUrl: 'ws://127.0.0.1/socket',
        openPdfInDefaultApp: openPdfInDefaultAppBridge,
      },
    })
    vi.stubGlobal('open', windowOpen)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(pdfBytes, { status: 200 })))

    await expect(openPdfInDefaultApp({
      filePath: '/tmp/missing.pdf',
      fallbackUrl: 'blob:https://forge.example.test/pdf',
    })).resolves.toEqual({ opened: 'none', error: 'No application found' })
    expect(windowOpen).not.toHaveBeenCalled()
  })

  it('uses an http fallback tab in Electron when a native path fails', async () => {
    const openPdfInDefaultAppBridge = vi.fn(async () => ({ success: false as const, error: 'File not found' }))
    const windowOpen = vi.fn()
    Object.defineProperty(window, 'electronBridge', {
      configurable: true,
      value: {
        windowRole: 'main',
        backendWsUrl: 'ws://127.0.0.1/socket',
        openPdfInDefaultApp: openPdfInDefaultAppBridge,
      },
    })
    vi.stubGlobal('open', windowOpen)

    await expect(openPdfInDefaultApp({
      filePath: '/tmp/missing.pdf',
      fallbackUrl: 'https://forge.example.test/ticket',
    })).resolves.toEqual({ opened: 'fallback' })
    expect(windowOpen).toHaveBeenCalledWith('https://forge.example.test/ticket', '_blank', 'noopener,noreferrer')
  })
})
