import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchSkillFileContent,
  fetchSkillFiles,
  fetchSkillInventory,
  importSkill,
  previewSkillImportFromUrl,
  shareSkill,
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

  it('posts share and import requests through the settings client', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock
      .mockResolvedValueOnce(mockJsonResponse({ shareUrl: 'https://share.test/s/t', importUrl: 'forge://skill-import?url=x', expiresAt: '2026-05-20T00:00:00.000Z', contentSha256: 'a'.repeat(64), warnings: [] }))
      .mockResolvedValueOnce(mockJsonResponse({ bundle: { skill: { handle: 'shared', name: 'Shared' }, files: [], totals: { fileCount: 0, byteCount: 0 }, portability: { scripts: [], dependencies: [] }, origin: { platform: 'darwin', arch: 'arm64' } }, target: { scope: 'global' }, conflict: { exists: false }, warnings: [] }))
      .mockResolvedValueOnce(mockJsonResponse({ bundle: { skill: { handle: 'shared', name: 'Shared' }, files: [], totals: { fileCount: 0, byteCount: 0 } }, target: { scope: 'global' }, rootPath: '/tmp/shared', replaced: false, installedOverride: false, warnings: [] }))

    await shareSkill('ws://127.0.0.1:47187', 'skill/id')
    await previewSkillImportFromUrl('ws://127.0.0.1:47187', { url: 'https://share.test/s/t', target: { scope: 'global' } })
    await importSkill('ws://127.0.0.1:47187', { source: { url: 'https://share.test/s/t' }, target: { scope: 'global' } })

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:47187/api/settings/skills/skill%2Fid/share',
      expect.objectContaining({ method: 'POST', cache: 'no-store', credentials: 'same-origin' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:47187/api/settings/skills/import/preview-url',
      expect.objectContaining({ method: 'POST', cache: 'no-store', credentials: 'same-origin' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:47187/api/settings/skills/import',
      expect.objectContaining({ method: 'POST', cache: 'no-store', credentials: 'same-origin' }),
    )
  })
})
