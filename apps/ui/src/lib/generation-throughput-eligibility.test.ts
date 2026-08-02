import { describe, expect, it } from 'vitest'
import type { AgentDescriptor } from '@forge/protocol'
import { isPiGenerationThroughputEligible } from './generation-throughput-eligibility'

function agent(provider: string): Pick<AgentDescriptor, 'model'> {
  return { model: { provider, modelId: 'test-model', thinkingLevel: 'high' } }
}

describe('Pi generation throughput eligibility', () => {
  it('uses descriptor model provider as the runtime discriminator for manager sessions', () => {
    expect(isPiGenerationThroughputEligible(agent('openai-codex'))).toBe(true)
    expect(isPiGenerationThroughputEligible(agent(' CURSOR-SDK '))).toBe(false)
  })

  it('fails closed until worker runtime metadata is available', () => {
    expect(isPiGenerationThroughputEligible(undefined)).toBe(false)
  })
})
