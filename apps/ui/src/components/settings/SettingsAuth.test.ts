/** @vitest-environment jsdom */

import { fireEvent, getByRole, queryByRole, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsAuth } from './SettingsAuth'
import type { SettingsApiClient } from './settings-api-client'

vi.mock('@/components/help/help-hooks', () => ({ useHelpContext: () => undefined }))
vi.mock('./CredentialPoolPanel', () => ({ CredentialPoolPanel: () => createElement('div', {}, 'Anthropic accounts') }))
vi.mock('./OpenAICredentialPool', () => ({ OpenAICredentialPool: () => createElement('div', {}, 'OpenAI accounts') }))

function sseResponse(): Response {
  const body = [
    'event: auth_url\n',
    'data: {"url":"https://auth.x.ai/oauth2/authorize?client_id=test","instructions":"Authorize xAI in your browser."}\n\n',
    'event: prompt\n',
    'data: {"requestId":"request-1","message":"Paste the complete callback URL","placeholder":"http://127.0.0.1:56121/callback?code=...&state=..."}\n\n',
  ].join('')
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

function builderTarget() {
  return {
    kind: 'builder' as const,
    label: 'Builder backend',
    description: 'Builder',
    wsUrl: 'ws://127.0.0.1:47187',
    apiBaseUrl: 'http://127.0.0.1:47187/',
    fetchCredentials: 'same-origin' as const,
    requiresAdmin: false,
    availableTabs: [],
  }
}

function authConfiguredResponse(): Response {
  return new Response(JSON.stringify({
    providers: [
      { provider: 'xai', configured: true, authType: 'api_key', maskedValue: '********test' },
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('SettingsAuth xAI OAuth', () => {
  let container: HTMLDivElement
  let root: Root
  const clipboardWrite = vi.fn(async () => undefined)

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    clipboardWrite.mockClear()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWrite },
    })
  })

  afterEach(() => {
    root.unmount()
    container.remove()
    vi.restoreAllMocks()
  })

  it('offers open, copy, manual callback, and cancellation controls for xAI', async () => {
    const apiClient = {
      fetch: vi.fn(async (path: string) => {
        if (path === '/api/settings/auth') return authConfiguredResponse()
        if (path === '/api/settings/auth/login/xai') return sseResponse()
        throw new Error(`Unexpected request: ${path}`)
      }),
      readApiError: vi.fn(async () => 'API error'),
    } as unknown as SettingsApiClient

    root.render(createElement(SettingsAuth, {
      wsUrl: 'ws://127.0.0.1:47187',
      apiClient,
      target: builderTarget(),
    }))

    await waitFor(() => expect(container.textContent).toContain('Stored API key'))
    expect(getByRole(container, 'heading', { name: 'Authentication' })).toBeTruthy()
    expect(container.textContent).not.toContain('API Keys')
    expect(container.textContent).toContain(
      'Native xAI credentials enable Grok for manager, specialist, and spawn usage.'
    )
    fireEvent.click(getByRole(container, 'button', { name: 'Login with OAuth' }))

    const openLink = await waitFor(() => getByRole(container, 'link', { name: /Open authorization URL/ }))
    expect(openLink.getAttribute('href')).toContain('https://auth.x.ai/oauth2/authorize')
    const copyButton = getByRole(container, 'button', { name: 'Copy URL' })
    fireEvent.click(copyButton)
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith(openLink.getAttribute('href')))

    expect(getByRole(container, 'textbox').getAttribute('placeholder')).toContain('callback?code=')
    fireEvent.click(getByRole(container, 'button', { name: 'Cancel' }))
    await waitFor(() => expect(queryByRole(container, 'button', { name: 'Cancel' })).toBeNull())
  })

  it('shows a visible error when clipboard writeText is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })

    const apiClient = {
      fetch: vi.fn(async (path: string) => {
        if (path === '/api/settings/auth') return authConfiguredResponse()
        if (path === '/api/settings/auth/login/xai') return sseResponse()
        throw new Error(`Unexpected request: ${path}`)
      }),
      readApiError: vi.fn(async () => 'API error'),
    } as unknown as SettingsApiClient

    root.render(createElement(SettingsAuth, {
      wsUrl: 'ws://127.0.0.1:47187',
      apiClient,
      target: builderTarget(),
    }))

    await waitFor(() => expect(container.textContent).toContain('Stored API key'))
    fireEvent.click(getByRole(container, 'button', { name: 'Login with OAuth' }))
    await waitFor(() => getByRole(container, 'button', { name: 'Copy URL' }))
    fireEvent.click(getByRole(container, 'button', { name: 'Copy URL' }))

    await waitFor(() => {
      expect(container.textContent).toContain('Clipboard access is unavailable. Select and copy the URL manually.')
    })
    expect(container.textContent).not.toContain('Copied')
  })

  it('re-shows the manual callback prompt after an invalid submission when the provider re-prompts', async () => {
    let loginController: ReadableStreamDefaultController<Uint8Array> | undefined
    const encoder = new TextEncoder()
    const loginBody = new ReadableStream<Uint8Array>({
      start(controller) {
        loginController = controller
        controller.enqueue(encoder.encode([
          'event: auth_url\n',
          'data: {"url":"https://auth.x.ai/oauth2/authorize?client_id=test","instructions":"Authorize xAI in your browser."}\n\n',
          'event: prompt\n',
          'data: {"requestId":"request-1","message":"Paste the complete callback URL","placeholder":"http://127.0.0.1:56121/callback?code=...&state=..."}\n\n',
        ].join('')))
      },
    })

    const apiClient = {
      fetch: vi.fn(async (path: string, init?: RequestInit) => {
        if (path === '/api/settings/auth') return authConfiguredResponse()
        if (path === '/api/settings/auth/login/xai') {
          return new Response(loginBody, { headers: { 'content-type': 'text/event-stream' } })
        }
        if (path === '/api/settings/auth/login/xai/respond' && init?.method === 'POST') {
          return new Response(null, { status: 204 })
        }
        throw new Error(`Unexpected request: ${path}`)
      }),
      readApiError: vi.fn(async () => 'API error'),
    } as unknown as SettingsApiClient

    root.render(createElement(SettingsAuth, {
      wsUrl: 'ws://127.0.0.1:47187',
      apiClient,
      target: builderTarget(),
    }))

    await waitFor(() => expect(container.textContent).toContain('Stored API key'))
    fireEvent.click(getByRole(container, 'button', { name: 'Login with OAuth' }))

    const input = await waitFor(() => getByRole(container, 'textbox'))
    fireEvent.change(input, { target: { value: 'https://example.com/bad-callback' } })
    fireEvent.click(getByRole(container, 'button', { name: 'Submit' }))

    await waitFor(() => expect(container.textContent).toContain('Authorization code submitted'))
    expect(queryByRole(container, 'textbox')).toBeNull()

    loginController?.enqueue(encoder.encode([
      'event: progress\n',
      'data: {"message":"The pasted xAI callback was invalid or did not match this login. Paste the complete redirect URL from this attempt."}\n\n',
      'event: prompt\n',
      'data: {"requestId":"request-2","message":"Paste the complete callback URL","placeholder":"http://127.0.0.1:56121/callback?code=...&state=..."}\n\n',
    ].join('')))

    const retryInput = await waitFor(() => getByRole(container, 'textbox'))
    expect(container.textContent).toContain('invalid or did not match')
    fireEvent.change(retryInput, {
      target: { value: 'http://127.0.0.1:56121/callback?code=ok&state=matching' },
    })
    fireEvent.click(getByRole(container, 'button', { name: 'Submit' }))

    await waitFor(() => {
      const respondCalls = (apiClient.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([path]) => path === '/api/settings/auth/login/xai/respond',
      )
      expect(respondCalls).toHaveLength(2)
      expect(JSON.parse(String(respondCalls[1]?.[1]?.body))).toMatchObject({
        value: 'http://127.0.0.1:56121/callback?code=ok&state=matching',
        requestId: 'request-2',
      })
    })
  })
})
