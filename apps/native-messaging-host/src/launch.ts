import { realpathSync } from 'node:fs'
import path from 'node:path'
import type { Platform } from './platform.js'

export class LaunchArgumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LaunchArgumentError'
  }
}

const WINDOWS_PARENT_WINDOW = /^--parent-window=(0|[1-9][0-9]*)$/u

export function resolveNativeHostExecutable(
  argv: readonly string[],
  sea: boolean,
  processExecutable: string,
): string {
  if (sea) return processExecutable
  const script = argv[1]
  if (!script) throw new LaunchArgumentError('native host executable path is unavailable')
  return path.resolve(script)
}

export function normalizeNativeHostLaunchArguments(
  argv: readonly string[],
  sea: boolean,
  executablePath: string,
): string[] {
  if (!sea) return argv.slice(2)

  const launchArguments = argv.slice(1)
  // Node 25 --build-sea inserts the configured output executable at argv[1].
  // Remove it only when it resolves back to this process; every other value
  // remains subject to the exact pinned-origin launch validation below.
  if (launchArguments[0] && pathsReferToSameFile(launchArguments[0], executablePath)) {
    return launchArguments.slice(1)
  }
  return launchArguments
}

export function validateChromeLaunchArguments(
  args: readonly string[],
  expectedOrigin: string,
  platform: Platform,
): void {
  if (args[0] !== expectedOrigin) throw new LaunchArgumentError('native host origin does not match the pinned extension')
  if (platform === 'win32') {
    if (args.length !== 2 || !WINDOWS_PARENT_WINDOW.test(args[1] ?? '')) {
      throw new LaunchArgumentError('Windows native host launch must include only Chrome parent-window metadata')
    }
    return
  }
  if (args.length !== 1) throw new LaunchArgumentError('native host launch contains unexpected arguments')
}

function pathsReferToSameFile(candidate: string, executable: string): boolean {
  try {
    const candidatePath = realpathSync.native(path.resolve(candidate))
    const executablePath = realpathSync.native(path.resolve(executable))
    return process.platform === 'win32'
      ? candidatePath.toLowerCase() === executablePath.toLowerCase()
      : candidatePath === executablePath
  } catch {
    return false
  }
}
