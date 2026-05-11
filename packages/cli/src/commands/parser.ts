import { CliError } from '../output.js'
import { EXIT_CODES } from '../version.js'
import type { ParsedArgs } from './types.js'

const VALUE_FLAGS = new Set(['--url', '--api-key', '--profile', '--session'])

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const options: ParsedArgs['options'] = {}

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    if (token === '--') {
      positionals.push(...argv.slice(index + 1))
      break
    }

    if (token === '--json') {
      options.json = true
      continue
    }
    if (token === '--quiet') {
      options.quiet = true
      continue
    }
    if (token === '--help' || token === '-h') {
      options.help = true
      continue
    }
    if (token === '--version' || token === '-v') {
      options.version = true
      continue
    }

    if (VALUE_FLAGS.has(token)) {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) {
        throw new CliError(`Missing value for ${token}`, { exitCode: EXIT_CODES.usage, code: 'missing_flag_value' })
      }
      assignValueFlag(options, token, value)
      index += 1
      continue
    }

    if (token.startsWith('--url=')) {
      options.url = token.slice('--url='.length)
      continue
    }
    if (token.startsWith('--api-key=')) {
      options.apiKey = token.slice('--api-key='.length)
      continue
    }
    if (token.startsWith('--profile=')) {
      options.profile = token.slice('--profile='.length)
      continue
    }
    if (token.startsWith('--session=')) {
      options.session = token.slice('--session='.length)
      continue
    }

    if (token.startsWith('-')) {
      throw new CliError(`Unknown option: ${token}`, { exitCode: EXIT_CODES.usage, code: 'unknown_option' })
    }

    positionals.push(token)
  }

  return { positionals, options }
}

function assignValueFlag(options: ParsedArgs['options'], flag: string, value: string): void {
  switch (flag) {
    case '--url':
      options.url = value
      return
    case '--api-key':
      options.apiKey = value
      return
    case '--profile':
      options.profile = value
      return
    case '--session':
      options.session = value
  }
}
