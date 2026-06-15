import { describe, expect, it } from 'vitest'

import { parseArgs } from './parser.js'

describe('parseArgs', () => {
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
