import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { isChoiceAnswer, type ChoiceAnswer } from '@forge/protocol/choices'

import { CliError } from '../output.js'
import { EXIT_CODES } from '../version.js'

export async function readMessageInput(value: string | undefined, cwd: string): Promise<string> {
  if (!value || value.trim().length === 0) {
    throw usage('Missing required --message <text|@file>.')
  }

  if (!value.startsWith('@')) return value
  const filePath = value.slice(1)
  if (!filePath) throw usage('Message file path after @ is required.')
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath)
  try {
    return await readFile(resolved, 'utf8')
  } catch (error) {
    throw new CliError(`Could not read message file ${resolved}: ${errorMessage(error)}`, {
      exitCode: EXIT_CODES.usage,
      code: 'message_file_read_failed',
    })
  }
}

export function parseAnswersJson(value: string | undefined): ChoiceAnswer[] {
  if (!value) throw usage('Missing required --answers <json>.')
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new CliError(`Invalid --answers JSON: ${errorMessage(error)}`, {
      exitCode: EXIT_CODES.usage,
      code: 'invalid_answers_json',
    })
  }
  if (!Array.isArray(parsed) || !parsed.every(isChoiceAnswer)) {
    throw new CliError('--answers must be a JSON array of choice answers.', {
      exitCode: EXIT_CODES.usage,
      code: 'invalid_answers',
    })
  }
  return parsed
}

export function parseTimeoutMs(value: string | undefined): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  const match = /^(\d+)(ms|s|m)?$/.exec(trimmed)
  if (!match) throw usage('Timeout must be an integer duration like 5000, 5000ms, 30s, or 5m.')
  const amount = Number(match[1])
  const unit = match[2] ?? 'ms'
  if (!Number.isSafeInteger(amount) || amount <= 0) throw usage('Timeout must be a positive integer duration.')
  if (unit === 'm') return amount * 60_000
  if (unit === 's') return amount * 1000
  return amount
}

export function parsePinned(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw usage('--pinned must be true or false.')
}

function usage(message: string): CliError {
  return new CliError(message, { exitCode: EXIT_CODES.usage, code: 'usage_error' })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
