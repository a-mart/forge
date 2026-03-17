import { createConnection } from 'node:net'
import type { PlaywrightDiscoveredSession } from '@forge/protocol'

export interface PlaywrightDevtoolsStartResult {
  upstreamControllerUrl: string
  source: 'playwright-cli-daemon'
}

export interface PlaywrightDevtoolsBridgeLike {
  startPreviewController(session: PlaywrightDiscoveredSession): Promise<PlaywrightDevtoolsStartResult>
}

export class PlaywrightDevtoolsBridgeError extends Error {
  readonly statusCode: number

  constructor(message: string, statusCode = 502) {
    super(message)
    this.name = 'PlaywrightDevtoolsBridgeError'
    this.statusCode = statusCode
  }
}

interface SocketRpcResponse {
  id?: number
  result?: {
    text?: string
  }
  error?: string
  version?: string
}

export class PlaywrightDevtoolsBridge implements PlaywrightDevtoolsBridgeLike {
  async startPreviewController(session: PlaywrightDiscoveredSession): Promise<PlaywrightDevtoolsStartResult> {
    if (process.platform === 'win32') {
      throw new PlaywrightDevtoolsBridgeError(
        'Playwright live preview is not supported on Windows',
        501,
      )
    }

    if (session.liveness !== 'active') {
      throw new PlaywrightDevtoolsBridgeError(
        `Session ${session.sessionName} is ${session.liveness} and cannot start live preview`,
        409,
      )
    }

    if (session.schemaVersion !== 'v2') {
      throw new PlaywrightDevtoolsBridgeError(
        `Session ${session.sessionName} uses legacy Playwright CLI metadata and cannot start live preview`,
        409,
      )
    }

    if (!session.socketPath) {
      throw new PlaywrightDevtoolsBridgeError(
        `Session ${session.sessionName} is missing a Playwright daemon socket path`,
        409,
      )
    }

    if (!session.sessionVersion) {
      throw new PlaywrightDevtoolsBridgeError(
        `Session ${session.sessionName} is missing a Playwright CLI version and cannot be controlled safely`,
        409,
      )
    }

    const response = await sendSocketRpc(session, {
      id: 1,
      method: 'run',
      params: {
        args: { _: ['devtools-start'] },
        cwd: session.worktreePath ?? session.rootPath,
      },
      version: session.sessionVersion,
    })

    if (typeof response.error === 'string' && response.error.trim()) {
      throw new PlaywrightDevtoolsBridgeError(
        `Playwright daemon refused devtools-start for ${session.sessionName}: ${response.error}`,
        502,
      )
    }

    const rawText = response.result?.text
    if (!rawText) {
      throw new PlaywrightDevtoolsBridgeError(
        `Playwright daemon did not return a devtools-start payload for ${session.sessionName}`,
        502,
      )
    }

    const match = rawText.match(/Server is listening on:\s*(\S+)/)
    if (!match) {
      throw new PlaywrightDevtoolsBridgeError(
        `Unable to parse Playwright controller URL from devtools-start output for ${session.sessionName}`,
        502,
      )
    }

    const upstreamControllerUrl = normalizeControllerUrl(match[1])
    if (!upstreamControllerUrl) {
      throw new PlaywrightDevtoolsBridgeError(
        `Playwright returned an invalid controller URL for ${session.sessionName}: ${match[1]}`,
        502,
      )
    }

    return {
      upstreamControllerUrl,
      source: 'playwright-cli-daemon',
    }
  }
}

async function sendSocketRpc(
  session: PlaywrightDiscoveredSession,
  payload: Record<string, unknown>,
): Promise<SocketRpcResponse> {
  const socket = await connectSocket(session.socketPath!)

  try {
    const responsePromise = readJsonLine(socket, session.sessionName)
    await new Promise<void>((resolve, reject) => {
      socket.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })

    return await responsePromise
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new PlaywrightDevtoolsBridgeError(
      `Unable to communicate with Playwright daemon for ${session.sessionName}: ${message}`,
      502,
    )
  } finally {
    socket.destroy()
  }
}

async function connectSocket(socketPath: string) {
  return await new Promise<import('node:net').Socket>((resolve, reject) => {
    const socket = createConnection(socketPath)
    const timeout = setTimeout(() => {
      socket.destroy(new Error(`Timed out connecting to ${socketPath}`))
    }, 5_000)

    socket.once('connect', () => {
      clearTimeout(timeout)
      resolve(socket)
    })

    socket.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

async function readJsonLine(socket: import('node:net').Socket, sessionName: string): Promise<SocketRpcResponse> {
  return await new Promise<SocketRpcResponse>((resolve, reject) => {
    const chunks: Buffer[] = []

    const cleanup = (): void => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }

    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }

    const onClose = (): void => {
      cleanup()
      reject(new Error(`Socket closed before Playwright responded for ${sessionName}`))
    }

    const onData = (chunk: Buffer): void => {
      const newlineIndex = chunk.indexOf(0x0a)
      if (newlineIndex === -1) {
        chunks.push(chunk)
        return
      }

      chunks.push(chunk.subarray(0, newlineIndex))
      cleanup()

      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim()
        resolve((raw ? JSON.parse(raw) : {}) as SocketRpcResponse)
      } catch (error) {
        reject(error)
      }
    }

    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

function normalizeControllerUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  try {
    const url = new URL(trimmed)
    if (url.protocol === 'http:') {
      url.protocol = 'ws:'
    } else if (url.protocol === 'https:') {
      url.protocol = 'wss:'
    }

    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      return null
    }

    return url.toString()
  } catch {
    return null
  }
}
