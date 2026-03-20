import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getCommonKnowledgePath, getSharedKnowledgeDir } from '../swarm/data-paths.js'
import {
  getOnboardingSnapshot,
  loadOnboardingState,
  renderOnboardingCommonKnowledge,
  saveOnboardingPreferences,
  skipOnboarding,
  ONBOARDING_STATE_FILE_NAME,
} from '../swarm/onboarding-state.js'

describe('onboarding-state', () => {
  it('fresh load creates the default pending state file', async () => {
    const dataDir = await createTempDataDir()

    const state = await loadOnboardingState(dataDir)

    expect(state).toEqual({
      status: 'pending',
      completedAt: null,
      skippedAt: null,
      preferences: null,
    })
  })

  it('saves completed onboarding preferences in the simplified format', async () => {
    const dataDir = await createTempDataDir()

    const state = await saveOnboardingPreferences(dataDir, {
      preferredName: 'Ada',
      technicalLevel: 'developer',
      additionalPreferences: 'Keep responses concise.',
    })

    expect(state.status).toBe('completed')
    expect(state.completedAt).toMatch(/T/)
    expect(state.preferences).toEqual({
      preferredName: 'Ada',
      technicalLevel: 'developer',
      additionalPreferences: 'Keep responses concise.',
    })

    const raw = await readFile(join(getSharedKnowledgeDir(dataDir), ONBOARDING_STATE_FILE_NAME), 'utf8')
    expect(JSON.parse(raw)).toEqual(state)
  })

  it('records skipped onboarding without preferences', async () => {
    const dataDir = await createTempDataDir()

    const state = await skipOnboarding(dataDir)

    expect(state).toEqual({
      status: 'skipped',
      completedAt: null,
      skippedAt: expect.stringMatching(/T/),
      preferences: null,
    })
  })

  it('does not rewrite an already-valid simplified onboarding state', async () => {
    const dataDir = await createTempDataDir()
    const statePath = join(getSharedKnowledgeDir(dataDir), ONBOARDING_STATE_FILE_NAME)
    await mkdir(dirname(statePath), { recursive: true })

    const raw = '{"status":"completed","completedAt":"2026-03-20T12:00:00.000Z","skippedAt":null,"preferences":{"preferredName":"Ada","technicalLevel":"developer","additionalPreferences":"Keep responses concise."}}\n'
    await writeFile(statePath, raw, 'utf8')

    const state = await loadOnboardingState(dataDir)
    const stored = await readFile(statePath, 'utf8')

    expect(state).toEqual({
      status: 'completed',
      completedAt: '2026-03-20T12:00:00.000Z',
      skippedAt: null,
      preferences: {
        preferredName: 'Ada',
        technicalLevel: 'developer',
        additionalPreferences: 'Keep responses concise.',
      },
    })
    expect(stored).toBe(raw)
  })

  it('preserves saved preferences when skipping after completion', async () => {
    const dataDir = await createTempDataDir()

    const completed = await saveOnboardingPreferences(dataDir, {
      preferredName: 'Ada',
      technicalLevel: 'developer',
      additionalPreferences: 'Keep responses concise.',
    })
    const skipped = await skipOnboarding(dataDir)

    expect(skipped.status).toBe('skipped')
    expect(skipped.completedAt).toBe(completed.completedAt)
    expect(skipped.skippedAt).toMatch(/T/)
    expect(skipped.preferences).toEqual(completed.preferences)
  })

  it('renders the managed onboarding block into common knowledge', async () => {
    const dataDir = await createTempDataDir()
    const commonKnowledgePath = getCommonKnowledgePath(dataDir)
    await mkdir(dirname(commonKnowledgePath), { recursive: true })
    await writeFile(
      commonKnowledgePath,
      '# Common Knowledge\n<!-- Maintained by Cortex. Last updated: {ISO timestamp} -->\n\n## Interaction Defaults\n\nManual content stays here.\n',
      'utf8',
    )

    const state = await saveOnboardingPreferences(dataDir, {
      preferredName: 'Ada',
      technicalLevel: 'technical_non_developer',
      additionalPreferences: 'Prefer plain language.',
    })

    await renderOnboardingCommonKnowledge(dataDir, state)
    const rendered = await readFile(commonKnowledgePath, 'utf8')

    expect(rendered).toContain('## User Snapshot')
    expect(rendered).toContain('<!-- BEGIN MANAGED:ONBOARDING -->')
    expect(rendered).toContain('Onboarding status: completed')
    expect(rendered).toContain('Preferred name: Ada')
    expect(rendered).toContain('Technical level: Technical (non-developer)')
    expect(rendered).toContain('Additional preferences: Prefer plain language.')
    expect(rendered).toContain('Manual content stays here.')
    expect(rendered).not.toContain('{ISO timestamp}')
  })

  it('migrates completed legacy conversational onboarding into the new shape', async () => {
    const dataDir = await createTempDataDir()
    const statePath = join(getSharedKnowledgeDir(dataDir), ONBOARDING_STATE_FILE_NAME)
    await mkdir(dirname(statePath), { recursive: true })
    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          schemaVersion: 2,
          status: 'completed',
          completedAt: '2026-03-20T12:00:00.000Z',
          captured: {
            preferredName: { value: 'Ada', status: 'confirmed', updatedAt: '2026-03-20T12:00:00.000Z' },
            technicalComfort: { value: 'technical', status: 'confirmed', updatedAt: '2026-03-20T12:00:00.000Z' },
            responseVerbosity: { value: 'concise', status: 'confirmed', updatedAt: '2026-03-20T12:00:00.000Z' },
            explanationDepth: { value: 'standard', status: 'confirmed', updatedAt: '2026-03-20T12:00:00.000Z' },
            updateCadence: { value: 'periodic', status: 'confirmed', updatedAt: '2026-03-20T12:00:00.000Z' },
            autonomyDefault: { value: 'balanced', status: 'confirmed', updatedAt: '2026-03-20T12:00:00.000Z' },
            riskEscalationPreference: { value: 'normal', status: 'confirmed', updatedAt: '2026-03-20T12:00:00.000Z' },
            primaryUseCases: { value: ['code review'], status: 'confirmed', updatedAt: '2026-03-20T12:00:00.000Z' },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    const state = await getOnboardingSnapshot(dataDir)

    expect(state.status).toBe('completed')
    expect(state.completedAt).toBe('2026-03-20T12:00:00.000Z')
    expect(state.preferences).toEqual({
      preferredName: 'Ada',
      technicalLevel: 'technical_non_developer',
      additionalPreferences:
        'Response verbosity: concise; Explanation depth: standard; Update cadence: periodic; Autonomy: balanced; Risk escalation: normal; Primary use cases: code review',
    })
  })
})

async function createTempDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'onboarding-state-'))
}
