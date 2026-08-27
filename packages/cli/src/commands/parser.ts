import { CliError } from '../output.js'
import { EXIT_CODES } from '../version.js'
import type { ParsedArgs } from './types.js'

type ValueOptionKey = {
  [Key in keyof ParsedArgs['options']]-?: Exclude<ParsedArgs['options'][Key], undefined> extends string
    ? Key
    : never
}[keyof ParsedArgs['options']]

const VALUE_FLAG_OPTIONS = {
  '--url': 'url',
  '--api-key': 'apiKey',
  '--profile': 'profile',
  '--session': 'session',
  '--project-agent': 'projectAgent',
  '--message': 'message',
  '--label': 'label',
  '--name': 'name',
  '--timeout': 'timeout',
  '--limit': 'limit',
  '--offset': 'offset',
  '--from-message-id': 'fromMessageId',
  '--instructions': 'instructions',
  '--answers': 'answers',
  '--pinned': 'pinned',
} as const satisfies Record<string, ValueOptionKey>

type ValueFlag = keyof typeof VALUE_FLAG_OPTIONS

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
    if (token === '--include-worker-updates') {
      options.includeWorkerUpdates = true
      continue
    }
    if (token === '--version' || token === '-v') {
      options.version = true
      continue
    }

    const equalsIndex = token.indexOf('=')
    const flag = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token
    if (isValueFlag(flag)) {
      const value = equalsIndex >= 0 ? token.slice(equalsIndex + 1) : argv[index + 1]
      if (value === undefined || (equalsIndex < 0 && (!value || value.startsWith('--')))) {
        throw new CliError(`Missing value for ${flag}`, { exitCode: EXIT_CODES.usage, code: 'missing_flag_value' })
      }
      options[VALUE_FLAG_OPTIONS[flag]] = value
      if (equalsIndex < 0) index += 1
      continue
    }

    if (token.startsWith('-')) {
      throw new CliError(`Unknown option: ${token}`, { exitCode: EXIT_CODES.usage, code: 'unknown_option' })
    }

    positionals.push(token)
  }

  return { positionals, options }
}

function isValueFlag(value: string): value is ValueFlag {
  return Object.hasOwn(VALUE_FLAG_OPTIONS, value)
}
