import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PackagedRemoteUiServer,
  PackagedRemoteUiStartupError,
  resolvePackagedRemoteUiHost,
  startOptionalPackagedRemoteUi,
} from '../packaged-remote-ui-server.js'

const temporaryDirectories: string[] = []
const servers: PackagedRemoteUiServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()))
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('PackagedRemoteUiServer', () => {
  it('serves packaged assets, injects runtime backend configuration, and falls back to the SPA shell', async () => {
    let backendPort = 48_287
    const server = await startServer(() => backendPort)
    const baseUrl = serverBaseUrl(server)

    const root = await fetch(`${baseUrl}/`)
    expect(root.status).toBe(200)
    expect(root.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(root.headers.get('cache-control')).toBe('no-store')
    await expect(root.text()).resolves.toContain('<base href="/"><script src="/.forge-runtime-config.js"></script>')

    const asset = await fetch(`${baseUrl}/assets/app.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toBe('application/javascript; charset=utf-8')
    await expect(asset.text()).resolves.toBe('console.log("Forge packaged UI")')

    const notificationAudio = await fetch(`${baseUrl}/assets/notification.mp3`)
    expect(notificationAudio.status).toBe(200)
    expect(notificationAudio.headers.get('content-type')).toBe('audio/mpeg')

    const route = await fetch(`${baseUrl}/projects/example/conversation`)
    expect(route.status).toBe(200)
    await expect(route.text()).resolves.toContain('<main>Forge</main>')

    const runtimeConfig = await fetch(`${baseUrl}/.forge-runtime-config.js`)
    expect(runtimeConfig.headers.get('cache-control')).toBe('no-store')
    await expect(runtimeConfig.text()).resolves.toBe(
      'window.__forgeRemoteRuntimeConfig = Object.freeze({ backendPort: 48287 });\n',
    )

    backendPort = 49_287
    const updatedRuntimeConfig = await fetch(`${baseUrl}/.forge-runtime-config.js`)
    await expect(updatedRuntimeConfig.text()).resolves.toBe(
      'window.__forgeRemoteRuntimeConfig = Object.freeze({ backendPort: 49287 });\n',
    )
  })

  it('supports HEAD requests and closes its listener during lifecycle shutdown', async () => {
    const server = await startServer(() => 47_287)
    const baseUrl = serverBaseUrl(server)

    await server.start()
    const head = await fetch(`${baseUrl}/assets/app.js`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength('console.log("Forge packaged UI")')))

    await server.stop()
    await expect(fetch(`${baseUrl}/`)).rejects.toThrow()
  })

  it('force closes a stalled active client after the shutdown grace period', async () => {
    const server = await startServer(() => 47_287, { shutdownGracePeriodMs: 20 })
    const client = await connectStalledClient(server)
    const clientClosed = once(client, 'close')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      const startedAt = Date.now()
      await server.stop()
      expect(Date.now() - startedAt).toBeLessThan(1_000)
      await expect(clientClosed).resolves.toEqual([false])
      expect(warning).toHaveBeenCalledWith(
        '[packaged-remote-ui] Shutdown grace period elapsed; closing active remote browser connections',
      )
    } finally {
      warning.mockRestore()
      client.destroy()
    }
  })
})

describe('startOptionalPackagedRemoteUi', () => {
  it('reports a distinct remote-UI error while leaving local startup available', async () => {
    const reportUnavailable = vi.fn()

    const started = await startOptionalPackagedRemoteUi(
      async () => { throw new Error('listen EADDRINUSE: address already in use') },
      reportUnavailable,
    )

    expect(started).toBe(false)
    expect(reportUnavailable).toHaveBeenCalledOnce()
    expect(reportUnavailable.mock.calls[0]?.[0]).toBeInstanceOf(PackagedRemoteUiStartupError)
    expect(reportUnavailable.mock.calls[0]?.[0]).toMatchObject({
      message: 'Packaged remote browser access is unavailable: listen EADDRINUSE: address already in use',
    })
  })

  it('does not report when the optional remote-UI listener starts', async () => {
    const reportUnavailable = vi.fn()

    await expect(startOptionalPackagedRemoteUi(async () => undefined, reportUnavailable)).resolves.toBe(true)
    expect(reportUnavailable).not.toHaveBeenCalled()
  })
})

describe('resolvePackagedRemoteUiHost', () => {
  it('uses the Electron backend bind host and keeps the trusted-network default', () => {
    expect(resolvePackagedRemoteUiHost({ FORGE_HOST: '127.0.0.1' })).toBe('127.0.0.1')
    expect(resolvePackagedRemoteUiHost({})).toBe('0.0.0.0')
  })
})

async function startServer(
  getBackendPort: () => number,
  options: { shutdownGracePeriodMs?: number } = {},
): Promise<PackagedRemoteUiServer> {
  const rendererDir = mkdtempSync(path.join(os.tmpdir(), 'forge-packaged-remote-ui-'))
  temporaryDirectories.push(rendererDir)
  writeFileSync(path.join(rendererDir, 'index.html'), '<!doctype html><html><head><title>Forge</title></head><body><main>Forge</main></body></html>')
  mkdirSync(path.join(rendererDir, 'assets'))
  writeFileSync(path.join(rendererDir, 'assets', 'app.js'), 'console.log("Forge packaged UI")')
  writeFileSync(path.join(rendererDir, 'assets', 'notification.mp3'), Buffer.from([0x49, 0x44, 0x33]))
  const server = new PackagedRemoteUiServer({
    rendererDir,
    host: '127.0.0.1',
    port: 0,
    shutdownGracePeriodMs: options.shutdownGracePeriodMs ?? 20,
    getBackendPort,
  })
  servers.push(server)
  await server.start()
  return server
}

function serverBaseUrl(server: PackagedRemoteUiServer): string {
  const address = server.address
  if (!address) {
    throw new Error('Packaged remote UI server did not listen')
  }
  return `http://127.0.0.1:${address.port}`
}

async function connectStalledClient(server: PackagedRemoteUiServer): Promise<Socket> {
  const address = server.address
  if (!address) {
    throw new Error('Packaged remote UI server did not listen')
  }

  const client = createConnection({ host: '127.0.0.1', port: address.port })
  await once(client, 'connect')
  const receivedResponse = once(client, 'data')
  client.write('GET /assets/app.js HTTP/1.1\r\nHost: forge.local\r\nContent-Length: 9999999\r\nConnection: keep-alive\r\n\r\n')
  client.resume()
  await receivedResponse
  client.pause()
  return client
}
