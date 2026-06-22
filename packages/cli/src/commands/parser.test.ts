import { describe, expect, it } from 'vitest'

import { parseArgs } from './parser.js'

describe('parseArgs', () => {
  it('parses compaction instructions in spaced and equals forms', () => {
    expect(parseArgs(['sessions', 'compact', 'session-1', '--instructions', 'Preserve pins'])).toEqual({
      positionals: ['sessions', 'compact', 'session-1'],
      options: { instructions: 'Preserve pins' },
    })
    expect(parseArgs(['sessions', 'smart-compact', 'session-1', '--instructions=Preserve pins'])).toEqual({
      positionals: ['sessions', 'smart-compact', 'session-1'],
      options: { instructions: 'Preserve pins' },
    })
  })

  it('parses transcript flags in spaced and equals forms', () => {
    expect(parseArgs([
      'sessions',
      'transcript',
      'session-1',
      '--include-worker-updates',
      '--limit',
      '10',
      '--offset=20',
    ])).toEqual({
      positionals: ['sessions', 'transcript', 'session-1'],
      options: {
        includeWorkerUpdates: true,
        limit: '10',
        offset: '20',
      },
    })
  })
})
