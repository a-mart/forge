import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('conversation subscription emitter invariant', () => {
  it('has one production buildSubscribeCommand call', () => {
    const source = readFileSync(fileURLToPath(new URL('../ws-client.ts', import.meta.url)), 'utf8')
    const callCount = source.match(/buildSubscribeCommand\s*\(/g)?.length ?? 0
    expect(callCount).toBe(1)
    expect(source.indexOf('conversationBootstrap: {')).toBeLessThan(source.indexOf('this.emitActiveSubscriptionCommand()'))
  })
})
