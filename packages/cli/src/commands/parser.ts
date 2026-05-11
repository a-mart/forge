import { CliError } from '../output.js'
import { EXIT_CODES } from '../version.js'
import type { ParsedArgs } from './types.js'

const VALUE_FLAGS = new Set([
  '--url',
  '--api-key',
  '--profile',
  '--session',
  '--project-agent',
  '--message',
  '--label',
  '--name',
  '--timeout',
  '--from-message-id',
  '--answers',
  '--pinned',
])

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
    if (token === '--yes') {
      options.yes = true
      continue
    }
    if (token === '--stop-on-timeout') {
      options.stopOnTimeout = true
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
    if (token.startsWith('--project-agent=')) {
      options.projectAgent = token.slice('--project-agent='.length)
      continue
    }
    if (token.startsWith('--message=')) {
      options.message = token.slice('--message='.length)
      continue
    }
    if (token.startsWith('--label=')) {
      options.label = token.slice('--label='.length)
      continue
    }
    if (token.startsWith('--name=')) {
      options.name = token.slice('--name='.length)
      continue
    }
    if (token.startsWith('--timeout=')) {
      options.timeout = token.slice('--timeout='.length)
      continue
    }
    if (token.startsWith('--from-message-id=')) {
      options.fromMessageId = token.slice('--from-message-id='.length)
      continue
    }
    if (token.startsWith('--answers=')) {
      options.answers = token.slice('--answers='.length)
      continue
    }
    if (token.startsWith('--pinned=')) {
      options.pinned = token.slice('--pinned='.length)
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
      return
    case '--project-agent':
      options.projectAgent = value
      return
    case '--message':
      options.message = value
      return
    case '--label':
      options.label = value
      return
    case '--name':
      options.name = value
      return
    case '--timeout':
      options.timeout = value
      return
    case '--from-message-id':
      options.fromMessageId = value
      return
    case '--answers':
      options.answers = value
      return
    case '--pinned':
      options.pinned = value
  }
}
