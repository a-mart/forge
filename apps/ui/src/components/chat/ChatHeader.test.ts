/** @vitest-environment jsdom */

import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenerationThroughputLiveMeasurement } from '@forge/protocol'
import { ChatHeader } from './ChatHeader'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement

const measurement: GenerationThroughputLiveMeasurement = {
  measurementId: 'stale-pi-call',
  sequence: 2,
  phase: 'completed',
  profileId: 'profile-1',
  sessionId: 'manager-1',
  agentId: 'manager-1',
  managerId: 'manager-1',
  role: 'manager',
  provider: 'openai-codex',
  modelId: 'gpt-5.5',
  sampledAt: '2026-07-31T10:00:02.000Z',
  firstOutputAt: '2026-07-31T10:00:01.000Z',
  timeToFirstOutputMs: 1_000,
  elapsedGenerationMs: 2_000,
  outputTokens: 100,
  instantaneousTokensPerSecond: null,
  generationAverageTokensPerSecond: 50,
  valueKind: 'provider_final',
  quality: {
    measurementScope: 'agent_model_call',
    agentRetryAttempt: 0,
    providerAttemptScope: 'unavailable',
    observedProviderAttemptCount: null,
    tokenSource: 'provider_final',
    boundarySource: 'content_delta_to_stream_end',
    reasoningBoundaryCoverage: 'observed',
  },
}

const props: ComponentProps<typeof ChatHeader> = {
  connected: true,
  activeAgentId: 'manager-1',
  activeAgentLabel: 'Manager',
  activeAgentStatus: 'idle',
  activeAgentRole: 'manager',
  channelView: 'web',
  onChannelViewChange: vi.fn(),
  contextWindowUsage: null,
  showCompact: false,
  compactInProgress: false,
  onCompact: vi.fn(),
  showSmartCompact: false,
  smartCompactInProgress: false,
  onSmartCompact: vi.fn(),
  showStopAll: false,
  stopAllInProgress: false,
  stopAllDisabled: false,
  onStopAll: vi.fn(),
  showNewChat: false,
  onNewChat: vi.fn(),
  isArtifactsPanelOpen: false,
  onToggleArtifactsPanel: vi.fn(),
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ChatHeader generation throughput', () => {
  it('renders only count and normalized current tool metadata for manager activity', () => {
    act(() => {
      root.render(createElement(ChatHeader, {
        ...props,
        managerToolActivity: {
          type: 'manager_tool_activity',
          sessionAgentId: 'manager-1',
          revision: 2,
          toolCount: 3,
          currentToolName: 'read_file',
        },
      }))
    })

    const indicator = container.querySelector('[data-testid="manager-tool-activity"]')
    expect(indicator?.textContent).toContain('3')
    expect(indicator?.textContent).toContain('read_file')
    expect(indicator?.getAttribute('aria-label')).toBe('Manager tool activity: 3 tools, read_file')
  })

  it('does not render activity for a worker header', () => {
    act(() => {
      root.render(createElement(ChatHeader, {
        ...props,
        activeAgentRole: 'worker',
        managerToolActivity: {
          type: 'manager_tool_activity',
          sessionAgentId: 'manager-1',
          revision: 2,
          toolCount: 3,
          currentToolName: 'read_file',
        },
      }))
    })

    expect(container.querySelector('[data-testid="manager-tool-activity"]')).toBeNull()
  })

  it('suppresses a retained Pi anchor when the manager runtime is not eligible', () => {
    act(() => {
      root.render(createElement(ChatHeader, {
        ...props,
        generationThroughputEligible: false,
        showGenerationThroughput: true,
        generationThroughput: measurement,
        generationThroughputLatestFinal: measurement,
      }))
    })

    expect(container.querySelector('[data-testid="throughput-pulse"]')).toBeNull()
  })

  it('defaults to hiding the manager pulse even for an eligible Pi runtime', () => {
    act(() => {
      root.render(createElement(ChatHeader, {
        ...props,
        generationThroughputEligible: true,
        generationThroughput: measurement,
        generationThroughputLatestFinal: measurement,
      }))
    })

    expect(container.querySelector('[data-testid="throughput-pulse"]')).toBeNull()
  })

  it('renders the manager pulse when display and Pi runtime eligibility are explicit', () => {
    act(() => {
      root.render(createElement(ChatHeader, {
        ...props,
        generationThroughputEligible: true,
        showGenerationThroughput: true,
        generationThroughput: measurement,
        generationThroughputLatestFinal: measurement,
      }))
    })

    expect(container.querySelector('[data-testid="throughput-pulse"]')?.textContent).toContain('50')
  })
})

describe('ChatHeader initial model-input entry point', () => {
  it('uses initial-model-input copy in All mode', () => {
    act(() => {
      root.render(createElement(ChatHeader, {
        ...props,
        channelView: 'all',
      }))
    })

    const button = container.querySelector('button[aria-label="View initial model input"]')
    expect(button).not.toBeNull()
    expect(container.querySelector('button[aria-label="View system prompt"]')).toBeNull()
  })
})
