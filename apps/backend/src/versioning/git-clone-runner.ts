import { spawn, type ChildProcess } from 'node:child_process'
import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { RepositoryProjectCreationErrorCode } from '@forge/protocol'
import { validateSingleFolderName, DirectoryValidationError } from '../swarm/cwd-policy.js'
import {
  ExclusiveRenameError,
  exclusiveRenameNoClobber,
} from './exclusive-dir-rename.js'

export const GIT_CLONE_TIMEOUT_MS = 15 * 60 * 1000
const STAGING_PREFIX = 'forge-clone-'
const MAX_FOLDER_LENGTH = 200
const MAX_OUTPUT_BUFFER = 64 * 1024
const KILL_GRACE_MS = 250

export type GitCloneErrorCode = RepositoryProjectCreationErrorCode

export class GitCloneError extends Error {
  readonly code: GitCloneErrorCode
  readonly repositoryPath?: string

  constructor(code: GitCloneErrorCode, message: string, options?: { repositoryPath?: string }) {
    super(message)
    this.name = 'GitCloneError'
    this.code = code
    this.repositoryPath = options?.repositoryPath
  }
}

export interface ParsedRepositoryUrl {
  /** Sanitized display form (no userinfo/query/fragment). */
  display: string
  /** Argv-safe URL passed to git (credentials rejected earlier). */
  cloneUrl: string
  /** Suggested folder leaf derived from the URL. */
  suggestedFolder: string
  host: string
}

export interface GitCloneProgress {
  stage: 'cloning'
  percent?: number
}

export interface GitCloneRunnerOptions {
  gitBinary?: string
  timeoutMs?: number
  /** Override spawn for tests. */
  spawnImpl?: typeof spawn
  /** Override platform for process-tree kill tests. */
  platform?: NodeJS.Platform
  /** Injected for deterministic publish race tests. */
  publishImpl?: (cloneTarget: string, destination: string) => Promise<void>
  /** Injected for process-termination tests. */
  terminateImpl?: (child: ChildProcess, platform: NodeJS.Platform) => Promise<void>
}

export interface RunCloneOptions {
  repositoryUrl: string
  basePath: string
  folder: string
  signal?: AbortSignal
  onProgress?: (progress: GitCloneProgress) => void
  /** Optional pre-resolved canonical base (realpath). */
  canonicalBasePath?: string
  /**
   * Called after git succeeds and immediately before irreversible publication.
   * Return false (or throw clone_cancelled) to abort without publishing.
   */
  beforePublish?: () => boolean | Promise<boolean>
}

export interface RunCloneResult {
  repositoryPath: string
  stagingPath: string
}

export function parseAndValidateRepositoryUrl(raw: string): ParsedRepositoryUrl {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new GitCloneError('invalid_repository_url', 'Repository URL is required.')
  }

  if (/[\0\r\n]/.test(trimmed) || trimmed.startsWith('-')) {
    throw new GitCloneError('invalid_repository_url', 'Repository URL contains unsupported characters.')
  }

  const lower = trimmed.toLowerCase()
  if (
    lower.startsWith('file:') ||
    lower.startsWith('ext::') ||
    lower.startsWith('git://') ||
    lower.startsWith('http://') ||
    looksLikeLocalPath(trimmed)
  ) {
    throw new GitCloneError(
      'invalid_repository_url',
      'Only HTTPS and SSH repository URLs are supported.',
    )
  }

  // SCP-like: [user@]host:path/repo[.git] — host may be bare IPv6 without brackets in rare forms;
  // require non-URL form without :// and with a single host:path split after optional user@.
  const scpMatch = trimmed.match(/^([^@/\s]+@)?([^:/\s]+):(.+)$/)
  if (scpMatch && !trimmed.includes('://')) {
    const user = scpMatch[1]?.replace(/@$/, '') ?? undefined
    const host = scpMatch[2]!
    const pathPart = scpMatch[3]!
    if (user?.includes(':') || user?.includes('/')) {
      throw new GitCloneError('invalid_repository_url', 'SSH username is invalid.')
    }
    if (!host || !pathPart || pathPart.includes('://')) {
      throw new GitCloneError('invalid_repository_url', 'SSH repository URL is invalid.')
    }
    const leaf = deriveFolderFromPath(pathPart)
    return {
      display: `${user ? `${user}@` : ''}${host}:${sanitizePathForDisplay(pathPart)}`,
      cloneUrl: trimmed,
      suggestedFolder: leaf,
      host,
    }
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new GitCloneError('invalid_repository_url', 'Repository URL is invalid.')
  }

  const protocol = parsed.protocol.toLowerCase()
  if (protocol !== 'https:' && protocol !== 'ssh:') {
    throw new GitCloneError(
      'invalid_repository_url',
      'Only HTTPS and SSH repository URLs are supported.',
    )
  }

  if (parsed.password) {
    throw new GitCloneError(
      'invalid_repository_url',
      'Repository URLs must not include passwords or tokens. Use system Git credentials instead.',
    )
  }

  if (protocol === 'https:' && parsed.username) {
    throw new GitCloneError(
      'invalid_repository_url',
      'HTTPS repository URLs must not include credentials. Use system Git credentials instead.',
    )
  }

  if (!parsed.hostname) {
    throw new GitCloneError('invalid_repository_url', 'Repository URL is missing a host.')
  }

  const pathLeaf = deriveFolderFromPath(parsed.pathname)
  if (!pathLeaf) {
    throw new GitCloneError('invalid_repository_url', 'Repository URL is missing a repository name.')
  }

  const hostForDisplay = formatHostForUrl(parsed)
  const portSuffix = formatPortSuffix(parsed)
  const display = `${protocol}//${hostForDisplay}${portSuffix}${sanitizePathForDisplay(parsed.pathname)}`

  let cloneUrl: string
  if (protocol === 'https:') {
    cloneUrl = `https://${hostForDisplay}${portSuffix}${parsed.pathname}`
  } else {
    const user = parsed.username ? `${encodeURIComponent(parsed.username)}@` : ''
    cloneUrl = `ssh://${user}${hostForDisplay}${portSuffix}${parsed.pathname}`
  }

  return {
    display,
    cloneUrl,
    suggestedFolder: pathLeaf,
    host: parsed.hostname,
  }
}

export function validateRepositoryFolder(folder: string): string {
  try {
    const validated = validateSingleFolderName(folder)
    if (validated.length > MAX_FOLDER_LENGTH) {
      throw new GitCloneError(
        'invalid_repository_folder',
        `Repository folder must be at most ${MAX_FOLDER_LENGTH} characters.`,
      )
    }
    if (/[<>:"|?*\u0000-\u001f]/.test(validated)) {
      throw new GitCloneError(
        'invalid_repository_folder',
        'Repository folder contains unsupported characters.',
      )
    }
    return validated
  } catch (error) {
    if (error instanceof GitCloneError) {
      throw error
    }
    if (error instanceof DirectoryValidationError) {
      throw new GitCloneError('invalid_repository_folder', error.message)
    }
    throw new GitCloneError('invalid_repository_folder', 'Repository folder is invalid.')
  }
}

export class GitCloneRunner {
  private readonly gitBinary: string
  private readonly timeoutMs: number
  private readonly spawnImpl: typeof spawn
  private readonly platform: NodeJS.Platform
  private readonly publishImpl: (cloneTarget: string, destination: string) => Promise<void>
  private readonly terminateImpl: (child: ChildProcess, platform: NodeJS.Platform) => Promise<void>

  constructor(options: GitCloneRunnerOptions = {}) {
    this.gitBinary = options.gitBinary ?? 'git'
    this.timeoutMs = options.timeoutMs ?? GIT_CLONE_TIMEOUT_MS
    this.spawnImpl = options.spawnImpl ?? spawn
    this.platform = options.platform ?? process.platform
    this.publishImpl = options.publishImpl ?? publishCloneWithoutReplace
    this.terminateImpl = options.terminateImpl ?? terminateProcessTree
  }

  async clone(options: RunCloneOptions): Promise<RunCloneResult> {
    const parsed = parseAndValidateRepositoryUrl(options.repositoryUrl)
    const folder = validateRepositoryFolder(options.folder)
    const basePath = options.canonicalBasePath ?? resolve(options.basePath)
    const destination = resolve(basePath, folder)

    if (dirname(destination) !== basePath && !isPathInside(basePath, destination)) {
      throw new GitCloneError('invalid_repository_folder', 'Repository folder escapes the base path.')
    }

    await assertDestinationAbsent(destination)

    let stagingPath: string | undefined
    try {
      stagingPath = await mkdtemp(join(basePath, STAGING_PREFIX))
    } catch (error) {
      throw classifyFsError(error, 'Unable to create clone staging directory.')
    }

    const cloneTarget = join(stagingPath, folder)

    try {
      if (options.signal?.aborted) {
        throw new GitCloneError('clone_cancelled', 'Clone was cancelled.')
      }

      options.onProgress?.({ stage: 'cloning', percent: 0 })
      await this.runGitClone(parsed.cloneUrl, cloneTarget, options.signal, options.onProgress)

      // Recheck abort after Git completes and before irreversible publication.
      if (options.signal?.aborted) {
        throw new GitCloneError('clone_cancelled', 'Clone was cancelled.')
      }
      if (options.beforePublish) {
        const allowed = await options.beforePublish()
        if (!allowed) {
          throw new GitCloneError('clone_cancelled', 'Clone was cancelled.')
        }
      }
      if (options.signal?.aborted) {
        throw new GitCloneError('clone_cancelled', 'Clone was cancelled.')
      }

      try {
        await this.publishImpl(cloneTarget, destination)
      } catch (error) {
        if (error instanceof GitCloneError) {
          throw error
        }
        const code = typeof error === 'object' && error && 'code' in error
          ? String((error as { code: unknown }).code)
          : ''
        if (code === 'EEXIST' || code === 'ENOTEMPTY') {
          throw new GitCloneError(
            'destination_exists',
            'A file or folder already exists at the destination path.',
          )
        }
        throw classifyFsError(error, 'Unable to publish the cloned repository.')
      }

      await safeRemoveOwnedStaging(stagingPath, basePath)
      stagingPath = undefined

      return { repositoryPath: destination, stagingPath: '' }
    } catch (error) {
      if (stagingPath) {
        await safeRemoveOwnedStaging(stagingPath, basePath)
      }
      throw error
    }
  }

  private async runGitClone(
    cloneUrl: string,
    targetPath: string,
    signal: AbortSignal | undefined,
    onProgress: ((progress: GitCloneProgress) => void) | undefined,
  ): Promise<void> {
    const args = [
      '-c',
      'protocol.file.allow=never',
      '-c',
      'protocol.ext.allow=never',
      'clone',
      '--progress',
      '--',
      cloneUrl,
      targetPath,
    ]

    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      DISPLAY: '',
    }

    let child: ChildProcess
    try {
      child = this.spawnImpl(this.gitBinary, args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // New process group on POSIX so we can signal the whole tree via -pid.
        detached: this.platform !== 'win32',
      })
    } catch {
      throw new GitCloneError(
        'git_unavailable',
        'Git is not available. Install Git and ensure it is on the Forge backend PATH.',
      )
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    /** Memoized only when abort/timeout begins — never on normal close. */
    let terminationPromise: Promise<void> | null = null

    const beginTermination = (): Promise<void> => {
      if (!terminationPromise) {
        terminationPromise = this.terminateImpl(child, this.platform).catch(() => undefined)
      }
      return terminationPromise
    }

    const appendBounded = (current: string, chunk: string): string => {
      const next = current + chunk
      return next.length > MAX_OUTPUT_BUFFER ? next.slice(next.length - MAX_OUTPUT_BUFFER) : next
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout = appendBounded(stdout, chunk)
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr = appendBounded(stderr, chunk)
      const percent = parseClonePercent(chunk)
      if (percent !== undefined) {
        onProgress?.({ stage: 'cloning', percent })
      }
    })

    const abortHandler = () => {
      void beginTermination()
    }

    if (signal) {
      if (signal.aborted) {
        abortHandler()
      } else {
        signal.addEventListener('abort', abortHandler, { once: true })
      }
    }

    const timeout = setTimeout(() => {
      timedOut = true
      void beginTermination()
    }, this.timeoutMs)

    try {
      const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
        child.once('error', (error) => {
          if (settled) return
          settled = true
          const message = error instanceof Error ? error.message : String(error)
          if (/enoent/i.test(message)) {
            rejectExit(
              new GitCloneError(
                'git_unavailable',
                'Git is not available. Install Git and ensure it is on the Forge backend PATH.',
              ),
            )
            return
          }
          rejectExit(new GitCloneError('clone_failed', 'Clone failed to start.'))
        })

        child.once('close', (code) => {
          if (settled) return
          settled = true
          if (signal?.aborted) {
            rejectExit(new GitCloneError('clone_cancelled', 'Clone was cancelled.'))
            return
          }
          if (timedOut) {
            rejectExit(
              new GitCloneError(
                'clone_timed_out',
                'Clone timed out. Retry or clone externally for large repositories.',
              ),
            )
            return
          }
          resolveExit(code ?? 1)
        })
      })

      // Normal close (success or nonzero): never terminate.
      if (exitCode === 0) {
        onProgress?.({ stage: 'cloning', percent: 100 })
        return
      }

      throw classifyGitCloneFailure(stderr, stdout)
    } catch (error) {
      // Cancellation/timeout must not settle until process-tree termination completes.
      if (terminationPromise) {
        await terminationPromise
      } else if (signal?.aborted || timedOut) {
        await beginTermination()
      }
      throw error
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abortHandler)
      if (terminationPromise) {
        await terminationPromise
      }
    }
  }
}

/**
 * Atomically publish a staged clone to the destination with no-clobber semantics.
 *
 * Uses platform exclusive-rename primitives (renamex_np / renameat2 /
 * MoveFileExW). Never mkdir's the destination, never moves children into a
 * visible empty claim, and never deletes the destination on failure.
 */
export async function publishCloneWithoutReplace(
  cloneTarget: string,
  destination: string,
): Promise<void> {
  // Fail closed on any preexisting name, including empty dirs and symlink/junction leaves.
  await assertDestinationAbsent(destination)

  try {
    await exclusiveRenameNoClobber(cloneTarget, destination)
  } catch (error) {
    if (error instanceof ExclusiveRenameError) {
      throw new GitCloneError(error.code, error.message)
    }
    if (error instanceof GitCloneError) {
      throw error
    }
    const code = typeof error === 'object' && error && 'code' in error
      ? String((error as { code: unknown }).code)
      : ''
    if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'ENOTDIR') {
      throw new GitCloneError(
        'destination_exists',
        'A file or folder already exists at the destination path.',
      )
    }
    throw classifyFsError(error, 'Unable to publish the cloned repository.')
  }
}

function formatHostForUrl(parsed: URL): string {
  // URL.hostname strips brackets from IPv6 on most Node versions, but be defensive
  // against hosts that already include brackets so we never emit `[[...]]`.
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (host.includes(':')) {
    return `[${host}]`
  }
  return host
}

function formatPortSuffix(parsed: URL): string {
  if (!parsed.port) {
    return ''
  }
  // URL.port is empty when the port is the scheme default; preserve explicit non-default ports.
  return `:${parsed.port}`
}

function looksLikeLocalPath(value: string): boolean {
  if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || value.startsWith('~')) {
    return true
  }
  if (/^[a-zA-Z]:[\\/]/.test(value)) {
    return true
  }
  return false
}

function deriveFolderFromPath(pathPart: string): string {
  const cleaned = pathPart.replace(/\\/g, '/').replace(/\/+$/, '')
  const segments = cleaned.split('/').filter(Boolean)
  const last = segments[segments.length - 1] ?? ''
  let decoded = last
  try {
    decoded = decodeURIComponent(last)
  } catch {
    decoded = last
  }
  const withoutGit = decoded.replace(/\.git$/i, '')
  if (!withoutGit) {
    throw new GitCloneError('invalid_repository_url', 'Repository URL is missing a repository name.')
  }
  return validateRepositoryFolder(withoutGit)
}

function sanitizePathForDisplay(pathPart: string): string {
  return pathPart.split('?')[0]?.split('#')[0] ?? pathPart
}

function isPathInside(parent: string, child: string): boolean {
  const normalizedParent = parent.endsWith(sep) ? parent : parent + sep
  return child === parent || child.startsWith(normalizedParent)
}

async function assertDestinationAbsent(destination: string): Promise<void> {
  try {
    await lstat(destination)
    throw new GitCloneError(
      'destination_exists',
      'A file or folder already exists at the destination path.',
    )
  } catch (error) {
    if (error instanceof GitCloneError) {
      throw error
    }
    const code = typeof error === 'object' && error && 'code' in error
      ? String((error as { code: unknown }).code)
      : ''
    if (code !== 'ENOENT') {
      throw classifyFsError(error, 'Unable to inspect the destination path.')
    }
  }
}

/**
 * Only remove an operation-owned staging directory: exactly one child of base
 * whose leaf starts with the staging prefix.
 */
export async function safeRemoveOwnedStaging(stagingPath: string, basePath: string): Promise<void> {
  const resolvedStaging = resolve(stagingPath)
  const resolvedBase = resolve(basePath)
  if (!isPathInside(resolvedBase, resolvedStaging) || resolvedStaging === resolvedBase) {
    return
  }

  const relative = resolvedStaging.slice(resolvedBase.length).replace(/^[/\\]+/, '')
  // Exactly one path segment under base.
  if (!relative || relative.includes('/') || relative.includes('\\')) {
    return
  }
  if (!relative.startsWith(STAGING_PREFIX)) {
    return
  }

  try {
    await rm(resolvedStaging, { recursive: true, force: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[git-clone-runner] Failed to clean staging ${sanitizePathForLog(resolvedStaging)}: ${message}`)
  }
}

function sanitizePathForLog(pathValue: string): string {
  return pathValue.length > 500 ? `${pathValue.slice(0, 500)}…` : pathValue
}

function classifyFsError(error: unknown, fallback: string): GitCloneError {
  const code = typeof error === 'object' && error && 'code' in error
    ? String((error as { code: unknown }).code)
    : ''
  if (code === 'EACCES' || code === 'EPERM') {
    return new GitCloneError('destination_permission_denied', 'Permission denied for the destination path.')
  }
  if (code === 'ENOSPC') {
    return new GitCloneError('disk_full', 'Not enough disk space to clone the repository.')
  }
  return new GitCloneError('clone_failed', fallback)
}

function classifyGitCloneFailure(stderr: string, stdout: string): GitCloneError {
  const haystack = redactSecrets(`${stderr}\n${stdout}`).toLowerCase()

  if (
    haystack.includes('authentication failed') ||
    haystack.includes('permission denied (publickey)') ||
    haystack.includes('could not read from remote') ||
    haystack.includes('invalid credentials') ||
    haystack.includes('403') ||
    haystack.includes('401')
  ) {
    return new GitCloneError(
      'repository_auth_failed',
      'Authentication failed. Configure system Git or SSH credentials and retry.',
    )
  }

  if (
    haystack.includes('not found') ||
    haystack.includes('repository not found') ||
    haystack.includes('does not exist') ||
    haystack.includes('404')
  ) {
    return new GitCloneError(
      'repository_not_found',
      'Repository not found. Check the URL and visibility.',
    )
  }

  if (
    haystack.includes('could not resolve host') ||
    haystack.includes('connection refused') ||
    haystack.includes('network is unreachable') ||
    haystack.includes('timed out') ||
    haystack.includes('failed to connect')
  ) {
    return new GitCloneError(
      'repository_network_failed',
      'Network error while cloning. Check connectivity, VPN, or proxy settings.',
    )
  }

  if (haystack.includes('no space left') || haystack.includes('disk quota exceeded')) {
    return new GitCloneError('disk_full', 'Not enough disk space to clone the repository.')
  }

  if (haystack.includes('permission denied') || haystack.includes('operation not permitted')) {
    return new GitCloneError(
      'destination_permission_denied',
      'Permission denied while cloning to the destination.',
    )
  }

  return new GitCloneError('clone_failed', 'Clone failed. Check the URL and try again.')
}

export function redactSecrets(text: string): string {
  return text
    .replace(/https?:\/\/[^/\s:@]+:[^/\s@]+@/gi, 'https://***:***@')
    .replace(/ghp_[A-Za-z0-9_]+/g, 'ghp_***')
    .replace(/github_pat_[A-Za-z0-9_]+/g, 'github_pat_***')
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, 'xox***')
}

function parseClonePercent(chunk: string): number | undefined {
  const match = chunk.match(/(\d+)%/)
  if (!match) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(100, value))
}

export async function terminateProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform,
): Promise<void> {
  const pid = child.pid
  if (!pid) {
    return
  }

  if (platform === 'win32') {
    await new Promise<void>((resolveKill) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.once('exit', () => resolveKill())
      killer.once('error', () => resolveKill())
    })
    return
  }

  // Process-group kill (detached spawn); fall back to the direct child.
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {
      // ignore
    }
  }

  await delay(KILL_GRACE_MS)

  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // ignore
    }
  }

  // Wait briefly for exit so staging cleanup does not race live writers.
  await Promise.race([
    new Promise<void>((resolveWait) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolveWait()
        return
      }
      child.once('close', () => resolveWait())
    }),
    delay(KILL_GRACE_MS * 4),
  ])
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

export const GIT_CLONE_STAGING_PREFIX = STAGING_PREFIX
