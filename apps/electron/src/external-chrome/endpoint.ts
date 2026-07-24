import * as fs from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import path from 'node:path'
import type { CurrentUserAccessController } from './auth-rendezvous.js'

export type ExternalChromeEndpointAccessPosture = 'posix-mode-0600' | 'windows-current-user-authenticated'

export interface ExternalChromeEndpointHandle {
  endpoint: string
  accessPosture: ExternalChromeEndpointAccessPosture
  close(): Promise<void>
}

export interface ExternalChromeEndpointAuthority {
  listen(input: {
    runDirectory: string
    platform: NodeJS.Platform
    userScope: string
    epoch: string
  }): Promise<ExternalChromeEndpointHandle>
}

export interface EndpointConnectionHandler {
  accept(socket: Socket): void
}

/**
 * Owns the per-launch local endpoint before rendezvous publication. The M3 relay can inject a
 * connection handler; the default fails closed and never interprets unauthenticated bytes.
 */
export class NodeExternalChromeEndpointAuthority implements ExternalChromeEndpointAuthority {
  constructor(
    private readonly access: CurrentUserAccessController,
    private readonly connectionHandler: EndpointConnectionHandler = { accept: (socket) => socket.destroy() },
  ) {}

  async listen(input: {
    runDirectory: string
    platform: NodeJS.Platform
    userScope: string
    epoch: string
  }): Promise<ExternalChromeEndpointHandle> {
    await this.access.preparePrivateDirectory(input.runDirectory)
    const endpoint = endpointName(input)
    if (input.platform !== 'win32') {
      await this.access.preparePrivateDirectory(path.dirname(endpoint))
      await fs.rm(endpoint, { force: true })
    }

    const sockets = new Set<Socket>()
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      this.connectionHandler.accept(socket)
    })
    await listen(server, endpoint)
    if (input.platform !== 'win32') await fs.chmod(endpoint, 0o600)

    let closed = false
    return {
      endpoint,
      // The random endpoint is discoverable only through the current-user ACL-protected rendezvous,
      // and every usable connection must prove possession of the current-user ACL-protected key.
      accessPosture: input.platform === 'win32' ? 'windows-current-user-authenticated' : 'posix-mode-0600',
      close: async () => {
        if (closed) return
        closed = true
        for (const socket of sockets) socket.destroy()
        await close(server)
        if (input.platform !== 'win32') {
          await fs.rm(endpoint, { force: true })
          if (path.dirname(endpoint) !== input.runDirectory) await fs.rmdir(path.dirname(endpoint)).catch(() => undefined)
        }
      },
    }
  }
}

export function endpointName(input: {
  runDirectory: string
  platform: NodeJS.Platform
  userScope: string
  epoch: string
}): string {
  const suffix = `${input.userScope.slice(-16)}-${input.epoch.slice(0, 20)}`
  if (input.platform === 'win32') return `\\\\.\\pipe\\forge-external-chrome-${suffix}`
  const endpoint = path.join(input.runDirectory, `relay-${suffix}.sock`)
  // Darwin sockaddr_un permits 104 bytes including the NUL terminator. Use a current-user private
  // /tmp subdirectory when a custom Forge data root would exceed that bound; never truncate.
  if (Buffer.byteLength(endpoint) <= 103) return endpoint
  const fallback = path.join('/tmp', `forge-external-chrome-${input.userScope.slice(-16)}`, `relay-${input.epoch.slice(0, 20)}.sock`)
  if (Buffer.byteLength(fallback) > 103) throw new Error('External Chrome endpoint cannot fit the Unix-domain socket bound')
  return fallback
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
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
    server.listen(endpoint)
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}
