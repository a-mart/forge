import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import mime from 'mime'
import type { RuntimeTarget } from '../../../runtime-target.js'
import { applyCorsHeaders, sendJson } from '../../http-utils.js'
import type { HttpRoute } from '../shared/http-route.js'

const STATIC_UI_METHODS = 'GET, HEAD, OPTIONS'
const STATIC_UI_CANDIDATE_DIR_SEGMENTS = ['apps', 'ui', '.output', 'public'] as const
const STATIC_UI_SHELL_CANDIDATES = ['index.html', '_shell.html'] as const

export function createStaticUiRoutes(options: {
  rootDir: string
  resourcesDir?: string
  runtimeTarget: RuntimeTarget
  nodeEnv?: string
}): HttpRoute[] {
  if (!shouldEnableStaticUi(options.runtimeTarget, options.nodeEnv)) {
    return []
  }

  const staticRoot = resolveStaticUiRoot(options.rootDir, options.resourcesDir)
  if (!staticRoot) {
    return []
  }

  const shellPath = resolveStaticUiShellPath(staticRoot)
  if (!shellPath) {
    return []
  }

  return [
    {
      methods: STATIC_UI_METHODS,
      matches: (pathname) => !pathname.startsWith('/api/'),
      handle: async (request, response, requestUrl) => {
        await handleStaticUiRequest(request, response, requestUrl, staticRoot, shellPath)
      },
    },
  ]
}

function shouldEnableStaticUi(runtimeTarget: RuntimeTarget, nodeEnv: string | undefined): boolean {
  return runtimeTarget === 'collaboration-server' || nodeEnv === 'production'
}

function resolveStaticUiRoot(rootDir: string, resourcesDir?: string): string | null {
  const candidateBases = new Set<string>([
    ...(resourcesDir ? [resolve(resourcesDir)] : []),
    resolve(rootDir),
    resolve(process.cwd()),
  ])

  for (const candidateBase of candidateBases) {
    const candidateRoot = resolve(candidateBase, ...STATIC_UI_CANDIDATE_DIR_SEGMENTS)
    if (existsSync(candidateRoot)) {
      return candidateRoot
    }
  }

  return null
}

function resolveStaticUiShellPath(staticRoot: string): string | null {
  for (const candidate of STATIC_UI_SHELL_CANDIDATES) {
    const shellPath = resolve(staticRoot, candidate)
    if (existsSync(shellPath)) {
      return shellPath
    }
  }

  return null
}

async function handleStaticUiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  staticRoot: string,
  shellPath: string,
): Promise<void> {
  applyCorsHeaders(request, response, STATIC_UI_METHODS)

  if (request.method === 'OPTIONS') {
    response.statusCode = 204
    response.end()
    return
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', STATIC_UI_METHODS)
    sendJson(response, 405, { error: 'Method Not Allowed' })
    return
  }

  const target = resolveStaticUiResponseTarget(requestUrl.pathname, staticRoot, shellPath)
  if (target.kind === 'invalid_path') {
    sendJson(response, 400, { error: 'Invalid path' })
    return
  }

  if (target.kind === 'forbidden') {
    sendJson(response, 403, { error: 'Forbidden' })
    return
  }

  try {
    const fileStats = await stat(target.filePath)
    if (!fileStats.isFile()) {
      sendJson(response, 404, { error: 'Not Found' })
      return
    }

    const content = await readFile(target.filePath)
    response.statusCode = 200
    response.setHeader('Cache-Control', target.kind === 'shell' ? 'no-store' : 'public, max-age=31536000, immutable')
    response.setHeader('Content-Type', resolveStaticUiContentType(target.filePath))
    response.setHeader('Content-Length', String(content.byteLength))
    response.setHeader('X-Content-Type-Options', 'nosniff')

    if (request.method === 'HEAD') {
      response.end()
      return
    }

    response.end(content)
  } catch {
    sendJson(response, 404, { error: 'Not Found' })
  }
}

type StaticUiResponseTarget =
  | { kind: 'shell'; filePath: string }
  | { kind: 'asset'; filePath: string }
  | { kind: 'invalid_path' }
  | { kind: 'forbidden' }

function resolveStaticUiResponseTarget(
  pathname: string,
  staticRoot: string,
  shellPath: string,
): StaticUiResponseTarget {
  if (pathname === '/' || pathname.length === 0) {
    return { kind: 'shell', filePath: shellPath }
  }

  let decodedPathname: string
  try {
    decodedPathname = decodeURIComponent(pathname)
  } catch {
    return { kind: 'invalid_path' }
  }

  const relativePath = decodedPathname.replace(/^\/+/, '').trim()
  if (!relativePath) {
    return { kind: 'shell', filePath: shellPath }
  }

  if (!extname(relativePath)) {
    return { kind: 'shell', filePath: shellPath }
  }

  const assetPath = resolveStaticUiAssetPath(staticRoot, relativePath)
  if (!assetPath) {
    return { kind: 'forbidden' }
  }

  return { kind: 'asset', filePath: assetPath }
}

export function resolveStaticUiAssetPath(staticRoot: string, requestedPath: string): string | null {
  const normalizedPath = requestedPath.trim()
  if (!normalizedPath || normalizedPath.includes('\0')) {
    return null
  }

  const resolvedPath = resolve(staticRoot, normalizedPath)
  const relativeToRoot = relative(staticRoot, resolvedPath)

  if (!relativeToRoot || relativeToRoot === '.') {
    return null
  }

  if (relativeToRoot.startsWith('..') || isAbsolute(relativeToRoot)) {
    return null
  }

  return resolvedPath
}

function resolveStaticUiContentType(pathValue: string): string {
  const mimeType = mime.getType(pathValue) ?? 'application/octet-stream'
  if (
    mimeType.startsWith('text/') ||
    mimeType === 'application/javascript' ||
    mimeType === 'application/json' ||
    mimeType === 'image/svg+xml'
  ) {
    return `${mimeType}; charset=utf-8`
  }

  return mimeType
}
