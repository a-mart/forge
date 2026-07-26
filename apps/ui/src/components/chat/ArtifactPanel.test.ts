/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ArtifactReference } from '@/lib/artifacts'
import { ArtifactPanel } from './ArtifactPanel'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'electronBridge')
  Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
})

function renderPanel(artifact: ArtifactReference) {
  act(() => {
    root.render(createElement(
      TooltipProvider,
      null,
      createElement(ArtifactPanel, {
        artifact,
        wsUrl: 'wss://forge.example.test/socket?origin=remote',
        activeAgentId: 'fallback-manager',
        onClose: vi.fn(),
      }),
    ))
  })
}

function imageArtifact(overrides: Partial<ArtifactReference> = {}): ArtifactReference {
  return {
    path: '/tmp/result.png',
    fileName: 'result.png',
    href: 'swarm-file:///tmp/result.png',
    sourceAgentId: 'actor-worker',
    transcriptAgentId: 'viewed-manager',
    messageId: 'message-7',
    ...overrides,
  }
}

describe('ArtifactPanel transcript-authorized reads', () => {
  it('requests a bounded capable response and renders only a same-origin image ticket', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      path: '/private/tmp/result.png',
      binary: true,
      transport: 'http_ticket',
      contentType: 'image/png',
      totalBytes: 4 * 1024 * 1024,
      ticket: { url: '/api/chat-artifacts/tickets/opaque_ticket_token', expiresAt: new Date(Date.now() + 30_000).toISOString() },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    renderPanel(imageArtifact())

    await waitFor(() => {
      expect(document.querySelector('img[alt="result.png"]')?.getAttribute('src'))
        .toBe('https://forge.example.test/api/chat-artifacts/tickets/opaque_ticket_token')
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://forge.example.test/api/chat-artifacts/read')
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' })
    expect(JSON.parse(String(init?.body))).toEqual({
      transcriptAgentId: 'viewed-manager',
      messageId: 'message-7',
      path: '/tmp/result.png',
      previewBytes: 512 * 1024,
      imageTransport: 'http_ticket',
    })
  })

  it('performs one exact old-server compatibility retry and keeps the legacy base64 response', async () => {
    const pngBase64 = 'iVBORw0KGgo='
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body))
      if (request.imageTransport) {
        return new Response(JSON.stringify({ error: 'invalid_request', code: 'invalid_request' }), { status: 400 })
      }
      return new Response(JSON.stringify({ path: request.path, binary: true, encoding: 'base64', contentType: 'image/png', content: pngBase64 }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    renderPanel(imageArtifact())
    await waitFor(() => expect(document.querySelector('img[alt="result.png"]')?.getAttribute('src')).toBe(`data:image/png;base64,${pngBase64}`))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ transcriptAgentId: 'viewed-manager', messageId: 'message-7', path: '/tmp/result.png' })
  })

  it('rejects an uninspected cross-origin image ticket URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      path: '/tmp/result.png', binary: true, transport: 'http_ticket', contentType: 'image/png', totalBytes: 4,
      ticket: { url: 'https://attacker.example/image', expiresAt: new Date(Date.now() + 30_000).toISOString() },
    }), { status: 200 })))
    renderPanel(imageArtifact())
    await waitFor(() => expect(document.body.textContent).toContain('Invalid image ticket response.'))
    expect(document.querySelector('img[alt="result.png"]')).toBeNull()
  })

  it('renders bounded text metadata without requesting the discarded tail', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      path: '/tmp/report.txt', contentType: 'application/octet-stream', content: 'bounded', truncated: true, totalBytes: 2 * 1024 * 1024,
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    renderPanel(imageArtifact({ path: '/tmp/report.txt', fileName: 'report.txt', href: 'swarm-file:///tmp/report.txt' }))
    await waitFor(() => expect(document.body.textContent).toContain('Showing a bounded preview of 2,097,152 bytes.'))
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ previewBytes: 512 * 1024, imageTransport: 'http_ticket' })
  })

  it('keeps an absolute path outside the workspace openable in the editor and desktop folder', async () => {
    const externalPath = '/Users/adam/RedAlertEnhancements/reference/alpha bounds.png.txt'
    const revealInFolder = vi.fn(async () => undefined)
    Object.defineProperty(window, 'electronBridge', {
      configurable: true,
      value: { windowRole: 'main', backendWsUrl: 'ws://127.0.0.1/socket', revealInFolder },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      path: externalPath, contentType: 'application/octet-stream', content: 'external artifact',
    }), { status: 200 })))

    renderPanel(imageArtifact({ path: externalPath, fileName: 'alpha bounds.png.txt', href: `swarm-file://${externalPath}` }))

    await waitFor(() => expect(document.body.textContent).toContain('external artifact'))
    const editorLink = document.querySelector<HTMLAnchorElement>('a[href^="vscode-insiders://file"]')
    expect(editorLink?.getAttribute('href')).toBe('vscode-insiders://file/Users/adam/RedAlertEnhancements/reference/alpha%20bounds.png.txt')
    const revealButton = document.querySelector<HTMLButtonElement>('button[aria-label="Show in folder"]')
    expect(revealButton).not.toBeNull()
    act(() => revealButton?.click())
    expect(revealInFolder).toHaveBeenCalledWith(externalPath)
  })

  it('recognizes forward-slash Windows absolute paths for desktop folder reveal', async () => {
    const externalPath = 'D:/external-project/reference/result.txt'
    const revealInFolder = vi.fn(async () => undefined)
    Object.defineProperty(window, 'electronBridge', {
      configurable: true,
      value: { windowRole: 'main', backendWsUrl: 'ws://127.0.0.1/socket', revealInFolder },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      path: externalPath, contentType: 'application/octet-stream', content: 'windows artifact',
    }), { status: 200 })))

    renderPanel(imageArtifact({ path: externalPath, fileName: 'result.txt', href: `swarm-file:///${externalPath}` }))

    await waitFor(() => expect(document.body.textContent).toContain('windows artifact'))
    const revealButton = document.querySelector<HTMLButtonElement>('button[aria-label="Show in folder"]')
    expect(revealButton).not.toBeNull()
    act(() => revealButton?.click())
    expect(revealInFolder).toHaveBeenCalledWith(externalPath)
  })

  it('surfaces secure denial without falling back to the legacy read-file route', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
      JSON.stringify({ error: 'path_not_presented', code: 'path_not_presented' }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)

    renderPanel(imageArtifact())

    await waitFor(() => expect(document.body.textContent).toContain('path_not_presented'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/chat-artifacts/read')
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('/api/read-file')
  })

  it('surfaces malformed binary image responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      path: '/private/tmp/result.png',
      binary: true,
      encoding: 'base64',
      contentType: 'image/png',
      content: 'not base64!',
    }), { status: 200, headers: { 'content-type': 'application/json' } })))

    renderPanel(imageArtifact())

    await waitFor(() => expect(document.body.textContent).toContain('Invalid image response.'))
    expect(document.querySelector('img[alt="result.png"]')).toBeNull()
  })

  it('keeps the legacy image URL when transcript provenance is absent', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    renderPanel(imageArtifact({ transcriptAgentId: undefined, messageId: undefined }))

    await waitFor(() => {
      const src = document.querySelector('img[alt="result.png"]')?.getAttribute('src')
      expect(src).toContain('https://forge.example.test/api/read-file?')
      expect(src).toContain('agentId=actor-worker')
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
