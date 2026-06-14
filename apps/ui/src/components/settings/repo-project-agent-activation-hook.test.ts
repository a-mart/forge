/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { waitFor } from '@testing-library/dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsApiClient } from './settings-api-client'
import { useRepoProjectAgentActivation } from './repo-project-agent-ui-utils'

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

function HookHarness({ apiClient }: { apiClient: SettingsApiClient }) {
  const { activateError, handleActivate } = useRepoProjectAgentActivation({
    apiClient,
    context: { profileId: 'profile-a', sessionAgentId: 'session-a' },
  })

  return createElement('div', null,
    createElement('button', {
      type: 'button',
      onClick: () => { void handleActivate({
        definitionId: 'def-docs',
        handle: 'docs',
        path: '/repo/.forge/project-agents/def-docs',
        status: 'valid',
        problems: [],
      }) },
    }, 'Activate'),
    activateError ? createElement('p', { role: 'alert' }, activateError) : null,
  )
}

describe('useRepoProjectAgentActivation', () => {
  it('sets inline error without returning an unhandled rejected promise', async () => {
    const apiClient = {
      target: { apiBaseUrl: 'http://127.0.0.1:47187', fetchCredentials: 'same-origin' },
      endpoint: (path: string) => path,
      fetch: vi.fn(),
      fetchJson: vi.fn(async () => { throw new Error('Activation failed hard') }),
      readApiError: vi.fn(),
    } as unknown as SettingsApiClient
    const unhandled = vi.fn()
    window.addEventListener('unhandledrejection', unhandled)

    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(HookHarness, { apiClient }))
    })

    const button = container.querySelector('button')
    expect(button).toBeTruthy()
    flushSync(() => {
      button?.click()
    })
    await waitFor(() => {
      expect(container.textContent).toContain('Activation failed hard')
    })
    expect(unhandled).not.toHaveBeenCalled()
    window.removeEventListener('unhandledrejection', unhandled)
  })
})
