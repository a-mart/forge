import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { ProjectContextModeSnapshot, SessionContextModeSnapshot } from '@forge/protocol'
import {
  fetchProjectContextMode,
  fetchSessionContextMode,
  parseProjectContextModeSnapshot,
  parseSessionContextModeSnapshot,
  updateProjectContextMode,
  updateSessionContextMode,
} from './context-mode-api'
import { createBuilderSettingsApiClient, createSettingsApiClient } from './settings-api-client'
import { createCollabSettingsTarget } from './settings-target'

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

const BUILDER_WS = 'ws://127.0.0.1:47187'
const COLLAB_WS = 'wss://collab.example.com'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('context-mode-api', () => {
  let fetchSpy: MockInstance

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }))
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('parses project and session snapshots from the shared DTOs', () => {
    expect(parseProjectContextModeSnapshot({ profileId: 'forge', mode: 'fresh' })).toEqual({
      profileId: 'forge',
      mode: 'fresh',
    } satisfies ProjectContextModeSnapshot)
    expect(parseSessionContextModeSnapshot({
      sessionAgentId: 'manager',
      profileId: 'forge',
      projectDefault: 'fresh',
      sessionOverride: 'summary',
      effectiveMode: 'summary',
      freshSupported: true,
    })).toEqual({
      sessionAgentId: 'manager',
      profileId: 'forge',
      projectDefault: 'fresh',
      sessionOverride: 'summary',
      effectiveMode: 'summary',
      freshSupported: true,
    } satisfies SessionContextModeSnapshot)
  })

  it('omits inherit/absent optional fields from session snapshots', () => {
    expect(parseSessionContextModeSnapshot({
      sessionAgentId: 'manager',
      profileId: 'forge',
      projectDefault: 'summary',
      effectiveMode: 'summary',
      freshSupported: false,
      unsupportedReason: 'Fresh windows are not supported for Cursor SDK runtimes.',
    })).toEqual({
      sessionAgentId: 'manager',
      profileId: 'forge',
      projectDefault: 'summary',
      effectiveMode: 'summary',
      freshSupported: false,
      unsupportedReason: 'Fresh windows are not supported for Cursor SDK runtimes.',
    })
  })

  it('rejects malformed snapshots instead of inventing defaults', () => {
    expect(() => parseProjectContextModeSnapshot({ profileId: 'forge', mode: 'window' })).toThrow(
      'Invalid project context-mode response.',
    )
    expect(() => parseSessionContextModeSnapshot({
      sessionAgentId: 'manager',
      profileId: 'forge',
      projectDefault: 'summary',
      effectiveMode: 'summary',
    })).toThrow('Invalid session context-mode response.')
  })

  it('reads and writes project context mode through the builder settings client', async () => {
    const client = createBuilderSettingsApiClient(BUILDER_WS)
    fetchSpy.mockResolvedValueOnce(jsonResponse({ profileId: 'forge', mode: 'summary' }))
    await expect(fetchProjectContextMode(client, 'forge')).resolves.toEqual({
      profileId: 'forge',
      mode: 'summary',
    })
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/profiles/forge/context-mode',
      expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' }),
    )

    fetchSpy.mockResolvedValueOnce(jsonResponse({ profileId: 'forge', mode: 'fresh' }))
    await expect(updateProjectContextMode(client, 'forge', 'fresh')).resolves.toEqual({
      profileId: 'forge',
      mode: 'fresh',
    })
    expect(fetchSpy).toHaveBeenLastCalledWith(
      'http://127.0.0.1:47187/api/profiles/forge/context-mode',
      expect.objectContaining({
        method: 'PUT',
        credentials: 'same-origin',
        body: JSON.stringify({ mode: 'fresh' }),
      }),
    )
  })

  it('encodes ids and sends null to restore session inheritance', async () => {
    const client = createBuilderSettingsApiClient(BUILDER_WS)
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      sessionAgentId: 'mgr/1',
      profileId: 'forge',
      projectDefault: 'fresh',
      effectiveMode: 'fresh',
      freshSupported: true,
    }))
    await expect(updateSessionContextMode(client, 'mgr/1', null)).resolves.toMatchObject({
      sessionAgentId: 'mgr/1',
      effectiveMode: 'fresh',
    })
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/agents/mgr%2F1/context-mode',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ mode: null }),
      }),
    )
  })

  it('surfaces API errors from failed writes', async () => {
    const client = createBuilderSettingsApiClient(BUILDER_WS)
    fetchSpy.mockResolvedValueOnce(jsonResponse(
      { error: 'Fresh windows are not supported for Cursor SDK runtimes.' },
      409,
    ))
    await expect(updateSessionContextMode(client, 'cursor', 'fresh')).rejects.toThrow(
      'Fresh windows are not supported for Cursor SDK runtimes.',
    )
  })

  it('routes through the supplied client rather than inventing a new socket', async () => {
    const client = createSettingsApiClient(createCollabSettingsTarget(COLLAB_WS))
    fetchSpy.mockResolvedValueOnce(jsonResponse({ profileId: 'forge', mode: 'summary' }))
    await fetchProjectContextMode(client, 'forge')
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://collab.example.com/api/profiles/forge/context-mode',
      expect.objectContaining({ credentials: 'include' }),
    )
    for (const call of fetchSpy.mock.calls) {
      expect(call[0]).not.toContain('127.0.0.1')
    }
  })

  it('loads a session snapshot for live/reload consumption', async () => {
    const client = createBuilderSettingsApiClient(BUILDER_WS)
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      sessionAgentId: 'manager',
      profileId: 'forge',
      projectDefault: 'fresh',
      sessionOverride: 'summary',
      effectiveMode: 'summary',
      freshSupported: true,
    }))
    await expect(fetchSessionContextMode(client, 'manager')).resolves.toMatchObject({
      sessionOverride: 'summary',
      effectiveMode: 'summary',
    })
  })
})
