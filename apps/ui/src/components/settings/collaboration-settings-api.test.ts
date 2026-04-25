/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* ------------------------------------------------------------------ */
/*  Mocks                                                             */
/* ------------------------------------------------------------------ */

vi.mock('@/lib/collaboration-endpoints', () => ({
  resolveCollaborationApiBaseUrl: () => 'https://collab.example.com/',
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

/** Extract the URL and init from the most recent fetch call. */
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

describe('collaboration-settings-api', () => {
  /* ---- Endpoint resolution: uses collab base URL, not builder wsUrl ---- */

  describe('endpoint resolution', () => {
    it('fetchCollaborationStatus uses collab base URL, not builder wsUrl', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ enabled: true }))
      const { fetchCollaborationStatus } = await import('./collaboration-settings-api')
      await fetchCollaborationStatus()

      const { url, init } = lastFetchCall()
      expect(url).toBe('https://collab.example.com/api/collaboration/status')
      expect(init?.credentials).toBe('include')
    })

    it('fetchCollaborationMe uses collab base URL', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ authenticated: true }))
      const { fetchCollaborationMe } = await import('./collaboration-settings-api')
      await fetchCollaborationMe()

      const { url, init } = lastFetchCall()
      expect(url).toBe('https://collab.example.com/api/collaboration/me')
      expect(init?.credentials).toBe('include')
    })
  })

  /* ---- Exact endpoint paths and methods ---- */

  describe('endpoint paths and methods', () => {
    it('changeMyPassword POSTs to /api/collaboration/me/password', async () => {
      fetchSpy.mockResolvedValueOnce(noContentResponse())
      const { changeMyPassword } = await import('./collaboration-settings-api')
      await changeMyPassword('old', 'new')

      const { url, init } = lastFetchCall()
      expect(url).toBe('https://collab.example.com/api/collaboration/me/password')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(init?.body as string)).toEqual({
        currentPassword: 'old',
        newPassword: 'new',
      })
    })

    it('fetchCollaborationUsers GETs /api/collaboration/users', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ users: [] }))
      const { fetchCollaborationUsers } = await import('./collaboration-settings-api')
      await fetchCollaborationUsers()

      const { url, init } = lastFetchCall()
      expect(url).toBe('https://collab.example.com/api/collaboration/users')
      // GET is the default — method should be undefined
      expect(init?.method).toBeUndefined()
    })

    it('updateCollaborationUser PATCHes /api/collaboration/users/:id', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ user: { userId: 'u1', role: 'admin' } }),
      )
      const { updateCollaborationUser } = await import('./collaboration-settings-api')
      await updateCollaborationUser('u1', { role: 'admin' })

      const { url, init } = lastFetchCall()
      expect(url).toBe('https://collab.example.com/api/collaboration/users/u1')
      expect(init?.method).toBe('PATCH')
    })

    it('resetUserPassword POSTs to /api/collaboration/users/:id/password-reset', async () => {
      fetchSpy.mockResolvedValueOnce(noContentResponse())
      const { resetUserPassword } = await import('./collaboration-settings-api')
      await resetUserPassword('user-42', 'temp1234')

      const { url, init } = lastFetchCall()
      expect(url).toBe(
        'https://collab.example.com/api/collaboration/users/user-42/password-reset',
      )
      expect(init?.method).toBe('POST')
      expect(JSON.parse(init?.body as string)).toEqual({
        temporaryPassword: 'temp1234',
      })
    })

    it('fetchCollaborationInvites GETs /api/collaboration/invites', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ invites: [] }))
      const { fetchCollaborationInvites } = await import('./collaboration-settings-api')
      await fetchCollaborationInvites()

      const { url } = lastFetchCall()
      expect(url).toBe('https://collab.example.com/api/collaboration/invites')
    })

    it('createCollaborationInvite POSTs to /api/collaboration/invites with email', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          invite: {
            inviteId: 'inv-1',
            email: 'a@b.com',
            role: 'member',
            createdAt: '2025-01-01',
            expiresAt: '2025-01-08',
            inviteUrl: 'https://collab.example.com/collaboration/invite/tok',
          },
        }),
      )
      const { createCollaborationInvite } = await import('./collaboration-settings-api')
      await createCollaborationInvite('a@b.com')

      const { url, init } = lastFetchCall()
      expect(url).toBe('https://collab.example.com/api/collaboration/invites')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(init?.body as string)).toEqual({ email: 'a@b.com' })
    })

    it('revokeCollaborationInvite DELETEs /api/collaboration/invites/:inviteId', async () => {
      fetchSpy.mockResolvedValueOnce(noContentResponse())
      const { revokeCollaborationInvite } = await import('./collaboration-settings-api')
      await revokeCollaborationInvite('inv-42')

      const { url, init } = lastFetchCall()
      expect(url).toBe('https://collab.example.com/api/collaboration/invites/inv-42')
      expect(init?.method).toBe('DELETE')
    })
  })

  /* ---- Auth error detection ---- */

  describe('isAuthError', () => {
    it('returns true for 401 status', async () => {
      const { isAuthError } = await import('./collaboration-settings-api')
      const err = new Error('401: Unauthorized') as Error & { status?: number }
      err.status = 401
      expect(isAuthError(err)).toBe(true)
    })

    it('returns true for 403 status', async () => {
      const { isAuthError } = await import('./collaboration-settings-api')
      const err = new Error('403: Forbidden') as Error & { status?: number }
      err.status = 403
      expect(isAuthError(err)).toBe(true)
    })

    it('returns false for non-auth errors', async () => {
      const { isAuthError } = await import('./collaboration-settings-api')
      const err = new Error('500: Internal Server Error') as Error & { status?: number }
      err.status = 500
      expect(isAuthError(err)).toBe(false)
    })

    it('returns false for non-Error values', async () => {
      const { isAuthError } = await import('./collaboration-settings-api')
      expect(isAuthError('some string')).toBe(false)
      expect(isAuthError(null)).toBe(false)
    })
  })

  /* ---- credentials: include on all requests ---- */

  describe('credentials', () => {
    it('all requests include credentials: include', async () => {
      const mod = await import('./collaboration-settings-api')

      // Status
      fetchSpy.mockResolvedValueOnce(jsonResponse({ enabled: true }))
      await mod.fetchCollaborationStatus()
      expect(lastFetchCall().init?.credentials).toBe('include')

      // Users
      fetchSpy.mockResolvedValueOnce(jsonResponse({ users: [] }))
      await mod.fetchCollaborationUsers()
      expect(lastFetchCall().init?.credentials).toBe('include')

      // Password change
      fetchSpy.mockResolvedValueOnce(noContentResponse())
      await mod.changeMyPassword('a', 'b')
      expect(lastFetchCall().init?.credentials).toBe('include')

      // Invite create
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          invite: {
            inviteId: 'x',
            role: 'member',
            createdAt: '',
            expiresAt: '',
            inviteUrl: 'url',
          },
        }),
      )
      await mod.createCollaborationInvite('a@b.com')
      expect(lastFetchCall().init?.credentials).toBe('include')
    })
  })
})
