/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ArtifactReference } from '@/lib/artifacts'
import { ArtifactPanel } from './ArtifactPanel'

const pdfPreviewProps: Array<Record<string, unknown>> = []

vi.mock('@/components/file-browser/PdfPreview', () => ({
  PdfPreview: (props: Record<string, unknown>) => {
    pdfPreviewProps.push(props)
    return createElement('div', { 'data-testid': 'pdf-preview' })
  },
}))

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
  pdfPreviewProps.length = 0
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

function pdfArtifact(overrides: Partial<ArtifactReference> = {}): ArtifactReference {
  return {
    path: '/tmp/spec.pdf',
    fileName: 'spec.pdf',
    href: 'swarm-file:///tmp/spec.pdf',
    sourceAgentId: 'actor-worker',
    transcriptAgentId: 'viewed-manager',
    messageId: 'message-7',
    ...overrides,
  }
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

  it('requests a PDF ticket, renders the in-panel viewer from a blob URL, and keeps native-open on the authorized path', async () => {
    const ticketUrl = '/api/chat-artifacts/tickets/opaque_pdf_token'
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/chat-artifacts/read')) {
        return new Response(JSON.stringify({
          path: '/tmp/spec.pdf',
          binary: true,
          transport: 'http_ticket',
          contentType: 'application/pdf',
          totalBytes: 12,
          ticket: { url: ticketUrl, expiresAt: new Date(Date.now() + 30_000).toISOString() },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith(ticketUrl)) {
        return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const createObjectURL = vi.fn(() => 'blob:https://forge.example.test/pdf')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revokeObjectURL })

    renderPanel(pdfArtifact())

    await waitFor(() => {
      expect(document.querySelector('[data-testid="pdf-preview"]')).not.toBeNull()
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://forge.example.test/api/chat-artifacts/read')
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      transcriptAgentId: 'viewed-manager',
      messageId: 'message-7',
      path: '/tmp/spec.pdf',
      previewBytes: 512 * 1024,
      imageTransport: 'http_ticket',
    })
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('https://forge.example.test/api/chat-artifacts/tickets/opaque_pdf_token')
    expect(pdfPreviewProps.at(-1)).toMatchObject({
      sourceUrl: 'blob:https://forge.example.test/pdf',
      fileName: 'spec.pdf',
      nativeFilePath: '/tmp/spec.pdf',
      openUrl: 'blob:https://forge.example.test/pdf',
    })
  })

  it('rejects an uninspected cross-origin PDF ticket URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      path: '/tmp/spec.pdf', binary: true, transport: 'http_ticket', contentType: 'application/pdf', totalBytes: 12,
      ticket: { url: 'https://attacker.example/pdf', expiresAt: new Date(Date.now() + 30_000).toISOString() },
    }), { status: 200 })))
    renderPanel(pdfArtifact())
    await waitFor(() => expect(document.body.textContent).toContain('Invalid PDF ticket response.'))
    expect(document.querySelector('[data-testid="pdf-preview"]')).toBeNull()
  })

  it('keeps the legacy PDF URL when transcript provenance is absent', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    renderPanel(pdfArtifact({ transcriptAgentId: undefined, messageId: undefined }))
    await waitFor(() => {
      expect(document.querySelector('[data-testid="pdf-preview"]')).not.toBeNull()
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(pdfPreviewProps.at(-1)).toMatchObject({
      sourceUrl: expect.stringContaining('https://forge.example.test/api/read-file?'),
      nativeFilePath: '/tmp/spec.pdf',
    })
    expect(String(pdfPreviewProps.at(-1)?.sourceUrl)).toContain('agentId=actor-worker')
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

function htmlArtifact(overrides: Partial<ArtifactReference> = {}): ArtifactReference {
  return {
    path: '/Users/adam/reports/dashboard.html',
    fileName: 'dashboard.html',
    href: 'swarm-file:///Users/adam/reports/dashboard.html',
    sourceAgentId: 'actor-worker',
    transcriptAgentId: 'viewed-manager',
    messageId: 'message-7',
    ...overrides,
  }
}

describe('ArtifactPanel HTML artifacts', () => {
  const html = '<!doctype html><html><body><h1>Quarterly dashboard</h1><script>document.title = "x"</script></body></html>'

  function stubHtmlRead() {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      path: '/Users/adam/reports/dashboard.html', contentType: 'text/html; charset=utf-8', content: html, truncated: false, totalBytes: html.length,
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('renders the page in an opaque-origin sandboxed frame instead of raw source', async () => {
    const fetchMock = stubHtmlRead()
    renderPanel(htmlArtifact())

    const frame = await waitFor(() => {
      const element = document.querySelector<HTMLIFrameElement>('iframe[title="dashboard.html"]')
      expect(element).not.toBeNull()
      return element!
    })
    expect(frame.getAttribute('srcdoc')).toBe(html)
    const sandbox = frame.getAttribute('sandbox')?.split(/\s+/) ?? []
    expect(sandbox).toContain('allow-scripts')
    expect(sandbox).not.toContain('allow-same-origin')
    expect(sandbox).not.toContain('allow-top-navigation')
    expect(document.querySelector('pre code')).toBeNull()
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ previewBytes: 2 * 1024 * 1024 })
  })

  it('toggles between the rendered preview and the HTML source', async () => {
    stubHtmlRead()
    renderPanel(htmlArtifact())
    await waitFor(() => expect(document.querySelector('iframe[title="dashboard.html"]')).not.toBeNull())

    const sourceButton = document.querySelector<HTMLButtonElement>('button[aria-label="Show HTML source"]')
    expect(sourceButton).not.toBeNull()
    act(() => sourceButton?.click())
    expect(document.querySelector('iframe[title="dashboard.html"]')).toBeNull()
    expect(document.querySelector('pre code')?.textContent).toBe(html)

    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Show rendered preview"]')?.click())
    expect(document.querySelector('iframe[title="dashboard.html"]')).not.toBeNull()
  })

  it('opens the local file in the external browser and reveals it in its folder on desktop', async () => {
    const openHtmlInBrowser = vi.fn(async () => ({ success: true as const }))
    const revealInFolder = vi.fn(async () => undefined)
    Object.defineProperty(window, 'electronBridge', {
      configurable: true,
      value: { windowRole: 'main', backendWsUrl: 'ws://127.0.0.1/socket', revealInFolder, openHtmlInBrowser },
    })
    stubHtmlRead()
    renderPanel(htmlArtifact())
    await waitFor(() => expect(document.querySelector('iframe[title="dashboard.html"]')).not.toBeNull())

    const openButton = document.querySelector<HTMLButtonElement>('button[aria-label="Open in browser"]')
    expect(openButton).not.toBeNull()
    await act(async () => openButton?.click())
    expect(openHtmlInBrowser).toHaveBeenCalledWith('/Users/adam/reports/dashboard.html')

    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Show in folder"]')?.click())
    expect(revealInFolder).toHaveBeenCalledWith('/Users/adam/reports/dashboard.html')
  })

  it('surfaces a desktop open failure in the panel', async () => {
    Object.defineProperty(window, 'electronBridge', {
      configurable: true,
      value: {
        windowRole: 'main',
        backendWsUrl: 'ws://127.0.0.1/socket',
        openHtmlInBrowser: vi.fn(async () => ({ success: false as const, error: 'File not found' })),
      },
    })
    stubHtmlRead()
    renderPanel(htmlArtifact())
    await waitFor(() => expect(document.querySelector('iframe[title="dashboard.html"]')).not.toBeNull())
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Open in browser"]')?.click())
    await waitFor(() => expect(document.body.textContent).toContain('File not found'))
  })
})

describe('ArtifactPanel resizing', () => {
  it('drags the left edge to resize, keeps the HTML frame from swallowing the drag, and persists the width', async () => {
    vi.stubGlobal('innerWidth', 2000)
    window.localStorage.removeItem('forge-artifact-panel-width')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      path: '/Users/adam/reports/dashboard.html', contentType: 'text/html', content: '<h1>hi</h1>', truncated: false, totalBytes: 11,
    }), { status: 200 })))
    renderPanel(htmlArtifact())
    const frame = await waitFor(() => {
      const element = document.querySelector<HTMLIFrameElement>('iframe[title="dashboard.html"]')
      expect(element).not.toBeNull()
      return element!
    })

    const handle = document.querySelector<HTMLElement>('[role="separator"][aria-label="Resize artifact panel"]')
    expect(handle).not.toBeNull()
    expect(handle?.getAttribute('aria-valuenow')).toBe('880')

    act(() => { handle!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 1000 })) })
    expect(frame.className).toContain('pointer-events-none')
    act(() => { document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 800 })) })
    expect(handle?.getAttribute('aria-valuenow')).toBe('1080')
    act(() => { document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })) })

    expect(frame.className).not.toContain('pointer-events-none')
    expect(window.localStorage.getItem('forge-artifact-panel-width')).toBe('1080')
    const panel = handle!.parentElement!
    expect(panel.style.getPropertyValue('--artifact-panel-width')).toBe('1080px')
  })
})

describe('ArtifactPanel HTML header actions', () => {
  function stubRead() {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      path: '/Users/adam/reports/dashboard.html', contentType: 'text/html', content: '<h1>hi</h1>', truncated: false, totalBytes: 11,
    }), { status: 200 })))
  }

  it('offers the external browser instead of the code editor for HTML', async () => {
    Object.defineProperty(window, 'electronBridge', {
      configurable: true,
      value: { windowRole: 'main', backendWsUrl: 'ws://127.0.0.1/socket', openHtmlInBrowser: vi.fn(), revealInFolder: vi.fn() },
    })
    stubRead()
    renderPanel(htmlArtifact())
    await waitFor(() => expect(document.querySelector('iframe[title="dashboard.html"]')).not.toBeNull())
    expect(document.querySelector('a[href^="vscode"], a[href^="cursor"]')).toBeNull()
    expect(document.querySelector('button[aria-label="Open in browser"]')).not.toBeNull()
    expect(document.querySelector('button[aria-label="Show in folder"]')).not.toBeNull()
  })

  it('keeps the browser action visible and explains a restart when the desktop bridge predates it', async () => {
    Object.defineProperty(window, 'electronBridge', {
      configurable: true,
      value: { windowRole: 'main', backendWsUrl: 'ws://127.0.0.1/socket', revealInFolder: vi.fn() },
    })
    stubRead()
    renderPanel(htmlArtifact())
    await waitFor(() => expect(document.querySelector('iframe[title="dashboard.html"]')).not.toBeNull())
    const openButton = document.querySelector<HTMLButtonElement>('button[aria-label="Open in browser"]')
    expect(openButton).not.toBeNull()
    await act(async () => openButton?.click())
    await waitFor(() => expect(document.body.textContent).toContain('Restart Forge to open HTML files in your browser.'))
  })
})
