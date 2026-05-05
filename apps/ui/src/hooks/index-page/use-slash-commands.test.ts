import { describe, expect, it } from 'vitest'
import { parseCompactSlashCommand } from './use-slash-commands'

describe('parseCompactSlashCommand', () => {
  it('accepts /compact with no instructions', () => {
    const result = parseCompactSlashCommand('/compact')
    expect(result).toEqual({})
    expect(result).not.toBeNull()
    expect(result).not.toHaveProperty('customInstructions')
  })

  it('accepts /compact with custom instructions', () => {
    const result = parseCompactSlashCommand('/compact preserve API docs')
    expect(result).toEqual({ customInstructions: 'preserve API docs' })
  })

  it('preserves multiline custom instructions', () => {
    const result = parseCompactSlashCommand('/compact line one\nline two\nline three')
    expect(result).toEqual({ customInstructions: 'line one\nline two\nline three' })
  })

  it('trims leading/trailing whitespace around the command', () => {
    const result = parseCompactSlashCommand('  /compact  ')
    expect(result).toEqual({})
  })

  it('trims leading whitespace from instructions while preserving internal newlines', () => {
    const result = parseCompactSlashCommand('/compact   keep this\nand this   ')
    expect(result).toEqual({ customInstructions: 'keep this\nand this' })
  })

  it('is case insensitive', () => {
    expect(parseCompactSlashCommand('/Compact')).toEqual({})
    expect(parseCompactSlashCommand('/COMPACT')).toEqual({})
    expect(parseCompactSlashCommand('/CoMpAcT focus on tests')).toEqual({
      customInstructions: 'focus on tests',
    })
  })

  it('rejects text that does not start with /compact', () => {
    expect(parseCompactSlashCommand('hello')).toBeNull()
    expect(parseCompactSlashCommand('compact')).toBeNull()
    expect(parseCompactSlashCommand('/ compact')).toBeNull()
  })

  it('rejects /compactly and other near-misses as non-matching', () => {
    // The regex matches /compact followed by optional whitespace+instructions
    // /compactly should NOT match because the regex requires either end-of-string or whitespace after /compact
    expect(parseCompactSlashCommand('/compactly')).toBeNull()
    expect(parseCompactSlashCommand('/compacting')).toBeNull()
  })

  it('rejects empty and whitespace-only input', () => {
    expect(parseCompactSlashCommand('')).toBeNull()
    expect(parseCompactSlashCommand('   ')).toBeNull()
  })

  it('rejects /compact embedded in other text', () => {
    expect(parseCompactSlashCommand('please /compact this')).toBeNull()
  })

  it('returns empty object when instructions are only whitespace', () => {
    const result = parseCompactSlashCommand('/compact    ')
    expect(result).toEqual({})
    expect(result).not.toHaveProperty('customInstructions')
  })
})
