import type { ForgeClientLike } from '../forge-client.js'
import type { CliIo, OutputOptions } from '../output.js'

export interface ParsedArgs {
  positionals: string[]
  options: OutputOptions & {
    url?: string
    apiKey?: string
    profile?: string
    session?: string
    projectAgent?: string
    message?: string
    label?: string
    name?: string
    timeout?: string
    fromMessageId?: string
    answers?: string
    pinned?: string
    yes?: boolean
    stopOnTimeout?: boolean
    help?: boolean
    version?: boolean
  }
}

export interface CommandContext {
  args: ParsedArgs
  io: CliIo
  cwd: string
  env: NodeJS.ProcessEnv
  createClient: () => Promise<ForgeClientLike>
}
