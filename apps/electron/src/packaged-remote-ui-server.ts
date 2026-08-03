import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { realpath, readFile, stat } from 'node:fs/promises'
import type { AddressInfo, Socket } from 'node:net'
import path from 'node:path'

export const DEFAULT_PACKAGED_REMOTE_UI_PORT = 47_188
export const PACKAGED_REMOTE_UI_SHUTDOWN_GRACE_PERIOD_MS = 2_000
const RUNTIME_CONFIG_PATH = '/.forge-runtime-config.js'

export interface PackagedRemoteUiServerOptions {
  rendererDir: string
  host: string
  port?: number
  /** Only override this bounded production grace period in focused tests. */
  shutdownGracePeriodMs?: number
  getBackendPort(): number
}

/** Identifies a non-fatal failure to expose the packaged UI to remote browsers. */
export class PackagedRemoteUiStartupError extends Error {
  constructor(cause: unknown) {
    super(`Packaged remote browser access is unavailable: ${errorMessage(cause)}`, { cause })
    this.name = 'PackagedRemoteUiStartupError'
  }
}

/**
 * Starts the optional remote-browser surface without making a healthy local
 * Desktop/backend unavailable when its listener cannot bind.
 */
export async function startOptionalPackagedRemoteUi(
  start: () => Promise<void>,
  reportUnavailable: (error: PackagedRemoteUiStartupError) => void,
): Promise<boolean> {
  try {
    await start()
    return true
  } catch (error) {
    reportUnavailable(new PackagedRemoteUiStartupError(error))
    return false
  }
}

/**
 * Serves the already-packaged renderer to trusted-network browsers. It is
 * deliberately a static surface: unlike the Electron renderer, it has no
 * preload bridge, IPC, or Desktop-only capabilities.
 */
export class PackagedRemoteUiServer {
  private readonly port: number
  private server: Server | null = null
  private rendererDir: string | null = null
  private rendererEntry: string | null = null
  private startPromise: Promise<void> | null = null
  private readonly connections = new Set<Socket>()

  constructor(private readonly options: PackagedRemoteUiServerOptions) {
    this.port = options.port ?? DEFAULT_PACKAGED_REMOTE_UI_PORT
  }

  get address(): AddressInfo | null {
    const address = this.server?.address()
    return address && typeof address !== 'string' ? address : null
  }

  async start(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise
    }
    if (this.server) {
      return
    }

    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  async stop(): Promise<void> {
    if (this.startPromise) {
      await this.startPromise
    }

    const server = this.server
    this.server = null
    if (!server) {
      return
    }

    let closeFinished = false
    const closePromise = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        closeFinished = true
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
    // Drop keep-alive clients immediately; the bounded grace period below is
    // reserved for requests that are still actively in flight.
    server.closeIdleConnections()

    const gracePeriodMs = this.options.shutdownGracePeriodMs ?? PACKAGED_REMOTE_UI_SHUTDOWN_GRACE_PERIOD_MS
    let gracePeriodTimer: NodeJS.Timeout | undefined
    const gracePeriodElapsed = new Promise<void>((resolve) => {
      gracePeriodTimer = setTimeout(resolve, gracePeriodMs)
    })
    try {
      await Promise.race([closePromise, gracePeriodElapsed])
      if (closeFinished && this.connections.size === 0) {
        return
      }
      await gracePeriodElapsed
    } finally {
      if (gracePeriodTimer) clearTimeout(gracePeriodTimer)
    }

    if (!closeFinished || this.connections.size > 0) {
      console.warn('[packaged-remote-ui] Shutdown grace period elapsed; closing active remote browser connections')
      server.closeAllConnections()
      for (const connection of this.connections) {
        connection.destroy()
      }
    }
  }

  private async startInternal(): Promise<void> {
    const rendererDir = await realpath(this.options.rendererDir)
    const rendererEntry = path.join(rendererDir, 'index.html')
    const entryStats = await stat(rendererEntry)
    if (!entryStats.isFile()) {
      throw new Error(`Packaged remote UI entry is not a file: ${rendererEntry}`)
    }

    this.rendererDir = rendererDir
    this.rendererEntry = rendererEntry
    const server = createServer((request, response) => {
      void this.handleRequest(request, response)
    })
    server.on('connection', (connection) => {
      this.connections.add(connection)
      connection.once('close', () => {
        this.connections.delete(connection)
      })
    })
    this.server = server

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = (): void => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(this.port, this.options.host)
      })
    } catch (error) {
      this.server = null
      server.close()
      throw error
    }
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.setHeader('Allow', 'GET, HEAD')
        this.respond(response, 405, 'Method Not Allowed', 'text/plain; charset=utf-8', request.method === 'HEAD')
        return
      }

      const requestUrl = new URL(request.url ?? '/', 'http://forge.local')
      if (requestUrl.pathname === RUNTIME_CONFIG_PATH) {
        const backendPort = this.options.getBackendPort()
        if (!Number.isInteger(backendPort) || backendPort < 1 || backendPort > 65_535) {
          throw new Error('Packaged remote UI received an invalid backend port')
        }
        this.respond(
          response,
          200,
          `window.__forgeRemoteRuntimeConfig = Object.freeze({ backendPort: ${backendPort} });\n`,
          'application/javascript; charset=utf-8',
          request.method === 'HEAD',
          'no-store',
        )
        return
      }

      const filePath = await this.resolveRequestFile(requestUrl.pathname)
      const contents = await readFile(filePath)
      const isHtml = filePath === this.rendererEntry
      const body = isHtml
        ? injectRemoteRuntimeConfig(contents.toString('utf8'))
        : contents
      this.respond(
        response,
        200,
        body,
        contentTypeFor(filePath),
        request.method === 'HEAD',
        isHtml ? 'no-store' : 'public, max-age=31536000, immutable',
      )
    } catch (error) {
      console.warn('[packaged-remote-ui] Failed to serve request', error instanceof Error ? error.message : String(error))
      this.respond(response, 500, 'Internal Server Error', 'text/plain; charset=utf-8', request.method === 'HEAD')
    }
  }

  private async resolveRequestFile(requestPath: string): Promise<string> {
    const rendererDir = this.rendererDir
    const rendererEntry = this.rendererEntry
    if (!rendererDir || !rendererEntry) {
      throw new Error('Packaged remote UI was not initialized')
    }

    let decodedPath: string
    try {
      decodedPath = decodeURIComponent(requestPath)
    } catch {
      return rendererEntry
    }

    const requestedPath = decodedPath.replace(/^[/\\]+/, '')
    const candidate = path.resolve(rendererDir, requestedPath)
    if (!isPathWithin(rendererDir, candidate)) {
      return rendererEntry
    }

    try {
      const realCandidate = await realpath(candidate)
      if (!isPathWithin(rendererDir, realCandidate) || !(await stat(realCandidate)).isFile()) {
        return rendererEntry
      }
      return realCandidate
    } catch {
      // Unknown routes intentionally receive the SPA shell.
      return rendererEntry
    }
  }

  private respond(
    response: ServerResponse,
    status: number,
    body: string | Buffer,
    contentType: string,
    headOnly: boolean,
    cacheControl?: string,
  ): void {
    response.statusCode = status
    response.setHeader('Content-Type', contentType)
    response.setHeader('Content-Length', Buffer.byteLength(body))
    if (cacheControl) {
      response.setHeader('Cache-Control', cacheControl)
    }
    response.end(headOnly ? undefined : body)
  }
}

export function resolvePackagedRemoteUiHost(environment: NodeJS.ProcessEnv = process.env): string {
  // Keep the UI on the exact host that Electron passes to its backend child.
  return environment.FORGE_HOST || '0.0.0.0'
}

function injectRemoteRuntimeConfig(html: string): string {
  const runtimeConfigTag = `<base href="/"><script src="${RUNTIME_CONFIG_PATH}"></script>`
  const closingHeadIndex = html.toLowerCase().indexOf('</head>')
  if (closingHeadIndex < 0) {
    return `${runtimeConfigTag}${html}`
  }
  return `${html.slice(0, closingHeadIndex)}${runtimeConfigTag}${html.slice(closingHeadIndex)}`
}

function isPathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function contentTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.css': return 'text/css; charset=utf-8'
    case '.html': return 'text/html; charset=utf-8'
    case '.js':
    case '.mjs': return 'application/javascript; charset=utf-8'
    case '.json':
    case '.map': return 'application/json; charset=utf-8'
    case '.svg': return 'image/svg+xml'
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.gif': return 'image/gif'
    case '.webp': return 'image/webp'
    case '.ico': return 'image/x-icon'
    case '.woff': return 'font/woff'
    case '.woff2': return 'font/woff2'
    case '.ttf': return 'font/ttf'
    case '.otf': return 'font/otf'
    case '.wasm': return 'application/wasm'
    case '.mp3': return 'audio/mpeg'
    default: return 'application/octet-stream'
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
