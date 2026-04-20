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
