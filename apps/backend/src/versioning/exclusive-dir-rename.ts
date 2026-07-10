import { createRequire } from 'node:module'
import { arch as osArch, platform as osPlatform } from 'node:os'

export type ExclusiveRenameErrorCode =
  | 'destination_exists'
  | 'destination_permission_denied'
  | 'disk_full'
  | 'clone_failed'

export class ExclusiveRenameError extends Error {
  readonly code: ExclusiveRenameErrorCode

  constructor(code: ExclusiveRenameErrorCode, message: string) {
    super(message)
    this.name = 'ExclusiveRenameError'
    this.code = code
  }
}

/** Win32 constants used by MoveFileExW / GetLastError mapping. */
export const WIN32_ERROR_FILE_EXISTS = 80
export const WIN32_ERROR_ALREADY_EXISTS = 183
export const WIN32_ERROR_ACCESS_DENIED = 5
export const WIN32_ERROR_DISK_FULL = 112
export const WIN32_ERROR_HANDLE_DISK_FULL = 39

export const DARWIN_RENAME_EXCL = 0x0000_0004
export const LINUX_AT_FDCWD = -100
export const LINUX_RENAME_NOREPLACE = 1 << 0

export type ExclusiveRenameNativeBinding = {
  /** Perform exclusive no-clobber directory rename. Throws ExclusiveRenameError on failure. */
  renameExclusive: (source: string, destination: string) => void
}

export type ExclusiveRenameDeps = {
  platform?: NodeJS.Platform
  arch?: string
  /** Injectable native binding factory for table-driven tests. */
  createBinding?: (platform: NodeJS.Platform, arch: string) => ExclusiveRenameNativeBinding
  /**
   * Optional hook invoked after JS-level destination absence checks would run
   * (caller-side) and immediately before the native exclusive rename — used to
   * simulate destination appearing between precheck and native call.
   */
  beforeNativeRename?: (source: string, destination: string) => void | Promise<void>
}

type KoffiModule = {
  load: (name: string) => {
    func: (...args: unknown[]) => (...fnArgs: unknown[]) => unknown
  }
  errno?: number | (() => number)
}

let koffiModule: KoffiModule | null | undefined

function loadKoffi(): KoffiModule | null {
  if (koffiModule !== undefined) {
    return koffiModule
  }
  try {
    const require = createRequire(import.meta.url)
    koffiModule = require('koffi') as KoffiModule
    return koffiModule
  } catch {
    koffiModule = null
    return null
  }
}

/**
 * Atomically rename a directory onto a non-existent destination without
 * replacing any preexisting path (including empty directories, files, or
 * symlink/junction names).
 *
 * Platform primitives (via koffi 2.15.x):
 * - macOS: renamex_np(src, dst, RENAME_EXCL)
 * - Linux: renameat2(AT_FDCWD, src, AT_FDCWD, dst, RENAME_NOREPLACE)
 * - Windows x64/arm64: MoveFileExW + GetLastError (__stdcall), no REPLACE flag
 *
 * Fail-closed: never mkdir the destination, never move children into place,
 * and never delete the destination on failure.
 */
export async function exclusiveRenameNoClobber(
  source: string,
  destination: string,
  deps: ExclusiveRenameDeps = {},
): Promise<void> {
  const platform = deps.platform ?? (osPlatform() as NodeJS.Platform)
  const arch = deps.arch ?? osArch()
  const createBinding = deps.createBinding ?? createDefaultNativeBinding

  let binding: ExclusiveRenameNativeBinding
  try {
    binding = createBinding(platform, arch)
  } catch (error) {
    if (error instanceof ExclusiveRenameError) {
      throw error
    }
    throw classifyExclusiveRenameError(error)
  }

  if (deps.beforeNativeRename) {
    await deps.beforeNativeRename(source, destination)
  }

  try {
    binding.renameExclusive(source, destination)
  } catch (error) {
    if (error instanceof ExclusiveRenameError) {
      throw error
    }
    throw classifyExclusiveRenameError(error)
  }
}

export function createDefaultNativeBinding(
  platform: NodeJS.Platform,
  arch: string,
): ExclusiveRenameNativeBinding {
  if (platform === 'darwin') {
    return createDarwinBinding()
  }
  if (platform === 'linux') {
    return createLinuxBinding()
  }
  if (platform === 'win32') {
    return createWin32Binding(arch)
  }
  throw new ExclusiveRenameError(
    'clone_failed',
    `Atomic no-clobber repository publication is not supported on ${platform}.`,
  )
}

function createDarwinBinding(): ExclusiveRenameNativeBinding {
  const koffi = requireKoffi()
  let libc
  try {
    libc = koffi.load('libc.dylib')
  } catch (error) {
    throw new ExclusiveRenameError(
      'clone_failed',
      `Unable to load libc.dylib for exclusive rename: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  let renamexNp: (from: string, to: string, flags: number) => number
  try {
    renamexNp = libc.func('renamex_np', 'int', ['str', 'str', 'uint32']) as typeof renamexNp
  } catch (error) {
    throw new ExclusiveRenameError(
      'clone_failed',
      `Missing renamex_np symbol: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  return {
    renameExclusive(source, destination) {
      const rc = renamexNp(source, destination, DARWIN_RENAME_EXCL)
      if (rc === 0) {
        return
      }
      throw errnoToError(readErrno(koffi), 'Unable to publish the cloned repository.')
    },
  }
}

function createLinuxBinding(): ExclusiveRenameNativeBinding {
  const koffi = requireKoffi()
  let libc
  try {
    libc = koffi.load('libc.so.6')
  } catch (error) {
    throw new ExclusiveRenameError(
      'clone_failed',
      `Unable to load libc.so.6 for exclusive rename: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  let renameat2: (
    olddirfd: number,
    oldpath: string,
    newdirfd: number,
    newpath: string,
    flags: number,
  ) => number
  try {
    renameat2 = libc.func('renameat2', 'int', ['int', 'str', 'int', 'str', 'uint32']) as typeof renameat2
  } catch (error) {
    throw new ExclusiveRenameError(
      'clone_failed',
      `Missing renameat2 symbol: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  return {
    renameExclusive(source, destination) {
      const rc = renameat2(
        LINUX_AT_FDCWD,
        source,
        LINUX_AT_FDCWD,
        destination,
        LINUX_RENAME_NOREPLACE,
      )
      if (rc === 0) {
        return
      }
      throw errnoToError(readErrno(koffi), 'Unable to publish the cloned repository.')
    },
  }
}

function createWin32Binding(arch: string): ExclusiveRenameNativeBinding {
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new ExclusiveRenameError(
      'clone_failed',
      `Atomic no-clobber repository publication is not supported on win32-${arch}.`,
    )
  }

  const koffi = requireKoffi()
  let kernel32
  try {
    kernel32 = koffi.load('kernel32.dll')
  } catch (error) {
    throw new ExclusiveRenameError(
      'clone_failed',
      `Unable to load kernel32.dll for exclusive rename: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  // Bind both symbols before any invocation so GetLastError is ready immediately.
  let moveFileExW: (existing: string, next: string, flags: number) => number
  let getLastError: () => number
  try {
    // Exact Win32 prototypes / stdcall (Koffi 2.15 prototype-string form).
    moveFileExW = kernel32.func(
      'int __stdcall MoveFileExW(str16 lpExistingFileName, str16 lpNewFileName, uint32 dwFlags)',
    ) as typeof moveFileExW
    getLastError = kernel32.func('uint32 __stdcall GetLastError()') as typeof getLastError
  } catch (error) {
    throw new ExclusiveRenameError(
      'clone_failed',
      `Missing MoveFileExW/GetLastError symbols: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  return {
    renameExclusive(source, destination) {
      const from = toWin32LongPath(source)
      const to = toWin32LongPath(destination)
      // dwFlags = 0 → do not replace an existing destination.
      const ok = moveFileExW(from, to, 0)
      if (ok !== 0) {
        return
      }
      const code = getLastError()
      throw win32ErrorToExclusive(code)
    },
  }
}

/** Prefix absolute Win32 paths for long-path awareness; fail closed on relative paths. */
export function toWin32LongPath(pathValue: string): string {
  if (pathValue.startsWith('\\\\?\\') || pathValue.startsWith('\\\\.\\')) {
    return pathValue
  }
  // UNC: \\server\share\... → \\?\UNC\server\share\...
  if (pathValue.startsWith('\\\\')) {
    return `\\\\?\\UNC\\${pathValue.slice(2)}`
  }
  if (/^[a-zA-Z]:[\\/]/.test(pathValue)) {
    return `\\\\?\\${pathValue}`
  }
  throw new ExclusiveRenameError(
    'clone_failed',
    'Atomic no-clobber publication on Windows requires an absolute destination path.',
  )
}

export function win32ErrorToExclusive(code: number): ExclusiveRenameError {
  if (code === WIN32_ERROR_FILE_EXISTS || code === WIN32_ERROR_ALREADY_EXISTS) {
    return new ExclusiveRenameError(
      'destination_exists',
      'A file or folder already exists at the destination path.',
    )
  }
  if (code === WIN32_ERROR_ACCESS_DENIED) {
    return new ExclusiveRenameError(
      'destination_permission_denied',
      'Permission denied for the destination path.',
    )
  }
  if (code === WIN32_ERROR_DISK_FULL || code === WIN32_ERROR_HANDLE_DISK_FULL) {
    return new ExclusiveRenameError('disk_full', 'Not enough disk space to clone the repository.')
  }
  return new ExclusiveRenameError(
    'clone_failed',
    `Unable to publish the cloned repository (Win32 error ${code}).`,
  )
}

function requireKoffi(): KoffiModule {
  const koffi = loadKoffi()
  if (!koffi) {
    throw new ExclusiveRenameError(
      'clone_failed',
      'Atomic no-clobber repository publication requires the koffi native binding.',
    )
  }
  return koffi
}

function readErrno(koffi: KoffiModule): number {
  try {
    if (typeof koffi.errno === 'function') {
      return koffi.errno()
    }
    if (typeof koffi.errno === 'number') {
      return koffi.errno
    }
  } catch {
    // ignore
  }
  return 0
}

export function errnoToError(errno: number, fallback: string): ExclusiveRenameError {
  // EEXIST=17, ENOTEMPTY=66 (darwin) / 39 (linux), EACCES=13, EPERM=1, ENOSPC=28
  if (errno === 17 || errno === 66 || errno === 39) {
    return new ExclusiveRenameError(
      'destination_exists',
      'A file or folder already exists at the destination path.',
    )
  }
  if (errno === 13 || errno === 1) {
    return new ExclusiveRenameError(
      'destination_permission_denied',
      'Permission denied for the destination path.',
    )
  }
  if (errno === 28) {
    return new ExclusiveRenameError('disk_full', 'Not enough disk space to clone the repository.')
  }
  return new ExclusiveRenameError('clone_failed', fallback)
}

function classifyExclusiveRenameError(error: unknown): ExclusiveRenameError {
  const code = typeof error === 'object' && error && 'code' in error
    ? String((error as { code: unknown }).code)
    : ''
  if (code === 'EEXIST' || code === 'ENOTEMPTY') {
    return new ExclusiveRenameError(
      'destination_exists',
      'A file or folder already exists at the destination path.',
    )
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new ExclusiveRenameError(
      'destination_permission_denied',
      'Permission denied for the destination path.',
    )
  }
  if (code === 'ENOSPC') {
    return new ExclusiveRenameError('disk_full', 'Not enough disk space to clone the repository.')
  }
  const message = error instanceof Error ? error.message : String(error)
  return new ExclusiveRenameError('clone_failed', message || 'Unable to publish the cloned repository.')
}
