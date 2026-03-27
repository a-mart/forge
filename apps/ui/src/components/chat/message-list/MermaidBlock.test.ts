/** @vitest-environment jsdom */

import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mock mermaid
// ---------------------------------------------------------------------------

const mockInitialize = vi.fn()
const mockRender = vi.fn()

vi.mock('mermaid', () => ({
  default: {
    initialize: (...args: unknown[]) => mockInitialize(...args),
    render: (...args: unknown[]) => mockRender(...args),
  },
}))

// ---------------------------------------------------------------------------
// Import component under test (after mocks are set up)
// ---------------------------------------------------------------------------

import { MermaidBlock } from './MermaidBlock'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mockInitialize.mockReset()
  mockRender.mockReset()
})

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
})

/** Flush pending microtasks so the async effect inside MermaidBlock completes. */
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

function render(code: string, isDocument = false) {
  flushSync(() => {
    root.render(createElement(MermaidBlock, { code, isDocument }))
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MermaidBlock', () => {
  // -----------------------------------------------------------------------
  // Important #1 — strict security config enforcement
  // -----------------------------------------------------------------------

  it('always calls mermaid.initialize with securityLevel strict before render', async () => {
    mockRender.mockResolvedValue({ svg: '<svg><text>Hello</text></svg>' })

    render('graph LR; A-->B')
    await flush()

    expect(mockInitialize).toHaveBeenCalledTimes(1)
    expect(mockInitialize).toHaveBeenCalledWith(
      expect.objectContaining({
        startOnLoad: false,
        securityLevel: 'strict',
      }),
    )

    // Verify initialize is called before render
    const initOrder = mockInitialize.mock.invocationCallOrder[0]
    const renderOrder = mockRender.mock.invocationCallOrder[0]
    expect(initOrder).toBeLessThan(renderOrder!)
  })

  it('re-asserts strict config on every render cycle, not just theme changes', async () => {
    mockRender.mockResolvedValue({ svg: '<svg><text>v1</text></svg>' })

    render('graph LR; A-->B')
    await flush()

    expect(mockInitialize).toHaveBeenCalledTimes(1)

    // Re-render with different code but same theme
    mockRender.mockResolvedValue({ svg: '<svg><text>v2</text></svg>' })
    render('graph LR; A-->C')
    await flush()

    // Should have called initialize again (not skipped due to same theme)
    expect(mockInitialize).toHaveBeenCalledTimes(2)
    for (const call of mockInitialize.mock.calls) {
      expect(call[0]).toMatchObject({ securityLevel: 'strict' })
    }
  })

  // -----------------------------------------------------------------------
  // Important #2 — SVG sanitization
  // -----------------------------------------------------------------------

  it('strips script tags from rendered SVG before DOM injection', async () => {
    const maliciousSvg =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert("xss")</script><text>Safe</text></svg>'
    mockRender.mockResolvedValue({ svg: maliciousSvg })

    render('graph LR; A-->B')
    await flush()

    // The rendered content should not contain any script tags
    expect(container.innerHTML).not.toContain('<script>')
    expect(container.innerHTML).not.toContain('alert("xss")')
    // But should still have the safe text content
    expect(container.innerHTML).toContain('Safe')
  })

  it('strips onload event handlers from SVG before DOM injection', async () => {
    const maliciousSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><text>OK</text></svg>'
    mockRender.mockResolvedValue({ svg: maliciousSvg })

    render('graph LR; A-->B')
    await flush()

    expect(container.innerHTML).not.toContain('onload')
    expect(container.innerHTML).not.toContain('alert(1)')
    expect(container.innerHTML).toContain('OK')
  })

  it('strips foreignObject from SVG before DOM injection', async () => {
    const maliciousSvg =
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body><script>alert(1)</script></body></foreignObject><text>OK</text></svg>'
    mockRender.mockResolvedValue({ svg: maliciousSvg })

    render('graph LR; A-->B')
    await flush()

    expect(container.innerHTML).not.toContain('foreignObject')
    expect(container.innerHTML).not.toContain('<script>')
  })

  // -----------------------------------------------------------------------
  // Important #2 — Error / fallback UI
  // -----------------------------------------------------------------------

  it('shows error fallback UI when mermaid render throws', async () => {
    mockRender.mockRejectedValue(new Error('Parse error: invalid syntax'))

    render('graph invalid!!!')
    await flush()

    // Should show error banner
    expect(container.textContent).toContain('Diagram error')
    // Should show raw source code as fallback
    expect(container.textContent).toContain('graph invalid!!!')
  })

  it('shows error fallback UI when mermaid import fails', async () => {
    // Temporarily override the mock to simulate import failure
    const originalRender = mockRender.getMockImplementation()
    mockInitialize.mockImplementation(() => {
      throw new Error('Module not found')
    })

    render('graph LR; A-->B')
    await flush()

    expect(container.textContent).toContain('Diagram error')

    // Restore
    mockInitialize.mockReset()
    if (originalRender) mockRender.mockImplementation(originalRender)
  })

  it('shows generic error message for non-Error exceptions', async () => {
    mockRender.mockRejectedValue('string error')

    render('graph LR; A-->B')
    await flush()

    expect(container.textContent).toContain('Diagram error')
  })

  // -----------------------------------------------------------------------
  // Source toggle behavior
  // -----------------------------------------------------------------------

  it('defaults to source view and shows code immediately', () => {
    mockRender.mockReturnValue(new Promise(() => {})) // never resolves

    render('graph LR; A-->B')

    // Should show source by default (not loading spinner)
    expect(container.textContent).toContain('graph LR; A-->B')
    // The source toggle button should be present and not disabled
    const buttons = container.querySelectorAll('button')
    const toggleBtn = Array.from(buttons).find(
      (b) => b.querySelector('svg') !== null,
    )
    expect(toggleBtn).toBeTruthy()
    expect(toggleBtn?.disabled).toBe(false)
  })

  it('auto-switches to diagram view after first successful render', async () => {
    mockRender.mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Diagram</text></svg>',
    })

    render('graph LR; A-->B')
    await flush()

    // Should now show the rendered SVG, not the source
    const svgContainer = container.querySelector('[class*="justify-center"]')
    expect(svgContainer?.innerHTML).toContain('<svg')
  })

  // -----------------------------------------------------------------------
  // Fullscreen uses same sanitized SVG
  // -----------------------------------------------------------------------

  it('fullscreen dialog receives the same sanitized SVG', async () => {
    const unsafeSvg =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>xss</script><text>Diagram</text></svg>'
    mockRender.mockResolvedValue({ svg: unsafeSvg })

    render('graph LR; A-->B')
    await flush()

    // Both the inline and zoom dialog SVG should be sanitized
    // The zoom dialog content div also uses dangerouslySetInnerHTML with the same svg state
    const allDivsWithSvg = container.querySelectorAll('div')
    for (const div of allDivsWithSvg) {
      expect(div.innerHTML).not.toContain('<script>')
    }
  })

  // -----------------------------------------------------------------------
  // Highlighted source is sanitized
  // -----------------------------------------------------------------------

  it('sanitizes highlighted source output used in dangerouslySetInnerHTML', () => {
    mockRender.mockReturnValue(new Promise(() => {})) // never resolves

    // The code content itself will be escaped, but let's verify the output path is safe
    render('<script>alert(1)</script>')

    // The raw source view should escape the script tag
    const codeEl = container.querySelector('code')
    expect(codeEl).toBeTruthy()
    expect(codeEl!.innerHTML).not.toContain('<script>')
    expect(codeEl!.textContent).toContain('<script>')
  })
})
