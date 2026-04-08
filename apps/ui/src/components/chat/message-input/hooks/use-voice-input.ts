import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MAX_VOICE_RECORDING_DURATION_MS, useVoiceRecorder } from '@/hooks/use-voice-recorder'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import { transcribeVoice } from '@/lib/voice-transcription-client'
import { OPENAI_KEY_REQUIRED_MESSAGE } from '../types'

async function hasConfiguredOpenAiKey(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(endpoint)
    if (!response.ok) return false

    const payload = (await response.json()) as {
      providers?: Array<{
        provider?: unknown
        configured?: unknown
      }>
    }

    if (!payload || !Array.isArray(payload.providers)) return false

    return payload.providers.some((provider) => {
      if (!provider || typeof provider !== 'object') return false
      const providerId =
        typeof provider.provider === 'string' ? provider.provider.trim().toLowerCase() : ''
      const configured = provider.configured === true
      return configured && providerId === 'openai-codex'
    })
  } catch {
    return false
  }
}

interface UseVoiceInputOptions {
  wsUrl?: string
  disabled: boolean
  blockedByLoading: boolean
  /** Called with transcribed text to append to the input. Return true if text was appended. */
  onTranscription: (text: string) => boolean
}

interface UseVoiceInputReturn {
  isRecording: boolean
  isRequestingMicrophone: boolean
  isTranscribingVoice: boolean
  voiceError: string | null
  voiceRecordingDurationMs: number
  recordingWaveformBars: number[]
  voiceButtonDisabled: boolean
  handleVoiceButtonClick: () => void
  stopAndTranscribeRecording: () => Promise<void>
}

export function useVoiceInput({
  wsUrl,
  disabled,
  blockedByLoading,
  onTranscription,
}: UseVoiceInputOptions): UseVoiceInputReturn {
  const [isTranscribingVoice, setIsTranscribingVoice] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)

  const {
    isRecording,
    isRequestingPermission: isRequestingMicrophone,
    durationMs: voiceRecordingDurationMs,
    waveformBars: recordingWaveformBars,
    startRecording,
    stopRecording,
  } = useVoiceRecorder()

  const transcribeEndpoint = useMemo(() => resolveApiEndpoint(wsUrl, '/api/transcribe'), [wsUrl])
  const settingsAuthEndpoint = useMemo(
    () => resolveApiEndpoint(wsUrl, '/api/settings/auth'),
    [wsUrl],
  )

  // Keep a stable ref to onTranscription to avoid re-creating callbacks
  const onTranscriptionRef = useRef(onTranscription)
  onTranscriptionRef.current = onTranscription

  const stopAndTranscribeRecording = useCallback(async () => {
    const recording = await stopRecording()
    if (!recording) {
      setVoiceError('Recording failed. Could not capture audio. Please try again.')
      return
    }

    setIsTranscribingVoice(true)
    setVoiceError(null)

    try {
      const result = await transcribeVoice(recording.blob, transcribeEndpoint)
      const appended = onTranscriptionRef.current(result.text)
      if (!appended) {
        setVoiceError('No speech detected. Try speaking a little louder.')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Voice transcription failed.'
      setVoiceError(message)
    } finally {
      setIsTranscribingVoice(false)
    }
  }, [stopRecording, transcribeEndpoint])

  useEffect(() => {
    if (!isRecording || isTranscribingVoice) return
    if (voiceRecordingDurationMs < MAX_VOICE_RECORDING_DURATION_MS) return
    void stopAndTranscribeRecording()
  }, [isRecording, isTranscribingVoice, stopAndTranscribeRecording, voiceRecordingDurationMs])

  const startInlineRecording = useCallback(async () => {
    const hasOpenAiKey = await hasConfiguredOpenAiKey(settingsAuthEndpoint)
    if (!hasOpenAiKey) {
      setVoiceError(OPENAI_KEY_REQUIRED_MESSAGE)
      return
    }

    try {
      await startRecording()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not access your microphone.'
      setVoiceError(message)
    }
  }, [settingsAuthEndpoint, startRecording])

  const handleVoiceButtonClick = useCallback(() => {
    if (disabled || blockedByLoading || isRequestingMicrophone || isTranscribingVoice) return

    setVoiceError(null)

    if (isRecording) {
      void stopAndTranscribeRecording()
      return
    }

    void startInlineRecording()
  }, [
    blockedByLoading,
    disabled,
    isRecording,
    isRequestingMicrophone,
    isTranscribingVoice,
    startInlineRecording,
    stopAndTranscribeRecording,
  ])

  const voiceButtonDisabled =
    disabled || blockedByLoading || isRequestingMicrophone || isTranscribingVoice

  return {
    isRecording,
    isRequestingMicrophone,
    isTranscribingVoice,
    voiceError,
    voiceRecordingDurationMs,
    recordingWaveformBars,
    voiceButtonDisabled,
    handleVoiceButtonClick,
    stopAndTranscribeRecording,
  }
}
