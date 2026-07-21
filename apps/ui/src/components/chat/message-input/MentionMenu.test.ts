/** @vitest-environment jsdom */

import { createElement, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MentionMenu } from './MentionMenu'
import { CODEX_MENTION_SUGGESTION } from './mention-types'

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  container.remove()
})

function renderMenu(
  overrides: Partial<Parameters<typeof MentionMenu>[0]> = {},
): void {
  const menuRef = createRef<HTMLDivElement>()
  const props = {
    menuRef,
    listboxId: 'mention-listbox-test',
    status: 'list' as const,
    mentions: [CODEX_MENTION_SUGGESTION],
    selectedIndex: 0,
    onSelect: () => {},
    onHover: () => {},
    ...overrides,
  }
  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(MentionMenu, props))
  })
}

describe('MentionMenu', () => {
  it('renders listbox options with aria-selected on the active item', () => {
    renderMenu()

    const listbox = container.querySelector('[role="listbox"]')
    expect(listbox?.getAttribute('aria-label')).toBe('Mentions')

    const options = container.querySelectorAll('[role="option"]')
    expect(options.length).toBe(1)
    expect(options[0]?.getAttribute('aria-selected')).toBe('true')
    expect(options[0]?.id).toBe('mention-listbox-test-option-0')
  })

  it('shows loading status for Codex tool picker', () => {
    renderMenu({ status: 'loading', mentions: [], codexToolPicker: true })

    expect(container.textContent).toContain('Loading Codex plugins')
    expect(container.querySelector('[role="listbox"]')?.getAttribute('aria-busy')).toBe('true')
  })

  it('shows catalog fetch failure message', () => {
    renderMenu({ status: 'error', mentions: [], codexToolPicker: true })

    expect(container.textContent).toContain('Could not load Codex plugins')
  })

  it('identifies a missing Codex executable without exposing its raw stderr', () => {
    renderMenu({
      status: 'error',
      mentions: [],
      codexToolPicker: true,
      codexCatalogErrorMessage:
        'Codex app-server exited (code=1, signal=null): Error: spawn /opt/homebrew/lib/node_modules/@openai/codex/vendor/codex ENOENT',
    })

    expect(container.textContent).toContain('Forge could not start Codex. Reinstall Codex')
    expect(container.textContent).not.toContain('/opt/homebrew')
  })

  it('shows empty-catalog message when no tools are available', () => {
    renderMenu({ status: 'empty-catalog', mentions: [], codexToolPicker: true })

    expect(container.textContent).toContain('No Codex plugins available')
  })
})
