import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SwarmWebSocketServer } from '../ws/server.js'
import { resolveStaticUiAssetPath } from '../ws/http/routes/static-ui-routes.js'
import { TestSwarmManager, bootWithDefaultManager, createTempConfig, getAvailablePort, type TempConfigHandle } from '../test-support/index.js'

const ADMIN_EMAIL = 'admin@example.com'
const ADMIN_PASSWORD = 'password-123'

const activeHandles: TempConfigHandle[] = []

afterEach(async () => {
  while (activeHandles.length > 0) {
    const handle = activeHandles.pop()
    await handle?.cleanup()
  }
})

async function createStaticUiHarness(): Promise<{
  handle: TempConfigHandle
  server: SwarmWebSocketServer
  baseUrl: string
}> {
  const port = await getAvailablePort()
  const handle = await createTempConfig({
    port,
    runtimeTarget: 'collaboration-server',
    adminEmail: ADMIN_EMAIL,
    adminPassword: ADMIN_PASSWORD,
  })
  activeHandles.push(handle)

  const staticUiRoot = join(handle.config.paths.rootDir, 'apps', 'ui', '.output', 'public')
  await mkdir(join(staticUiRoot, 'assets'), { recursive: true })
  await writeFile(join(staticUiRoot, '_shell.html'), '<!DOCTYPE html><html><body>Forge collab shell</body></html>', 'utf8')
  await writeFile(join(staticUiRoot, 'assets', 'main.js'), 'console.log("forge collab static ui");', 'utf8')

  const manager = new TestSwarmManager(handle.config)
  await bootWithDefaultManager(manager, handle.config)

  const server = new SwarmWebSocketServer({
    swarmManager: manager,
    host: handle.config.host,
    port: handle.config.port,
    allowNonManagerSubscriptions: handle.config.allowNonManagerSubscriptions,
  })
  await server.start()

  return {
    handle,
    server,
    baseUrl: `http://${handle.config.host}:${handle.config.port}`,
  }
}

describe('collaboration static UI serving', () => {
  it('serves the shell at / and falls back to it for deep links', async () => {
    const harness = await createStaticUiHarness()

    try {
      const rootResponse = await fetch(`${harness.baseUrl}/`)
      expect(rootResponse.status).toBe(200)
      expect(rootResponse.headers.get('content-type')).toContain('text/html')
      await expect(rootResponse.text()).resolves.toContain('Forge collab shell')

      const deepLinkResponse = await fetch(`${harness.baseUrl}/settings`)
      expect(deepLinkResponse.status).toBe(200)
      await expect(deepLinkResponse.text()).resolves.toContain('Forge collab shell')
    } finally {
      await harness.server.stop()
    }
  })

  it('serves built assets and blocks path traversal outside the UI root', async () => {
    const harness = await createStaticUiHarness()

    try {
      const staticUiRoot = join(harness.handle.config.paths.rootDir, 'apps', 'ui', '.output', 'public')
      const assetResponse = await fetch(`${harness.baseUrl}/assets/main.js`)
      expect(assetResponse.status).toBe(200)
      expect(assetResponse.headers.get('content-type')).toContain('javascript')
      await expect(assetResponse.text()).resolves.toContain('forge collab static ui')

      expect(resolveStaticUiAssetPath(staticUiRoot, '../package.json')).toBeNull()

      const missingAssetResponse = await fetch(`${harness.baseUrl}/assets/missing.js`)
      expect(missingAssetResponse.status).toBe(404)
    } finally {
      await harness.server.stop()
    }
  })
})
