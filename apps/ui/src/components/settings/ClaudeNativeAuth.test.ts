/** @vitest-environment jsdom */
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ClaudeNativeAuth } from './ClaudeNativeAuth'
import { createBuilderSettingsApiClient } from './settings-api-client'
import type { ClaudeAuthStatus } from '@forge/protocol'

let root: Root
let container: HTMLDivElement
const client = createBuilderSettingsApiClient('ws://127.0.0.1:49571')
const signedOut: ClaudeAuthStatus = { connected: false, mode: 'subscription', phase: 'idle' }
beforeEach(() => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { flushSync(() => root.unmount()); container.remove(); vi.restoreAllMocks() })

function button(label: string) {
  const found = [...container.querySelectorAll('button')].find(b => b.textContent?.includes(label))
  if (!found) throw new Error(`Button not found: ${label}`)
  return found
}

it('offers subscription sign-in, a browser link and private code entry, then confirms the saved connection', async () => {
  const request = vi.spyOn(client, 'fetchJson').mockResolvedValue(signedOut)
  flushSync(() => root.render(createElement(ClaudeNativeAuth, { apiClient: client, inConversation: true })))
  await vi.waitFor(() => expect(button('Sign in to Claude').disabled).toBe(false))
  expect(container.textContent).not.toContain('node_modules')
  expect(container.textContent).not.toContain('auth login')
  request.mockResolvedValue({ ...signedOut, phase: 'waiting', flowId: 'fixture', authorizationUrl: 'https://claude.ai/oauth/authorize?state=fixture' })
  flushSync(() => button('Sign in to Claude').click())
  await vi.waitFor(() => expect(container.querySelector('a')?.href).toContain('claude.ai/oauth/authorize'))
  expect(request).toHaveBeenLastCalledWith('/api/settings/claude-native', expect.objectContaining({ method: 'POST', body: expect.stringContaining('"action":"start"') }))
  expect(container.querySelector('input')?.type).toBe('password')
  expect(container.querySelector('input')?.getAttribute('autocomplete')).toBe('off')
  request.mockResolvedValue({ ...signedOut, connected: true })
  await vi.waitFor(() => expect(container.textContent).toContain('Claude connected'), { timeout: 4000 })
  expect(container.querySelector('input')).toBeNull()
  expect(container.querySelector('a')).toBeNull()
  expect(container.textContent).toContain('Send your message again')
})

it('recovers a failed connection check without claiming that the account is signed out', async () => {
  const request = vi.spyOn(client, 'fetchJson').mockRejectedValue(new Error('Connection check failed'))
  flushSync(() => root.render(createElement(ClaudeNativeAuth, { apiClient: client })))
  await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toBe('Connection check failed'))
  request.mockResolvedValue({ ...signedOut, connected: true })
  flushSync(() => button('Check connection').click())
  await vi.waitFor(() => expect(container.textContent).toContain('Claude connected'))
  expect(container.querySelector('[role="alert"]')).toBeNull()
})
