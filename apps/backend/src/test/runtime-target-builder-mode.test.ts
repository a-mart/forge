import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startServer, type StartedServer } from '../server.js'
import { createTempConfig, type TempConfigHandle } from '../test-support/temp-config.js'

const SILENT_LOGGER = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const tempConfigHandles: TempConfigHandle[] = []
let activeServer: StartedServer | null = null

async function startBuilderServer(): Promise<{ server: StartedServer; config: TempConfigHandle['config'] }> {
  const tempConfigHandle = await createTempConfig({ runtimeTarget: 'builder' })
  tempConfigHandles.push(tempConfigHandle)

  const server = await startServer({
    config: tempConfigHandle.config,
    logger: SILENT_LOGGER,
  })

  activeServer = server
  return { server, config: tempConfigHandle.config }
}

afterEach(async () => {
  if (activeServer) {
    await activeServer.stop()
    activeServer = null
  }

  while (tempConfigHandles.length > 0) {
    const handle = tempConfigHandles.pop()
    await handle?.cleanup()
  }
})

describe('builder runtime target seam', () => {
  it('serves only the disabled collaboration status stub while leaving auth and collab routes unmounted', async () => {
    const { server, config } = await startBuilderServer()
    const baseUrl = `http://${server.host}:${server.port}`

    expect(config.runtimeTarget).toBe('builder')

    const statusResponse = await fetch(`${baseUrl}/api/collaboration/status`)
    expect(statusResponse.status).toBe(200)
    await expect(statusResponse.json()).resolves.toEqual({
      enabled: false,
      adminExists: false,
      ready: false,
      bootstrapState: 'disabled',
      workspaceExists: false,
      workspaceDefaultsInitialized: false,
      storageProfileExists: false,
      storageRootSessionExists: false,
    })

    const authResponse = await fetch(`${baseUrl}/api/auth/session`)
    expect(authResponse.status).toBe(404)

    const sessionResponse = await fetch(`${baseUrl}/api/collaboration/me`)
    expect(sessionResponse.status).toBe(404)

    const builderSettingsResponse = await fetch(`${baseUrl}/api/settings/auth`)
    expect(builderSettingsResponse.status).toBe(200)
  })

  it('does not set up documented collaboration auth artifacts in builder mode', async () => {
    const { config } = await startBuilderServer()

    const collaborationConfigDir = join(config.paths.sharedConfigDir, 'collaboration')
    const authDbPath = join(collaborationConfigDir, 'auth.db')
    const authSecretPath = join(collaborationConfigDir, 'auth-secret.key')

    await expect(access(authDbPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(authSecretPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
