/** @vitest-environment jsdom */

import { fireEvent, getByLabelText, getByRole } from '@testing-library/dom'
import { createElement, createRef, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageInput, type MessageInputHandle, type ProjectAgentSuggestion } from './MessageInput'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import type { SlashCommand } from '@/components/settings/slash-commands-api'
import type { ConversationAttachment } from '@forge/protocol'
import { fetchCodexCatalog } from '@/lib/codex-catalog-api'
import { clearCodexCatalogCache } from '@/lib/codex-catalog-cache'
import { makeManagerSelectionCatalog } from '@/lib/manager-selection-catalog.fixture'
import { invalidateManagerSelectionCatalog } from '@/lib/use-manager-selection-catalog'

const fetchCodexCatalogMock = vi.mocked(fetchCodexCatalog)
const pickerApiClient = { target: { kind: 'collab' } } as unknown as SettingsApiClient

/* ------------------------------------------------------------------ */
/*  Mocks                                                             */
/* ------------------------------------------------------------------ */

vi.mock('@/lib/voice-transcription-client', () => ({
  transcribeVoice: vi.fn(),
}))

vi.mock('@/hooks/use-voice-recorder', () => ({
  MAX_VOICE_RECORDING_DURATION_MS: 120_000,
  useVoiceRecorder: () => ({
    isRecording: false,
    isRequestingPermission: false,
    durationMs: 0,
    waveformBars: [],
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
  }),
}))

vi.mock('@/lib/file-attachments', () => ({
  fileToPendingAttachment: vi.fn(async (file: File) => ({
    id: crypto.randomUUID(),
    type: 'text' as const,
    mimeType: 'text/plain',
    text: 'file-content',
    fileName: file.name,
    sizeBytes: file.size,
  })),
}))

vi.mock('@/lib/api-endpoint', () => ({
  resolveApiEndpoint: (_ws: string, path: string) => `http://127.0.0.1:47187${path}`,
}))

vi.mock('@/lib/codex-catalog-api', () => ({
  fetchCodexCatalog: vi.fn(),
}))

const catalogApiMock = vi.hoisted(() => ({
  fetchManagerSelectionCatalog: vi.fn(),
}))

vi.mock('@/lib/manager-selection-catalog-api', () => ({
  fetchManagerSelectionCatalog: (...args: unknown[]) =>
    catalogApiMock.fetchManagerSelectionCatalog(...args),
}))

const voiceInputMockState: {
  transcribedText: string | null
} = {
  transcribedText: null,
}

vi.mock('./message-input/hooks/use-voice-input', () => ({
  useVoiceInput: ({
    disabled,
    blockedByLoading,
    onTranscription,
  }: {
    disabled: boolean
    blockedByLoading: boolean
    onTranscription: (text: string) => boolean
  }) => ({
    isRecording: false,
    isRequestingMicrophone: false,
    isTranscribingVoice: false,
    voiceError: null,
    voiceRecordingDurationMs: 0,
    recordingWaveformBars: [],
    voiceButtonDisabled: disabled || blockedByLoading,
    handleVoiceButtonClick: () => {
      if (disabled || blockedByLoading) return
      if (voiceInputMockState.transcribedText) {
        onTranscription(voiceInputMockState.transcribedText)
      }
    },
    stopAndTranscribeRecording: async () => {
      if (disabled || blockedByLoading) return
      if (voiceInputMockState.transcribedText) {
        onTranscription(voiceInputMockState.transcribedText)
      }
    },
  }),
}))

/* ------------------------------------------------------------------ */
/*  Setup                                                             */
/* ------------------------------------------------------------------ */

const DRAFTS_KEY = 'forge-chat-drafts'
const FORMAT_MODE_KEY = 'forge-chat-format-mode'

// Mock localStorage — Node 22 built-in localStorage is incomplete in jsdom env
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value }),
    removeItem: vi.fn((key: string) => { delete store[key] }),
    clear: vi.fn(() => { store = {} }),
    get length() { return Object.keys(store).length },
    key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
  }
})()

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
  configurable: true,
})

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  Element.prototype.hasPointerCapture ??= vi.fn(() => false)
  Element.prototype.setPointerCapture ??= vi.fn()
  Element.prototype.releasePointerCapture ??= vi.fn()
  Element.prototype.scrollIntoView ??= vi.fn()
  localStorageMock.clear()
  voiceInputMockState.transcribedText = null
  fetchCodexCatalogMock.mockReset()
  clearCodexCatalogCache()
  invalidateManagerSelectionCatalog()
  vi.clearAllMocks()
  catalogApiMock.fetchManagerSelectionCatalog.mockResolvedValue(makeManagerSelectionCatalog())
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  container.remove()
  invalidateManagerSelectionCatalog()
})

async function flush(): Promise<void> {
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  await Promise.resolve()
  flushSync(() => {})
}

function renderMessageInput(
  overrides: Partial<{
    onSend: (msg: string, attachments?: ConversationAttachment[], options?: Parameters<ComponentProps<typeof MessageInput>['onSend']>[2]) => void | boolean | Promise<boolean>
    isLoading: boolean
    disabled: boolean
    agentId: string
    draftKey: string
    slashCommands: SlashCommand[]
    projectAgents: ProjectAgentSuggestion[]
    enableCodexMention: boolean
    managerAgentId: string
    wsUrl: string
    replyTarget: ComponentProps<typeof MessageInput>['replyTarget']
    onClearReplyTarget: () => void
    sessionModelPicker: ComponentProps<typeof MessageInput>['sessionModelPicker']
    sessionCoordinationPicker: ComponentProps<typeof MessageInput>['sessionCoordinationPicker']
    secureSessionPicker: ComponentProps<typeof MessageInput>['secureSessionPicker']
  }> = {},
  inputRef?: React.RefObject<MessageInputHandle | null>,
): void {
  const defaultProps = {
    onSend: vi.fn(),
    isLoading: false,
    disabled: false,
    agentId: 'agent-1',
    wsUrl: 'ws://127.0.0.1:47187',
    ...overrides,
  }
  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(MessageInput, { ...defaultProps, ref: inputRef ?? null }))
  })
}

function getTextarea(): HTMLTextAreaElement {
  return container.querySelector('textarea')!
}

function typeInTextarea(value: string): void {
  const textarea = getTextarea()
  flushSync(() => {
    fireEvent.change(textarea, { target: { value } })
  })
}

/* ================================================================== */
/*  Tests                                                             */
/* ================================================================== */

describe('MessageInput', () => {
  /* ---- Mention deletion ---- */

  describe('mention deletion', () => {
    it('removes entire mention token on backspace', async () => {
      renderMessageInput({
        projectAgents: [
          { agentId: 'a1', handle: 'docs', displayName: 'Docs', whenToUse: '' },
        ],
      })
      await flush()

      const textarea = getTextarea()

      // Simulate typing a mention token manually
      flushSync(() => {
        fireEvent.change(textarea, { target: { value: '[@docs] hello' } })
      })
      await flush()

      // Set cursor right after the closing bracket (position 7)
      textarea.setSelectionRange(7, 7)

      // Press backspace — should remove entire [@docs] token
      flushSync(() => {
        fireEvent.keyDown(textarea, { key: 'Backspace' })
      })
      await flush()

      expect(getTextarea().value).toBe(' hello')
    })

    it('removes entire mention token on delete key', async () => {
      renderMessageInput({
        projectAgents: [
          { agentId: 'a1', handle: 'docs', displayName: 'Docs', whenToUse: '' },
        ],
      })
      await flush()

      const textarea = getTextarea()

      flushSync(() => {
        fireEvent.change(textarea, { target: { value: '[@docs] hello' } })
      })
      await flush()

      // Set cursor right before the mention token (position 0)
      textarea.setSelectionRange(0, 0)

      flushSync(() => {
        fireEvent.keyDown(textarea, { key: 'Delete' })
      })
      await flush()

      expect(getTextarea().value).toBe(' hello')
    })
  })

  /* ---- Draft persistence ---- */

  describe('draft persistence', () => {
    it('persists text draft to localStorage on input change', async () => {
      renderMessageInput({ agentId: 'agent-1' })
      await flush()

      typeInTextarea('draft message')
      await flush()

      const drafts = JSON.parse(localStorageMock.getItem(DRAFTS_KEY) ?? '{}')
      expect(drafts['agent-1']).toBe('draft message')
    })

    it('restores draft when remounting with same agentId', async () => {
      // Pre-seed localStorage with a draft
      localStorageMock.setItem(DRAFTS_KEY, JSON.stringify({ 'agent-1': 'restored draft' }))

      renderMessageInput({ agentId: 'agent-1' })
      await flush()

      expect(getTextarea().value).toBe('restored draft')
    })

    it('saves and restores drafts across agent switches', async () => {
      renderMessageInput({ agentId: 'agent-1' })
      await flush()
      typeInTextarea('draft for agent-1')
      await flush()

      // Unmount and remount with a different agentId
      flushSync(() => root?.unmount())
      root = null

      renderMessageInput({ agentId: 'agent-2' })
      await flush()

      // Agent-2 textarea should start empty
      expect(getTextarea().value).toBe('')

      // Check that agent-1 draft is still in storage
      const drafts = JSON.parse(localStorageMock.getItem(DRAFTS_KEY) ?? '{}')
      expect(drafts['agent-1']).toBe('draft for agent-1')
    })

    it('clears draft from localStorage when input is emptied', async () => {
      renderMessageInput({ agentId: 'agent-1' })
      await flush()

      typeInTextarea('something')
      await flush()
      expect(JSON.parse(localStorageMock.getItem(DRAFTS_KEY) ?? '{}')['agent-1']).toBe('something')

      typeInTextarea('')
      await flush()
      expect(JSON.parse(localStorageMock.getItem(DRAFTS_KEY) ?? '{}')['agent-1']).toBeUndefined()
    })

    it('preserves other session drafts when voice transcription updates the current draft', async () => {
      localStorageMock.setItem(DRAFTS_KEY, JSON.stringify({ 'agent-2': 'keep this draft' }))
      voiceInputMockState.transcribedText = 'voice transcript'

      renderMessageInput({ agentId: 'agent-1' })
      await flush()

      const voiceBtn = getByLabelText(container, 'Record voice input')
      flushSync(() => {
        fireEvent.click(voiceBtn)
      })
      await flush()

      expect(getTextarea().value).toBe('voice transcript')
      expect(JSON.parse(localStorageMock.getItem(DRAFTS_KEY) ?? '{}')).toEqual({
        'agent-1': 'voice transcript',
        'agent-2': 'keep this draft',
      })
    })
  })

  /* ---- Slash command menu ---- */

  describe('slash command menu', () => {
    const slashCommands: SlashCommand[] = [
      { id: '1', name: 'review', prompt: 'Please review this code', createdAt: '', updatedAt: '' },
      { id: '2', name: 'fix', prompt: 'Fix this bug', createdAt: '', updatedAt: '' },
    ]

    it('opens slash menu when typing /', async () => {
      renderMessageInput({ slashCommands })
      await flush()

      typeInTextarea('/')
      await flush()

      expect(container.textContent).toContain('/review')
      expect(container.textContent).toContain('/fix')
    })

    it('filters commands as user types', async () => {
      renderMessageInput({ slashCommands })
      await flush()

      typeInTextarea('/rev')
      await flush()

      expect(container.textContent).toContain('/review')
      expect(container.textContent).not.toContain('/fix')
    })

    it('selects slash command on click and replaces input', async () => {
      const onSend = vi.fn()
      renderMessageInput({ slashCommands, onSend })
      await flush()

      typeInTextarea('/')
      await flush()

      // Find the /review button and click it
      const reviewButton = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.includes('/review'),
      )
      expect(reviewButton).toBeTruthy()
      flushSync(() => {
        fireEvent.mouseDown(reviewButton!)
      })
      await flush()

      expect(getTextarea().value).toBe('Please review this code')
    })

    it('shows no matching commands message when filter yields nothing', async () => {
      renderMessageInput({ slashCommands })
      await flush()

      typeInTextarea('/zzz')
      await flush()

      expect(container.textContent).toContain('No matching commands')
    })

    it('closes slash menu when typing a space after /', async () => {
      renderMessageInput({ slashCommands })
      await flush()

      typeInTextarea('/ hello')
      await flush()

      // Menu should not be showing command items
      expect(container.textContent).not.toContain('/review')
    })
  })

  /* ---- Session model picker ---- */

  describe('session model picker', () => {
    const basePicker = {
      originId: 'remote-origin',
      httpClientRef: { current: pickerApiClient },
      sessionAgentId: 'manager-1',
      sessionLabel: 'Main',
      currentModel: {
        provider: 'openai-codex',
        modelId: 'gpt-5.5',
        thinkingLevel: 'xhigh',
      },
      modelOrigin: 'profile_default' as const,
      profileDefaultModel: {
        provider: 'openai-codex',
        modelId: 'gpt-5.5',
        thinkingLevel: 'xhigh',
      },
      onUpdate: vi.fn(),
    }

    it('stays hidden when the parent does not provide a writable Builder manager session', async () => {
      renderMessageInput()
      await flush()

      expect(container.querySelector('[aria-haspopup="dialog"]')).toBeNull()
    })

    it('shows the effective catalog model and friendly reasoning label', async () => {
      renderMessageInput({ sessionModelPicker: basePicker })
      await flush()

      const trigger = getByLabelText(container, 'Session model: GPT-5.5, reasoning Max. Change session model.')
      expect(trigger.textContent).toContain('GPT-5.5 · Max')
      expect(trigger.getAttribute('aria-expanded')).toBe('false')
    })

    it('disables the trigger while its Builder connection is not writable', async () => {
      renderMessageInput({
        sessionModelPicker: {
          ...basePicker,
          disabled: true,
        },
      })
      await flush()

      const trigger = getByLabelText(container, 'Session model: GPT-5.5, reasoning Max. Change session model.')
      expect(trigger).toBeInstanceOf(HTMLButtonElement)
      expect((trigger as HTMLButtonElement).disabled).toBe(true)
    })

    it('falls back to the effective raw model id and formats legacy reasoning', async () => {
      renderMessageInput({
        sessionModelPicker: {
          ...basePicker,
          currentModel: {
            provider: 'custom-provider',
            modelId: 'custom-model-v2',
            thinkingLevel: 'x-high',
          },
        },
      })
      await flush()

      expect(container.textContent).toContain('custom-model-v2 · Max')
    })

    it('opens a compact nested Session Model menu', async () => {
      renderMessageInput({ sessionModelPicker: basePicker })
      await flush()

      const trigger = getByLabelText(container, 'Session model: GPT-5.5, reasoning Max. Change session model.')
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
      await flush()

      expect(document.body.querySelector('[role="dialog"]')).toBeNull()
      expect(getByRole(document.body, 'menu').textContent).toContain('Session model')
      expect(getByRole(document.body, 'menuitem', { name: /Model.*GPT-5.5/ })).toBeTruthy()
      expect(getByRole(document.body, 'menuitem', { name: /Reasoning.*Max/ })).toBeTruthy()
      expect(trigger.getAttribute('aria-expanded')).toBe('true')
      expect(catalogApiMock.fetchManagerSelectionCatalog).toHaveBeenCalledWith(pickerApiClient)
    })

    it('does not submit a non-empty draft when saving a session model change', async () => {
      const onSend = vi.fn()
      const onUpdate = vi.fn()
      renderMessageInput({
        onSend,
        sessionModelPicker: {
          ...basePicker,
          onUpdate,
        },
      })
      await flush()

      typeInTextarea('Keep this draft unsent')
      await flush()

      const trigger = getByLabelText(container, 'Session model: GPT-5.5, reasoning Max. Change session model.')
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
      await flush()

      const reasoningTrigger = getByRole(document.body, 'menuitem', { name: /Reasoning.*Max/ })
      fireEvent.pointerMove(reasoningTrigger, {
        pointerType: 'mouse',
        clientX: 10,
        clientY: 10,
      })
      await new Promise((resolve) => setTimeout(resolve, 150))
      fireEvent.click(getByRole(document.body, 'menuitemradio', { name: 'High' }))
      await flush()

      expect(onUpdate).toHaveBeenCalledWith(
        'manager-1',
        'override',
        { provider: 'openai-codex', modelId: 'gpt-5.5' },
        'high',
      )
      expect(onSend).not.toHaveBeenCalled()
      expect(getTextarea().value).toBe('Keep this draft unsent')
    })

    it('restores keyboard focus to the pill after closing with Escape', async () => {
      renderMessageInput({ sessionModelPicker: basePicker })
      await flush()

      const trigger = getByLabelText(container, 'Session model: GPT-5.5, reasoning Max. Change session model.')
      trigger.focus()
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
      await flush()

      fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' })
      await flush()

      expect(document.body.querySelector('[role="menu"]')).toBeNull()
      expect(document.activeElement).toBe(trigger)
    })

    it('keeps the picker open after returning to the project default', async () => {
      const onUpdate = vi.fn()
      renderMessageInput({
        sessionModelPicker: {
          ...basePicker,
          modelOrigin: 'session_override',
          onUpdate,
        },
      })
      await flush()

      const trigger = getByLabelText(container, 'Session model: GPT-5.5, reasoning Max. Change session model.')
      trigger.focus()
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
      await flush()

      const reset = getByRole(document.body, 'menuitem', {
        name: /Use project default.*GPT-5.5/,
      })
      fireEvent.click(reset)
      await flush()

      expect(onUpdate).toHaveBeenCalledWith('manager-1', 'inherit')
      expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
    })
  })

  describe('session coordination picker', () => {
    const baseCoordinationPicker = {
      originId: 'remote-origin',
      httpClientRef: { current: pickerApiClient },
      sessionAgentId: 'manager-1',
      profileId: 'project-1',
      managerPosture: 'delegation_first' as const,
      managerPostureOrigin: 'product_default' as const,
      delegationRosterId: 'balanced',
      delegationRosterOrigin: 'global_default' as const,
      onUpdateProjectDefaults: vi.fn(),
      onUpdateSession: vi.fn(),
    }

    it('stays hidden without a parent-provided Builder manager configuration', async () => {
      renderMessageInput()
      await flush()
      expect(container.querySelector('[aria-label^="Work mode:"]')).toBeNull()
    })

    it('renders a non-submitting control for an eligible Builder manager', async () => {
      renderMessageInput({ sessionCoordinationPicker: baseCoordinationPicker })
      await flush()

      const trigger = getByLabelText(
        container,
        'Work mode: Delegate first. Roster: balanced.',
      )
      expect(trigger).toBeInstanceOf(HTMLButtonElement)
      expect((trigger as HTMLButtonElement).type).toBe('button')
    })

    it('disables the coordination control with the Builder connection', async () => {
      renderMessageInput({
        sessionCoordinationPicker: {
          ...baseCoordinationPicker,
          disabled: true,
        },
      })
      await flush()

      const trigger = getByLabelText(
        container,
        'Work mode: Delegate first. Roster: balanced.',
      )
      expect((trigger as HTMLButtonElement).disabled).toBe(true)
    })
  })

  describe('secure session picker', () => {
    it('renders only when the parent provides a Secure Session view model', async () => {
      renderMessageInput({
        secureSessionPicker: {
          availability: { state: 'available' },
          snapshot: {
            sessionAgentId: 'manager-1',
            principalKind: 'manager',
            revision: 1,
            executionMode: 'standard',
            environmentStatus: 'stopped',
            leases: [],
            pendingRequests: [],
            updatedAt: '2026-07-23T12:00:00.000Z',
          },
          secrets: [],
          onStart: vi.fn(),
          onGrant: vi.fn(),
          onRevoke: vi.fn(),
        },
      })
      await flush()

      expect(getByLabelText(container, 'Start a secure session.')).toBeTruthy()
    })

    it('does not submit or clear a draft when granting saved secrets', async () => {
      const onSend = vi.fn()
      const onGrant = vi.fn(async () => true)
      renderMessageInput({
        onSend,
        secureSessionPicker: {
          availability: { state: 'available' },
          snapshot: {
            sessionAgentId: 'manager-1',
            principalKind: 'manager',
            revision: 2,
            executionMode: 'secure',
            environmentStatus: 'ready',
            leases: [],
            pendingRequests: [],
            updatedAt: '2026-07-23T12:00:00.000Z',
          },
          secrets: [{
            secretId: 'secret-1',
            displayAlias: 'ssh-password',
            displayName: 'SSH password',
            available: true,
            bindings: [{ kind: 'askpass', variable: 'SSH_ASKPASS' }],
          }],
          onGrant,
          onRevoke: vi.fn(),
        },
      })
      await flush()

      typeInTextarea('Keep this secure-session draft unsent')
      fireEvent.click(getByLabelText(container, /secure session ready/i))
      await flush()
      fireEvent.click(getByRole(document.body, 'button', { name: 'Grant secrets' }))
      await flush()
      fireEvent.click(getByRole(document.body, 'button', { name: 'Grant 1 secret' }))
      await flush()

      expect(onGrant).toHaveBeenCalled()
      expect(onSend).not.toHaveBeenCalled()
      expect(getTextarea().value).toBe('Keep this secure-session draft unsent')
    })

    it('preserves the draft while routing an empty vault to project secrets', async () => {
      const onSend = vi.fn()
      const onReviewProjectSecrets = vi.fn()
      renderMessageInput({
        onSend,
        secureSessionPicker: {
          availability: { state: 'available' },
          snapshot: {
            sessionAgentId: 'manager-1',
            principalKind: 'manager',
            revision: 2,
            executionMode: 'secure',
            environmentStatus: 'ready',
            leases: [],
            pendingRequests: [],
            updatedAt: '2026-07-23T12:00:00.000Z',
          },
          secrets: [],
          onGrant: vi.fn(),
          onReviewProjectSecrets,
        },
      })
      await flush()

      typeInTextarea('Keep this empty-vault draft unsent')
      fireEvent.click(getByLabelText(container, /secure session ready/i))
      await flush()
      fireEvent.click(getByRole(document.body, 'button', {
        name: 'Add project secret',
      }))
      await flush()

      expect(onReviewProjectSecrets).toHaveBeenCalledTimes(1)
      expect(onSend).not.toHaveBeenCalled()
      expect(getTextarea().value).toBe('Keep this empty-vault draft unsent')
    })

    it('applies project defaults without submitting, clearing, or closing the draft flow', async () => {
      const onSend = vi.fn()
      const onApplyProjectDefaults = vi.fn(async () => true)
      renderMessageInput({
        onSend,
        secureSessionPicker: {
          availability: { state: 'available' },
          snapshot: {
            sessionAgentId: 'manager-1',
            principalKind: 'manager',
            revision: 2,
            executionMode: 'secure',
            environmentStatus: 'ready',
            leases: [],
            pendingRequests: [],
            projectDefaults: [{
              secretId: 'secret-1',
              displayAlias: 'deploy-token',
              state: 'configured',
              statusCode: 'ok',
            }],
            updatedAt: '2026-07-23T12:00:00.000Z',
          },
          secrets: [],
          onApplyProjectDefaults,
        },
      })
      await flush()

      typeInTextarea('Keep this project-default draft unsent')
      fireEvent.click(getByLabelText(container, /secure session ready/i))
      await flush()
      const apply = getByRole(document.body, 'button', { name: 'Apply now' })
      apply.focus()
      fireEvent.click(apply)
      await flush()

      expect(onApplyProjectDefaults).toHaveBeenCalledWith('manager-1')
      expect(onSend).not.toHaveBeenCalled()
      expect(getTextarea().value).toBe('Keep this project-default draft unsent')
      expect(getByRole(document.body, 'button', { name: 'Apply now' })).toBeTruthy()
      expect(document.activeElement).toBe(apply)
    })
  })

  /* ---- Voice recording gating ---- */

  describe('voice recording button', () => {
    it('renders voice button when not disabled', async () => {
      renderMessageInput()
      await flush()

      const voiceBtn = getByLabelText(container, 'Record voice input')
      expect(voiceBtn).toBeTruthy()
    })

    it('disables voice button when component is disabled', async () => {
      renderMessageInput({ disabled: true })
      await flush()

      const voiceBtn = getByLabelText(container, 'Record voice input')
      expect(voiceBtn).toBeInstanceOf(HTMLButtonElement)
      expect((voiceBtn as HTMLButtonElement).disabled).toBe(true)
    })

    it('disables voice button when loading and not allowWhileLoading', async () => {
      renderMessageInput({ isLoading: true })
      await flush()

      const voiceBtn = getByLabelText(container, 'Record voice input')
      expect((voiceBtn as HTMLButtonElement).disabled).toBe(true)
    })
  })

  /* ---- Submit behavior ---- */

  describe('submit behavior', () => {
    it('calls onSend with trimmed message on form submit', async () => {
      const onSend = vi.fn()
      renderMessageInput({ onSend })
      await flush()

      typeInTextarea('  hello world  ')
      await flush()

      const form = container.querySelector('form')!
      flushSync(() => {
        fireEvent.submit(form)
      })
      await flush()

      expect(onSend).toHaveBeenCalledWith('hello world', undefined)
    })

    it('clears input after submit', async () => {
      const onSend = vi.fn()
      renderMessageInput({ onSend })
      await flush()

      typeInTextarea('hello')
      await flush()

      const form = container.querySelector('form')!
      flushSync(() => {
        fireEvent.submit(form)
      })
      await flush()

      expect(getTextarea().value).toBe('')
    })

    it('does not send when input is empty', async () => {
      const onSend = vi.fn()
      renderMessageInput({ onSend })
      await flush()

      const form = container.querySelector('form')!
      flushSync(() => {
        fireEvent.submit(form)
      })
      await flush()

      expect(onSend).not.toHaveBeenCalled()
    })

    it('does not send when disabled', async () => {
      const onSend = vi.fn()
      renderMessageInput({ onSend, disabled: true })
      await flush()

      typeInTextarea('hello')
      await flush()

      const form = container.querySelector('form')!
      flushSync(() => {
        fireEvent.submit(form)
      })
      await flush()

      expect(onSend).not.toHaveBeenCalled()
    })
  })

  /* ---- Accepted-send semantics ---- */

  describe('accepted-send semantics', () => {
    it('clears draft when onSend returns true', async () => {
      const onSend = vi.fn(() => true)
      renderMessageInput({ onSend })
      await flush()

      typeInTextarea('hello')
      await flush()

      const form = container.querySelector('form')!
      flushSync(() => {
        fireEvent.submit(form)
      })
      await flush()

      expect(onSend).toHaveBeenCalledWith('hello', undefined)
      expect(getTextarea().value).toBe('')
    })

    it('passes reply metadata and clears the reply target only when send is accepted', async () => {
      const onSend = vi.fn(() => true)
      const onClearReplyTarget = vi.fn()
      const replyTarget = {
        messageId: 'assistant-1',
        role: 'assistant' as const,
        timestamp: '2026-06-29T10:00:00.000Z',
        text: 'Original answer',
      }
      renderMessageInput({ onSend, replyTarget, onClearReplyTarget })
      await flush()

      expect(container.textContent).toContain('Replying to Assistant')
      typeInTextarea('follow up')
      await flush()

      const form = container.querySelector('form')!
      flushSync(() => {
        fireEvent.submit(form)
      })
      await flush()

      expect(onSend).toHaveBeenCalledWith('follow up', undefined, { replyTo: replyTarget })
      expect(onClearReplyTarget).toHaveBeenCalledTimes(1)
    })

    it('omits reply metadata for local slash commands', async () => {
      const onSend = vi.fn(() => true)
      const replyTarget = {
        messageId: 'assistant-1',
        role: 'assistant' as const,
        timestamp: '2026-06-29T10:00:00.000Z',
        text: 'Original answer',
      }
      renderMessageInput({ onSend, replyTarget })
      await flush()

      typeInTextarea('/compact')
      await flush()

      const form = container.querySelector('form')!
      flushSync(() => {
        fireEvent.submit(form)
      })
      await flush()

      expect(onSend).toHaveBeenCalledWith('/compact', undefined)
    })

    it('preserves draft when onSend returns false', async () => {
      const onSend = vi.fn(() => false)
      renderMessageInput({ onSend })
      await flush()

      typeInTextarea('rejected message')
      await flush()

      const form = container.querySelector('form')!
      flushSync(() => {
        fireEvent.submit(form)
      })
      await flush()

      expect(onSend).toHaveBeenCalledWith('rejected message', undefined)
      expect(getTextarea().value).toBe('rejected message')
    })

    it('clears draft when onSend returns void (backward compat)', async () => {
      const onSend = vi.fn() // returns undefined (void)
      renderMessageInput({ onSend })
      await flush()

      typeInTextarea('legacy send')
      await flush()

      const form = container.querySelector('form')!
      flushSync(() => {
        fireEvent.submit(form)
      })
      await flush()

      expect(onSend).toHaveBeenCalledWith('legacy send', undefined)
      expect(getTextarea().value).toBe('')
    })

    it('clears draft when onSend returns a resolved true Promise', async () => {
      const onSend = vi.fn(() => Promise.resolve(true))
      renderMessageInput({ onSend })
      await flush()

      typeInTextarea('async accepted')
      await flush()

      const form = container.querySelector('form')!
      flushSync(() => {
        fireEvent.submit(form)
      })
      // Wait for the promise to resolve
      await flush()

      expect(getTextarea().value).toBe('')
    })

    it('preserves draft when onSend returns a resolved false Promise', async () => {
      const onSend = vi.fn(() => Promise.resolve(false))
      renderMessageInput({ onSend })
      await flush()

      typeInTextarea('async rejected')
      await flush()

      const form = container.querySelector('form')!
      flushSync(() => {
        fireEvent.submit(form)
      })
      // Wait for the promise to resolve
      await flush()

      expect(getTextarea().value).toBe('async rejected')
    })
  })

  /* ---- Draft restoration ---- */

  describe('restoreLastSubmission', () => {
    it('restores text after a successful send', async () => {
      const inputRef = createRef<MessageInputHandle>()
      const onSend = vi.fn(() => true)
      renderMessageInput({ onSend }, inputRef)
      await flush()

      typeInTextarea('important message')
      await flush()

      const form = container.querySelector('form')!
      flushSync(() => {
        fireEvent.submit(form)
      })
      await flush()

      // Draft should be cleared
      expect(getTextarea().value).toBe('')

      // Restore the last submission
      let restored = false
      flushSync(() => {
        restored = inputRef.current!.restoreLastSubmission()
      })
      await flush()

      expect(restored).toBe(true)
      expect(getTextarea().value).toBe('important message')
    })

    it('returns false when there is nothing to restore', async () => {
      const inputRef = createRef<MessageInputHandle>()
      renderMessageInput({}, inputRef)
      await flush()

      const restored = inputRef.current!.restoreLastSubmission()
      expect(restored).toBe(false)
      expect(getTextarea().value).toBe('')
    })

    it('clears saved submission after restore', async () => {
      const inputRef = createRef<MessageInputHandle>()
      const onSend = vi.fn(() => true)
      renderMessageInput({ onSend }, inputRef)
      await flush()

      typeInTextarea('once only')
      await flush()

      const form = container.querySelector('form')!
      flushSync(() => {
        fireEvent.submit(form)
      })
      await flush()

      // First restore succeeds
      flushSync(() => {
        inputRef.current!.restoreLastSubmission()
      })
      await flush()
      expect(getTextarea().value).toBe('once only')

      // Clear again manually
      flushSync(() => {
        inputRef.current!.setInput('')
      })
      await flush()

      // Second restore returns false — already consumed
      const restored = inputRef.current!.restoreLastSubmission()
      expect(restored).toBe(false)
    })

    it('does not save submission when onSend returns false', async () => {
      const inputRef = createRef<MessageInputHandle>()
      const onSend = vi.fn(() => false)
      renderMessageInput({ onSend }, inputRef)
      await flush()

      typeInTextarea('rejected')
      await flush()

      const form = container.querySelector('form')!
      flushSync(() => {
        fireEvent.submit(form)
      })
      await flush()

      // Draft kept — nothing was cleared, so nothing to restore
      expect(getTextarea().value).toBe('rejected')
      const restored = inputRef.current!.restoreLastSubmission()
      expect(restored).toBe(false)
    })
  })

  /* ---- draftKey prop ---- */

  describe('draftKey prop', () => {
    it('uses draftKey instead of agentId for draft storage', async () => {
      renderMessageInput({ agentId: 'agent-1', draftKey: 'collab:channel:ch1' })
      await flush()

      typeInTextarea('channel draft')
      await flush()

      const drafts = JSON.parse(localStorageMock.getItem(DRAFTS_KEY) ?? '{}')
      expect(drafts['collab:channel:ch1']).toBe('channel draft')
      expect(drafts['agent-1']).toBeUndefined()
    })

    it('restores draft from draftKey on mount', async () => {
      localStorageMock.setItem(DRAFTS_KEY, JSON.stringify({ 'collab:channel:ch1': 'saved channel draft' }))

      renderMessageInput({ agentId: 'agent-1', draftKey: 'collab:channel:ch1' })
      await flush()

      expect(getTextarea().value).toBe('saved channel draft')
    })

    it('falls back to agentId when draftKey is not provided', async () => {
      renderMessageInput({ agentId: 'agent-1' })
      await flush()

      typeInTextarea('agent draft')
      await flush()

      const drafts = JSON.parse(localStorageMock.getItem(DRAFTS_KEY) ?? '{}')
      expect(drafts['agent-1']).toBe('agent draft')
    })
  })

  /* ---- Format mode ---- */

  describe('format mode', () => {
    it('defaults to quick-send mode', async () => {
      renderMessageInput()
      await flush()

      const formatBtn = getByLabelText(container, 'Switch to format mode')
      expect(formatBtn).toBeTruthy()
    })

    it('persists format mode to localStorage on toggle', async () => {
      renderMessageInput()
      await flush()

      const formatBtn = getByLabelText(container, 'Switch to format mode')
      flushSync(() => {
        fireEvent.click(formatBtn)
      })
      await flush()

      expect(localStorageMock.getItem(FORMAT_MODE_KEY)).toBe('true')
    })
  })

  /* ---- @mention autocomplete ---- */

  describe('@mention autocomplete', () => {
    const projectAgents: ProjectAgentSuggestion[] = [
      { agentId: 'a1', handle: 'docs', displayName: 'Documentation', whenToUse: 'For docs work' },
      { agentId: 'a2', handle: 'releases', displayName: 'Releases', whenToUse: 'For releases' },
    ]

    it('opens mention menu when typing @', async () => {
      renderMessageInput({ projectAgents })
      await flush()

      typeInTextarea('@')
      await flush()

      expect(container.textContent).toContain('@docs')
      expect(container.textContent).toContain('@releases')
    })

    it('filters mentions by typed text', async () => {
      renderMessageInput({ projectAgents })
      await flush()

      typeInTextarea('@doc')
      await flush()

      expect(container.textContent).toContain('@docs')
      expect(container.textContent).not.toContain('@releases')
    })

    it('shows no matching agents message', async () => {
      renderMessageInput({ projectAgents })
      await flush()

      typeInTextarea('@zzz')
      await flush()

      expect(container.textContent).toContain('No matching project agents')
    })

    it('shows synthetic @Codex target at leading position on Builder surface', async () => {
      renderMessageInput({ enableCodexMention: true })
      await flush()

      typeInTextarea('@')
      await flush()

      expect(container.textContent).toContain('@Codex')
      expect(container.textContent).toContain('Codex app-server')
    })

    it('hides synthetic @Codex target when mention is not leading', async () => {
      renderMessageInput({ enableCodexMention: true, projectAgents })
      await flush()

      typeInTextarea('please @d')
      await flush()

      expect(container.textContent).not.toContain('@Codex')
      expect(container.textContent).toContain('@docs')
    })

    it('shows @Codex while typing an inline codex prefix', async () => {
      renderMessageInput({ enableCodexMention: true, projectAgents })
      await flush()

      typeInTextarea('Test one two three @C')
      await flush()

      expect(container.textContent).toContain('@Codex')
      expect(container.textContent).not.toContain('No matching mentions')
    })

    it('opens Codex plugin picker after [@Codex] chip when user types -', async () => {
      fetchCodexCatalogMock.mockResolvedValue({
        status: 'ok',
        snapshot: {
          apps: [],
          plugins: [
            {
              selector: 'repo-prompt',
              displayName: 'RepoPrompt',
              description: 'Repository browser tools',
            },
          ],
          tools: [
            {
              selector: 'RepoPrompt/get_code_structure',
              serverName: 'RepoPrompt',
              toolName: 'get_code_structure',
            },
          ],
          fetchedAt: '2026-01-01T00:00:00.000Z',
        },
      })

      renderMessageInput({ enableCodexMention: true, managerAgentId: 'manager-1' })
      await flush()

      typeInTextarea('[@Codex] -repo')
      await flush()
      await flush()

      expect(container.textContent).toContain('RepoPrompt')
      expect(container.textContent).not.toContain('get_code_structure')
      expect(container.textContent).not.toContain('No matching mentions')
    })

    it('moves through Codex plugin suggestions with arrow keys and selects the active option', async () => {
      fetchCodexCatalogMock.mockResolvedValue({
        status: 'ok',
        snapshot: {
          apps: [],
          plugins: [
            { selector: 'fireflies', displayName: 'Fireflies', description: 'Meeting notes' },
            { selector: 'repo-prompt', displayName: 'RepoPrompt', description: 'Repository browser tools' },
            { selector: 'linear', displayName: 'Linear', description: 'Issue tracker' },
          ],
          tools: [],
          fetchedAt: '2026-01-01T00:00:00.000Z',
        },
      })

      renderMessageInput({ enableCodexMention: true, managerAgentId: 'manager-plugins-keyboard' })
      await flush()

      typeInTextarea('@Codex -')
      await flush()
      await flush()

      const textarea = getTextarea()
      const options = Array.from(container.querySelectorAll('[role="option"]'))
      expect(options).toHaveLength(3)
      expect(options[0].getAttribute('aria-selected')).toBe('true')
      expect(textarea.getAttribute('aria-activedescendant')).toBe(options[0].id)

      flushSync(() => {
        fireEvent.keyDown(textarea, { key: 'ArrowDown' })
      })
      await flush()

      expect(options[1].getAttribute('aria-selected')).toBe('true')
      expect(textarea.getAttribute('aria-activedescendant')).toBe(options[1].id)

      flushSync(() => {
        fireEvent.keyDown(textarea, { key: 'ArrowUp' })
      })
      await flush()

      expect(options[0].getAttribute('aria-selected')).toBe('true')
      expect(textarea.getAttribute('aria-activedescendant')).toBe(options[0].id)

      flushSync(() => {
        fireEvent.keyDown(textarea, { key: 'ArrowDown' })
      })
      await flush()

      flushSync(() => {
        fireEvent.keyDown(textarea, { key: 'Enter' })
      })
      await flush()

      expect(getTextarea().value).toBe('[@Codex:repo-prompt]')
    })

    it('does not open an empty mention popup for inline @ when only Codex mention is enabled', async () => {
      renderMessageInput({ enableCodexMention: true })
      await flush()

      typeInTextarea('please @')
      await flush()

      expect(container.textContent).not.toContain('@Codex')
      expect(container.textContent).not.toContain('No matching mentions')
    })

    it('does not treat email addresses as mention triggers', async () => {
      renderMessageInput({ enableCodexMention: true })
      await flush()

      typeInTextarea('email me at adam@example.com')
      await flush()

      expect(container.textContent).not.toContain('@Codex')
      expect(container.textContent).not.toContain('No matching mentions')
    })

    it('inserts [@Codex] token when Codex mention is selected', async () => {
      renderMessageInput({ enableCodexMention: true })
      await flush()

      typeInTextarea('@cod')
      await flush()

      const codexButton = Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('@Codex'),
      )
      expect(codexButton).toBeTruthy()
      flushSync(() => {
        fireEvent.mouseDown(codexButton!)
      })
      await flush()

      expect(getTextarea().value).toBe('[@Codex]')
    })

    it('inserts leading @Codex -plugin shorthand from the plugin picker at message start', async () => {
      fetchCodexCatalogMock.mockResolvedValue({
        status: 'ok',
        snapshot: {
          apps: [],
          plugins: [
            {
              selector: 'fireflies',
              displayName: 'Fireflies',
              description: 'Meeting notes',
            },
          ],
          tools: [
            {
              selector: 'fireflies/list',
              serverName: 'fireflies',
              toolName: 'list',
            },
          ],
          fetchedAt: '2026-01-01T00:00:00.000Z',
        },
      })

      renderMessageInput({ enableCodexMention: true, managerAgentId: 'manager-1' })
      await flush()

      typeInTextarea('@Codex -fire')
      await flush()
      await flush()

      const pluginButton = Array.from(container.querySelectorAll('[role="option"]')).find((button) =>
        button.textContent?.includes('Fireflies'),
      )
      expect(pluginButton).toBeTruthy()
      expect(container.textContent).not.toContain('fireflies/list')
      flushSync(() => {
        fireEvent.mouseDown(pluginButton!)
      })
      await flush()

      expect(getTextarea().value).toBe('[@Codex:fireflies]')
    })

    it('opens plugin picker for @Codex: colon trigger', async () => {
      fetchCodexCatalogMock.mockResolvedValue({
        status: 'ok',
        snapshot: {
          apps: [],
          plugins: [{ selector: 'fireflies', displayName: 'Fireflies' }],
          tools: [{ selector: 'fireflies/list', serverName: 'fireflies', toolName: 'list' }],
          fetchedAt: '2026-01-01T00:00:00.000Z',
        },
      })

      renderMessageInput({ enableCodexMention: true, managerAgentId: 'manager-1' })
      await flush()

      typeInTextarea('[@Codex]:fire')
      await flush()
      await flush()

      expect(container.textContent).toContain('Fireflies')
      expect(container.textContent).not.toContain('fireflies/list')
    })

    it('inserts inline [@Codex:plugin] from the plugin picker mid-message', async () => {
      fetchCodexCatalogMock.mockResolvedValue({
        status: 'ok',
        snapshot: {
          apps: [],
          plugins: [{ selector: 'fireflies', displayName: 'Fireflies' }],
          tools: [{ selector: 'fireflies/list', serverName: 'fireflies', toolName: 'list' }],
          fetchedAt: '2026-01-01T00:00:00.000Z',
        },
      })

      renderMessageInput({ enableCodexMention: true, managerAgentId: 'manager-1' })
      await flush()

      typeInTextarea('please @Codex -fire')
      await flush()
      await flush()

      const pluginButton = Array.from(container.querySelectorAll('[role="option"]')).find((button) =>
        button.textContent?.includes('Fireflies'),
      )
      expect(pluginButton).toBeTruthy()
      flushSync(() => {
        fireEvent.mouseDown(pluginButton!)
      })
      await flush()

      expect(getTextarea().value).toBe('please [@Codex:fireflies]')
    })

    it('uses preloaded catalog immediately when cache is warm and refreshes on picker open', async () => {
      fetchCodexCatalogMock
        .mockResolvedValueOnce({
          status: 'ok',
          snapshot: {
            apps: [],
            plugins: [{ selector: 'fireflies', displayName: 'Fireflies' }],
            tools: [],
            fetchedAt: '2026-01-01T00:00:00.000Z',
          },
        })
        .mockResolvedValueOnce({
          status: 'ok',
          snapshot: {
            apps: [],
            plugins: [{ selector: 'fireflies', displayName: 'Fireflies refreshed' }],
            tools: [],
            fetchedAt: '2026-01-01T00:00:01.000Z',
          },
        })

      renderMessageInput({ enableCodexMention: true, managerAgentId: 'manager-1' })
      await flush()
      await flush()

      typeInTextarea('@Codex -fire')
      await flush()

      expect(container.textContent).toContain('Fireflies')
      expect(container.textContent).not.toContain('Loading Codex plugins')
      expect(fetchCodexCatalogMock).toHaveBeenCalledTimes(2)

      await flush()
      expect(container.textContent).toContain('Fireflies refreshed')
    })

    it('keeps a known-good plugin catalog visible when picker refresh fails', async () => {
      fetchCodexCatalogMock
        .mockResolvedValueOnce({
          status: 'ok',
          snapshot: {
            apps: [],
            plugins: [{ selector: 'fireflies', displayName: 'Fireflies' }],
            tools: [],
            fetchedAt: '2026-01-01T00:00:00.000Z',
          },
        })
        .mockResolvedValueOnce({ status: 'error' })

      renderMessageInput({ enableCodexMention: true, managerAgentId: 'manager-refresh-error' })
      await flush()
      await flush()

      typeInTextarea('@Codex -fire')
      await flush()
      await flush()

      expect(container.textContent).toContain('Fireflies')
      expect(container.textContent).not.toContain('Could not load Codex plugins')
      expect(container.textContent).not.toContain('No Codex plugins available')
    })

    it('shows loading state while Codex plugin catalog is fetching', async () => {
      fetchCodexCatalogMock.mockReturnValue(new Promise(() => {}))

      renderMessageInput({ enableCodexMention: true, managerAgentId: 'manager-loading' })
      await flush()

      typeInTextarea('@Codex -fire')
      await flush()

      expect(container.textContent).toContain('Loading Codex plugins')
      expect(container.textContent).not.toContain('No matching mentions')
    })

    it('shows catalog failure state instead of empty-filter copy', async () => {
      fetchCodexCatalogMock.mockResolvedValue({ status: 'error' })

      renderMessageInput({ enableCodexMention: true, managerAgentId: 'manager-catalog-error' })
      await flush()

      typeInTextarea('@Codex -fire')
      await flush()
      await flush()

      expect(container.textContent).toContain('Could not load Codex plugins')
      expect(container.textContent).not.toContain('No matching mentions')
    })

    it('shows actionable Codex config guidance when catalog refresh reports config failure', async () => {
      fetchCodexCatalogMock.mockResolvedValue({
        status: 'error',
        error:
          'Codex MCP catalog discovery failed for plugin/list: failed to reload config: /Users/example/.codex/config.toml:10:16: unknown variant `priority`, expected `fast` or `flex`',
      })

      renderMessageInput({ enableCodexMention: true, managerAgentId: 'manager-catalog-config-error' })
      await flush()

      typeInTextarea('@Codex -fire')
      await flush()
      await flush()

      expect(container.textContent).toContain('Codex rejected ~/.codex/config.toml')
      expect(container.textContent).not.toContain('/Users/example')
    })

    it('does not quick-send while Codex tool picker is loading', async () => {
      fetchCodexCatalogMock.mockReturnValue(new Promise(() => {}))
      const onSend = vi.fn()

      renderMessageInput({ enableCodexMention: true, managerAgentId: 'manager-quick-send', onSend })
      await flush()

      typeInTextarea('@Codex -fire')
      await flush()

      flushSync(() => {
        fireEvent.keyDown(getTextarea(), { key: 'Enter' })
      })
      await flush()

      expect(onSend).not.toHaveBeenCalled()
      expect(getTextarea().value).toBe('@Codex -fire')
    })

    it('exposes combobox/listbox ARIA while mention menu is open', async () => {
      renderMessageInput({ enableCodexMention: true })
      await flush()

      typeInTextarea('@cod')
      await flush()

      const textarea = getTextarea()
      expect(textarea.getAttribute('aria-expanded')).toBe('true')
      expect(textarea.getAttribute('aria-controls')).toBeTruthy()
      expect(container.querySelector('[role="listbox"]')).toBeTruthy()
    })
  })
})
