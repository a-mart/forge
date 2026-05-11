/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* ------------------------------------------------------------------ */
/*  Mocks                                                             */
/* ------------------------------------------------------------------ */

vi.mock('@/lib/collaboration-endpoints', () => ({
  resolveCollaborationApiBaseUrl: () => 'https://default-collab.example.com/',
}))

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

let fetchSpy: ReturnType<typeof vi.fn>

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function noContentResponse(): Response {
  return new Response(null, { status: 204 })
}

beforeEach(() => {
  fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function lastFetchCall(): { url: string; init: RequestInit | undefined } {
  const calls = fetchSpy.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  const last = calls[calls.length - 1]!
  return {
    url: typeof last[0] === 'string' ? last[0] : (last[0] as URL | Request).toString(),
    init: last[1] as RequestInit | undefined,
  }
}

/* ================================================================== */
/*  Tests                                                             */
/* ================================================================== */

describe('collaboration-settings-api target-aware routing', () => {
  const BACKEND_A = 'https://collab-a.example.com/'
  const BACKEND_B = 'https://collab-b.example.com/'

  // ── fetchCollaborationStatus ──

  describe('fetchCollaborationStatus', () => {
    it('uses default when no apiBaseUrl', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ enabled: true }))
      const { fetchCollaborationStatus } = await import('./collaboration-settings-api')
      await fetchCollaborationStatus()
      expect(lastFetchCall().url).toBe('https://default-collab.example.com/api/collaboration/status')
    })

    it('targets explicit backend', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ enabled: true }))
      const { fetchCollaborationStatus } = await import('./collaboration-settings-api')
      await fetchCollaborationStatus(BACKEND_A)
      expect(lastFetchCall().url).toBe('https://collab-a.example.com/api/collaboration/status')
    })
  })

  // ── fetchCollaborationMe ──

  describe('fetchCollaborationMe', () => {
    it('targets explicit backend', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ authenticated: true }))
      const { fetchCollaborationMe } = await import('./collaboration-settings-api')
      await fetchCollaborationMe(BACKEND_B)
      expect(lastFetchCall().url).toBe('https://collab-b.example.com/api/collaboration/me')
    })
  })

  // ── changeMyPassword ──

  describe('changeMyPassword', () => {
    it('targets explicit backend', async () => {
      fetchSpy.mockResolvedValueOnce(noContentResponse())
      const { changeMyPassword } = await import('./collaboration-settings-api')
      await changeMyPassword('old', 'new', BACKEND_A)
      const { url, init } = lastFetchCall()
      expect(url).toBe('https://collab-a.example.com/api/collaboration/me/password')
      expect(init?.credentials).toBe('include')
    })
  })

  // ── fetchCollaborationUsers ──

  describe('fetchCollaborationUsers', () => {
    it('targets explicit backend', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ users: [] }))
      const { fetchCollaborationUsers } = await import('./collaboration-settings-api')
      await fetchCollaborationUsers(BACKEND_B)
      expect(lastFetchCall().url).toBe('https://collab-b.example.com/api/collaboration/users')
    })
  })

  // ── updateCollaborationUser ──

  describe('updateCollaborationUser', () => {
    it('targets explicit backend', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ user: { userId: 'u1', role: 'admin' } }))
      const { updateCollaborationUser } = await import('./collaboration-settings-api')
      await updateCollaborationUser('u1', { role: 'admin' }, BACKEND_A)
      expect(lastFetchCall().url).toBe('https://collab-a.example.com/api/collaboration/users/u1')
    })
  })

  // ── resetUserPassword ──

  describe('resetUserPassword', () => {
    it('targets explicit backend', async () => {
      fetchSpy.mockResolvedValueOnce(noContentResponse())
      const { resetUserPassword } = await import('./collaboration-settings-api')
      await resetUserPassword('u42', 'temp', BACKEND_B)
      expect(lastFetchCall().url).toBe('https://collab-b.example.com/api/collaboration/users/u42/password-reset')
    })
  })

  // ── fetchCollaborationInvites ──

  describe('fetchCollaborationInvites', () => {
    it('targets explicit backend', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ invites: [] }))
      const { fetchCollaborationInvites } = await import('./collaboration-settings-api')
      await fetchCollaborationInvites(BACKEND_A)
      expect(lastFetchCall().url).toBe('https://collab-a.example.com/api/collaboration/invites')
    })
  })

  // ── createCollaborationInvite ──

  describe('createCollaborationInvite', () => {
    it('targets explicit backend', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          invite: { inviteId: 'inv-1', role: 'member', createdAt: '', expiresAt: '', inviteUrl: 'url' },
        }),
      )
      const { createCollaborationInvite } = await import('./collaboration-settings-api')
      await createCollaborationInvite('a@b.com', undefined, BACKEND_B)
      expect(lastFetchCall().url).toBe('https://collab-b.example.com/api/collaboration/invites')
    })
  })

  // ── revokeCollaborationInvite ──

  describe('revokeCollaborationInvite', () => {
    it('targets explicit backend', async () => {
      fetchSpy.mockResolvedValueOnce(noContentResponse())
      const { revokeCollaborationInvite } = await import('./collaboration-settings-api')
      await revokeCollaborationInvite('inv-42', BACKEND_A)
      expect(lastFetchCall().url).toBe('https://collab-a.example.com/api/collaboration/invites/inv-42')
    })
  })

  // ── Two-connection scenario ──

  describe('two connection routing', () => {
    it('routes status check to owning backend, not default', async () => {
      const { fetchCollaborationStatus } = await import('./collaboration-settings-api')

      fetchSpy.mockResolvedValueOnce(jsonResponse({ enabled: true }))
      await fetchCollaborationStatus(BACKEND_A)
      expect(lastFetchCall().url).toContain('collab-a.example.com')

      fetchSpy.mockResolvedValueOnce(jsonResponse({ enabled: false }))
      await fetchCollaborationStatus(BACKEND_B)
      expect(lastFetchCall().url).toContain('collab-b.example.com')
    })

    it('all requests include credentials: include', async () => {
      const mod = await import('./collaboration-settings-api')

      fetchSpy.mockResolvedValueOnce(jsonResponse({ enabled: true }))
      await mod.fetchCollaborationStatus(BACKEND_A)
      expect(lastFetchCall().init?.credentials).toBe('include')

      fetchSpy.mockResolvedValueOnce(jsonResponse({ users: [] }))
      await mod.fetchCollaborationUsers(BACKEND_B)
      expect(lastFetchCall().init?.credentials).toBe('include')

      fetchSpy.mockResolvedValueOnce(noContentResponse())
      await mod.changeMyPassword('a', 'b', BACKEND_A)
      expect(lastFetchCall().init?.credentials).toBe('include')
    })
  })
})
