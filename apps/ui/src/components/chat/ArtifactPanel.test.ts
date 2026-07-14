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
  it('posts exact transcript provenance and renders a returned base64 PNG', async () => {
    const pngBase64 = 'iVBORw0KGgo='
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      path: '/private/tmp/result.png',
      binary: true,
      encoding: 'base64',
      contentType: 'image/png',
      content: pngBase64,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    renderPanel(imageArtifact())

    await waitFor(() => {
      expect(document.querySelector('img[alt="result.png"]')?.getAttribute('src'))
        .toBe(`data:image/png;base64,${pngBase64}`)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://forge.example.test/api/chat-artifacts/read')
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' })
    expect(JSON.parse(String(init?.body))).toEqual({
      transcriptAgentId: 'viewed-manager',
      messageId: 'message-7',
      path: '/tmp/result.png',
    })
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
