import { mkdir, mkdtemp, writeFile, rm, readFile, access, constants } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DARWIN_RENAME_EXCL,
  ExclusiveRenameError,
  LINUX_AT_FDCWD,
  LINUX_RENAME_NOREPLACE,
  WIN32_ERROR_ACCESS_DENIED,
  WIN32_ERROR_ALREADY_EXISTS,
  WIN32_ERROR_DISK_FULL,
  WIN32_ERROR_FILE_EXISTS,
  WIN32_ERROR_HANDLE_DISK_FULL,
  createDefaultNativeBinding,
  errnoToError,
  exclusiveRenameNoClobber,
  toWin32LongPath,
  win32ErrorToExclusive,
  type ExclusiveRenameNativeBinding,
} from '../versioning/exclusive-dir-rename.js'

describe('exclusive-dir-rename table-driven bindings', () => {
  const cases: Array<{
    name: string
    platform: NodeJS.Platform
    arch: string
    expectedFlags?: number
    expectedConstants?: Record<string, number>
  }> = [
    {
      name: 'darwin renamex_np RENAME_EXCL',
      platform: 'darwin',
      arch: 'arm64',
      expectedFlags: DARWIN_RENAME_EXCL,
    },
    {
      name: 'linux renameat2 RENAME_NOREPLACE',
      platform: 'linux',
      arch: 'x64',
      expectedFlags: LINUX_RENAME_NOREPLACE,
      expectedConstants: { AT_FDCWD: LINUX_AT_FDCWD },
    },
    {
      name: 'win32 MoveFileExW no-replace',
      platform: 'win32',
      arch: 'x64',
      expectedFlags: 0,
    },
  ]

  for (const entry of cases) {
    it(`invokes ${entry.name} with expected prototype/flags`, async () => {
      const calls: unknown[][] = []
      const binding: ExclusiveRenameNativeBinding = {
        renameExclusive(source, destination) {
          calls.push([source, destination, entry.expectedFlags])
        },
      }

      await exclusiveRenameNoClobber('/tmp/src', '/tmp/dst', {
        platform: entry.platform,
        arch: entry.arch,
        createBinding: (platform, arch) => {
          expect(platform).toBe(entry.platform)
          expect(arch).toBe(entry.arch)
          if (entry.expectedConstants) {
            expect(LINUX_AT_FDCWD).toBe(entry.expectedConstants.AT_FDCWD)
          }
          return binding
        },
      })

      expect(calls).toEqual([['/tmp/src', '/tmp/dst', entry.expectedFlags]])
    })
  }

  it('maps posix errno codes immediately', () => {
    expect(errnoToError(17, 'x').code).toBe('destination_exists')
    expect(errnoToError(66, 'x').code).toBe('destination_exists')
    expect(errnoToError(39, 'x').code).toBe('destination_exists')
    expect(errnoToError(13, 'x').code).toBe('destination_permission_denied')
    expect(errnoToError(1, 'x').code).toBe('destination_permission_denied')
    expect(errnoToError(28, 'x').code).toBe('disk_full')
    expect(errnoToError(999, 'fallback').message).toBe('fallback')
  })

  it('maps Win32 GetLastError codes immediately', () => {
    expect(win32ErrorToExclusive(WIN32_ERROR_FILE_EXISTS).code).toBe('destination_exists')
    expect(win32ErrorToExclusive(WIN32_ERROR_ALREADY_EXISTS).code).toBe('destination_exists')
    expect(win32ErrorToExclusive(WIN32_ERROR_ACCESS_DENIED).code).toBe('destination_permission_denied')
    expect(win32ErrorToExclusive(WIN32_ERROR_DISK_FULL).code).toBe('disk_full')
    expect(win32ErrorToExclusive(WIN32_ERROR_HANDLE_DISK_FULL).code).toBe('disk_full')
    expect(win32ErrorToExclusive(1234).message).toContain('1234')
  })

  it('fail-closed when createBinding reports missing library/symbol', async () => {
    await expect(
      exclusiveRenameNoClobber('/tmp/src', '/tmp/dst', {
        platform: 'darwin',
        createBinding: () => {
          throw new ExclusiveRenameError('clone_failed', 'Missing renamex_np symbol')
        },
      }),
    ).rejects.toMatchObject({ code: 'clone_failed', message: /Missing renamex_np/ })
  })

  it('fail-closed on unsupported win32 architecture', () => {
    expect(() => createDefaultNativeBinding('win32', 'ia32')).toThrow(/win32-ia32/)
  })

  it('prefixes absolute Win32 paths for long-path awareness', () => {
    expect(toWin32LongPath('C:\\repos\\dest')).toBe('\\\\?\\C:\\repos\\dest')
    expect(toWin32LongPath('\\\\server\\share\\path')).toBe('\\\\?\\UNC\\server\\share\\path')
    expect(() => toWin32LongPath('relative\\path')).toThrow(/absolute/)
  })

  it('surfaces destination_exists when destination appears between precheck and native call', async () => {
    const renameExclusive = vi.fn(() => {
      throw new ExclusiveRenameError(
        'destination_exists',
        'A file or folder already exists at the destination path.',
      )
    })

    await expect(
      exclusiveRenameNoClobber('/tmp/src', '/tmp/dst', {
        platform: 'darwin',
        beforeNativeRename: async () => {
          // Simulated interference after JS precheck / before native call.
        },
        createBinding: () => ({ renameExclusive }),
      }),
    ).rejects.toMatchObject({ code: 'destination_exists' })

    expect(renameExclusive).toHaveBeenCalledOnce()
  })

  it('never deletes destination on native failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-excl-no-delete-'))
    const destination = join(root, 'dest')
    await mkdir(destination)
    await writeFile(join(destination, 'third-party'), 'keep')

    await expect(
      exclusiveRenameNoClobber(join(root, 'src'), destination, {
        platform: 'linux',
        createBinding: () => ({
          renameExclusive: () => {
            throw new ExclusiveRenameError('destination_exists', 'exists')
          },
        }),
      }),
    ).rejects.toMatchObject({ code: 'destination_exists' })

    await expect(readFile(join(destination, 'third-party'), 'utf8')).resolves.toBe('keep')
    await rm(root, { recursive: true, force: true })
  })
})

describe('exclusive-dir-rename current-host smoke', () => {
  let root = ''

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true })
      root = ''
    }
  })

  it('publishes with the real platform primitive into a temp path', async () => {
    if (process.platform !== 'darwin' && process.platform !== 'linux' && process.platform !== 'win32') {
      return
    }

    root = await mkdtemp(join(tmpdir(), 'forge-excl-smoke-'))
    const source = join(root, 'src')
    const destination = join(root, 'dst')
    await mkdir(source)
    await writeFile(join(source, 'README'), 'ok')

    await exclusiveRenameNoClobber(source, destination)
    await expect(readFile(join(destination, 'README'), 'utf8')).resolves.toBe('ok')
    await expect(access(source, constants.F_OK)).rejects.toBeTruthy()

    // Empty preexisting destination must not be replaced / deleted.
    const blocked = join(root, 'blocked')
    const otherSrc = join(root, 'other-src')
    await mkdir(blocked)
    await writeFile(join(blocked, 'mine'), 'safe')
    await mkdir(otherSrc)
    await writeFile(join(otherSrc, 'x'), 'x')
    await expect(exclusiveRenameNoClobber(otherSrc, blocked)).rejects.toMatchObject({
      code: 'destination_exists',
    })
    await expect(readFile(join(blocked, 'mine'), 'utf8')).resolves.toBe('safe')
  })
})
