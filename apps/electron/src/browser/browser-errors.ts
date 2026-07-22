import type { BrowserAutomationErrorCode, BrowserAutomationFailure } from '@forge/protocol'

export class BrowserHostError extends Error {
  constructor(
    readonly code: BrowserAutomationErrorCode,
    message: string,
    readonly retryable = false,
    readonly details?: Record<string, string | number | boolean | null>,
  ) {
    super(message)
    this.name = 'BrowserHostError'
  }

  toFailure(): BrowserAutomationFailure {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    }
  }
}

export function asBrowserHostError(error: unknown, fallbackMessage: string): BrowserHostError {
  if (error instanceof BrowserHostError) return error
  return new BrowserHostError(
    'execution-failed',
    error instanceof Error && error.message.length > 0 ? error.message : fallbackMessage,
  )
}
