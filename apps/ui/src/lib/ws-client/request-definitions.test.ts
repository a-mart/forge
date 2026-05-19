import { describe, expect, it } from 'vitest'
import { buildCreateManagerCommand } from './request-definitions'

describe('buildCreateManagerCommand', () => {
  it('serializes reasoningLevel with preset create_manager payloads', () => {
    expect(buildCreateManagerCommand({
      name: '  Preset Manager  ',
      cwd: '/tmp/project',
      model: 'pi-codex',
      reasoningLevel: 'low',
    }, 'req-1')).toEqual({
      type: 'create_manager',
      name: 'Preset Manager',
      cwd: '/tmp/project',
      model: 'pi-codex',
      reasoningLevel: 'low',
      requestId: 'req-1',
    })
  })

  it('serializes reasoningLevel with exact modelSelection create_manager payloads', () => {
    expect(buildCreateManagerCommand({
      name: 'Exact Manager',
      cwd: '/tmp/project',
      modelSelection: { provider: 'claude-sdk', modelId: 'claude-opus-4-7' },
      reasoningLevel: 'medium',
    }, 'req-2')).toEqual({
      type: 'create_manager',
      name: 'Exact Manager',
      cwd: '/tmp/project',
      modelSelection: { provider: 'claude-sdk', modelId: 'claude-opus-4-7' },
      reasoningLevel: 'medium',
      requestId: 'req-2',
    })
  })

  it('rejects invalid create_manager reasoningLevel during serialization', () => {
    expect(() => buildCreateManagerCommand({
      name: 'Bad Reasoning Manager',
      cwd: '/tmp/project',
      model: 'pi-codex',
      reasoningLevel: 'ultra' as never,
    }, 'req-3')).toThrow('Invalid reasoning level.')
  })
})
