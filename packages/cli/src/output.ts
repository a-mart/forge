import type { Writable } from 'node:stream'

import { EXIT_CODES, type ExitCode } from './version.js'

export interface CliIo {
  stdout: Writable
  stderr: Writable
}

export interface OutputOptions {
  json?: boolean
  quiet?: boolean
}

export class CliError extends Error {
  readonly exitCode: ExitCode
  readonly code: string
  readonly details?: unknown

  constructor(message: string, options?: { exitCode?: ExitCode; code?: string; details?: unknown }) {
    super(message)
    this.name = 'CliError'
    this.exitCode = options?.exitCode ?? EXIT_CODES.usage
    this.code = options?.code ?? 'usage_error'
    this.details = options?.details
  }
}

export function writeJson(io: CliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

export function writeHuman(io: CliIo, options: OutputOptions, text: string): void {
  if (options.quiet || text.length === 0) return
  io.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
}

export function writeWarning(io: CliIo, text: string): void {
  io.stderr.write(text.endsWith('\n') ? text : `${text}\n`)
}

export function renderError(error: unknown, json: boolean): { exitCode: ExitCode; text: string } {
  const cliError = toCliError(error)
  if (json) {
    return {
      exitCode: cliError.exitCode,
      text: `${JSON.stringify({ error: { code: cliError.code, message: cliError.message, details: cliError.details } }, null, 2)}\n`,
    }
  }

  return { exitCode: cliError.exitCode, text: `Error: ${cliError.message}\n` }
}

export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error
  if (error instanceof Error) return new CliError(error.message, { exitCode: EXIT_CODES.connection, code: 'unexpected_error' })
  return new CliError('Unknown error', { exitCode: EXIT_CODES.connection, code: 'unexpected_error' })
}

export interface TableColumn<T> {
  header: string
  value: (record: T) => string | number | boolean | null | undefined
}

export function formatTable<T>(records: T[], columns: TableColumn<T>[]): string {
  if (records.length === 0) return 'No results.'

  const rows = records.map((record) => columns.map((column) => String(column.value(record) ?? '')))
  const headers = columns.map((column) => column.header)
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)))
  const formatRow = (values: string[]) => values.map((value, index) => value.padEnd(widths[index] ?? 0)).join('  ').trimEnd()

  return [formatRow(headers), formatRow(widths.map((width) => '-'.repeat(width))), ...rows.map(formatRow)].join('\n')
}

export function formatObject(record: Record<string, unknown>): string {
  const entries = Object.entries(record).filter(([, value]) => value !== undefined)
  if (entries.length === 0) return 'No details.'
  const width = Math.max(...entries.map(([key]) => key.length))
  return entries.map(([key, value]) => `${key.padEnd(width)}  ${formatScalar(value)}`).join('\n')
}

function formatScalar(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}
