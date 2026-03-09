export function resolveApiEndpoint(wsUrl: string | undefined, path: string): string {
  if (!wsUrl) {
    return path
  }

  try {
    const parsed = new URL(wsUrl)
    parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
    // Use URL constructor to properly parse path + query string,
    // instead of assigning to pathname (which encodes `?` into `%3F`).
    const resolved = new URL(path, parsed.origin)
    return resolved.toString()
  } catch {
    return path
  }
}
