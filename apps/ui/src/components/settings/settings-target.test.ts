/** @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api-endpoint', () => ({
  resolveApiEndpoint: (wsUrl: string, path: string) => {
    try {
      const parsed = new URL(wsUrl)
      parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
      return new URL(path, parsed.origin).toString()
    } catch {
      return path
    }
  },
}))

vi.mock('@/lib/collaboration-endpoints', () => ({
  resolveCollaborationApiBaseUrl: () => 'https://collab.example.com/',
}))

const { createBuilderSettingsTarget, createCollabSettingsTarget } = await import('./settings-target')

describe('createBuilderSettingsTarget', () => {
  it('creates a builder target with correct defaults', () => {
    const target = createBuilderSettingsTarget('ws://127.0.0.1:47187')

    expect(target.kind).toBe('builder')
    expect(target.label).toBe('Builder backend')
    expect(target.wsUrl).toBe('ws://127.0.0.1:47187')
    expect(target.apiBaseUrl).toBe('http://127.0.0.1:47187/')
    expect(target.fetchCredentials).toBe('same-origin')
    expect(target.requiresAdmin).toBe(false)
  })

  it('includes all standard tabs', () => {
    const target = createBuilderSettingsTarget('ws://127.0.0.1:47187')

    expect(target.availableTabs).toContain('general')
    expect(target.availableTabs).toContain('notifications')
    expect(target.availableTabs).toContain('auth')
    expect(target.availableTabs).toContain('models')
    expect(target.availableTabs).toContain('integrations')
    expect(target.availableTabs).toContain('skills')
    expect(target.availableTabs).toContain('prompts')
    expect(target.availableTabs).toContain('specialists')
    expect(target.availableTabs).toContain('slash-commands')
    expect(target.availableTabs).toContain('extensions')
    expect(target.availableTabs).toContain('collaboration')
    expect(target.availableTabs).toContain('about')
  })
})

describe('createCollabSettingsTarget', () => {
  it('creates a collab target with remote base URL and include credentials', () => {
    const target = createCollabSettingsTarget('wss://collab.example.com')

    expect(target.kind).toBe('collab')
    expect(target.label).toBe('Collab backend')
    expect(target.wsUrl).toBe('wss://collab.example.com')
    expect(target.apiBaseUrl).toBe('https://collab.example.com/')
    expect(target.fetchCredentials).toBe('include')
    expect(target.requiresAdmin).toBe(true)
  })

  it('excludes notifications from collab tabs', () => {
    const target = createCollabSettingsTarget('wss://collab.example.com')

    expect(target.availableTabs).not.toContain('notifications')
  })

  it('includes admin-visible collab tabs', () => {
    const target = createCollabSettingsTarget('wss://collab.example.com')

    expect(target.availableTabs).toContain('general')
    expect(target.availableTabs).toContain('auth')
    expect(target.availableTabs).toContain('models')
    expect(target.availableTabs).toContain('integrations')
    expect(target.availableTabs).toContain('skills')
    expect(target.availableTabs).toContain('prompts')
    expect(target.availableTabs).toContain('specialists')
    expect(target.availableTabs).toContain('slash-commands')
    expect(target.availableTabs).toContain('extensions')
    expect(target.availableTabs).toContain('collaboration')
    expect(target.availableTabs).toContain('about')
  })
})
