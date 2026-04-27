import { readFile, rm, writeFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { getControlPidFilePath } from '../../../../reboot/control-pid.js'
import { getAvailablePort } from '../../../../test-support/index.js'
import {
  WsServerTestSwarmManager as TestSwarmManager,
  bootWsServerTestManager as bootWithDefaultManager,
  makeWsServerTempConfig as makeTempConfig,
} from '../../../../test-support/ws-integration-harness.js'
import { SwarmWebSocketServer } from '../../../server.js'

// ---------------------------------------------------------------------------
// Health endpoint CORS + method support
// ---------------------------------------------------------------------------

describe('/api/health CORS and method support', () => {
  async function startServer() {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })
    await server.start()

    const baseUrl = `http://${config.host}:${config.port}`
    return { server, baseUrl }
  }

  it('GET /api/health returns 200 with CORS headers', async () => {
    const { server, baseUrl } = await startServer()
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        method: 'GET',
        headers: { Origin: 'http://localhost:47188' },
      })
      expect(response.status).toBe(200)

      // CORS headers present
      expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:47188')
      expect(response.headers.get('access-control-allow-methods')).toContain('GET')

      // Body is valid JSON
      const body = await response.json()
      expect(body.ok).toBe(true)
    } finally {
      await server.stop()
    }
  })

  it('HEAD /api/health returns 200 with CORS headers and no body', async () => {
    const { server, baseUrl } = await startServer()
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        method: 'HEAD',
        headers: { Origin: 'http://localhost:47188' },
      })
      expect(response.status).toBe(200)

      // CORS headers present
      expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:47188')

      // HEAD should have no body (Node strips it automatically)
      const text = await response.text()
      expect(text).toBe('')
    } finally {
      await server.stop()
    }
  })

  it('OPTIONS /api/health returns 204 preflight with CORS headers', async () => {
    const { server, baseUrl } = await startServer()
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:47188',
          'Access-Control-Request-Method': 'GET',
        },
      })
      expect(response.status).toBe(204)

      // CORS headers present for preflight
      expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:47188')
      expect(response.headers.get('access-control-allow-methods')).toContain('GET')
      expect(response.headers.get('access-control-allow-methods')).toContain('HEAD')
    } finally {
      await server.stop()
    }
  })

  it('unsupported method returns 405 with Allow header', async () => {
    const { server, baseUrl } = await startServer()
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        method: 'DELETE',
      })
      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toContain('GET')
      expect(response.headers.get('allow')).toContain('HEAD')
    } finally {
      await server.stop()
    }
  })

  it('GET without Origin header uses wildcard CORS origin', async () => {
    const { server, baseUrl } = await startServer()
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        method: 'GET',
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
    } finally {
      await server.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// Reboot endpoint
// ---------------------------------------------------------------------------

describe('SwarmWebSocketServer', () => {
  it('accepts POST /api/reboot and signals the daemon pid asynchronously', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const daemonPid = 54321
    const pidFile = getControlPidFilePath(config.paths.rootDir, config.port)
    const restartFile = pidFile.replace(/\.pid$/, '.restart')
    await writeFile(pidFile, `${daemonPid}\n`, 'utf8')

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/reboot`, {
        method: 'POST',
      })

      expect(response.status).toBe(200)
      await vi.waitFor(() => {
        expect(killSpy).toHaveBeenCalledWith(daemonPid, 0)
      })

      expect(killSpy).toHaveBeenCalledWith(daemonPid, 0)
      if (process.platform === 'win32') {
        const restartPayload = await readFile(restartFile, 'utf8')
        expect(restartPayload.trim()).toMatch(/^\d+$/)
        expect(killSpy).not.toHaveBeenCalledWith(daemonPid, 'SIGUSR1')
      } else {
        expect(killSpy).toHaveBeenCalledWith(daemonPid, 'SIGUSR1')
      }
    } finally {
      killSpy.mockRestore()
      await rm(pidFile, { force: true })
      await rm(restartFile, { force: true })
      await server.stop()
    }
  })

  it('does not scan foreign control pid files when rebooting', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const foreignPid = 65432
    const primaryPidFile = getControlPidFilePath(config.paths.rootDir, config.port)
    await rm(primaryPidFile, { force: true })
    const foreignPidFile = getControlPidFilePath(config.paths.rootDir, config.port + 1)
    const foreignRestartFile = foreignPidFile.replace(/\.pid$/, '.restart')
    await writeFile(foreignPidFile, `${foreignPid}\n`, 'utf8')

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/reboot`, {
        method: 'POST',
      })

      expect(response.status).toBe(200)
      for (let attempt = 0; attempt < 20 && consoleErrorSpy.mock.calls.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }

      expect(killSpy).not.toHaveBeenCalledWith(foreignPid, 'SIGUSR1')
      expect(killSpy).not.toHaveBeenCalledWith(foreignPid, 0)
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('No control PID file found for this instance'),
      )
      await expect(readFile(foreignRestartFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      consoleErrorSpy.mockRestore()
      killSpy.mockRestore()
      await rm(foreignPidFile, { force: true })
      await rm(foreignRestartFile, { force: true })
      await server.stop()
    }
  })

})
