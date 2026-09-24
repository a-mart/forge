import { describe, expect, it } from 'vitest'

import { getWsRequestContract } from '../ws-request-contract.js'

describe('session attention protocol contract', () => {
  it('registers dismissal-to-update request correlation', () => {
    expect(getWsRequestContract('dismiss_session_attention')).toEqual({
      commandType: 'dismiss_session_attention',
      resultFamily: 'session_attention_update',
      requestId: { ui: 'required', wire: 'required' },
      successEvents: ['session_attention_update'],
      errorCodeFragments: ['dismiss_session_attention'],
    })
  })
})
