import type { CliChoiceRouteResult, CliSessionCreatedResult } from '@forge/protocol'

import { CliError, formatObject, writeHuman, writeJson } from '../output.js'
import { EXIT_CODES } from '../version.js'
import { parseAnswersJson, parsePinned, parseTimeoutMs, readMessageInput } from './input.js'
import { exitCodeForRunResult, writeDispatchResult, writeRunResult } from './run.js'
import type { CommandContext } from './types.js'

export async function handleSessionsMutationCommand(context: CommandContext): Promise<number> {
  const [, action, arg] = context.args.positionals

  switch (action) {
    case 'create': {
      const profileId = requireOption(context.args.options.profile, '--profile')
      const client = await context.createClient()
      const result = await client.createSession({
        profileId,
        label: context.args.options.label,
        name: context.args.options.name,
        invocationCwd: context.cwd,
      })
      writeSessionCreatedResult(context, result)
      return EXIT_CODES.success
    }

    case 'send': {
      const agentId = requireArg(arg, 'agentId')
      const text = await readMessageInput(context.args.options.message, context.cwd)
      const client = await context.createClient()
      const result = await client.sendSessionMessage(agentId, { text })
      writeDispatchResult(context, result)
      return EXIT_CODES.success
    }

    case 'wait': {
      const agentId = requireArg(arg, 'agentId')
      const timeoutMs = parseTimeoutMs(context.args.options.timeout)
      const client = await context.createClient()
      const result = await client.waitForSession(agentId, {
        timeoutMs,
        stopOnTimeout: Boolean(context.args.options.stopOnTimeout),
      })
      writeRunResult(context, result)
      return exitCodeForRunResult(result)
    }

    case 'stop':
      return mutateSession(context, requireArg(arg, 'agentId'), 'stop', (client, agentId) => client.stopSession(agentId))
    case 'resume':
      return mutateSession(context, requireArg(arg, 'agentId'), 'resume', (client, agentId) => client.resumeSession(agentId))
    case 'clear': {
      requireYes(context)
      return mutateSession(context, requireArg(arg, 'agentId'), 'clear', (client, agentId) => client.clearSession(agentId))
    }
    case 'delete': {
      requireYes(context)
      return mutateSession(context, requireArg(arg, 'agentId'), 'delete', (client, agentId) => client.deleteSession(agentId))
    }
    case 'rename': {
      const agentId = requireArg(arg, 'agentId')
      const label = requireOption(context.args.options.label, '--label')
      return mutateSession(context, agentId, 'rename', (client) => client.renameSession(agentId, label), { label })
    }
    case 'pin': {
      const pinned = parsePinned(context.args.options.pinned, true)
      return mutateSession(context, requireArg(arg, 'agentId'), 'pin', (client, agentId) => client.pinSession(agentId, pinned), { pinned })
    }
    case 'unpin': {
      const pinned = parsePinned(context.args.options.pinned, false)
      return mutateSession(context, requireArg(arg, 'agentId'), 'pin', (client, agentId) => client.pinSession(agentId, pinned), { pinned })
    }
    case 'fork': {
      const sourceAgentId = requireArg(arg, 'agentId')
      const client = await context.createClient()
      const result = await client.forkSession(sourceAgentId, {
        label: context.args.options.label,
        fromMessageId: context.args.options.fromMessageId,
      })
      writeMutationResult(context, 'fork', sourceAgentId, result, {
        label: context.args.options.label,
        fromMessageId: context.args.options.fromMessageId,
      })
      return EXIT_CODES.success
    }
    default:
      throw usage('Usage: forge sessions create|send|wait|stop|resume|fork|rename|pin|unpin|clear|delete ...')
  }
}

export async function handleProjectAgentsMutationCommand(context: CommandContext): Promise<number> {
  const [, action, handle] = context.args.positionals
  if (action !== 'send') {
    throw usage('Usage: forge project-agents send --profile <profileId> <handle> --message <text|@file>')
  }
  const profileId = requireOption(context.args.options.profile, '--profile')
  const resolvedHandle = requireArg(handle, 'handle')
  const text = await readMessageInput(context.args.options.message, context.cwd)
  const client = await context.createClient()
  const result = await client.sendProjectAgentMessage(profileId, resolvedHandle, { text })
  writeDispatchResult(context, result)
  return EXIT_CODES.success
}

export async function handleChoicesMutationCommand(context: CommandContext): Promise<number> {
  const [, action, choiceIdArg] = context.args.positionals
  const choiceId = requireArg(choiceIdArg, 'choiceId')

  switch (action) {
    case 'answer': {
      const answers = parseAnswersJson(context.args.options.answers)
      const client = await context.createClient()
      const result = await client.answerChoice(choiceId, answers, context.args.options.session)
      writeChoiceRouteResult(context, result)
      return EXIT_CODES.success
    }
    case 'cancel': {
      const client = await context.createClient()
      const result = await client.cancelChoice(choiceId, context.args.options.session)
      writeChoiceRouteResult(context, result)
      return EXIT_CODES.success
    }
    default:
      throw usage('Usage: forge choices answer <choiceId> --answers <json> [--session <agentId>] | cancel <choiceId> [--session <agentId>]')
  }
}

async function mutateSession(
  context: CommandContext,
  agentId: string,
  action: string,
  mutate: (client: Awaited<ReturnType<CommandContext['createClient']>>, agentId: string) => Promise<unknown>,
  extra?: Record<string, unknown>,
): Promise<number> {
  const client = await context.createClient()
  const result = await mutate(client, agentId)
  writeMutationResult(context, action, agentId, result, extra)
  return EXIT_CODES.success
}

function writeSessionCreatedResult(context: CommandContext, result: CliSessionCreatedResult): void {
  if (context.args.options.json) {
    writeJson(context.io, result)
    return
  }
  writeHuman(context.io, context.args.options, formatObject({
    created: true,
    sessionAgentId: result.session.agentId,
    profileId: result.profile.profileId,
    label: result.session.sessionLabel ?? result.session.displayName,
  }))
}

function writeMutationResult(
  context: CommandContext,
  action: string,
  agentId: string,
  result: unknown,
  extra?: Record<string, unknown>,
): void {
  const payload = { status: 'ok', action, agentId, ...(extra ?? {}), result }
  if (context.args.options.json) {
    writeJson(context.io, payload)
    return
  }
  writeHuman(context.io, context.args.options, formatObject({ status: 'ok', action, agentId, ...(extra ?? {}) }))
}

function writeChoiceRouteResult(context: CommandContext, result: CliChoiceRouteResult): void {
  if (context.args.options.json) {
    writeJson(context.io, result)
    return
  }
  writeHuman(context.io, context.args.options, formatObject(result as unknown as Record<string, unknown>))
}

function requireYes(context: CommandContext): void {
  if (!context.args.options.yes) {
    throw usage('Destructive session action requires --yes.')
  }
}

function requireArg(value: string | undefined, name: string): string {
  if (!value) throw usage(`Missing ${name}.`)
  return value
}

function requireOption(value: string | undefined, name: string): string {
  if (!value) throw usage(`Missing required ${name}.`)
  return value
}

function usage(message: string): CliError {
  return new CliError(message, { exitCode: EXIT_CODES.usage, code: 'usage_error' })
}
