/** @vitest-environment jsdom */

import { waitFor } from '@testing-library/dom'
import { createElement, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HelpProvider } from '@/components/help/HelpProvider'
import { SkillsViewer } from './SkillsViewer'

const skillsViewerApiMock = vi.hoisted(() => ({
  fetchSkillInventory: vi.fn(),
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
      )
      expect(container.textContent).toContain('memory')
    })
  })
})
