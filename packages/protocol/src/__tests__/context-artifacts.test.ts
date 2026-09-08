import { describe, expect, it } from 'vitest'
import { isSessionContextArtifacts } from '../context-artifacts.js'
const snapshot = { revision: 1, contextMode: { sessionAgentId: 'session', profileId: 'project',
  projectDefault: 'summary', effectiveMode: 'fresh', appliedMode: 'fresh', freshSupported: true },
  files: [{ path: 'checkpoint.md', kind: 'checkpoint', revision: 1, digest: 'a'.repeat(64), bytes: 4,
    text: 'note', updatedAt: '2026-09-08T12:00:00Z' }] }
describe('context artifact response contract', () => {
  it('accepts a bounded canonical snapshot and an empty session', () => {
    expect(isSessionContextArtifacts(snapshot)).toBe(true)
    expect(isSessionContextArtifacts({ ...snapshot, revision: 0, files: [] })).toBe(true)
  })
  it('rejects malformed text, duplicate paths, invalid kinds and invalid context modes', () => {
    for (const file of [{ ...snapshot.files[0], text: {} }, { ...snapshot.files[0], kind: 'other' },
      { ...snapshot.files[0], text: 'x'.repeat(128 * 1024 + 1) }]) {
      expect(isSessionContextArtifacts({ ...snapshot, files: [file] })).toBe(false)
    }
    expect(isSessionContextArtifacts({ ...snapshot, files: [...snapshot.files, ...snapshot.files] })).toBe(false)
    expect(isSessionContextArtifacts({ ...snapshot, contextMode: { ...snapshot.contextMode, appliedMode: 'invalid' } })).toBe(false)
  })
})
