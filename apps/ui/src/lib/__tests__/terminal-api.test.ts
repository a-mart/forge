import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeTerminal,
  createTerminal,
  issueTerminalTicket,
  renameTerminal,
  resizeTerminal,
} from '../terminal-api'

const wsUrl = 'ws://127.0.0.1:47187/'
const fetchMock = vi.fn<typeof fetch>()

afterEach(() => {
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

function mockJsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
}

describe('terminal-api', () => {
  it('createTerminal sends the expected POST request shape', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      mockJsonResponse({
        terminal: {
          terminalId: 'term-1',
          sessionAgentId: 'manager-1',
          profileId: 'profile-1',
          name: 'Build shell',
          shell: '/bin/sh',
          cwd: '/repo',
          cols: 120,
          rows: 30,
          state: 'running',
          pid: 123,
          exitCode: null,
          exitSignal: null,
          recoveredFromPersistence: false,
          createdAt: '2026-03-25T00:00:00.000Z',
          updatedAt: '2026-03-25T00:00:00.000Z',
        },
        ticket: 'ticket-1',
        ticketExpiresAt: '2026-03-25T00:01:00.000Z',
      }),
    )

    const response = await createTerminal(wsUrl, {
      sessionAgentId: 'manager-1',
      name: 'Build shell',
      cwd: '/repo',
      cols: 120,
      rows: 30,
    })

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:47187/api/terminals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionAgentId: 'manager-1',
        name: 'Build shell',
        cwd: '/repo',
        cols: 120,
        rows: 30,
      }),
    })
    expect(response.ticket).toBe('ticket-1')
    expect(response.terminal.name).toBe('Build shell')
  })

  it('closeTerminal includes sessionAgentId in the query string', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))

    await closeTerminal(wsUrl, 'term/1', { sessionAgentId: 'manager-1' })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/terminals/term%2F1?sessionAgentId=manager-1',
      { method: 'DELETE' },
    )
  })

  it('renameTerminal sends sessionAgentId and name in the PATCH body', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      mockJsonResponse({
        terminal: {
          terminalId: 'term-1',
          sessionAgentId: 'manager-1',
          profileId: 'profile-1',
          name: 'Renamed terminal',
          shell: '/bin/sh',
          cwd: '/repo',
          cols: 120,
          rows: 30,
          state: 'running',
          pid: 123,
          exitCode: null,
          exitSignal: null,
          recoveredFromPersistence: false,
          createdAt: '2026-03-25T00:00:00.000Z',
          updatedAt: '2026-03-25T00:00:01.000Z',
        },
      }),
    )

    const response = await renameTerminal(wsUrl, 'term-1', {
      sessionAgentId: 'manager-1',
      name: 'Renamed terminal',
    })

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:47187/api/terminals/term-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionAgentId: 'manager-1', name: 'Renamed terminal' }),
    })
    expect(response.terminal.name).toBe('Renamed terminal')
  })

  it('resizeTerminal sends the expected POST body', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      mockJsonResponse({
        terminal: {
          terminalId: 'term-1',
          sessionAgentId: 'manager-1',
          profileId: 'profile-1',
          name: 'Terminal 1',
          shell: '/bin/sh',
          cwd: '/repo',
          cols: 132,
          rows: 48,
          state: 'running',
          pid: 123,
          exitCode: null,
          exitSignal: null,
          recoveredFromPersistence: false,
          createdAt: '2026-03-25T00:00:00.000Z',
          updatedAt: '2026-03-25T00:00:02.000Z',
        },
      }),
    )

    const response = await resizeTerminal(wsUrl, 'term-1', {
      sessionAgentId: 'manager-1',
      cols: 132,
      rows: 48,
    })

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:47187/api/terminals/term-1/resize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionAgentId: 'manager-1', cols: 132, rows: 48 }),
    })
    expect(response.terminal.cols).toBe(132)
    expect(response.terminal.rows).toBe(48)
  })

  it('issueTerminalTicket sends the expected POST body', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      mockJsonResponse({
        ticket: 'ticket-2',
        ticketExpiresAt: '2026-03-25T00:02:00.000Z',
      }),
    )

    const response = await issueTerminalTicket(wsUrl, 'term-1', {
      sessionAgentId: 'manager-1',
    })

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:47187/api/terminals/term-1/ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionAgentId: 'manager-1' }),
    })
    expect(response.ticket).toBe('ticket-2')
  })

  it('surfaces backend errors from non-OK responses', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      mockJsonResponse(
        {
          error: 'Terminal limit reached',
          code: 'TERMINAL_LIMIT_REACHED',
        },
        { status: 409 },
      ),
    )

    await expect(createTerminal(wsUrl, { sessionAgentId: 'manager-1' })).rejects.toThrow('Terminal limit reached')
  })
})
