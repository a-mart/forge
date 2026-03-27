/** @vitest-environment jsdom */

import { fireEvent, getAllByRole, getByRole, getByTestId, getByText, queryByRole, queryByText } from '@testing-library/dom'
import { createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-diff-viewer-continued', async () => {
  const React = await import('react')

  return {
    default: ({
      oldValue,
      newValue,
      showDiffOnly,
    }: {
      oldValue: string
      newValue: string
      showDiffOnly?: boolean
    }) => {
      const [initialShowDiffOnly] = React.useState(showDiffOnly ?? true)

      return createElement(
        'div',
        {
          'data-testid': 'raw-diff-viewer',
          'data-old': oldValue,
          'data-new': newValue,
          'data-mode': initialShowDiffOnly ? 'collapsed' : 'expanded',
        },
        `${oldValue}=>${newValue}`,
      )
    },
    DiffMethod: { WORDS: 'WORDS' },
  }
})

vi.mock('./diff-viewer-theme', () => ({
  useDiffTheme: () => ({ styles: {}, useDarkTheme: false }),
}))

vi.mock('@/lib/syntax-highlight', () => ({
  detectLanguage: () => 'markdown',
  highlightCode: (source: string) => source,
}))

vi.mock('@/components/chat/MarkdownMessage', () => ({
  MarkdownMessage: ({ content }: { content: string }) =>
    createElement('div', { 'data-testid': 'rendered-markdown' }, content),
}))

import { DiffPane } from './DiffPane'
import { MarkdownDiffPane } from './MarkdownDiffPane'

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
  }

  root = null
  container.remove()
  document.body.innerHTML = ''
})

function render(element: ReactElement) {
  root = createRoot(container)
  flushSync(() => {
    root?.render(element)
  })
}

function click(element: HTMLElement) {
  flushSync(() => {
    fireEvent.click(element)
  })
}

describe('MarkdownDiffPane', () => {
  it('renders outline entries from markdown headings', () => {
    render(
      createElement(MarkdownDiffPane, {
        fileName: 'knowledge.md',
        oldContent: '# Intro\nSame\n## Details\nSame',
        newContent: '# Intro\nChanged\n## Details\nSame',
      }),
    )

    expect(getByRole(document.body, 'button', { name: 'Intro' })).toBeTruthy()
    expect(getByRole(document.body, 'button', { name: 'Details' })).toBeTruthy()
  })

  it('collapses unchanged sections by default', () => {
    render(
      createElement(MarkdownDiffPane, {
        fileName: 'knowledge.md',
        oldContent: '# Changed\nBefore\n## Stable\nSame',
        newContent: '# Changed\nAfter\n## Stable\nSame',
      }),
    )

    expect(getByRole(document.body, 'heading', { name: 'Changed' })).toBeTruthy()
    expect(queryByRole(document.body, 'heading', { name: 'Stable' })).toBeNull()
    expect(queryByText(document.body, 'Hiding 1 unchanged section')).toBeTruthy()
  })

  it('shows an unchanged section on the first outline click', () => {
    render(
      createElement(MarkdownDiffPane, {
        fileName: 'knowledge.md',
        oldContent: '# Changed\nBefore\n## Stable\nSame',
        newContent: '# Changed\nAfter\n## Stable\nSame',
      }),
    )

    click(getByRole(document.body, 'button', { name: 'Stable' }))

    expect(getByText(document.body, /Showing section/i)).toBeTruthy()
    expect(getByRole(document.body, 'heading', { name: 'Stable' })).toBeTruthy()
    expect(getByTestId(document.body, 'raw-diff-viewer').getAttribute('data-new')).toContain('## Stable\nSame')
  })

  it('expands the selected section on the first outline click', () => {
    render(
      createElement(MarkdownDiffPane, {
        fileName: 'knowledge.md',
        oldContent: '# Changed\nBefore\nContext',
        newContent: '# Changed\nAfter\nContext',
      }),
    )

    const diffViewer = getByTestId(document.body, 'raw-diff-viewer')
    expect(diffViewer.getAttribute('data-mode')).toBe('collapsed')

    click(getByRole(document.body, 'button', { name: 'Changed' }))

    expect(getByText(document.body, /Showing section/i)).toBeTruthy()
    expect(getByTestId(document.body, 'raw-diff-viewer').getAttribute('data-mode')).toBe('expanded')
  })

  it('opens the rendered preview pane without removing the raw diff', () => {
    render(
      createElement(MarkdownDiffPane, {
        fileName: 'knowledge.md',
        oldContent: '# Intro\nOld body',
        newContent: '# Intro\nNew body',
      }),
    )

    click(getByRole(document.body, 'button', { name: 'Show preview' }))

    expect(getByText(document.body, 'Rendered preview')).toBeTruthy()
    expect(getByTestId(document.body, 'rendered-markdown').textContent).toContain('New body')
    expect(getAllByRole(document.body, 'button', { name: 'Preview current markdown' })[0].getAttribute('aria-pressed')).toBe('true')
    expect(getAllByRole(document.body, 'button', { name: 'Preview previous markdown' })[0].getAttribute('aria-pressed')).toBe('false')
    expect(getAllByRole(document.body, 'button', { name: 'Hide preview' }).length).toBeGreaterThan(0)
    expect(getByTestId(document.body, 'raw-diff-viewer')).toBeTruthy()
  })
})

describe('DiffPane markdown routing', () => {
  it('routes markdown files to the markdown-aware pane', () => {
    render(
      createElement(DiffPane, {
        fileName: 'notes.md',
        oldContent: '# Intro\nOld',
        newContent: '# Intro\nNew',
        isLoading: false,
        error: null,
      }),
    )

    expect(getByRole(document.body, 'button', { name: 'Expand all sections' })).toBeTruthy()
    expect(getByRole(document.body, 'button', { name: 'Show preview' })).toBeTruthy()
  })

  it('keeps non-markdown files on the generic diff pane', () => {
    render(
      createElement(DiffPane, {
        fileName: 'notes.ts',
        oldContent: 'const before = 1',
        newContent: 'const after = 2',
        isLoading: false,
        error: null,
      }),
    )

    expect(getByTestId(document.body, 'raw-diff-viewer')).toBeTruthy()
    expect(queryByRole(document.body, 'button', { name: 'Expand all sections' })).toBeNull()
    expect(queryByRole(document.body, 'button', { name: 'Show preview' })).toBeNull()
  })
})
