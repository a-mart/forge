import type { Writable } from 'node:stream'

import type { AgentDescriptor, CliStatusResponse, ManagerProfile } from '@forge/protocol'
import { describe, expect, it } from 'vitest'

import type { ForgeClientLike } from '../forge-client.js'
import { CliError } from '../output.js'
import { EXIT_CODES } from '../version.js'
import { runCli } from './index.js'

class MemoryWritable implements Partial<Writable> {
  chunks: string[] = []
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(String(chunk))
    return true
  }
  toString(): string {
    return this.chunks.join('')
  }
}

describe('runCli', () => {
  it('prints version without requiring a client', async () => {
    const io = makeIo()
    await expect(runCli(['--version'], { io })).resolves.toBe(0)
    expect(io.stdout.toString()).toBe('0.9.0\n')
  })

  it('renders status as stable JSON', async () => {
    const io = makeIo()
    const exit = await runCli(['--json', 'status'], { io, createClient: async () => mockClient() })
    expect(exit).toBe(0)
    expect(JSON.parse(io.stdout.toString())).toMatchObject({
      status: 'ok',
      capabilities: { protocolVersion: 1, features: { bearerAuth: true } },
    })
  })

  it('renders profile list as a concise table', async () => {
    const io = makeIo()
    const exit = await runCli(['profiles', 'list'], { io, createClient: async () => mockClient() })
    expect(exit).toBe(0)
    expect(io.stdout.toString()).toContain('profileId')
    expect(io.stdout.toString()).toContain('profile-1')
  })

  it('requires a profile for session lists', async () => {
    const io = makeIo()
    const exit = await runCli(['sessions', 'list'], { io, createClient: async () => mockClient() })
    expect(exit).toBe(EXIT_CODES.usage)
    expect(io.stderr.toString()).toContain('Missing required --profile')
  })

  it('doctor maps unsupported capabilities to exit 23', async () => {
    const io = makeIo()
    const client = mockClient({ status: { ...statusResponse(), capabilities: { ...statusResponse().capabilities, available: false } } })
    const exit = await runCli(['doctor', '--json'], { io, createClient: async () => client })
    expect(exit).toBe(EXIT_CODES.unsupported)
    expect(JSON.parse(io.stdout.toString())).toMatchObject({ status: 'failed' })
  })

  it('maps client errors to stable exit codes and JSON errors', async () => {
    const io = makeIo()
    const exit = await runCli(['status', '--json'], {
      io,
      createClient: async () => {
        throw new CliError('bad key', { exitCode: EXIT_CODES.auth, code: 'unauthorized' })
      },
    })
    expect(exit).toBe(EXIT_CODES.auth)
    expect(JSON.parse(io.stderr.toString())).toMatchObject({ error: { code: 'unauthorized', message: 'bad key' } })
  })
})

function makeIo(): { stdout: MemoryWritable & Writable; stderr: MemoryWritable & Writable } {
  return {
    stdout: new MemoryWritable() as MemoryWritable & Writable,
    stderr: new MemoryWritable() as MemoryWritable & Writable,
  }
}

function mockClient(overrides: { status?: CliStatusResponse } = {}): ForgeClientLike {
  const profile = profileFixture()
  const session = agentFixture('session-1', 'manager')
  const worker = agentFixture('worker-1', 'worker')
  const status = overrides.status ?? statusResponse()
  return {
    getCapabilities: async () => ({ serverTime: status.serverTime, serverVersion: status.serverVersion, capabilities: status.capabilities }),
    getStatus: async () => status,
    listProfiles: async () => ({ profiles: [profile] }),
    showProfile: async () => ({ profile }),
    listSessions: async () => ({ sessions: [session] }),
    showSession: async () => ({ session }),
    listAgents: async () => ({ agents: [session, worker] }),
    showAgent: async () => ({ agent: worker }),
    listProjectAgents: async () => ({ projectAgents: [{ profileId: 'profile-1', agentId: 'session-1', handle: 'docs', whenToUse: 'Docs', displayName: 'Docs' }] }),
    showProjectAgent: async () => ({ projectAgent: { profileId: 'profile-1', agentId: 'session-1', handle: 'docs', whenToUse: 'Docs', displayName: 'Docs' } }),
    listChoices: async () => ({ choices: [{ choiceId: 'choice-1', agentId: 'worker-1', sessionAgentId: 'session-1', profileId: 'profile-1', status: 'pending', questionSummary: 'Pick one' }] }),
    showChoice: async () => ({ choice: { choiceId: 'choice-1', agentId: 'worker-1', sessionAgentId: 'session-1', profileId: 'profile-1', status: 'pending', questionSummary: 'Pick one' } }),
  }
}

function statusResponse(): CliStatusResponse {
  return {
    status: 'ok',
    serverTime: '2026-05-11T00:00:00.000Z',
    serverVersion: '0.9.0',
    runtimeTarget: 'builder',
    capabilities: {
      protocolVersion: 1,
      minCliVersion: '0.9.0',
      available: true,
      runtimeTarget: 'builder',
      features: {
        bearerAuth: true,
        headlessWs: true,
        cliSourceContext: true,
        cliSessionMetadata: true,
        choiceOwnerLookup: true,
        activeToolSnapshot: true,
        projectAgentRunTarget: false,
        builderRuntimeOnly: true,
      },
    },
    summary: { profileCount: 1, sessionCount: 1, agentCount: 2 },
  }
}

function profileFixture(): ManagerProfile {
  return {
    profileId: 'profile-1',
    displayName: 'Profile One',
    defaultSessionAgentId: 'session-1',
    defaultModel: { provider: 'openai', modelId: 'gpt-5.3', thinkingLevel: 'medium' },
    createdAt: '2026-05-11T00:00:00.000Z',
    updatedAt: '2026-05-11T00:00:00.000Z',
  }
}

function agentFixture(agentId: string, role: 'manager' | 'worker'): AgentDescriptor {
  return {
    agentId,
    managerId: role === 'manager' ? agentId : 'session-1',
    displayName: role === 'manager' ? 'Session One' : 'Worker One',
    role,
    status: 'idle',
    createdAt: '2026-05-11T00:00:00.000Z',
    updatedAt: '2026-05-11T00:00:00.000Z',
    cwd: '/tmp/project',
    model: { provider: 'openai', modelId: 'gpt-5.3', thinkingLevel: 'medium' },
    sessionFile: '/tmp/session.jsonl',
    profileId: 'profile-1',
  }
}
