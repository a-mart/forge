const FORGE_PROTOCOL = 'forge:'
const SKILL_IMPORT_HOST = 'skill-import'

export function findSkillImportUrlInArgs(args: readonly string[]): string | null {
  for (const arg of args) {
    const skillImportUrl = parseSkillImportDeepLink(arg)
    if (skillImportUrl) {
      return skillImportUrl
    }
  }
  return null
}

export function parseSkillImportDeepLink(rawUrl: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }

  if (parsed.protocol !== FORGE_PROTOCOL || parsed.hostname !== SKILL_IMPORT_HOST) {
    return null
  }

  const embeddedUrl = parsed.searchParams.get('url')
  if (!embeddedUrl) {
    return null
  }

  let shareUrl: URL
  try {
    shareUrl = new URL(embeddedUrl)
  } catch {
    return null
  }

  if (!isAllowedShareProtocol(shareUrl)) {
    return null
  }

  shareUrl.hash = ''
  return shareUrl.toString()
}

export function buildSkillImportRouteUrl(rendererBaseUrl: string, skillImportUrl: string): string {
  const target = new URL(rendererBaseUrl)
  target.searchParams.set('view', 'settings')
  target.searchParams.set('settingsTab', 'skills')
  target.searchParams.set('skillImportUrl', skillImportUrl)
  return target.toString()
}

export function shouldRegisterExternalDeepLinkProtocol(options: {
  isPackaged: boolean
  env?: NodeJS.ProcessEnv
}): boolean {
  if (options.isPackaged) {
    return true
  }

  return options.env?.FORGE_REGISTER_DEV_PROTOCOL === '1'
}

function isAllowedShareProtocol(url: URL): boolean {
  if (url.protocol === 'https:') {
    return true
  }
  return url.protocol === 'http:' && (
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '::1' ||
    url.hostname === '[::1]'
  )
}
