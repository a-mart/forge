import type {
  InitialModelInputJsonValue,
  PiInitialModelInputCaptureV1,
} from '@forge/protocol'

export const TOKEN_ESTIMATE_CHARACTERS_PER_TOKEN = 4

export interface InitialModelInputTokenEstimates {
  total: number
  systemPrompt: number
  messages: number
  tools: number
}

/**
 * Provider-independent approximation matching Forge's established prompt-budget
 * heuristic. Provider framing and model-specific tokenization can differ.
 */
export function estimateTextTokens(value: string): number {
  const trimmed = value.trim()
  return trimmed ? Math.ceil(trimmed.length / TOKEN_ESTIMATE_CHARACTERS_PER_TOKEN) : 0
}

export function estimateJsonTokens(value: InitialModelInputJsonValue): number {
  return estimateTextTokens(JSON.stringify(value))
}

export function estimateInitialModelInputTokens(
  capture: Pick<PiInitialModelInputCaptureV1, 'systemPrompt' | 'messages' | 'tools'>,
): InitialModelInputTokenEstimates {
  const systemPrompt = estimateTextTokens(capture.systemPrompt)
  const messages = capture.messages.length > 0 ? estimateJsonTokens(capture.messages) : 0
  const tools = capture.tools.length > 0 ? estimateJsonTokens(capture.tools) : 0

  return {
    total: systemPrompt + messages + tools,
    systemPrompt,
    messages,
    tools,
  }
}
