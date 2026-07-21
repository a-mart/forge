/** @vitest-environment jsdom */

import { fireEvent, getByRole } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexElicitationRequestEvent } from '@forge/protocol'
import { CodexElicitationCard } from './CodexElicitationCard'

const baseRequest: CodexElicitationRequestEvent = {
  type: 'codex_elicitation_request',
  elicitationId: 'elicit-1',
  agentId: 'manager-a',
  sidecarAgentId: 'manager-a--codex',
  mode: 'form',
  message: 'Codex needs permission',
  persistScopes: [],
}

describe('CodexElicitationCard', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    flushSync(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  function render(request: CodexElicitationRequestEvent, onRespond = vi.fn()) {
    flushSync(() => {
      root.render(createElement(CodexElicitationCard, { request, onRespond }))
    })
    return onRespond
  }

  it('does not auto-open tokenized URLs and requires an explicit URL-flow action before allowing', () => {
    const open = vi.fn()
    vi.stubGlobal('open', open)
    const tokenizedUrl = 'https://Auth.Example.test:443/authorize?token=secret-token#callback'
    const onRespond = render({
      ...baseRequest,
      mode: 'url',
      url: tokenizedUrl,
      urlOrigin: 'https://auth.example.test',
    })

    expect(container.textContent).toContain('https://auth.example.test')
    expect(container.textContent).not.toContain('secret-token')
    expect(open).not.toHaveBeenCalled()
    expect((getByRole(container, 'button', { name: 'Allow' }) as HTMLButtonElement).disabled).toBe(true)

    flushSync(() => fireEvent.click(getByRole(container, 'button', { name: 'Open link' })))
    expect(open).toHaveBeenCalledWith(tokenizedUrl, '_blank', 'noopener,noreferrer')

    const allow = getByRole(container, 'button', { name: 'Allow' })
    expect((allow as HTMLButtonElement).disabled).toBe(false)
    flushSync(() => fireEvent.click(allow))
    expect(onRespond).toHaveBeenCalledWith('allow', {}, undefined)
  })

  it('keeps a cleared required number empty and blocks submission', () => {
    const onRespond = render({
      ...baseRequest,
      fields: [{ key: 'amount', label: 'Amount', type: 'number', required: true }],
    })
    const amount = container.querySelector('input[type="number"]') as HTMLInputElement
    const allow = getByRole(container, 'button', { name: 'Allow' })

    expect((allow as HTMLButtonElement).disabled).toBe(true)
    flushSync(() => fireEvent.change(amount, { target: { value: '42' } }))
    expect((allow as HTMLButtonElement).disabled).toBe(false)
    flushSync(() => fireEvent.change(amount, { target: { value: '' } }))

    expect(amount.value).toBe('')
    expect((allow as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(allow)
    expect(onRespond).not.toHaveBeenCalled()
  })
})
