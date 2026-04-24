/** @vitest-environment jsdom */

import { getByText, queryByText } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsPrompts } from './SettingsPrompts'
import { HelpProvider } from '@/components/help/HelpProvider'
import type { ManagerProfile } from '@forge/protocol'

let container: HTMLDivElement
let root: Root | null = null
const originalFetch = globalThis.fetch

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
  }

  root = null
  container.remove()
  vi.restoreAllMocks()
  globalThis.fetch = originalFetch
})

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  flushSync(() => {})
}

describe('SettingsPrompts', () => {
  it('collapses Cortex prompt selection into a single picker for the cortex profile', async () => {
    const profiles: ManagerProfile[] = [
      {
        profileId: 'cortex',
        displayName: 'Cortex',
        defaultSessionAgentId: 'cortex',
        defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.3-codex', thinkingLevel: 'medium' },
        createdAt: '2026-03-16T00:00:00.000Z',
        updatedAt: '2026-03-16T00:00:00.000Z',
      },
    ]

    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          enabled: true,
          surfaces: [
            {
              surfaceId: 'cortex-system-prompt',
              title: 'Cortex System Prompt',
              description: 'Core instructions for Cortex.',
              group: 'system',
              kind: 'registry',
              editable: true,
              resetMode: 'profileOverride',
              runtimeEffect: 'liveImmediate',
              category: 'archetype',
              promptId: 'cortex',
              activeLayer: 'builtin',
              sourcePath: '/tmp/cortex.md',
              seedPrompt: null,
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          category: 'archetype',
          promptId: 'cortex',
          content: 'You are Cortex.',
          sourceLayer: 'builtin',
          sourcePath: '/tmp/cortex.md',
          variables: [],
        }),
      }) as typeof fetch

    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(
          HelpProvider,
          null,
          createElement(SettingsPrompts, {
            wsUrl: 'ws://127.0.0.1:47187',
            profiles,
            promptChangeKey: 0,
          }),
        ),
      )
    })

    await flushPromises()
    await flushPromises()

    expect(queryByText(container, 'Category')).toBeNull()
    expect(getByText(container, 'Cortex item')).toBeTruthy()
    expect(container.textContent).toContain('Cortex System Prompt')
    expect(getByText(container, /Browse Cortex prompts, seed templates, live files, and scratch surfaces/)).toBeTruthy()
  })

  it('keeps category selection for non-cortex profiles', async () => {
    const profiles: ManagerProfile[] = [
      {
        profileId: 'feature-manager',
        displayName: 'Feature Manager',
        defaultSessionAgentId: 'feature-manager',
        defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.3-codex', thinkingLevel: 'medium' },
        createdAt: '2026-03-16T00:00:00.000Z',
        updatedAt: '2026-03-16T00:00:00.000Z',
      },
    ]

    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            category: 'archetype',
            promptId: 'manager',
            displayName: 'Manager',
            description: 'Manager prompt.',
            activeLayer: 'builtin',
            hasProfileOverride: false,
            variables: [],
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ enabled: false, surfaces: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          category: 'archetype',
          promptId: 'manager',
          content: 'You are the manager.',
          sourceLayer: 'builtin',
          sourcePath: '/tmp/manager.md',
          variables: [],
        }),
      }) as typeof fetch

    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(
          HelpProvider,
          null,
          createElement(SettingsPrompts, {
            wsUrl: 'ws://127.0.0.1:47187',
            profiles,
            promptChangeKey: 0,
          }),
        ),
      )
    })

    await flushPromises()
    await flushPromises()

    expect(getByText(container, 'Category')).toBeTruthy()
    expect(getByText(container, 'Prompt')).toBeTruthy()
    expect(queryByText(container, 'Cortex item')).toBeNull()
  })
})
