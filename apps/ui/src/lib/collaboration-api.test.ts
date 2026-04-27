/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn()

vi.mock('./collaboration-endpoints', () => ({
  resolveCollaborationApiBaseUrl: () => 'https://forge.example.com',
}))

const { fetchChannelPromptPreview } = await import('./collaboration-api')

describe('fetchChannelPromptPreview', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches the member prompt preview endpoint with credentials', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        channelId: 'channel-1',
        sections: [{ label: 'System Prompt', content: 'Hello' }],
        redacted: true,
      }),
    })

    await expect(fetchChannelPromptPreview('channel-1')).resolves.toEqual({
      channelId: 'channel-1',
      sections: [{ label: 'System Prompt', content: 'Hello' }],
      redacted: true,
    })

    expect(fetchMock).toHaveBeenCalledWith('https://forge.example.com/api/collaboration/channels/channel-1/prompt-preview', {
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
    })
  })

  it('surfaces API error messages from failed prompt preview fetches', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({ error: 'Password change required' }),
    })

    await expect(fetchChannelPromptPreview('channel-1')).rejects.toThrow('403: Password change required')
  })
})
