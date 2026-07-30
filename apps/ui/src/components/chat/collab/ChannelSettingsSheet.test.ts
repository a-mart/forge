/** @vitest-environment jsdom */

import { fireEvent, getAllByRole, getByRole } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollaborationChannel, ModelPresetInfo } from '@forge/protocol'

// Radix UI components require ResizeObserver in jsdom
globalThis.ResizeObserver ??= class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver

const modelPresetMocks = vi.hoisted(() => ({
  presets: [] as ModelPresetInfo[],
}))

vi.mock('@/lib/model-preset', () => ({
  useModelPresets: () => modelPresetMocks.presets,
  getAvailableChangeManagerFamilies: (presets: ModelPresetInfo[]) => presets.map((preset) => ({
    familyId: preset.presetId,
    displayName: preset.displayName,
  })),
  getSupportedReasoningLevelsForModelId: (modelId: string, presets: ModelPresetInfo[]) => (
    presets.find((preset) => preset.modelId === modelId || preset.presetId === modelId)?.supportedReasoningLevels ?? []
  ),
}))

vi.mock('@/lib/collaboration-endpoints', () => ({
  resolveCollaborationApiBaseUrl: () => 'http://localhost:47187',
}))

const apiMocks = vi.hoisted(() => ({
  getChannel: vi.fn(),
  updateChannel: vi.fn(),
}))

vi.mock('@/lib/collaboration-api', () => ({
  getChannel: apiMocks.getChannel,
  updateChannel: apiMocks.updateChannel,
}))

const { ChannelSettingsSheet } = await import('./ChannelSettingsSheet')

const channel: CollaborationChannel = {
  channelId: 'channel-1',
  workspaceId: 'workspace-1',
  sessionAgentId: 'session-1',
  name: 'engineering',
  slug: 'engineering',
  aiEnabled: true,
  activeSelectedSpecialistHandles: [],
  position: 0,
  archived: false,
  lastMessageSeq: 1,
  createdAt: '2026-04-14T12:00:00.000Z',
  updatedAt: '2026-04-14T12:00:00.000Z',
}

let root: Root
let container: HTMLDivElement

function renderSheet(overrides: Partial<CollaborationChannel> = {}, extraProps: { isAdmin?: boolean } = {}) {
  const merged = { ...channel, ...overrides }
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    channel: merged,
    categories: [],
    isAdmin: extraProps.isAdmin ?? true,
  }
  apiMocks.getChannel.mockResolvedValue(merged)
  flushSync(() => {
    root.render(createElement(ChannelSettingsSheet, props))
  })
}

beforeEach(() => {
  Element.prototype.hasPointerCapture ??= vi.fn(() => false)
  Element.prototype.setPointerCapture ??= vi.fn()
  Element.prototype.releasePointerCapture ??= vi.fn()
  Element.prototype.scrollIntoView ??= vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  apiMocks.getChannel.mockReset()
  apiMocks.updateChannel.mockReset()
  modelPresetMocks.presets = []
})

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('ChannelSettingsSheet', () => {
  it('renders Additional instructions with the updated labeling', () => {
    renderSheet()

    const labels = Array.from(document.body.querySelectorAll('label')).map((node) => node.textContent)
    expect(labels).toEqual(expect.arrayContaining([
      'Channel name',
      'Topic / description',
      'Category',
      'Model',
      'Auto-reply',
      'Additional instructions',
    ]))
    expect(labels).not.toContain('Prompt overlay')
  })

  it('shows Save button disabled when nothing has changed', () => {
    renderSheet()

    const saveButton = Array.from(document.body.querySelectorAll('button[type="submit"]')).find(
      (btn) => btn.textContent?.includes('Save'),
    ) as HTMLButtonElement | undefined

    expect(saveButton).toBeTruthy()
    expect(saveButton?.disabled).toBe(true)
  })

  it('submits updated instructions with the trimmed channel payload', async () => {
    renderSheet({ promptOverlay: 'Existing guidance' })

    const instructionsInput = document.getElementById('collab-channel-settings-prompt-overlay') as HTMLTextAreaElement | null
    expect(instructionsInput).toBeTruthy()
    if (instructionsInput) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(instructionsInput, '  Updated guidance  ')
      instructionsInput.dispatchEvent(new Event('input', { bubbles: true }))
      instructionsInput.dispatchEvent(new Event('change', { bubbles: true }))
    }

    const submitButton = Array.from(document.body.querySelectorAll('button[type="submit"]')).find(
      (btn) => btn.textContent?.includes('Save'),
    ) as HTMLButtonElement | undefined
    expect(submitButton?.disabled).toBe(false)

    if (submitButton) {
      flushSync(() => { submitButton.click() })
    }

    await vi.waitFor(() => {
      expect(apiMocks.updateChannel).toHaveBeenCalled()
    })

    const callArgs = apiMocks.updateChannel.mock.calls[0][1] as Record<string, unknown>
    expect(callArgs).toEqual({
      name: 'engineering',
      description: null,
      categoryId: null,
      aiEnabled: true,
      promptOverlay: 'Updated guidance',
    })
  })

  it('shows distinct Extra High, Max, and Ultra reasoning choices for GPT-5.6 Sol', async () => {
    modelPresetMocks.presets = [{
      presetId: 'pi-5.6',
      displayName: 'GPT-5.6 Sol',
      provider: 'openai-codex',
      modelId: 'gpt-5.6-sol',
      defaultReasoningLevel: 'max',
      supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    }]
    renderSheet({ modelId: 'gpt-5.6-sol', reasoningLevel: 'xhigh' })

    const reasoningTrigger = document.getElementById('collab-channel-settings-reasoning-level')
    expect(reasoningTrigger).toBeTruthy()
    flushSync(() => {
      fireEvent.pointerDown(reasoningTrigger!, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    })
    await vi.waitFor(() => expect(getByRole(document.body, 'option', { name: 'Extra High' })).toBeTruthy())
    expect(getAllByRole(document.body, 'option').map((option) => option.textContent?.trim() ?? '')).toEqual([
      'Low',
      'Medium',
      'High',
      'Extra High',
      'Max',
      'Ultra',
    ])
  })

  it('tracks reasoningLevel in baseline and change detection', () => {
    renderSheet({ reasoningLevel: 'high' })

    // No changes yet — save should be disabled
    const saveButton = Array.from(document.body.querySelectorAll('button[type="submit"]')).find(
      (btn) => btn.textContent?.includes('Save'),
    ) as HTMLButtonElement | undefined

    expect(saveButton).toBeTruthy()
    expect(saveButton?.disabled).toBe(true)
  })
})
