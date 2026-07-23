export type ManagedBrowserShortcutInput = {
  type: string
  key: string
  alt?: boolean
  control?: boolean
  meta?: boolean
  shift?: boolean
}

const SUPPORTED_DESKTOP_PLATFORMS = new Set<NodeJS.Platform>(['darwin', 'win32', 'linux'])

export function isManagedBrowserPopoutAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return SUPPORTED_DESKTOP_PLATFORMS.has(platform)
}

export function isDockManagedBrowserShortcut(
  input: ManagedBrowserShortcutInput,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!isManagedBrowserPopoutAvailable(platform)
    || input.type !== 'keyDown'
    || input.key.toLowerCase() !== 'w'
    || input.alt
    || input.shift) return false

  return platform === 'darwin'
    ? input.meta === true && input.control !== true
    : input.control === true && input.meta !== true
}
