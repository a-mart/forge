import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { MarkdownMessage } from './MarkdownMessage'

function renderMarkdownMessage(props: Parameters<typeof MarkdownMessage>[0]) {
  return renderToStaticMarkup(
    createElement(TooltipProvider, null, createElement(MarkdownMessage, props)),
  )
}

let mountedRoot: Root | null = null
let previousWindow: typeof globalThis.window | undefined
let previousDocument: typeof globalThis.document | undefined
let previousNavigator: typeof globalThis.navigator | undefined

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount())
    mountedRoot = null
  }

  if (previousWindow) {
    globalThis.window = previousWindow
  } else {
    Reflect.deleteProperty(globalThis, 'window')
  }

  if (previousDocument) {
    globalThis.document = previousDocument
  } else {
    Reflect.deleteProperty(globalThis, 'document')
  }

  if (previousNavigator) {
    globalThis.navigator = previousNavigator
  } else {
    Reflect.deleteProperty(globalThis, 'navigator')
  }

  Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
})

function installDom() {
  previousWindow = globalThis.window
  previousDocument = globalThis.document
  previousNavigator = globalThis.navigator

  const { JSDOM } = require('jsdom') as { JSDOM: new (html: string) => { window: Window } }
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.window = dom.window as unknown as typeof globalThis.window
  globalThis.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  })

  return dom.window.document.getElementById('root')!
}

describe('MarkdownMessage', () => {
  it('renders common markdown formatting for speak_to_user content', () => {
    const content = [
      'Visit [example](https://example.com).',
      '',
      'Use `pnpm test`.',
      '',
      '```ts',
      'console.log("hello")',
      '```',
      '',
      '- alpha',
      '- beta',
      '',
      'This is **bold** and *italic*.',
    ].join('\n')

    const html = renderMarkdownMessage({ content })

    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('>pnpm test</code>')
    expect(html).toContain('overflow-x-auto')
    expect(html).toContain('<ul class="mb-2 list-disc space-y-0.5 pl-5')
    expect(html).toContain('<strong class="font-semibold')
    expect(html).toContain('<em class="italic">italic</em>')
  })

  it('keeps raw HTML escaped and sanitizes javascript links', () => {
    const content = ['[xss](javascript:alert(1))', '', '<script>alert("x")</script>'].join('\n')

    const html = renderMarkdownMessage({ content })

    expect(html).not.toContain('href="javascript:alert(1)"')
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
  })

  it('renders artifact links as clickable artifact cards when callback is provided', () => {
    const content = '[artifact:/Users/example/worktrees/swarm/README.md]'

    const html = renderMarkdownMessage({
      content,
      onArtifactClick: () => {},
    })

    expect(html).toContain('data-artifact-card="true"')
    expect(html).toContain('README.md')
    expect(html).toContain('/Users/example/worktrees/swarm/README.md')
  })

  it('renders artifact shortcodes in prose but not inside inline or fenced code', () => {
    const content = [
      '[artifact:/tmp/allowed.png]',
      '',
      '`[artifact:/tmp/inline.png]`',
      '',
      '```md',
      '[artifact:/tmp/fenced.png]',
      '```',
    ].join('\n')

    const html = renderMarkdownMessage({ content, onArtifactClick: () => {} })

    expect((html.match(/data-artifact-card="true"/g) ?? [])).toHaveLength(1)
    expect(html).toContain('/tmp/allowed.png')
    expect(html).toContain('[artifact:/tmp/inline.png]')
    expect(html).toContain('[artifact:/tmp/fenced.png]')
  })

  it('renders PDF artifact links as clickable artifact cards', () => {
    const content = '[artifact:/tmp/spec.pdf]'

    const html = renderMarkdownMessage({
      content,
      onArtifactClick: () => {},
    })

    expect(html).toContain('data-artifact-card="true"')
    expect(html).toContain('spec.pdf')
    expect(html).toContain('/tmp/spec.pdf')
  })

  it('renders local markdown file links as artifact cards using link text as title', () => {
    const content = '[Terminal Support Plan](docs/plans/terminal-support.md)'

    const html = renderMarkdownMessage({
      content,
      onArtifactClick: () => {},
    })

    expect(html).toContain('data-artifact-card="true"')
    expect(html).toContain('Terminal Support Plan')
    expect(html).toContain('docs/plans/terminal-support.md')
  })

  it('preserves a horizontally scrolled code block across callback-only rerenders', () => {
    const host = installDom()
    mountedRoot = createRoot(host)
    const content = ['```ts', 'const value = "' + 'x'.repeat(200) + '"', '```'].join('\n')

    act(() => {
      mountedRoot?.render(
        createElement(TooltipProvider, null, createElement(MarkdownMessage, {
          content,
          variant: 'document',
          onArtifactClick: () => {},
        })),
      )
    })

    const scroller = host.querySelector<HTMLPreElement>('pre.overflow-x-auto')
    expect(scroller).toBeTruthy()
    scroller!.scrollLeft = 120

    act(() => {
      mountedRoot?.render(
        createElement(TooltipProvider, null, createElement(MarkdownMessage, {
          content,
          variant: 'document',
          onArtifactClick: () => {},
        })),
      )
    })

    expect(host.querySelector<HTMLPreElement>('pre.overflow-x-auto')).toBe(scroller)
    expect(scroller!.scrollLeft).toBe(120)
  })

  it('routes mermaid fences through the isolated iframe shell when enabled', () => {
    const content = ['```mermaid', 'graph LR', '  A-->B', '```'].join('\n')

    const html = renderMarkdownMessage({
      content,
      enableMermaid: true,
    })

    expect(html).toContain('data-mermaid-preview-frame="true"')
    expect(html).toContain('/mermaid-preview/embed')
    expect(html).not.toContain('foreignObject')
  })
})
