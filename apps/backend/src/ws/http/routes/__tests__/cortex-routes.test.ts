import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  getCommonKnowledgePath,
  getCortexNotesPath,
  getCortexPromotionManifestsDir,
  getCortexReviewLockPath,
  getCortexReviewLogPath,
  getCortexReviewRunsPath,
  getCortexWorkerPromptsPath,
  getProfileKnowledgePath,
  getProfileMemoryPath,
  getProfileMergeAuditLogPath,
  getProfileReferencePath,
} from '../../../../swarm/data-paths.js'
import { scanCortexReviewStatus } from '../../../../swarm/scripts/cortex-scan.js'
import { getAvailablePort } from '../../../../test-support/index.js'
import {
  WsServerTestSwarmManager as TestSwarmManager,
  bootWsServerTestManager as bootWithDefaultManager,
  makeWsServerTempConfig as makeTempConfig,
} from '../../../../test-support/ws-integration-harness.js'
import { SwarmWebSocketServer } from '../../../server.js'

describe('SwarmWebSocketServer', () => {
  it('returns scan data and knowledge file paths through GET /api/cortex/scan', async () => {
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

    const alphaSessionDir = join(config.paths.dataDir, 'profiles', 'alpha', 'sessions', 'alpha--s1')
    await mkdir(alphaSessionDir, { recursive: true })
    await writeFile(
      join(alphaSessionDir, 'meta.json'),
      `${JSON.stringify(
        {
          profileId: 'alpha',
          sessionId: 'alpha--s1',
          stats: { sessionFileSize: '1000' },
          cortexReviewedBytes: 250,
          cortexReviewedAt: '2026-03-01T10:00:00.000Z',
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    const betaSessionDir = join(config.paths.dataDir, 'profiles', 'beta', 'sessions', 'beta--s1')
    await mkdir(betaSessionDir, { recursive: true })
    await writeFile(
      join(betaSessionDir, 'meta.json'),
      `${JSON.stringify(
        {
          profileId: 'beta',
          sessionId: 'beta--s1',
          stats: { sessionFileSize: '400' },
          cortexReviewedBytes: 0,
          cortexReviewedAt: null,
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    const commonKnowledgePath = getCommonKnowledgePath(config.paths.dataDir)
    await mkdir(dirname(commonKnowledgePath), { recursive: true })
    await writeFile(commonKnowledgePath, '# Common knowledge\n', 'utf8')

    const alphaProfileMemoryPath = getProfileMemoryPath(config.paths.dataDir, 'alpha')
    const alphaProfileMemoryContent = '# Alpha Memory\n\n## Overview\n- concise injected summary\n'
    await writeFile(alphaProfileMemoryPath, alphaProfileMemoryContent, 'utf8')

    const alphaProfileKnowledgePath = getProfileKnowledgePath(config.paths.dataDir, 'alpha')
    const alphaProfileKnowledgeContent = '# Alpha knowledge\n\n- scoped fact\n'
    await writeFile(alphaProfileKnowledgePath, alphaProfileKnowledgeContent, 'utf8')

    const alphaProfileMergeAuditPath = getProfileMergeAuditLogPath(config.paths.dataDir, 'alpha')
    await writeFile(alphaProfileMergeAuditPath, '', 'utf8')

    const expectedScan = await scanCortexReviewStatus(config.paths.dataDir)

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/cortex/scan`)
      expect(response.status).toBe(200)

      const payload = (await response.json()) as {
        scan: {
          sessions: Array<{
            profileId: string
            sessionId: string
            deltaBytes: number
            totalBytes: number
            reviewedBytes: number
            reviewedAt: string | null
            reviewExcluded: boolean
            reviewExcludedAt: string | null
            feedbackDeltaBytes: number
            feedbackTotalBytes: number
            feedbackReviewedBytes: number
            feedbackReviewedAt: string | null
            lastFeedbackAt: string | null
            status: string
          }>
          summary: {
            needsReview: number
            upToDate: number
            excluded: number
            totalBytes: number
            reviewedBytes: number
            transcriptTotalBytes: number
            transcriptReviewedBytes: number
            memoryTotalBytes: number
            memoryReviewedBytes: number
            feedbackTotalBytes: number
            feedbackReviewedBytes: number
            attentionBytes: number
            sessionsWithTranscriptDrift: number
            sessionsWithMemoryDrift: number
            sessionsWithFeedbackDrift: number
          }
        }
        files: {
          commonKnowledge: string
          cortexNotes: string
          cortexReviewLog: {
            path: string
            exists: boolean
            sizeBytes: number
          }
          cortexReviewLock: {
            path: string
            exists: boolean
            sizeBytes: number
          }
          cortexReviewRuns: {
            path: string
            exists: boolean
            sizeBytes: number
          }
          cortexPromotionManifests: {
            path: string
            exists: boolean
            fileCount: number
          }
          profileMemory: Record<
            string,
            {
              path: string
              exists: boolean
              sizeBytes: number
            }
          >
          profileKnowledge: Record<
            string,
            {
              path: string
              exists: boolean
              sizeBytes: number
            }
          >
          profileReference: Record<
            string,
            {
              path: string
              exists: boolean
              sizeBytes: number
            }
          >
          profileMergeAudit: Record<
            string,
            {
              path: string
              exists: boolean
              sizeBytes: number
            }
          >
        }
      }

      expect(payload.scan).toEqual(expectedScan)
      expect(payload.files).toEqual({
        commonKnowledge: commonKnowledgePath,
        cortexNotes: getCortexNotesPath(config.paths.dataDir),
        cortexReviewLog: {
          path: getCortexReviewLogPath(config.paths.dataDir),
          exists: true,
          sizeBytes: 0,
        },
        cortexReviewLock: {
          path: getCortexReviewLockPath(config.paths.dataDir),
          exists: false,
          sizeBytes: 0,
        },
        cortexReviewRuns: {
          path: getCortexReviewRunsPath(config.paths.dataDir),
          exists: true,
          sizeBytes: expect.any(Number),
        },
        cortexPromotionManifests: {
          path: getCortexPromotionManifestsDir(config.paths.dataDir),
          exists: true,
          fileCount: 0,
        },
        profileMemory: {
          alpha: {
            path: alphaProfileMemoryPath,
            exists: true,
            sizeBytes: Buffer.byteLength(alphaProfileMemoryContent, 'utf8'),
          },
          beta: {
            path: getProfileMemoryPath(config.paths.dataDir, 'beta'),
            exists: false,
            sizeBytes: 0,
          },
          manager: {
            path: getProfileMemoryPath(config.paths.dataDir, 'manager'),
            exists: true,
            sizeBytes: expect.any(Number),
          },
        },
        profileKnowledge: {
          alpha: {
            path: alphaProfileKnowledgePath,
            exists: true,
            sizeBytes: Buffer.byteLength(alphaProfileKnowledgeContent, 'utf8'),
          },
          beta: {
            path: getProfileKnowledgePath(config.paths.dataDir, 'beta'),
            exists: false,
            sizeBytes: 0,
          },
          manager: {
            path: getProfileKnowledgePath(config.paths.dataDir, 'manager'),
            exists: false,
            sizeBytes: 0,
          },
        },
        profileReference: {
          alpha: {
            path: getProfileReferencePath(config.paths.dataDir, 'alpha', 'index.md'),
            exists: false,
            sizeBytes: 0,
          },
          beta: {
            path: getProfileReferencePath(config.paths.dataDir, 'beta', 'index.md'),
            exists: false,
            sizeBytes: 0,
          },
          manager: {
            path: getProfileReferencePath(config.paths.dataDir, 'manager', 'index.md'),
            exists: false,
            sizeBytes: 0,
          },
        },
        profileMergeAudit: {
          alpha: {
            path: alphaProfileMergeAuditPath,
            exists: true,
            sizeBytes: 0,
          },
          beta: {
            path: getProfileMergeAuditLogPath(config.paths.dataDir, 'beta'),
            exists: false,
            sizeBytes: 0,
          },
          manager: {
            path: getProfileMergeAuditLogPath(config.paths.dataDir, 'manager'),
            exists: false,
            sizeBytes: 0,
          },
        },
      })

      await expect(readFile(getProfileReferencePath(config.paths.dataDir, 'alpha', 'index.md'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await expect(
        readFile(getProfileReferencePath(config.paths.dataDir, 'alpha', 'legacy-profile-knowledge.md'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(getProfileReferencePath(config.paths.dataDir, 'beta', 'index.md'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      await server.stop()
    }
  })
  it('updates review-actionable session exclusion through POST /api/cortex/review-controls', async () => {
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

    const alphaSessionDir = join(config.paths.dataDir, 'profiles', 'alpha', 'sessions', 'alpha--s1')
    await mkdir(alphaSessionDir, { recursive: true })
    await writeFile(
      join(alphaSessionDir, 'meta.json'),
      `${JSON.stringify(
        {
          profileId: 'alpha',
          sessionId: 'alpha--s1',
          createdAt: '2026-03-01T10:00:00.000Z',
          updatedAt: '2026-03-01T10:00:00.000Z',
          model: { provider: null, modelId: null },
          label: null,
          cwd: null,
          promptFingerprint: null,
          promptComponents: null,
          workers: [],
          stats: { sessionFileSize: '1000', memoryFileSize: null, totalWorkers: 0, activeWorkers: 0, totalTokens: { input: null, output: null } },
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    const reviewedSessionDir = join(config.paths.dataDir, 'profiles', 'beta', 'sessions', 'beta--s1')
    await mkdir(reviewedSessionDir, { recursive: true })
    await writeFile(
      join(reviewedSessionDir, 'meta.json'),
      `${JSON.stringify(
        {
          profileId: 'beta',
          sessionId: 'beta--s1',
          createdAt: '2026-03-01T10:00:00.000Z',
          updatedAt: '2026-03-01T10:00:00.000Z',
          model: { provider: null, modelId: null },
          label: null,
          cwd: null,
          promptFingerprint: null,
          promptComponents: null,
          workers: [],
          stats: { sessionFileSize: '1000', memoryFileSize: null, totalWorkers: 0, activeWorkers: 0, totalTokens: { input: null, output: null } },
          cortexReviewedBytes: 400,
          cortexReviewedAt: '2026-03-02T10:00:00.000Z',
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    const upToDateSessionDir = join(config.paths.dataDir, 'profiles', 'gamma', 'sessions', 'gamma--s1')
    await mkdir(upToDateSessionDir, { recursive: true })
    await writeFile(
      join(upToDateSessionDir, 'meta.json'),
      `${JSON.stringify(
        {
          profileId: 'gamma',
          sessionId: 'gamma--s1',
          createdAt: '2026-03-01T10:00:00.000Z',
          updatedAt: '2026-03-01T10:00:00.000Z',
          model: { provider: null, modelId: null },
          label: null,
          cwd: null,
          promptFingerprint: null,
          promptComponents: null,
          workers: [],
          stats: { sessionFileSize: '1000', memoryFileSize: null, totalWorkers: 0, activeWorkers: 0, totalTokens: { input: null, output: null } },
          cortexReviewedBytes: 1000,
          cortexReviewedAt: '2026-03-02T10:00:00.000Z',
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    try {
      const baselineScanResponse = await fetch(`http://${config.host}:${config.port}/api/cortex/scan`)
      const baselinePayload = (await baselineScanResponse.json()) as {
        scan: {
          summary: {
            needsReview: number
            upToDate: number
            excluded: number
          }
        }
      }

      const excludeResponse = await fetch(`http://${config.host}:${config.port}/api/cortex/review-controls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: 'alpha', sessionId: 'alpha--s1', action: 'exclude' }),
      })
      expect(excludeResponse.status).toBe(200)
      await expect(excludeResponse.json()).resolves.toEqual({ ok: true })

      const excludedScanResponse = await fetch(`http://${config.host}:${config.port}/api/cortex/scan`)
      const excludedPayload = (await excludedScanResponse.json()) as {
        scan: {
          sessions: Array<{
            profileId: string
            sessionId: string
            reviewExcluded: boolean
            reviewExcludedAt: string | null
            status: string
          }>
          summary: {
            needsReview: number
            upToDate: number
            excluded: number
          }
        }
      }

      expect(excludedPayload.scan.sessions.find((session) => session.sessionId === 'alpha--s1')).toMatchObject({
        profileId: 'alpha',
        sessionId: 'alpha--s1',
        reviewExcluded: true,
        status: 'never-reviewed',
      })
      expect(excludedPayload.scan.summary).toMatchObject({
        needsReview: Math.max(0, baselinePayload.scan.summary.needsReview - 1),
        upToDate: baselinePayload.scan.summary.upToDate,
        excluded: baselinePayload.scan.summary.excluded + 1,
      })

      const reviewedExcludeResponse = await fetch(`http://${config.host}:${config.port}/api/cortex/review-controls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: 'beta', sessionId: 'beta--s1', action: 'exclude' }),
      })
      expect(reviewedExcludeResponse.status).toBe(200)
      await expect(reviewedExcludeResponse.json()).resolves.toEqual({ ok: true })

      const reviewedExcludedScanResponse = await fetch(`http://${config.host}:${config.port}/api/cortex/scan`)
      const reviewedExcludedPayload = (await reviewedExcludedScanResponse.json()) as {
        scan: {
          sessions: Array<{
            sessionId: string
            reviewExcluded: boolean
            status: string
          }>
          summary: {
            needsReview: number
            upToDate: number
            excluded: number
          }
        }
      }

      expect(reviewedExcludedPayload.scan.sessions.find((session) => session.sessionId === 'beta--s1')).toMatchObject({
        reviewExcluded: true,
        status: 'needs-review',
      })
      expect(reviewedExcludedPayload.scan.summary).toMatchObject({
        needsReview: Math.max(0, baselinePayload.scan.summary.needsReview - 2),
        upToDate: baselinePayload.scan.summary.upToDate,
        excluded: baselinePayload.scan.summary.excluded + 2,
      })

      const invalidExcludeResponse = await fetch(`http://${config.host}:${config.port}/api/cortex/review-controls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: 'gamma', sessionId: 'gamma--s1', action: 'exclude' }),
      })
      expect(invalidExcludeResponse.status).toBe(409)
      await expect(invalidExcludeResponse.json()).resolves.toMatchObject({
        error: 'Only review-actionable sessions can be excluded from Cortex review.',
      })

      const resumeResponse = await fetch(`http://${config.host}:${config.port}/api/cortex/review-controls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: 'alpha', sessionId: 'alpha--s1', action: 'resume' }),
      })
      expect(resumeResponse.status).toBe(200)
      await expect(resumeResponse.json()).resolves.toEqual({ ok: true })

      const resumedScanResponse = await fetch(`http://${config.host}:${config.port}/api/cortex/scan`)
      const resumedPayload = (await resumedScanResponse.json()) as {
        scan: {
          sessions: Array<{
            profileId: string
            sessionId: string
            reviewExcluded: boolean
            reviewExcludedAt: string | null
          }>
          summary: {
            needsReview: number
            excluded: number
          }
        }
      }

      expect(resumedPayload.scan.sessions.find((session) => session.sessionId === 'alpha--s1')).toMatchObject({
        reviewExcluded: false,
        reviewExcludedAt: null,
      })
      expect(resumedPayload.scan.summary).toMatchObject({
        needsReview: Math.max(0, baselinePayload.scan.summary.needsReview - 1),
        excluded: baselinePayload.scan.summary.excluded + 1,
      })
    } finally {
      await server.stop()
    }
  })

  it('starts Cortex review runs through POST /api/cortex/review-runs and exposes them via GET', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)
    const manager = new TestSwarmManager(config)
    await manager.boot()

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const createResponse = await fetch(`http://${config.host}:${config.port}/api/cortex/review-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: {
            mode: 'session',
            profileId: 'alpha',
            sessionId: 'alpha--s1',
            axes: ['memory', 'feedback'],
          },
        }),
      })

      expect(createResponse.status).toBe(202)
      const createdPayload = (await createResponse.json()) as {
        run: {
          status: string
          scopeLabel: string
          sessionAgentId: string | null
        }
      }
      expect(createdPayload.run).toMatchObject({
        status: 'completed',
        scopeLabel: 'alpha/alpha--s1 (memory, feedback)',
      })
      expect(createdPayload.run.sessionAgentId).toMatch(/^cortex--s\d+$/)

      const listResponse = await fetch(`http://${config.host}:${config.port}/api/cortex/review-runs`)
      expect(listResponse.status).toBe(200)
      const listPayload = (await listResponse.json()) as {
        runs: Array<{
          trigger: string
          scopeLabel: string
          sessionAgentId: string | null
        }>
      }
      expect(listPayload.runs[0]).toMatchObject({
        trigger: 'manual',
        scopeLabel: 'alpha/alpha--s1 (memory, feedback)',
        sessionAgentId: createdPayload.run.sessionAgentId,
      })

      const persistedRuns = JSON.parse(await readFile(getCortexReviewRunsPath(config.paths.dataDir), 'utf8')) as {
        runs: Array<{ sessionAgentId: string | null }>
      }
      expect(persistedRuns.runs[0]?.sessionAgentId).toBe(createdPayload.run.sessionAgentId)
    } finally {
      await server.stop()
    }
  })

  it('returns 400 for malformed JSON bodies on POST /api/cortex/review-runs', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)
    const manager = new TestSwarmManager(config)
    await manager.boot()

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/cortex/review-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not valid json',
      })

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({ error: 'Request body must be valid JSON.' })
    } finally {
      await server.stop()
    }
  })

  it('returns 400 for invalid review scope payloads on POST /api/cortex/review-runs', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)
    const manager = new TestSwarmManager(config)
    await manager.boot()

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/cortex/review-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: {
            mode: 'session',
            profileId: 'alpha',
          },
        }),
      })

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({ error: 'Request body must include a valid review scope.' })
    } finally {
      await server.stop()
    }
  })

  it('returns 413 for oversized bodies on POST /api/cortex/review-runs', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)
    const manager = new TestSwarmManager(config)
    await manager.boot()

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/cortex/review-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: { mode: 'all' }, padding: 'x'.repeat(20_000) }),
      })

      expect(response.status).toBe(413)
      const payload = (await response.json()) as { error: string }
      expect(payload.error).toContain('Request body exceeds')
    } finally {
      await server.stop()
    }
  })

  it('includes manager profiles in GET /api/cortex/scan without materializing reference docs', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const createdManager = await manager.createManager('manager', {
      name: 'fresh-profile',
      cwd: config.paths.rootDir,
    })
    const profileId = createdManager.profileId ?? createdManager.agentId

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/cortex/scan`)
      expect(response.status).toBe(200)

      const payload = (await response.json()) as {
        scan: { sessions: Array<{ profileId: string; sessionId: string; status: string }> }
        files: {
          profileMemory: Record<string, { path: string; exists: boolean; sizeBytes: number }>
          profileReference: Record<string, { path: string; exists: boolean; sizeBytes: number }>
          profileMergeAudit: Record<string, { path: string; exists: boolean; sizeBytes: number }>
        }
      }

      expect(
        payload.scan.sessions.map((session) => ({
          profileId: session.profileId,
          sessionId: session.sessionId,
          status: session.status,
        })),
      ).toEqual(
        expect.arrayContaining([
          {
            profileId,
            sessionId: profileId,
            status: 'never-reviewed',
          },
          {
            profileId: 'manager',
            sessionId: 'manager',
            status: 'never-reviewed',
          },
        ]),
      )
      expect(payload.files.profileMemory[profileId]).toEqual({
        path: getProfileMemoryPath(config.paths.dataDir, profileId),
        exists: expect.any(Boolean),
        sizeBytes: expect.any(Number),
      })
      expect(payload.files.profileReference[profileId]).toEqual({
        path: getProfileReferencePath(config.paths.dataDir, profileId, 'index.md'),
        exists: false,
        sizeBytes: 0,
      })
      expect(payload.files.profileMergeAudit[profileId]).toEqual({
        path: getProfileMergeAuditLogPath(config.paths.dataDir, profileId),
        exists: false,
        sizeBytes: 0,
      })
      await expect(readFile(getProfileReferencePath(config.paths.dataDir, profileId, 'index.md'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      await server.stop()
    }
  })

  it('keeps GET /api/cortex/scan read-only even when legacy knowledge files are malformed', async () => {
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

    const alphaSessionDir = join(config.paths.dataDir, 'profiles', 'alpha', 'sessions', 'alpha--s1')
    await mkdir(alphaSessionDir, { recursive: true })
    await writeFile(
      join(alphaSessionDir, 'meta.json'),
      `${JSON.stringify({ profileId: 'alpha', sessionId: 'alpha--s1', stats: { sessionFileSize: '100' } }, null, 2)}\n`,
      'utf8',
    )

    const betaSessionDir = join(config.paths.dataDir, 'profiles', 'beta', 'sessions', 'beta--s1')
    await mkdir(betaSessionDir, { recursive: true })
    await writeFile(
      join(betaSessionDir, 'meta.json'),
      `${JSON.stringify({ profileId: 'beta', sessionId: 'beta--s1', stats: { sessionFileSize: '200' } }, null, 2)}\n`,
      'utf8',
    )

    const alphaLegacyPath = getProfileKnowledgePath(config.paths.dataDir, 'alpha')
    await mkdir(dirname(alphaLegacyPath), { recursive: true })
    await writeFile(alphaLegacyPath, '# Alpha legacy\n', 'utf8')

    const betaLegacyPath = getProfileKnowledgePath(config.paths.dataDir, 'beta')
    await mkdir(betaLegacyPath, { recursive: true })

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/cortex/scan`)
      expect(response.status).toBe(200)

      const payload = (await response.json()) as {
        files: {
          profileReference: Record<string, { path: string; exists: boolean; sizeBytes: number }>
        }
      }

      expect(payload.files.profileReference.alpha.path).toBe(
        getProfileReferencePath(config.paths.dataDir, 'alpha', 'index.md'),
      )
      expect(payload.files.profileReference.alpha.exists).toBe(false)
      expect(payload.files.profileReference.beta.path).toBe(
        getProfileReferencePath(config.paths.dataDir, 'beta', 'index.md'),
      )
      expect(payload.files.profileReference.beta.exists).toBe(false)
      await expect(readFile(getProfileReferencePath(config.paths.dataDir, 'alpha', 'index.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(getProfileReferencePath(config.paths.dataDir, 'beta', 'index.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await server.stop()
    }
  })

  it('lists and reads Cortex prompt surfaces through the additive prompt routes', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const commonKnowledgePath = getCommonKnowledgePath(config.paths.dataDir)
    const workerPromptsPath = getCortexWorkerPromptsPath(config.paths.dataDir)
    const cortexNotesPath = getCortexNotesPath(config.paths.dataDir)

    await writeFile(commonKnowledgePath, '# Common Knowledge\n\nLive common content\n', 'utf8')
    await writeFile(workerPromptsPath, '# Cortex Worker Prompt Templates — v4\n<!-- Cortex Worker Prompts Version: 4 -->\n\nLive worker content\n', 'utf8')
    await writeFile(cortexNotesPath, '# Cortex Notes\n\nScratch note\n', 'utf8')

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
      promptRegistry: manager.promptRegistry,
    })

    await server.start()

    try {
      const listResponse = await fetch(
        `http://${config.host}:${config.port}/api/prompts/cortex-surfaces?profileId=cortex`,
      )
      expect(listResponse.status).toBe(200)
      const listPayload = (await listResponse.json()) as {
        enabled: boolean
        surfaces: Array<{
          surfaceId: string
          title: string
          group: string
          runtimeEffect: string
          editable: boolean
          filePath?: string
        }>
      }

      expect(listPayload.enabled).toBe(true)
      expect(listPayload.surfaces.map((surface) => surface.surfaceId)).toEqual([
        'cortex-system-prompt',
        'common-knowledge-template',
        'common-knowledge-live',
        'cortex-worker-prompts-template',
        'cortex-worker-prompts-live',
        'cortex-notes',
      ])

      const notesSurface = listPayload.surfaces.find((surface) => surface.surfaceId === 'cortex-notes')
      expect(notesSurface).toMatchObject({
        group: 'scratch',
        runtimeEffect: 'scratchOnly',
        editable: false,
        filePath: cortexNotesPath,
      })

      const commonResponse = await fetch(
        `http://${config.host}:${config.port}/api/prompts/cortex-surfaces/common-knowledge-live?profileId=cortex`,
      )
      expect(commonResponse.status).toBe(200)
      const commonPayload = (await commonResponse.json()) as { content: string; filePath: string }
      expect(commonPayload).toMatchObject({
        content: '# Common Knowledge\n\nLive common content\n',
        filePath: commonKnowledgePath,
      })

      const workerResponse = await fetch(
        `http://${config.host}:${config.port}/api/prompts/cortex-surfaces/cortex-worker-prompts-live?profileId=cortex`,
      )
      expect(workerResponse.status).toBe(200)
      const workerPayload = (await workerResponse.json()) as { content: string; filePath: string }
      expect(workerPayload).toMatchObject({
        content: '# Cortex Worker Prompt Templates — v4\n<!-- Cortex Worker Prompts Version: 4 -->\n\nLive worker content\n',
        filePath: workerPromptsPath,
      })

      const nonCortexResponse = await fetch(
        `http://${config.host}:${config.port}/api/prompts/cortex-surfaces?profileId=manager`,
      )
      expect(nonCortexResponse.status).toBe(200)
      expect(await nonCortexResponse.json()).toEqual({ enabled: false, surfaces: [] })
    } finally {
      await server.stop()
    }
  })

  it('reseeds the live Cortex worker prompt file from the current template without triggering legacy upgrade on next boot', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const workerPromptsPath = getCortexWorkerPromptsPath(config.paths.dataDir)
    const customTemplate = [
      '# Cortex Worker Prompt Templates — v4',
      '<!-- Cortex Worker Prompts Version: 4 -->',
      '',
      'Custom template content.',
      '',
    ].join('\n')

    await manager.promptRegistry.save('operational', 'cortex-worker-prompts', customTemplate, 'cortex')
    await writeFile(workerPromptsPath, '# Cortex Worker Prompt Templates\n\nlegacy content\n', 'utf8')

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
      promptRegistry: manager.promptRegistry,
    })

    await server.start()

    try {
      const resetResponse = await fetch(
        `http://${config.host}:${config.port}/api/prompts/cortex-surfaces/cortex-worker-prompts-live/reset?profileId=cortex`,
        {
          method: 'POST',
        },
      )

      expect(resetResponse.status).toBe(200)
      expect(await readFile(workerPromptsPath, 'utf8')).toBe(customTemplate)
    } finally {
      await server.stop()
    }

    const rebootedManager = new TestSwarmManager(config)
    await rebootedManager.boot()

    expect(await readFile(workerPromptsPath, 'utf8')).toBe(customTemplate)
    await expect(readFile(`${workerPromptsPath}.v1.bak`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(`${workerPromptsPath}.v2.bak`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('records versioning mutations for Cortex prompt-surface file saves and resets', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)
    const recordMutation = vi.fn(async () => true)

    const manager = new TestSwarmManager(config, {
      versioningService: {
        isTrackedPath: () => true,
        recordMutation,
        flushPending: async () => {},
        reconcileNow: async () => {},
      },
    })
    await bootWithDefaultManager(manager, config)

    const commonKnowledgePath = getCommonKnowledgePath(config.paths.dataDir)
    const workerPromptsPath = getCortexWorkerPromptsPath(config.paths.dataDir)
    const customTemplate = [
      '# Cortex Worker Prompt Templates — v4',
      '<!-- Cortex Worker Prompts Version: 4 -->',
      '',
      'Custom template content.',
      '',
    ].join('\n')

    await manager.promptRegistry.save('operational', 'cortex-worker-prompts', customTemplate, 'cortex')
    recordMutation.mockClear()

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
      promptRegistry: manager.promptRegistry,
    })

    await server.start()

    try {
      const saveResponse = await fetch(
        `http://${config.host}:${config.port}/api/prompts/cortex-surfaces/common-knowledge-live`,
        {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            profileId: 'cortex',
            content: '# Common Knowledge\n\nUpdated through cortex surface save\n',
          }),
        },
      )
      expect(saveResponse.status).toBe(200)

      const resetResponse = await fetch(
        `http://${config.host}:${config.port}/api/prompts/cortex-surfaces/cortex-worker-prompts-live/reset?profileId=cortex`,
        {
          method: 'POST',
        },
      )
      expect(resetResponse.status).toBe(200)

      expect(recordMutation).toHaveBeenNthCalledWith(1, {
        path: commonKnowledgePath,
        action: 'write',
        source: 'api-write-file',
        profileId: 'cortex',
      })
      expect(recordMutation).toHaveBeenNthCalledWith(2, {
        path: workerPromptsPath,
        action: 'write',
        source: 'api-write-file',
        profileId: 'cortex',
      })
    } finally {
      await server.stop()
    }
  })

})
