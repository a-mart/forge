/** @vitest-environment jsdom */

import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MermaidBlock } from './MermaidBlock'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  })
})

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
  document.documentElement.classList.remove('dark')
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function renderMermaid(code: string) {
  flushSync(() => {
    root.render(createElement(MermaidBlock, { code }))
  })
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

function getInlineIframe(): HTMLIFrameElement {
  const iframe = container.querySelector('iframe[title="Mermaid diagram preview"]')
  expect(iframe).toBeTruthy()
  return iframe as HTMLIFrameElement
}

function attachContentWindow(iframe: HTMLIFrameElement) {
  const contentWindow = {
    postMessage: vi.fn(),
  } as unknown as Window

  Object.defineProperty(iframe, 'contentWindow', {
    configurable: true,
    value: contentWindow,
  })

  return contentWindow
}

function getInstanceId(iframe: HTMLIFrameElement): string {
  const src = iframe.getAttribute('src')
  expect(src).toBeTruthy()
  const url = new URL(src!, 'http://localhost')
  const instanceId = url.searchParams.get('instanceId')
  expect(instanceId).toBeTruthy()
  return instanceId!
}

function dispatchFrameMessage(contentWindow: Window, data: Record<string, unknown>) {
  const event = new MessageEvent('message', { data })
  Object.defineProperty(event, 'source', {
    configurable: true,
    value: contentWindow,
  })

  act(() => {
    window.dispatchEvent(event)
  })
}

function getLatestPostedMessage(contentWindow: Window) {
  const calls = vi.mocked(contentWindow.postMessage).mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return calls.at(-1)?.[0] as Record<string, unknown>
}

describe('MermaidBlock', () => {
  it('shows source immediately and resolves iframe src from the backend URL', () => {
    renderMermaid('graph LR; A-->B')

    expect(container.textContent).toContain('graph LR; A-->B')

    const iframe = getInlineIframe()
    const iframeUrl = new URL(iframe.src)
    expect(iframeUrl.pathname).toBe('/mermaid-preview/embed')
    expect(iframeUrl.searchParams.get('instanceId')).toBeTruthy()
    expect(iframeUrl.searchParams.get('theme')).toBe('light')
    expect(container.querySelector('[aria-label="Download SVG"]')).toBeNull()
  })

  it('auto-switches to the diagram view after a successful iframe render', async () => {
    renderMermaid('graph LR; A-->B')

    const iframe = getInlineIframe()
    const contentWindow = attachContentWindow(iframe)
    const instanceId = getInstanceId(iframe)

    dispatchFrameMessage(contentWindow, {
      type: 'forge:mermaid-ready',
      instanceId,
    })
    await flush()

    const renderMessage = getLatestPostedMessage(contentWindow)
    dispatchFrameMessage(contentWindow, {
      type: 'forge:mermaid-rendered',
      instanceId,
      requestId: renderMessage.requestId as string,
      height: 360,
    })
    await flush()

    expect(container.querySelector('[aria-label="Show source"]')).toBeTruthy()
    expect(container.querySelector('[aria-label="Download SVG"]')).toBeTruthy()
    expect(container.querySelector('[aria-label="Download PNG"]')).toBeTruthy()
    expect(container.querySelector('[aria-label="Expand diagram"]')).toBeTruthy()
  })

  it('ignores bridge messages from the wrong source or instance', async () => {
    renderMermaid('graph LR; A-->B')

    const iframe = getInlineIframe()
    const contentWindow = attachContentWindow(iframe)
    const instanceId = getInstanceId(iframe)

    dispatchFrameMessage(
      { postMessage: vi.fn() } as unknown as Window,
      {
        type: 'forge:mermaid-ready',
        instanceId,
      },
    )
    await flush()
    expect(vi.mocked(contentWindow.postMessage).mock.calls.length).toBe(0)

    dispatchFrameMessage(contentWindow, {
      type: 'forge:mermaid-ready',
      instanceId,
    })
    await flush()

    const renderMessage = getLatestPostedMessage(contentWindow)
    dispatchFrameMessage(contentWindow, {
      type: 'forge:mermaid-rendered',
      instanceId: `${instanceId}-other`,
      requestId: renderMessage.requestId as string,
      height: 300,
    })
    await flush()

    expect(container.querySelector('[aria-label="Download SVG"]')).toBeNull()
  })

  it('re-sends a render request when the theme changes without changing the iframe URL', async () => {
    renderMermaid('graph LR; A-->B')

    const iframe = getInlineIframe()
    const initialIframeSrc = iframe.src
    const contentWindow = attachContentWindow(iframe)
    const instanceId = getInstanceId(iframe)

    dispatchFrameMessage(contentWindow, {
      type: 'forge:mermaid-ready',
      instanceId,
    })
    await flush()

    const initialRender = getLatestPostedMessage(contentWindow)
    expect(initialRender.themeMode).toBe('light')

    act(() => {
      document.documentElement.classList.add('dark')
    })
    await flush()

    const rerenderMessage = getLatestPostedMessage(contentWindow)
    expect(rerenderMessage.type).toBe('forge:mermaid-render')
    expect(rerenderMessage.themeMode).toBe('dark')
    expect(getInlineIframe().src).toBe(initialIframeSrc)
  })

  it('falls back to source-only UI when the iframe never reports ready', async () => {
    vi.useFakeTimers()
    renderMermaid('graph LR; A-->B')

    const iframe = getInlineIframe()
    attachContentWindow(iframe)

    act(() => {
      iframe.dispatchEvent(new Event('load'))
    })

    await act(async () => {
      vi.advanceTimersByTime(15_001)
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Diagram error')
    expect(container.textContent).toContain('graph LR; A-->B')
  })

  it('keeps the source fallback available when the iframe reports a render error', async () => {
    renderMermaid('graph invalid!!!')

    const iframe = getInlineIframe()
    const contentWindow = attachContentWindow(iframe)
    const instanceId = getInstanceId(iframe)

    dispatchFrameMessage(contentWindow, {
      type: 'forge:mermaid-ready',
      instanceId,
    })
    await flush()

    const renderMessage = getLatestPostedMessage(contentWindow)
    dispatchFrameMessage(contentWindow, {
      type: 'forge:mermaid-error',
      instanceId,
      requestId: renderMessage.requestId as string,
      error: 'Parse failure',
    })
    await flush()

    expect(container.textContent).toContain('Diagram error')
    expect(container.textContent).toContain('graph invalid!!!')
    expect(container.querySelector('[aria-label="Download SVG"]')).toBeNull()
  })

  it('exports SVG via the iframe bridge', async () => {
    const createObjectURL = vi.fn(() => 'blob:diagram-svg')
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: createObjectURL,
    })
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {})

    renderMermaid('graph LR; A-->B')

    const iframe = getInlineIframe()
    const contentWindow = attachContentWindow(iframe)
    const instanceId = getInstanceId(iframe)

    dispatchFrameMessage(contentWindow, {
      type: 'forge:mermaid-ready',
      instanceId,
    })
    await flush()

    const renderMessage = getLatestPostedMessage(contentWindow)
    dispatchFrameMessage(contentWindow, {
      type: 'forge:mermaid-rendered',
      instanceId,
      requestId: renderMessage.requestId as string,
      height: 360,
    })
    await flush()

    await act(async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (container.querySelector('[aria-label="Download SVG"]')) {
          return
        }
        await Promise.resolve()
      }
    })

    vi.mocked(contentWindow.postMessage).mockClear()

    const downloadButton = container.querySelector('[aria-label="Download SVG"]') as HTMLButtonElement | null
    expect(downloadButton).toBeTruthy()
    act(() => {
      downloadButton?.click()
    })
    await flush()

    const exportMessage = getLatestPostedMessage(contentWindow)
    expect(exportMessage.type).toBe('forge:mermaid-export-svg')

    dispatchFrameMessage(contentWindow, {
      type: 'forge:mermaid-export-svg-result',
      instanceId,
      requestId: exportMessage.requestId as string,
      svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    })
    await flush()

    expect(createObjectURL).toHaveBeenCalled()
    expect(anchorClick).toHaveBeenCalled()
  })

  it('opens fullscreen with a second isolated iframe renderer', async () => {
    renderMermaid('graph LR; A-->B')

    const iframe = getInlineIframe()
    const contentWindow = attachContentWindow(iframe)
    const instanceId = getInstanceId(iframe)

    dispatchFrameMessage(contentWindow, {
      type: 'forge:mermaid-ready',
      instanceId,
    })
    await flush()

    const renderMessage = getLatestPostedMessage(contentWindow)
    dispatchFrameMessage(contentWindow, {
      type: 'forge:mermaid-rendered',
      instanceId,
      requestId: renderMessage.requestId as string,
      height: 360,
    })
    await flush()

    await act(async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (container.querySelector('[aria-label="Expand diagram"]')) {
          return
        }
        await Promise.resolve()
      }
    })

    const expandButton = container.querySelector('[aria-label="Expand diagram"]') as HTMLButtonElement | null
    expect(expandButton).toBeTruthy()
    act(() => {
      expandButton?.click()
    })
    await flush()

    const zoomIframe = document.querySelector('iframe[title="Expanded Mermaid diagram preview"]')
    expect(zoomIframe).toBeTruthy()
  })

  it('sends a forge:mermaid-ping on iframe load to recover from a missed READY', async () => {
    renderMermaid('graph LR; A-->B')

    const iframe = getInlineIframe()
    const contentWindow = attachContentWindow(iframe)
    const instanceId = getInstanceId(iframe)

    // Simulate iframe load WITHOUT dispatching forge:mermaid-ready first.
    // This is the race scenario where READY fires before the React listener
    // is attached and is therefore lost.
    act(() => {
      iframe.dispatchEvent(new Event('load'))
    })
    await flush()

    // Parent should have posted a forge:mermaid-ping to the child to
    // request a re-post of the READY message.
    const allCalls = vi.mocked(contentWindow.postMessage).mock.calls
    const pingCalls = allCalls.filter(
      (call) => (call[0] as Record<string, unknown>)?.type === 'forge:mermaid-ping',
    )
    expect(pingCalls.length).toBeGreaterThanOrEqual(1)

    const pingMessage = pingCalls[0]![0] as Record<string, unknown>
    expect(pingMessage.instanceId).toBe(instanceId)

    // Now simulate the child responding with READY (as it would after a ping)
    dispatchFrameMessage(contentWindow, {
      type: 'forge:mermaid-ready',
      instanceId,
    })
    await flush()

    // Parent should have sent a render request after receiving READY
    const renderMessage = getLatestPostedMessage(contentWindow)
    expect(renderMessage.type).toBe('forge:mermaid-render')
    expect(renderMessage.code).toBe('graph LR; A-->B')
    expect(renderMessage.instanceId).toBe(instanceId)
  })

  it('completes full render lifecycle even when initial READY is missed', async () => {
    renderMermaid('graph LR; A-->B')

    const iframe = getInlineIframe()
    const contentWindow = attachContentWindow(iframe)
    const instanceId = getInstanceId(iframe)

    // Simulate onLoad (no READY dispatched — it was "lost")
    act(() => {
      iframe.dispatchEvent(new Event('load'))
    })
    await flush()

    // Respond to ping with READY
    dispatchFrameMessage(contentWindow, {
      type: 'forge:mermaid-ready',
      instanceId,
    })
    await flush()

    // Get the render request and simulate successful render
    const renderMessage = getLatestPostedMessage(contentWindow)
    expect(renderMessage.type).toBe('forge:mermaid-render')

    dispatchFrameMessage(contentWindow, {
      type: 'forge:mermaid-rendered',
      instanceId,
      requestId: renderMessage.requestId as string,
      height: 400,
    })
    await flush()

    // Should switch to diagram view and show toolbar actions
    expect(container.querySelector('[aria-label="Show source"]')).toBeTruthy()
    expect(container.querySelector('[aria-label="Download SVG"]')).toBeTruthy()
    expect(container.querySelector('[aria-label="Expand diagram"]')).toBeTruthy()
  })
})
