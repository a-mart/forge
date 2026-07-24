import type { Platform } from './platform.js'

export class LaunchArgumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LaunchArgumentError'
  }
}

const WINDOWS_PARENT_WINDOW = /^--parent-window=(0|[1-9][0-9]*)$/u

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
