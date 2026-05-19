/** @vitest-environment jsdom */

import { fireEvent, waitFor } from '@testing-library/dom'
import { createElement, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HelpProvider } from '@/components/help/HelpProvider'
import { SkillsViewer } from './SkillsViewer'

const skillsViewerApiMock = vi.hoisted(() => ({
  fetchSkillInventory: vi.fn(),
  shareSkill: vi.fn(),
  previewSkillImportFromUrl: vi.fn(),
  importSkill: vi.fn(),
}))

const settingsApiMock = vi.hoisted(() => ({
  fetchSettingsEnvVariables: vi.fn(),
  updateSettingsEnvVariables: vi.fn(),
  deleteSettingsEnvVariable: vi.fn(),
  toErrorMessage: vi.fn((error: unknown) =>
    error instanceof Error ? error.message : String(error),
  ),
}))

vi.mock('./skills-viewer-api', () => ({
  fetchSkillInventory: (...args: Parameters<typeof skillsViewerApiMock.fetchSkillInventory>) =>
    skillsViewerApiMock.fetchSkillInventory(...args),
  shareSkill: (...args: Parameters<typeof skillsViewerApiMock.shareSkill>) =>
    skillsViewerApiMock.shareSkill(...args),
  previewSkillImportFromUrl: (...args: Parameters<typeof skillsViewerApiMock.previewSkillImportFromUrl>) =>
    skillsViewerApiMock.previewSkillImportFromUrl(...args),
  importSkill: (...args: Parameters<typeof skillsViewerApiMock.importSkill>) =>
    skillsViewerApiMock.importSkill(...args),
}))

vi.mock('../settings-api', () => ({
  fetchSettingsEnvVariables: (...args: Parameters<typeof settingsApiMock.fetchSettingsEnvVariables>) =>
    settingsApiMock.fetchSettingsEnvVariables(...args),
  updateSettingsEnvVariables: (...args: Parameters<typeof settingsApiMock.updateSettingsEnvVariables>) =>
    settingsApiMock.updateSettingsEnvVariables(...args),
  deleteSettingsEnvVariable: (...args: Parameters<typeof settingsApiMock.deleteSettingsEnvVariable>) =>
    settingsApiMock.deleteSettingsEnvVariable(...args),
  toErrorMessage: (...args: Parameters<typeof settingsApiMock.toErrorMessage>) =>
    settingsApiMock.toErrorMessage(...args),
}))

vi.mock('./SkillFileTree', () => ({
  SkillFileTree: () => createElement('div', { 'data-testid': 'skill-file-tree' }),
}))

vi.mock('./SkillFileViewer', () => ({
  SkillFileViewer: () => createElement('div', { 'data-testid': 'skill-file-viewer' }),
}))

vi.mock('./SkillEnvVariables', () => ({
  SkillEnvVariables: () => createElement('div', { 'data-testid': 'skill-env-variables' }),
}))

vi.mock('../SettingsChromeCdp', () => ({
  SettingsChromeCdp: () => null,
}))

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)

  skillsViewerApiMock.fetchSkillInventory.mockResolvedValue([
    {
      skillId: 'skill-1',
      name: 'memory',
      directoryName: 'memory',
      envCount: 0,
      hasRichConfig: false,
      sourceKind: 'builtin',
      rootPath: '/tmp/memory',
      skillFilePath: '/tmp/memory/SKILL.md',
      isInherited: false,
      isEffective: true,
    },
  ])
  skillsViewerApiMock.shareSkill.mockResolvedValue({
    shareUrl: 'https://share.test/s/token',
    importUrl: 'forge://skill-import?url=https%3A%2F%2Fshare.test%2Fs%2Ftoken',
    expiresAt: '2026-05-20T00:00:00.000Z',
    contentSha256: 'a'.repeat(64),
    warnings: [],
  })
  skillsViewerApiMock.previewSkillImportFromUrl.mockResolvedValue({
    bundle: {
      format: 'forge.skill.bundle.v1',
      bundleVersion: 1,
      createdAt: '2026-05-13T00:00:00.000Z',
      contentSha256: 'a'.repeat(64),
      origin: { platform: 'darwin', arch: 'arm64', skillSourceKind: 'machine-local' },
      skill: { handle: 'shared', name: 'Shared', env: [], frontmatter: { knownForgeKeys: [], knownPiKeys: [], unsupportedKeys: [], warnings: [] } },
      portability: { scripts: [], dependencies: [], osIndicators: [] },
      files: [],
      totals: { fileCount: 0, byteCount: 0 },
    },
    target: { scope: 'global' },
    conflict: { exists: false },
    warnings: [],
  })
  skillsViewerApiMock.importSkill.mockResolvedValue({
    bundle: { skill: { handle: 'shared', name: 'Shared' }, files: [], totals: { fileCount: 0, byteCount: 0 } },
    target: { scope: 'global' },
    rootPath: '/tmp/shared',
    skillId: 'shared-skill',
    replaced: false,
    installedOverride: false,
    warnings: [],
  })
  settingsApiMock.fetchSettingsEnvVariables.mockResolvedValue([])
  settingsApiMock.updateSettingsEnvVariables.mockResolvedValue(undefined)
  settingsApiMock.deleteSettingsEnvVariable.mockResolvedValue(undefined)
})

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
  }

  root = null
  container.remove()
  vi.clearAllMocks()
})

describe('SkillsViewer', () => {
  it('loads the skill inventory on initial render in StrictMode', async () => {
    root = createRoot(container)

    flushSync(() => {
      root?.render(
        createElement(
          StrictMode,
          null,
          createElement(
            HelpProvider,
            null,
            createElement(SkillsViewer, {
              wsUrl: 'ws://127.0.0.1:47287',
              profiles: [],
            }),
          ),
        ),
      )
    })

    await waitFor(() => {
      expect(skillsViewerApiMock.fetchSkillInventory).toHaveBeenCalledWith(
        'ws://127.0.0.1:47287',
        undefined,
        undefined,
      )
      expect(container.textContent).toContain('memory')
    })
  })

  it('opens a URL import preview from route state without installing and requests route cleanup', async () => {
    root = createRoot(container)
    const onConsumed = vi.fn()

    renderViewer({ initialImportUrl: 'https://share.test/s/token', onConsumed })

    await waitFor(() => {
      expect(skillsViewerApiMock.previewSkillImportFromUrl).toHaveBeenCalledWith(
        'ws://127.0.0.1:47287',
        { url: 'https://share.test/s/token', target: { scope: 'global' } },
      )
      expect(skillsViewerApiMock.importSkill).not.toHaveBeenCalled()
      expect(onConsumed).toHaveBeenCalledTimes(1)
    })
  })

  it('allows the same route import URL after the route param is cleared and the dialog is closed', async () => {
    root = createRoot(container)
    const onConsumed = vi.fn()

    renderViewer({ initialImportUrl: 'https://share.test/s/token', onConsumed })
    await waitFor(() => expect(skillsViewerApiMock.previewSkillImportFromUrl).toHaveBeenCalledTimes(1))

    renderViewer({ initialImportUrl: undefined, onConsumed })
    fireEvent.click(buttonByText('Close'))

    renderViewer({ initialImportUrl: 'https://share.test/s/token', onConsumed })

    await waitFor(() => expect(skillsViewerApiMock.previewSkillImportFromUrl).toHaveBeenCalledTimes(2))
    expect(onConsumed).toHaveBeenCalledTimes(2)
  })
})

function renderViewer({ initialImportUrl, onConsumed }: { initialImportUrl?: string; onConsumed?: () => void }) {
  flushSync(() => {
    root?.render(
      createElement(
        HelpProvider,
        null,
        createElement(SkillsViewer, {
          wsUrl: 'ws://127.0.0.1:47287',
          profiles: [],
          initialImportUrl,
          onInitialImportUrlConsumed: onConsumed,
        }),
      ),
    )
  })
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes(text))
  if (!button) throw new Error(`Button not found: ${text}`)
  return button as HTMLButtonElement
}
