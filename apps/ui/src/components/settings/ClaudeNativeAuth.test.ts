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
afterEach(() => { flushSync(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

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


it('lets a connected subscription start account replacement and cancel back to its saved login', async () => {
  const connected = { ...signedOut, connected: true }
  const request = vi.spyOn(client, 'fetchJson').mockResolvedValue(connected)
  flushSync(() => root.render(createElement(ClaudeNativeAuth, { apiClient: client })))
  await vi.waitFor(() => expect(button('Switch account').disabled).toBe(false))
  expect(container.textContent).toContain('shared with Claude Code')
  request.mockResolvedValue({ ...signedOut, phase: 'waiting', flowId: 'switch-fixture', authorizationUrl: 'https://claude.ai/oauth/authorize?state=fixture' })
  flushSync(() => button('Switch account').click())
  await vi.waitFor(() => expect(container.querySelector('a')).not.toBeNull())
  expect(request).toHaveBeenLastCalledWith('/api/settings/claude-native', expect.objectContaining({ method: 'POST', body: expect.stringContaining('"action":"start"') }))
  expect(container.textContent).toContain('different account')
  request.mockResolvedValue(connected)
  flushSync(() => button('Cancel sign-in').click())
  await vi.waitFor(() => expect(button('Switch account').disabled).toBe(false))
  expect(request).toHaveBeenLastCalledWith('/api/settings/claude-native', expect.objectContaining({ method: 'DELETE', body: expect.stringContaining('switch-fixture') }))
  expect(container.querySelector('input')).toBeNull()
})

it('keeps account replacement out of API-key mode', async () => {
  vi.spyOn(client, 'fetchJson').mockResolvedValue({ ...signedOut, connected: true, mode: 'api_key' })
  flushSync(() => root.render(createElement(ClaudeNativeAuth, { apiClient: client })))
  await vi.waitFor(() => expect(container.textContent).toContain('configured Anthropic API key'))
  expect(container.textContent).not.toContain('Switch account')
})


it('copies the code-return link without opening a browser', async () => {
  const url = 'https://claude.ai/oauth/authorize?state=fixture&code=true'
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const open = vi.spyOn(window, 'open')
  const request = vi.spyOn(client, 'fetchJson').mockResolvedValue(signedOut)
  flushSync(() => root.render(createElement(ClaudeNativeAuth, { apiClient: client })))
  await vi.waitFor(() => expect(button('Sign in to Claude').disabled).toBe(false))
  request.mockResolvedValue({ ...signedOut, phase: 'waiting', flowId: 'fixture', authorizationUrl: url })
  flushSync(() => button('Sign in to Claude').click())
  await vi.waitFor(() => expect(button('Copy sign-in link').disabled).toBe(false))
  flushSync(() => button('Copy sign-in link').click())
  await vi.waitFor(() => expect(container.textContent).toContain('Link copied'))
  expect(writeText).toHaveBeenCalledWith(url)
  expect(open).not.toHaveBeenCalled()
  expect(container.querySelector('a')?.href).toBe(url)
  expect(container.querySelector('input[type="password"]')).not.toBeNull()
  request.mockResolvedValue(signedOut)
  flushSync(() => button('Cancel sign-in').click())
  await vi.waitFor(() => expect(container.querySelector('a')).toBeNull())
  expect(container.textContent).not.toContain('Link copied')
})

it.each(['unavailable', 'denied'])('provides a selectable link when clipboard access is %s and keeps checking login', async failure => {
  const url = 'https://claude.ai/oauth/authorize?state=fixture&code=true'
  vi.stubGlobal('navigator', failure === 'unavailable' ? {} : { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('clipboard denied')) } })
  const request = vi.spyOn(client, 'fetchJson').mockResolvedValue({ ...signedOut, phase: 'waiting', flowId: 'fixture', authorizationUrl: url })
  flushSync(() => root.render(createElement(ClaudeNativeAuth, { apiClient: client })))
  await vi.waitFor(() => expect(button('Copy sign-in link').disabled).toBe(false))
  flushSync(() => button('Copy sign-in link').click())
  await vi.waitFor(() => expect(container.textContent).toContain('Select and copy the link'))
  const input = container.querySelector<HTMLInputElement>('input[readonly]')
  expect(input?.value).toBe(url)
  expect(input?.getAttribute('aria-label')).toBe('Claude sign-in link')
  request.mockResolvedValue({ ...signedOut, connected: true })
  await vi.waitFor(() => expect(container.textContent).toContain('Claude connected'), { timeout: 4000 })
  expect(container.querySelector('input[readonly]')).toBeNull()
  expect(container.textContent).not.toContain('Select and copy the link')
})
