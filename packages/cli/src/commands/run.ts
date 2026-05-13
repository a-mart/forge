import type { CliMessageDispatchResult, CliRunResult } from '@forge/protocol'

import type { ClientRunTarget } from '../forge-client.js'
import { CliError, formatObject, writeHuman, writeJson } from '../output.js'
import { EXIT_CODES } from '../version.js'
import { parseTimeoutMs, readMessageInput } from './input.js'
import type { CommandContext } from './types.js'

export async function handleRunCommand(context: CommandContext, command: 'run' | 'launch'): Promise<number> {
  const text = await readMessageInput(context.args.options.message, context.cwd)
  const target = resolveRunTarget(context)
  const timeoutMs = parseTimeoutMs(context.args.options.timeout)
  const client = await context.createClient()

  if (command === 'launch') {
    const result = await client.launch({
      command,
      target,
      text,
      label: context.args.options.label,
      invocationCwd: context.cwd,
    })
    writeDispatchResult(context, result)
    return EXIT_CODES.success
  }

  const result = await client.run({
    command,
    target,
    text,
    label: context.args.options.label,
    invocationCwd: context.cwd,
    timeoutMs,
    stopOnTimeout: Boolean(context.args.options.stopOnTimeout),
  })
  writeRunResult(context, result)
  return exitCodeForRunResult(result)
}

export async function handleWaitCommand(context: CommandContext): Promise<number> {
  const [, agentId] = context.args.positionals
  if (!agentId) throw usage('Usage: forge wait <agentId> [--timeout <duration>] [--stop-on-timeout]')
  const timeoutMs = parseTimeoutMs(context.args.options.timeout)
  const client = await context.createClient()
  const result = await client.waitForSession(agentId, {
    timeoutMs,
    stopOnTimeout: Boolean(context.args.options.stopOnTimeout),
  })
  writeRunResult(context, result)
  return exitCodeForRunResult(result)
}

export function writeRunResult(context: CommandContext, result: CliRunResult): void {
  const output = result.status === 'timeout' && context.args.options.stopOnTimeout
    ? { ...result, stoppedOnTimeout: true }
    : result

  if (context.args.options.json) {
    writeJson(context.io, output)
    return
  }

  writeHuman(context.io, context.args.options, formatObject({
    status: output.status,
    sessionAgentId: output.sessionAgentId,
    profileId: output.profileId,
    finalMessage: output.finalMessage,
    timedOut: output.timedOut,
    stoppedOnTimeout: 'stoppedOnTimeout' in output ? output.stoppedOnTimeout : undefined,
    durationMs: output.durationMs,
    blocked: output.blocked ? output.blocked.reason : undefined,
  }))
}

export function writeDispatchResult(context: CommandContext, result: CliMessageDispatchResult): void {
  if (context.args.options.json) {
    writeJson(context.io, result)
    return
  }

  writeHuman(context.io, context.args.options, formatObject({
    accepted: true,
    sessionAgentId: result.sessionAgentId,
    profileId: result.profileId,
    messageId: result.messageId,
    acceptedAt: result.acceptedAt,
  }))
}

export function exitCodeForRunResult(result: CliRunResult): number {
  switch (result.status) {
    case 'success':
      return EXIT_CODES.success
    case 'blocked':
      return EXIT_CODES.blocked
    case 'timeout':
      return EXIT_CODES.timeout
    case 'agent_failure':
      return EXIT_CODES.agentFailure
    case 'canceled':
      return EXIT_CODES.canceled
  }
}

function resolveRunTarget(context: CommandContext): ClientRunTarget {
  const { profile, session, projectAgent, label, name } = context.args.options
  if (session && projectAgent) throw usage('Use either --session or --project-agent, not both.')
  if (session) return { kind: 'session', agentId: session }
  if (projectAgent) {
    if (!profile) throw usage('--profile is required with --project-agent.')
    return { kind: 'project_agent', profileId: profile, handle: projectAgent }
  }
  if (!profile) throw usage('--profile is required when creating a new CLI run session.')
  return {
    kind: 'new_session',
    profileId: profile,
    ...(label ? { label } : {}),
    ...(name ? { name } : {}),
  }
}

function usage(message: string): CliError {
  return new CliError(message, { exitCode: EXIT_CODES.usage, code: 'usage_error' })
}
