import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getGlobalForgeExtensionsDir,
  getProfileForgeExtensionsDir,
  getProfilePiExtensionsDir,
} from '../../../../swarm/data-paths.js'
import {
  P0HttpRouteFakeSwarmManager as FakeSwarmManager,
  createP0HttpRouteManagerDescriptor as createManagerDescriptor,
  makeP0HttpRouteTempConfig as makeTempConfig,
  parseP0HttpRouteJsonResponse as parseJsonResponse,
} from '../../../../test-support/ws-integration-harness.js'
import { SwarmWebSocketServer } from '../../../server.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SwarmWebSocketServer P0 endpoints', () => {
  it('exposes discovered extensions and runtime snapshots via /api/settings/extensions', async () => {
    const config = await makeTempConfig({ managerId: 'manager' })

    const globalWorkerExtensionsDir = join(config.paths.agentDir, 'extensions')
    const globalManagerExtensionsDir = join(config.paths.managerAgentDir, 'extensions')
    const profileExtensionsDir = getProfilePiExtensionsDir(config.paths.dataDir, 'manager')
    const projectExtensionsDir = join(config.paths.rootDir, '.pi', 'extensions')
    const forgeGlobalExtensionsDir = getGlobalForgeExtensionsDir(config.paths.dataDir)
    const forgeProfileExtensionsDir = getProfileForgeExtensionsDir(config.paths.dataDir, 'manager')
    const forgeProjectExtensionsDir = join(config.paths.rootDir, '.forge', 'extensions')

    await mkdir(globalWorkerExtensionsDir, { recursive: true })
    await mkdir(globalManagerExtensionsDir, { recursive: true })
    await mkdir(profileExtensionsDir, { recursive: true })
    await mkdir(join(projectExtensionsDir, 'project-pack'), { recursive: true })
    await mkdir(forgeGlobalExtensionsDir, { recursive: true })
    await mkdir(forgeProfileExtensionsDir, { recursive: true })
    await mkdir(join(forgeProjectExtensionsDir, 'forge-pack'), { recursive: true })

    await writeFile(join(globalWorkerExtensionsDir, 'worker-ext.ts'), 'export default () => {}\n', 'utf8')
    await writeFile(join(globalManagerExtensionsDir, 'manager-ext.js'), 'module.exports = () => {}\n', 'utf8')
    await writeFile(join(profileExtensionsDir, 'profile-ext.ts'), 'export default () => {}\n', 'utf8')
    await writeFile(join(projectExtensionsDir, 'project-pack', 'index.ts'), 'export default () => {}\n', 'utf8')
    await writeFile(
      join(forgeGlobalExtensionsDir, 'protect-env.ts'),
      'export const extension = { name: "protect-env", description: "Protect env" }\nexport default () => {}\n',
      'utf8',
    )
    await writeFile(join(forgeProfileExtensionsDir, 'broken-ext.ts'), 'export const extension = 42\nexport default () => {}\n', 'utf8')
    await writeFile(
      join(forgeProjectExtensionsDir, 'forge-pack', 'index.ts'),
      'export const extension = { name: "forge-pack" }\nexport default () => {}\n',
      'utf8',
    )

    const manager = new FakeSwarmManager(
      config,
      [createManagerDescriptor(config.paths.rootDir, 'manager')],
      {
        forgeSettingsSnapshot: {
          discovered: [
            {
              displayName: 'protect-env.ts',
              path: join(forgeGlobalExtensionsDir, 'protect-env.ts'),
              scope: 'global',
              name: 'protect-env',
              description: 'Protect env',
            },
            {
              displayName: 'broken-ext.ts',
              path: join(forgeProfileExtensionsDir, 'broken-ext.ts'),
              scope: 'profile',
              profileId: 'manager',
              loadError: "Forge extension named export 'extension' must be an object when provided",
            },
            {
              displayName: 'forge-pack',
              path: join(forgeProjectExtensionsDir, 'forge-pack', 'index.ts'),
              scope: 'project-local',
              cwd: config.paths.rootDir,
              name: 'forge-pack',
            },
          ],
          snapshots: [],
          recentErrors: [
            {
              timestamp: '2026-03-24T00:00:00.000Z',
              phase: 'load',
              message: 'Example Forge host diagnostic',
              path: join(forgeProfileExtensionsDir, 'broken-ext.ts'),
            },
          ],
          directories: {
            global: forgeGlobalExtensionsDir,
            profileTemplate: join(config.paths.dataDir, 'profiles', '<profileId>', 'extensions'),
            projectLocalRelative: '.forge/extensions',
          },
        },
        runtimeExtensionSnapshots: [
          {
            agentId: 'manager',
            role: 'manager',
            managerId: 'manager',
            profileId: 'manager',
            loadedAt: '2026-03-24T00:00:00.000Z',
            extensions: [
              {
                displayName: 'project-pack',
                path: join(projectExtensionsDir, 'project-pack', 'index.ts'),
                resolvedPath: join(projectExtensionsDir, 'project-pack', 'index.ts'),
                source: 'project-local',
                events: ['tool_call'],
                tools: [],
              },
            ],
            loadErrors: [
              {
                path: join(profileExtensionsDir, 'profile-ext.ts'),
                error: 'Failed to load extension: boom',
              },
            ],
          },
        ],
      },
    )

    const server = new SwarmWebSocketServer({
      swarmManager: manager as unknown as never,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: false,
    })

    await server.start()

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/settings/extensions`)
      const payload = await parseJsonResponse(response)

      expect(payload.status).toBe(200)
      expect(typeof payload.json.generatedAt).toBe('string')
      expect(payload.json.snapshots).toHaveLength(1)

      const discovered = payload.json.discovered as Array<Record<string, unknown>>
      expect(discovered).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            displayName: 'worker-ext.ts',
            path: join(globalWorkerExtensionsDir, 'worker-ext.ts'),
            source: 'global-worker',
          }),
          expect.objectContaining({
            displayName: 'manager-ext.js',
            path: join(globalManagerExtensionsDir, 'manager-ext.js'),
            source: 'global-manager',
          }),
          expect.objectContaining({
            displayName: 'profile-ext.ts',
            path: join(profileExtensionsDir, 'profile-ext.ts'),
            source: 'profile',
            profileId: 'manager',
          }),
          expect.objectContaining({
            displayName: 'project-pack',
            path: join(projectExtensionsDir, 'project-pack', 'index.ts'),
            source: 'project-local',
            cwd: config.paths.rootDir,
          }),
        ]),
      )

      const [snapshot] = payload.json.snapshots as Array<Record<string, unknown>>
      expect(snapshot).toMatchObject({
        agentId: 'manager',
        role: 'manager',
        managerId: 'manager',
        profileId: 'manager',
      })

      expect(payload.json.directories).toMatchObject({
        globalWorker: join(config.paths.agentDir, 'extensions'),
        globalManager: join(config.paths.managerAgentDir, 'extensions'),
        profileTemplate: join(config.paths.dataDir, 'profiles', '<profileId>', 'pi', 'extensions'),
        projectLocalRelative: '.pi/extensions',
      })

      expect(payload.json.forge).toMatchObject({
        directories: {
          global: forgeGlobalExtensionsDir,
          profileTemplate: join(config.paths.dataDir, 'profiles', '<profileId>', 'extensions'),
          projectLocalRelative: '.forge/extensions',
        },
      })

      expect(payload.json.forge).toEqual(
        expect.objectContaining({
          discovered: expect.arrayContaining([
            expect.objectContaining({
              displayName: 'protect-env.ts',
              path: join(forgeGlobalExtensionsDir, 'protect-env.ts'),
              scope: 'global',
              name: 'protect-env',
            }),
            expect.objectContaining({
              displayName: 'broken-ext.ts',
              path: join(forgeProfileExtensionsDir, 'broken-ext.ts'),
              scope: 'profile',
              profileId: 'manager',
              loadError: "Forge extension named export 'extension' must be an object when provided",
            }),
            expect.objectContaining({
              displayName: 'forge-pack',
              path: join(forgeProjectExtensionsDir, 'forge-pack', 'index.ts'),
              scope: 'project-local',
              cwd: config.paths.rootDir,
            }),
          ]),
          recentErrors: expect.arrayContaining([
            expect.objectContaining({
              phase: 'load',
              message: 'Example Forge host diagnostic',
            }),
          ]),
        }),
      )
    } finally {
      await server.stop()
    }
  })
})
