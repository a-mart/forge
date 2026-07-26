/*
 * Profile partition and permission behavior is adapted from T3 Code's
 * apps/desktop/src/preview/BrowserSession.ts at 9a0a0716 (MIT).
 */
import { createHash } from 'node:crypto'
import type { Session } from 'electron'
import { session } from 'electron'

export const BROWSER_PARTITION_PREFIX = 'persist:forge-browser-'
export const ALLOWED_BROWSER_PERMISSIONS: ReadonlySet<string> = new Set([
  'clipboard-read',
  'clipboard-sanitized-write',
  'notifications',
  'geolocation',
])

export function browserPartitionForProfile(profileId: string): string {
  if (profileId.trim().length === 0 || profileId.length > 256) {
    throw new Error('Browser profile ID must be a non-empty string of at most 256 characters')
  }
  const digest = createHash('sha256').update(profileId, 'utf8').digest('hex')
  return `${BROWSER_PARTITION_PREFIX}${digest.slice(0, 20)}`
}

export function isBrowserPartition(partition: string): boolean {
  return partition.startsWith(BROWSER_PARTITION_PREFIX) && partition.length === BROWSER_PARTITION_PREFIX.length + 20
}

export function sanitizeBrowserUserAgent(userAgent: string): string {
  return userAgent
    .replace(/\sElectron\/[\d.]+/gi, '')
    .replace(/\s(?:Forge|forge-desktop)\/[\w.-]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export class BrowserSessionRegistry {
  private readonly sessions = new Map<string, Session>()

  getPartition(profileId: string): string {
    return browserPartitionForProfile(profileId)
  }

  isPartition(partition: string): boolean {
    return isBrowserPartition(partition)
  }

  getSession(profileId: string): Session {
    const partition = this.getPartition(profileId)
    const existing = this.sessions.get(partition)
    if (existing) return existing

    const browserSession = session.fromPartition(partition)
    browserSession.setUserAgent(sanitizeBrowserUserAgent(browserSession.getUserAgent()))
    browserSession.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(ALLOWED_BROWSER_PERMISSIONS.has(permission))
    })
    browserSession.setPermissionCheckHandler((_contents, permission) => ALLOWED_BROWSER_PERMISSIONS.has(permission))
    this.sessions.set(partition, browserSession)
    return browserSession
  }

  async clear(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].map(async (browserSession) => {
        await browserSession.clearStorageData({
          storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers'],
        })
        await browserSession.clearCache()
      }),
    )
  }
}
