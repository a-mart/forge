/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileContentResult, FileSaveRequest, FileSaveSuccessResponse } from './use-file-browser-queries'
import {
  applySuccessfulFileDeleteToCaches,
  applySuccessfulFileSaveToCaches,
  deleteFilePath,
  invalidateFileBrowserCaches,
  saveFileContent,
} from './use-file-browser-queries'
import { invalidateGitCaches } from '@/components/diff-viewer/use-diff-queries'

vi.mock('@/components/diff-viewer/use-diff-queries', () => ({
  invalidateGitCaches: vi.fn(),
}))

const version = {
  kind: 'sha256-stat-v1' as const,
  sha256: 'abc123',
  size: 5,
  mtimeMs: 123,
}

const request: FileSaveRequest = {
  agentId: 'session-a',
  path: 'src/file.ts',
  content: 'hello',
  baseVersion: version,
}

function mockFetchResponse(status: number, payload: unknown, statusText = 'OK') {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: vi.fn().mockResolvedValue(payload),
  })
}

beforeEach(() => {
  invalidateFileBrowserCaches()
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('saveFileContent', () => {
  it('saves through PUT /api/files/content and returns successful typed responses', async () => {
    const success = {
      success: true,
      version: { ...version, sha256: 'def456' },
      size: 6,
      lines: 1,
      bytesWritten: 6,
    }
    const fetchSpy = mockFetchResponse(200, success)
    vi.stubGlobal('fetch', fetchSpy)

    await expect(saveFileContent('ws://127.0.0.1:47187', request)).resolves.toEqual(success)

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/files/content',
      expect.objectContaining({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      }),
    )
  })

  it('returns HTTP 409 conflict payloads without throwing', async () => {
    const conflict = {
      success: false,
      conflict: true,
      reason: 'modified' as const,
      currentVersion: { ...version, sha256: 'changed' },
      currentSize: 9,
    }
    vi.stubGlobal('fetch', mockFetchResponse(409, conflict, 'Conflict'))

    await expect(saveFileContent('ws://127.0.0.1:47187', request)).resolves.toEqual(conflict)
  })

  it('throws for non-409 errors and malformed success/conflict payloads', async () => {
    vi.stubGlobal('fetch', mockFetchResponse(400, { error: 'Invalid payload' }, 'Bad Request'))
    await expect(saveFileContent('ws://127.0.0.1:47187', request)).rejects.toThrow('Invalid payload')

    vi.stubGlobal('fetch', mockFetchResponse(409, { success: true }, 'Conflict'))
    await expect(saveFileContent('ws://127.0.0.1:47187', request)).rejects.toThrow('Malformed file save response')

    vi.stubGlobal('fetch', mockFetchResponse(200, {
      success: true,
      version: { kind: 'sha256-stat-v1', sha256: 'missing-numeric-fields' },
      size: 6,
      lines: 1,
      bytesWritten: 6,
    }))
    await expect(saveFileContent('ws://127.0.0.1:47187', request)).rejects.toThrow('Malformed file save response')

    vi.stubGlobal('fetch', mockFetchResponse(409, {
      success: false,
      conflict: true,
      reason: 'surprising-new-reason',
    }, 'Conflict'))
    await expect(saveFileContent('ws://127.0.0.1:47187', request)).rejects.toThrow('Malformed file save response')
  })
})

describe('file browser query keys', () => {
  function buildTestFileBrowserQueryKey(
    scope: string,
    agentId: string | null,
    worktreeId: string | null | undefined,
    ...parts: string[]
  ): string {
    return `${scope}:${agentId ?? ''}:${worktreeId ?? ''}:${parts.join(':')}`
  }

  it('separates cache entries by worktreeId for the same agent and path', () => {
    const sessionKey = buildTestFileBrowserQueryKey('files:list', 'agent-1', null, 'src')
    const worktreeKey = buildTestFileBrowserQueryKey('files:list', 'agent-1', 'abc123', 'src')

    expect(sessionKey).not.toBe(worktreeKey)
    expect(sessionKey).toBe('files:list:agent-1::src')
    expect(worktreeKey).toBe('files:list:agent-1:abc123:src')
  })
})

describe('file save cache helpers', () => {
  it('updates the content cache and marks explicit refresh targets for later mounted UI refresh', async () => {
    const previousContent: FileContentResult = {
      content: 'hello',
      binary: false,
      size: 5,
      lines: 1,
      encoding: 'utf8',
      version,
      editability: { editable: true, maxEditableBytes: 1024 },
    }
    const saveResponse: FileSaveSuccessResponse = {
      success: true,
      version: { ...version, sha256: 'saved', size: 12 },
      size: 12,
      lines: 2,
      bytesWritten: 12,
    }

    const result = applySuccessfulFileSaveToCaches({
      agentId: 'session-a',
      worktreeId: null,
      filePath: 'src/file.ts',
      previousContent,
      draftContent: 'hello\nworld\n',
      saveResponse,
    })

    expect(result.content).toMatchObject({
      content: 'hello\nworld\n',
      size: 12,
      lines: 2,
      encoding: 'utf8',
      version: saveResponse.version,
    })
    expect(result.refresh).toEqual({
      content: true,
      sidebar: true,
      tree: true,
      sourceControl: true,
    })
    expect(invalidateGitCaches).toHaveBeenCalledWith({ agentId: 'session-a', repoTarget: 'workspace' })

  })
})

describe('deleteFilePath', () => {
  it('deletes through DELETE /api/files/content with query params', async () => {
    const success = {
      success: true,
      path: 'src/file.ts',
      entryType: 'file' as const,
    }
    const fetchSpy = mockFetchResponse(200, success)
    vi.stubGlobal('fetch', fetchSpy)

    await expect(deleteFilePath('ws://127.0.0.1:47187', {
      agentId: 'session-a',
      path: 'src/file.ts',
      worktreeId: 'worktree-1',
    })).resolves.toEqual(success)

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/files/content?agentId=session-a&path=src%2Ffile.ts&worktreeId=worktree-1',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})

describe('file delete cache helpers', () => {
  it('invalidates git caches after delete', () => {
    applySuccessfulFileDeleteToCaches({
      agentId: 'session-a',
      worktreeId: null,
      path: 'src/file.ts',
      entryType: 'file',
      openFilePath: 'src/file.ts',
    })

    expect(invalidateGitCaches).toHaveBeenCalledWith({ agentId: 'session-a', repoTarget: 'workspace' })
  })
})
