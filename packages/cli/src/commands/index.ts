import { resolveCliConfig } from '../config.js'
import { ForgeClient, type ForgeClientLike } from '../forge-client.js'
import { CliError, type CliIo, renderError, writeHuman } from '../output.js'
import { CLI_VERSION, EXIT_CODES } from '../version.js'
import { handleConfigCommand } from './config.js'
import { commandHelp, mainHelp } from './help.js'
import {
  handleChoicesMutationCommand,
  handleProjectAgentsMutationCommand,
  handleSessionsMutationCommand,
} from './mutations.js'
import { parseArgs } from './parser.js'
import {
  handleAgentsCommand,
  handleChoicesCommand,
  handleDoctorCommand,
  handleProfilesCommand,
  handleProjectAgentsCommand,
  handleSessionsCommand,
  handleStatusCommand,
} from './read.js'
import { handleRunCommand, handleWaitCommand } from './run.js'
import type { CommandContext, ParsedArgs } from './types.js'

export interface RunCliOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  io?: CliIo
  createClient?: (args: ParsedArgs) => Promise<ForgeClientLike>
}

export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
  const io = options.io ?? { stdout: process.stdout, stderr: process.stderr }
  let args: ParsedArgs
  try {
    args = parseArgs(argv)
  } catch (error) {
    const rendered = renderError(error, false)
    io.stderr.write(rendered.text)
    return rendered.exitCode
  }

  if (args.options.version) {
    writeHuman(io, args.options, CLI_VERSION)
    return EXIT_CODES.success
  }

  if (args.options.help || args.positionals.length === 0) {
    writeHuman(io, args.options, commandHelp(args.positionals[0]))
    return EXIT_CODES.success
  }

  const context: CommandContext = {
    args,
    io,
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    createClient: options.createClient
      ? () => options.createClient!(args)
      : () => createDefaultClient(args, options.cwd ?? process.cwd(), options.env ?? process.env),
  }

  try {
    switch (args.positionals[0]) {
      case 'status':
        return await handleStatusCommand(context)
      case 'doctor':
        return await handleDoctorCommand(context)
      case 'config':
        return await handleConfigCommand(context)
      case 'profiles':
        return await handleProfilesCommand(context)
      case 'sessions':
        return isSessionMutationAction(args.positionals[1])
          ? await handleSessionsMutationCommand(context)
          : await handleSessionsCommand(context)
      case 'agents':
        return await handleAgentsCommand(context)
      case 'project-agents':
        return args.positionals[1] === 'send'
          ? await handleProjectAgentsMutationCommand(context)
          : await handleProjectAgentsCommand(context)
      case 'choices':
        return isChoiceMutationAction(args.positionals[1])
          ? await handleChoicesMutationCommand(context)
          : await handleChoicesCommand(context)
      case 'run':
        return await handleRunCommand(context, 'run')
      case 'launch':
        return await handleRunCommand(context, 'launch')
      case 'wait':
        return await handleWaitCommand(context)
      default:
        throw new CliError(`Unknown command: ${args.positionals[0]}`, { exitCode: EXIT_CODES.usage, code: 'unknown_command' })
    }
  } catch (error) {
    const rendered = renderError(error, Boolean(args.options.json))
    io.stderr.write(rendered.text)
    if (!args.options.json) io.stderr.write(`\nRun 'forge --help' for usage.\n`)
    return rendered.exitCode
  }
}

async function createDefaultClient(args: ParsedArgs, cwd: string, env: NodeJS.ProcessEnv): Promise<ForgeClientLike> {
  const resolved = await resolveCliConfig({
    cwd,
    env,
    flagUrl: args.options.url,
    flagApiKey: args.options.apiKey,
  })
  if (!resolved.url) {
    throw new CliError('Forge URL is required. Set --url, FORGE_URL, or forge config set url <url>.', {
      exitCode: EXIT_CODES.usage,
      code: 'missing_url',
    })
  }
  if (!resolved.apiKey) {
    throw new CliError('Forge CLI API key is required. Set --api-key, FORGE_CLI_API_KEY, or forge config set apiKey <key>.', {
      exitCode: EXIT_CODES.usage,
      code: 'missing_api_key',
    })
  }

  return new ForgeClient({ url: resolved.url, apiKey: resolved.apiKey })
}

function isSessionMutationAction(action: string | undefined): boolean {
  return action === 'create' ||
    action === 'send' ||
    action === 'wait' ||
    action === 'stop' ||
    action === 'resume' ||
    action === 'fork' ||
    action === 'compact' ||
    action === 'smart-compact' ||
    action === 'rename' ||
    action === 'pin' ||
    action === 'unpin' ||
    action === 'clear' ||
    action === 'delete'
}

function isChoiceMutationAction(action: string | undefined): boolean {
  return action === 'answer' || action === 'cancel'
}

export { mainHelp, parseArgs }
