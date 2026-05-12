export const CLI_VERSION = '0.9.0'
export const CLI_PROTOCOL_VERSION = 1

export const EXIT_CODES = {
  success: 0,
  blocked: 10,
  timeout: 11,
  agentFailure: 12,
  canceled: 13,
  usage: 20,
  auth: 21,
  connection: 22,
  unsupported: 23,
} as const

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES]
