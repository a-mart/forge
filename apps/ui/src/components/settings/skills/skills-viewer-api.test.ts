import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchSkillFileContent,
  fetchSkillFiles,
  fetchSkillInventory,
} from './skills-viewer-api'

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

describe('skills-viewer-api', () => {
  it('fetches the skill inventory without using the browser cache', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(mockJsonResponse({ skills: [] }))

    await fetchSkillInventory('ws://127.0.0.1:47187', 'profile-a')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/settings/skills?profileId=profile-a',
      expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' }),
    )
  })

  it('fetches skill files without using the browser cache', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(mockJsonResponse({ skillId: 'skill-1', rootPath: '/tmp/skill', path: '', entries: [] }))

    await fetchSkillFiles('ws://127.0.0.1:47187', 'skill-1', 'docs')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/settings/skills/skill-1/files?path=docs',
      expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' }),
    )
  })

  it('fetches skill file content without using the browser cache', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(mockJsonResponse({ path: 'SKILL.md', absolutePath: '/tmp/skill/SKILL.md', content: '# Skill', binary: false, size: 7, lines: 1 }))

    await fetchSkillFileContent('ws://127.0.0.1:47187', 'skill-1', 'SKILL.md')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/settings/skills/skill-1/content?path=SKILL.md',
      expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' }),
    )
  })
})
