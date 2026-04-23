/** @vitest-environment jsdom */

import { fireEvent, getByLabelText } from '@testing-library/dom'
import { createElement, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageInput, type MessageInputHandle, type ProjectAgentSuggestion } from './MessageInput'
import type { SlashCommand } from '@/components/settings/slash-commands-api'
import type { ConversationAttachment } from '@forge/protocol'

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
  localStorageMock.clear()
  voiceInputMockState.transcribedText = null
  vi.clearAllMocks()
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  container.remove()
})

async function flush(): Promise<void> {
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  await Promise.resolve()
  flushSync(() => {})
}

function renderMessageInput(
  overrides: Partial<{
    onSend: (msg: string, attachments?: ConversationAttachment[]) => void | boolean | Promise<boolean>
    isLoading: boolean
    disabled: boolean
    agentId: string
    draftKey: string
    slashCommands: SlashCommand[]
    projectAgents: ProjectAgentSuggestion[]
    wsUrl: string
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
  })
})
