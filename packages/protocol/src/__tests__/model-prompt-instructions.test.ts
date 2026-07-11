import { describe, expect, it } from 'vitest'
import { getBuiltInModelSpecificInstructions } from '../model-prompt-instructions.js'

describe('model-prompt-instructions', () => {
  it('returns GPT-5 instructions for pi-codex, pi-5.4, pi-5.5, and pi-5.6 families', () => {
    const codexInstructions = getBuiltInModelSpecificInstructions('pi-codex')
    const gpt54Instructions = getBuiltInModelSpecificInstructions('pi-5.4-mini')
    const gpt55Instructions = getBuiltInModelSpecificInstructions('pi-5.5')
    const gpt56Instructions = getBuiltInModelSpecificInstructions('pi-5.6')

    expect(codexInstructions).toContain('Return the requested sections only, in the requested order.')
    expect(codexInstructions).toContain('Do not use em dashes unless the user explicitly asks for them')
    expect(codexInstructions).toContain('Use proportional effort')
    expect(codexInstructions).toContain('do not start another review wave by default')
    expect(codexInstructions).not.toContain('If another action would likely improve correctness or completeness')
    expect(gpt54Instructions).toBe(codexInstructions)
    expect(gpt55Instructions).toBe(codexInstructions)
    expect(gpt56Instructions).toBe(codexInstructions)
  })

  it('returns Claude instructions for pi-opus, pi-sonnet, and Claude SDK families', () => {
    const instructions = getBuiltInModelSpecificInstructions('pi-opus')
    const sonnetInstructions = getBuiltInModelSpecificInstructions('pi-sonnet')
    const variantInstructions = getBuiltInModelSpecificInstructions('pi-opus-sonnet')
    const sdkOpusInstructions = getBuiltInModelSpecificInstructions('sdk-opus')
    const sdkSonnetInstructions = getBuiltInModelSpecificInstructions('sdk-sonnet')

    expect(instructions).toContain('Prefer concise, direct answers over essay-style framing.')
    expect(instructions).toContain('When evidence is sufficient, state the conclusion plainly instead of over-hedging.')
    expect(instructions).toContain('Use proportional effort and stop once acceptance criteria are met')
    expect(sonnetInstructions).toBe(instructions)
    expect(variantInstructions).toBe(instructions)
    expect(sdkOpusInstructions).toBe(instructions)
    expect(sdkSonnetInstructions).toBe(instructions)
  })

  it('returns null for unsupported families', () => {
    expect(getBuiltInModelSpecificInstructions('pi-grok')).toBeNull()
    expect(getBuiltInModelSpecificInstructions('')).toBeNull()
  })
})
