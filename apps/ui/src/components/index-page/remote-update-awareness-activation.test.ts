import { describe, expect, it, vi } from 'vitest'
import { activateRemoteUpdateAwarenessProject } from '@/components/settings/remote-update-awareness-api'

describe('remote update awareness activation', () => {
  it('uses the local Builder activation route with only the active project id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ snapshot: {} }) })
    vi.stubGlobal('fetch', fetchMock)
    await activateRemoteUpdateAwarenessProject('ws://127.0.0.1:47188', 'project-1')
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:47188/api/git/remote-update-awareness/activate',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ projectId: 'project-1' }) }),
    )
    vi.unstubAllGlobals()
  })
})
