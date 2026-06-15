import type {
  AgentDescriptor,
  CliChoiceOwner,
  CliSessionTranscriptMessage,
  CliSessionTranscriptResponse,
  CliStatusResponse,
  ManagerProfile,
} from '@forge/protocol'

import { assertSupportedCapabilities } from '../forge-client.js'
import { CliError, formatObject, formatTable, writeHuman, writeJson } from '../output.js'
import { EXIT_CODES } from '../version.js'
import type { CommandContext } from './types.js'

export async function handleStatusCommand(context: CommandContext): Promise<number> {
  const client = await context.createClient()
  const status = await client.getStatus()
  assertSupportedCapabilities(status)
  if (context.args.options.json) writeJson(context.io, status)
  else writeHuman(context.io, context.args.options, formatStatus(status))
  return EXIT_CODES.success
}

export async function handleDoctorCommand(context: CommandContext): Promise<number> {
  const checks: Array<{ name: string; status: 'ok' | 'failed'; message?: string }> = []
  try {
    const client = await context.createClient()
    checks.push({ name: 'config', status: 'ok' })
    const status = await client.getStatus()
    checks.push({ name: 'http', status: 'ok', message: status.serverVersion })
    assertSupportedCapabilities(status)
    checks.push({ name: 'capabilities', status: 'ok', message: capabilitySummary(status) })
    const result = { status: 'ok' as const, checks }
    if (context.args.options.json) writeJson(context.io, result)
    else writeHuman(context.io, context.args.options, formatDoctor(result))
    return EXIT_CODES.success
  } catch (error) {
    const cliError = error instanceof CliError ? error : new CliError(String(error), { exitCode: EXIT_CODES.connection })
    checks.push({ name: 'forge', status: 'failed', message: cliError.message })
    const result = { status: 'failed' as const, checks }
    if (context.args.options.json) writeJson(context.io, result)
    else writeHuman(context.io, context.args.options, formatDoctor(result))
    return cliError.exitCode
  }
}

export async function handleProfilesCommand(context: CommandContext): Promise<number> {
  const [, action, profileId] = context.args.positionals
  if (action === 'list') {
    const client = await context.createClient()
    const response = await client.listProfiles()
    if (context.args.options.json) writeJson(context.io, response)
    else writeHuman(context.io, context.args.options, formatProfiles(response.profiles))
    return EXIT_CODES.success
  }
  if (action === 'show') {
    const id = requireArg(profileId, 'profileId')
    const client = await context.createClient()
    const response = await client.showProfile(id)
    if (context.args.options.json) writeJson(context.io, response)
    else writeHuman(context.io, context.args.options, formatProfile(response.profile))
    return EXIT_CODES.success
  }
  throw usage('Usage: forge profiles list|show <profileId>')
}

export async function handleSessionsCommand(context: CommandContext): Promise<number> {
  const [, action, agentId] = context.args.positionals
  if (action === 'list') {
    const profileId = requireOption(context.args.options.profile, '--profile')
    const client = await context.createClient()
    const response = await client.listSessions(profileId)
    if (context.args.options.json) writeJson(context.io, response)
    else writeHuman(context.io, context.args.options, formatAgents(response.sessions))
    return EXIT_CODES.success
  }
  if (action === 'show') {
    const id = requireArg(agentId, 'agentId')
    const client = await context.createClient()
    const response = await client.showSession(id)
    if (context.args.options.json) writeJson(context.io, response)
    else writeHuman(context.io, context.args.options, formatAgent(response.session))
    return EXIT_CODES.success
  }
  if (action === 'transcript') {
    const id = requireArg(agentId, 'agentId')
    const limit = parseOptionalInteger(context.args.options.limit, '--limit', 1)
    const offset = parseOptionalInteger(context.args.options.offset, '--offset', 0)
    const client = await context.createClient()
    const response = await client.getSessionTranscript(id, {
      includeWorkerUpdates: Boolean(context.args.options.includeWorkerUpdates),
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
    })
    if (context.args.options.json) writeJson(context.io, response)
    else writeHuman(context.io, context.args.options, formatTranscript(response))
    return EXIT_CODES.success
  }
  throw usage('Usage: forge sessions list --profile <profileId> | forge sessions show <agentId> | forge sessions transcript <agentId> [--include-worker-updates] [--limit <n>] [--offset <n>]')
}

export async function handleAgentsCommand(context: CommandContext): Promise<number> {
  const [, action, agentId] = context.args.positionals
  if (action === 'list') {
    const client = await context.createClient()
    const response = await client.listAgents(context.args.options.profile)
    if (context.args.options.json) writeJson(context.io, response)
    else writeHuman(context.io, context.args.options, formatAgents(response.agents))
    return EXIT_CODES.success
  }
  if (action === 'show') {
    const id = requireArg(agentId, 'agentId')
    const client = await context.createClient()
    const response = await client.showAgent(id)
    if (context.args.options.json) writeJson(context.io, response)
    else writeHuman(context.io, context.args.options, formatAgent(response.agent))
    return EXIT_CODES.success
  }
  throw usage('Usage: forge agents list [--profile <profileId>] | forge agents show <agentId>')
}

export async function handleProjectAgentsCommand(context: CommandContext): Promise<number> {
  const [, action, handle] = context.args.positionals
  const profileId = requireOption(context.args.options.profile, '--profile')
  if (action === 'list') {
    const client = await context.createClient()
    const response = await client.listProjectAgents(profileId)
    if (context.args.options.json) writeJson(context.io, response)
    else writeHuman(context.io, context.args.options, formatTable(response.projectAgents, [
      { header: 'handle', value: (agent) => agent.handle },
      { header: 'agentId', value: (agent) => agent.agentId },
      { header: 'displayName', value: (agent) => agent.displayName },
      { header: 'whenToUse', value: (agent) => agent.whenToUse },
    ]))
    return EXIT_CODES.success
  }
  if (action === 'show') {
    const resolvedHandle = requireArg(handle, 'handle')
    const client = await context.createClient()
    const response = await client.showProjectAgent(profileId, resolvedHandle)
    if (context.args.options.json) writeJson(context.io, response)
    else writeHuman(context.io, context.args.options, formatObject(response.projectAgent as unknown as Record<string, unknown>))
    return EXIT_CODES.success
  }
  throw usage('Usage: forge project-agents list --profile <profileId> | forge project-agents show --profile <profileId> <handle>')
}

export async function handleChoicesCommand(context: CommandContext): Promise<number> {
  const [, action, choiceId] = context.args.positionals
  if (action === 'list') {
    const client = await context.createClient()
    const response = await client.listChoices({
      profileId: context.args.options.profile,
      sessionAgentId: context.args.options.session,
    })
    if (context.args.options.json) writeJson(context.io, response)
    else writeHuman(context.io, context.args.options, formatChoices(response.choices))
    return EXIT_CODES.success
  }
  if (action === 'show') {
    const resolvedChoiceId = requireArg(choiceId, 'choiceId')
    const client = await context.createClient()
    const response = await client.showChoice(resolvedChoiceId, context.args.options.session)
    if (context.args.options.json) writeJson(context.io, response)
    else writeHuman(context.io, context.args.options, formatObject(response.choice as unknown as Record<string, unknown>))
    return EXIT_CODES.success
  }
  throw usage('Usage: forge choices list [--session <agentId>] [--profile <profileId>] | forge choices show <choiceId> [--session <agentId>]')
}

function formatStatus(status: CliStatusResponse): string {
  return formatObject({
    status: status.status,
    serverVersion: status.serverVersion,
    runtimeTarget: status.runtimeTarget,
    protocolVersion: status.capabilities.protocolVersion,
    headlessWs: status.capabilities.features.headlessWs,
    choiceOwnerLookup: status.capabilities.features.choiceOwnerLookup,
    profiles: status.summary?.profileCount,
    sessions: status.summary?.sessionCount,
    agents: status.summary?.agentCount,
  })
}

function formatDoctor(result: { status: 'ok' | 'failed'; checks: Array<{ name: string; status: 'ok' | 'failed'; message?: string }> }): string {
  return [`doctor: ${result.status}`, ...result.checks.map((check) => `${check.status === 'ok' ? '✓' : '✗'} ${check.name}${check.message ? `: ${check.message}` : ''}`)].join('\n')
}

function capabilitySummary(status: CliStatusResponse): string {
  const enabled = Object.entries(status.capabilities.features)
    .filter(([, value]) => value)
    .map(([key]) => key)
  return enabled.join(', ')
}

function formatProfiles(profiles: ManagerProfile[]): string {
  return formatTable(profiles, [
    { header: 'profileId', value: (profile) => profile.profileId },
    { header: 'displayName', value: (profile) => profile.displayName },
    { header: 'defaultSession', value: (profile) => profile.defaultSessionAgentId },
  ])
}

function formatProfile(profile: ManagerProfile): string {
  return formatObject({
    profileId: profile.profileId,
    displayName: profile.displayName,
    defaultSessionAgentId: profile.defaultSessionAgentId,
    defaultModel: `${profile.defaultModel.provider}/${profile.defaultModel.modelId}`,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  })
}

function formatAgents(agents: AgentDescriptor[]): string {
  return formatTable(agents, [
    { header: 'agentId', value: (agent) => agent.agentId },
    { header: 'role', value: (agent) => agent.role },
    { header: 'status', value: (agent) => agent.status },
    { header: 'profileId', value: (agent) => agent.profileId },
    { header: 'displayName', value: (agent) => agent.sessionLabel ?? agent.displayName },
  ])
}

function formatAgent(agent: AgentDescriptor): string {
  return formatObject({
    agentId: agent.agentId,
    role: agent.role,
    status: agent.status,
    profileId: agent.profileId,
    displayName: agent.sessionLabel ?? agent.displayName,
    model: `${agent.model.provider}/${agent.model.modelId}`,
    workerCount: agent.workerCount,
    activeWorkerCount: agent.activeWorkerCount,
    pendingChoiceCount: agent.pendingChoiceCount,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  })
}

function formatChoices(choices: CliChoiceOwner[]): string {
  return formatTable(choices, [
    { header: 'choiceId', value: (choice) => choice.choiceId },
    { header: 'sessionAgentId', value: (choice) => choice.sessionAgentId },
    { header: 'profileId', value: (choice) => choice.profileId },
    { header: 'status', value: (choice) => choice.status },
    { header: 'question', value: (choice) => choice.questionSummary },
  ])
}

function formatTranscript(response: CliSessionTranscriptResponse): string {
  const header = `Transcript for ${response.session.displayName ?? response.session.agentId} (${response.session.agentId})`
  if (response.messages.length === 0) {
    return `${header}\nNo transcript messages.`
  }

  const blocks = response.messages.map(formatTranscriptMessage)
  const footer = response.page.hasMore && response.page.nextOffset !== undefined
    ? [`More messages available. Re-run with --offset ${response.page.nextOffset}.`]
    : []
  return [header, ...blocks, ...footer].join('\n\n')
}

function formatTranscriptMessage(message: CliSessionTranscriptMessage): string {
  const speaker = transcriptSpeaker(message)
  const body = indentTranscriptBody(message.text)
  const attachments = formatTranscriptAttachments(message)
  return [`[${message.timestamp}] ${speaker}:`, body, ...attachments].join('\n')
}

function transcriptSpeaker(message: CliSessionTranscriptMessage): string {
  if (message.kind === 'worker_update') {
    return `Worker${message.fromDisplayName ? ` (${message.fromDisplayName})` : ''}`
  }
  return message.kind === 'user' ? 'User' : 'Assistant'
}

function indentTranscriptBody(text: string): string {
  const normalized = text.length > 0 ? text : '(empty)'
  return normalized.split('\n').map((line) => `  ${line}`).join('\n')
}

function formatTranscriptAttachments(message: CliSessionTranscriptMessage): string[] {
  if (!message.attachments || message.attachments.length === 0) return []
  return message.attachments.map((attachment) => {
    const name = attachment.fileName ?? attachment.fileRef ?? 'attachment'
    const size = attachment.sizeBytes !== undefined ? `, ${attachment.sizeBytes} bytes` : ''
    return `  [attachment: ${name}, ${attachment.mimeType}${size}]`
  })
}

function parseOptionalInteger(value: string | undefined, flag: '--limit' | '--offset', min: number): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value)) {
    throw usage(`${flag} must be an integer greater than or equal to ${min}.`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw usage(`${flag} must be an integer greater than or equal to ${min}.`)
  }
  return parsed
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
