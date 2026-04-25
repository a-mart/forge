import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchServerVersion, fetchSkillsList } from './settings-api'

const fetchMock = vi.fn<typeof fetch>()

afterEach(() => {
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

function mockJsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
}

describe('settings-api skills list', () => {
  it('keeps skills whose description is omitted', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      mockJsonResponse({
        skills: [
          {
            name: 'custom-skill',
            envCount: 0,
            hasRichConfig: false,
          },
        ],
      }),
    )

    const skills = await fetchSkillsList('ws://127.0.0.1:47187')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/settings/skills',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
    expect(skills).toEqual([
      {
        name: 'custom-skill',
        envCount: 0,
        hasRichConfig: false,
      },
    ])
  })
})

describe('settings-api server version', () => {
  it('reads the resolved backend version from stats', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      mockJsonResponse({
        system: {
          serverVersion: '0.13.0',
        },
      }),
    )

    await expect(fetchServerVersion('ws://127.0.0.1:47187')).resolves.toBe('0.13.0')
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/stats?range=7d',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
  })
})
