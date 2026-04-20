import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  P0HttpRouteFakeSwarmManager as FakeSwarmManager,
  createP0HttpRouteManagerDescriptor as createManagerDescriptor,
  makeP0HttpRouteTempConfig as makeTempConfig,
  parseP0HttpRouteJsonResponse as parseJsonResponse,
  postP0HttpRouteTranscribe as postTranscribe,
  writeP0HttpRouteAuthKey as writeAuthKey,
} from '../../../../test-support/ws-integration-harness.js'
import { SwarmWebSocketServer } from '../../../server.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SwarmWebSocketServer P0 endpoints', () => {
  it('validates /api/transcribe content type, file size, and missing API key', async () => {
    const config = await makeTempConfig({ managerId: 'manager' })
    const manager = new FakeSwarmManager(config, [createManagerDescriptor(config.paths.rootDir, 'manager')])
    const server = new SwarmWebSocketServer({
      swarmManager: manager as unknown as never,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: false,
    })

    await server.start()

    try {
      const invalidTypeResponse = await fetch(`http://${config.host}:${config.port}/api/transcribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      const invalidType = await parseJsonResponse(invalidTypeResponse)
      expect(invalidType.status).toBe(400)
      expect(invalidType.json.error).toBe('Content-Type must be multipart/form-data')

      const tooLargeResponse = await postTranscribe(`http://${config.host}:${config.port}/api/transcribe`, {
        size: 4_000_001,
      })
      const tooLarge = await parseJsonResponse(tooLargeResponse)
      expect(tooLarge.status).toBe(413)
      expect(tooLarge.json.error).toBe('Audio file too large. Max size is 4MB.')

      const missingKeyResponse = await postTranscribe(`http://${config.host}:${config.port}/api/transcribe`)
      const missingKey = await parseJsonResponse(missingKeyResponse)
      expect(missingKey.status).toBe(400)
      expect(missingKey.json.error).toBe('OpenAI API key required — add it in Settings.')
    } finally {
      await server.stop()
    }
  })

  it('copies legacy auth forward for /api/transcribe when canonical shared auth is absent', async () => {
    const config = await makeTempConfig({ managerId: 'manager' })
    await writeAuthKey(config.paths.authFile, 'sk-legacy-transcribe')

    const manager = new FakeSwarmManager(config, [createManagerDescriptor(config.paths.rootDir, 'manager')])
    const server = new SwarmWebSocketServer({
      swarmManager: manager as unknown as never,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: false,
    })

    await server.start()

    const localOrigin = `http://${config.host}:${config.port}`
    const originalFetch = globalThis.fetch

    try {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

        if (url.startsWith(localOrigin)) {
          return originalFetch(input as any, init as any)
        }

        return new Response(JSON.stringify({ text: 'legacy-auth-transcribed' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      })

      const response = await postTranscribe(`${localOrigin}/api/transcribe`)
      const payload = await parseJsonResponse(response)
      expect(payload.status).toBe(200)
      expect(payload.json.text).toBe('legacy-auth-transcribed')

      const upstreamAuthHeader = fetchSpy.mock.calls
        .map((call) => call[1]?.headers)
        .find((headers) => headers && typeof headers === 'object' && 'Authorization' in headers) as
        | Record<string, string>
        | undefined
      expect(upstreamAuthHeader?.Authorization).toBe('Bearer sk-legacy-transcribe')

      const sharedAuth = JSON.parse(await readFile(config.paths.sharedAuthFile, 'utf8')) as Record<
        string,
        { type: string; key?: string; access?: string }
      >
      expect(sharedAuth['openai-codex']).toMatchObject({ type: 'api_key' })
      expect(sharedAuth['openai-codex'].key ?? sharedAuth['openai-codex'].access).toBe('sk-legacy-transcribe')
    } finally {
      await server.stop()
    }
  })

  it('maps /api/transcribe upstream auth errors, upstream failures, and aborts', async () => {
    const config = await makeTempConfig({ managerId: 'manager' })
    await writeAuthKey(config.paths.sharedAuthFile, 'sk-test-123')

    const manager = new FakeSwarmManager(config, [createManagerDescriptor(config.paths.rootDir, 'manager')])
    const server = new SwarmWebSocketServer({
      swarmManager: manager as unknown as never,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: false,
    })

    await server.start()

    const localOrigin = `http://${config.host}:${config.port}`
    const originalFetch = globalThis.fetch

    try {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

        if (url.startsWith(localOrigin)) {
          return originalFetch(input as any, init as any)
        }

        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
      })

      const unauthorizedResponse = await postTranscribe(`${localOrigin}/api/transcribe`)
      const unauthorized = await parseJsonResponse(unauthorizedResponse)
      expect(unauthorized.status).toBe(401)
      expect(unauthorized.json.error).toBe('OpenAI API key rejected — update it in Settings.')

      fetchSpy.mockImplementation(async (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

        if (url.startsWith(localOrigin)) {
          return originalFetch(input as any, init as any)
        }

        return new Response(JSON.stringify({ error: 'upstream failure' }), { status: 503 })
      })

      const upstreamFailureResponse = await postTranscribe(`${localOrigin}/api/transcribe`)
      const upstreamFailure = await parseJsonResponse(upstreamFailureResponse)
      expect(upstreamFailure.status).toBe(502)
      expect(upstreamFailure.json.error).toBe('Transcription failed. Please try again.')

      fetchSpy.mockImplementation(async (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

        if (url.startsWith(localOrigin)) {
          return originalFetch(input as any, init as any)
        }

        const error = new Error('aborted')
        Object.assign(error, { name: 'AbortError' })
        throw error
      })

      const timeoutResponse = await postTranscribe(`${localOrigin}/api/transcribe`)
      const timeout = await parseJsonResponse(timeoutResponse)
      expect(timeout.status).toBe(504)
      expect(timeout.json.error).toBe('Transcription timed out.')
    } finally {
      await server.stop()
    }
  })
})
