import { describe, expect, it } from 'vitest'
import { CliError } from '../output.js'
import { parseArgs } from './parser.js'

describe('parseArgs', () => {
  const valueFlags = [
    ['url', 'http://127.0.0.1:1'], ['api-key', 'secret'], ['profile', 'default'], ['session', 'session-1'],
    ['project-agent', 'agent-1'], ['message', 'hello world'], ['label', 'A label'], ['name', 'A name'],
    ['timeout', '10'], ['limit', '20'], ['offset', '3'], ['from-message-id', 'msg-1'],
    ['instructions', 'Preserve pins'], ['answers', '{"0":"yes"}'], ['pinned', 'true'],
  ] as const

  it.each(valueFlags)('parses --%s in spaced form', (flag, value) => {
    const parsed = parseArgs(['command', `--${flag}`, value])
    const option = flag.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
    expect(parsed.positionals).toEqual(['command'])
    expect(parsed.options).toEqual({ [option]: value })
  })

  it.each(valueFlags)('parses --%s in equals form', (flag, value) => {
    const parsed = parseArgs(['command', `--${flag}=${value}`])
    const option = flag.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
    expect(parsed.options).toEqual({ [option]: value })
  })

  it('parses all boolean flags and short aliases', () => {
    expect(parseArgs(['--json', '--quiet', '--help', '-h', '--yes', '--stop-on-timeout', '--include-worker-updates', '--version', '-v'])).toEqual({
      positionals: [], options: { json: true, quiet: true, help: true, yes: true, stopOnTimeout: true, includeWorkerUpdates: true, version: true },
    })
  })

  it('stops option parsing after -- and retains dash-prefixed positionals', () => {
    expect(parseArgs(['run', '--', '--not-an-option', 'value'])).toEqual({
      positionals: ['run', '--not-an-option', 'value'], options: {},
    })
  })

  it.each(['--url', '--message', '--answers', '--pinned'])('rejects missing value for %s', (flag) => {
    expect(() => parseArgs([flag])).toThrow(CliError)
    try { parseArgs([flag]) } catch (error) {
      expect(error).toMatchObject({ code: 'missing_flag_value' })
    }
  })

  it('rejects another flag as a value and unknown options', () => {
    expect(() => parseArgs(['--timeout', '--json'])).toThrow(/Missing value for --timeout/u)
    expect(() => parseArgs(['--wat'])).toThrow(/Unknown option: --wat/u)
    expect(() => parseArgs(['-x'])).toThrow(/Unknown option: -x/u)
  })
})
