/**
 * Tests for the desktop CLI installation module.
 *
 * Exercises the real shim generators, hint serialization/parsing,
 * PATH detection, verify-via-shim behavior, and Windows CMD stale-hint
 * fallback. Mocks the Electron `app` module minimally.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Hoisted mutable state so verify tests can redirect the resolved home dir.
// vi.hoisted runs before vi.mock, making this safe for mock factory capture.
const mockState = vi.hoisted(() => ({
  homeDir: null as string | null,
}))

// Mock Electron app module before importing cli-install
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (name: string) => {
      if (name === 'home') return mockState.homeDir ?? os.homedir()
      if (name === 'exe') return process.execPath
      return os.tmpdir()
    },
    getVersion: () => '1.0.0-test',
  },
}))

// Import the real module — generators and helpers are exercised directly
import {
  generatePosixShim,
  generateWindowsCmdShim,
  generateWindowsPs1Shim,
  parseInstallHintContent,
  serializeInstallHint,
  isBinDirOnPath,
  verifyCliInstall,
  SHIM_NAME_POSIX,
  type InstallHint,
} from '../cli-install.js'

/* ------------------------------------------------------------------ */
/*  Real generator tests                                               */
/* ------------------------------------------------------------------ */

describe('generatePosixShim (real)', () => {
  const hint = '/tmp/.forge/cli/install-hint'
  const fallbackExe = '/Applications/Forge.app/Contents/MacOS/Forge'
  const fallbackCli = '/Applications/Forge.app/Contents/Resources/cli/cli.js'
  const shim = generatePosixShim(hint, fallbackExe, fallbackCli)

  it('starts with sh shebang', () => {
    expect(shim.startsWith('#!/bin/sh\n')).toBe(true)
  })

  it('sets ELECTRON_RUN_AS_NODE=1', () => {
    expect(shim).toContain('ELECTRON_RUN_AS_NODE=1')
  })

  it('reads hint file for electronExePath and cliResourcePath', () => {
    expect(shim).toContain(hint)
    expect(shim).toContain('electronExePath')
    expect(shim).toContain('cliResourcePath')
  })

  it('falls back when hint exe is missing (checks -z and ! -f)', () => {
    expect(shim).toContain('[ -z "$ELECTRON_EXE" ] || [ ! -f "$ELECTRON_EXE" ]')
    expect(shim).toContain(fallbackExe)
    expect(shim).toContain(fallbackCli)
  })

  it('passes all arguments via "$@"', () => {
    expect(shim).toContain('"$@"')
  })

  it('uses exec for clean process replacement', () => {
    expect(shim).toContain('exec "$ELECTRON_EXE"')
  })

  it('embeds the provided hint path', () => {
    const customHint = '/custom/path/hint'
    const customShim = generatePosixShim(customHint, fallbackExe, fallbackCli)
    expect(customShim).toContain(customHint)
  })
})

describe('generateWindowsCmdShim (real)', () => {
  const hint = 'C:\\Users\\test\\.forge\\cli\\install-hint'
  const fallbackExe = 'C:\\Programs\\Forge\\Forge.exe'
  const fallbackCli = 'C:\\Programs\\Forge\\resources\\cli\\cli.js'
  const shim = generateWindowsCmdShim(hint, fallbackExe, fallbackCli)

  it('starts with @echo off', () => {
    expect(shim.startsWith('@echo off')).toBe(true)
  })

  it('sets ELECTRON_RUN_AS_NODE=1', () => {
    expect(shim).toContain('ELECTRON_RUN_AS_NODE=1')
  })

  it('reads hint file for electronExePath and cliResourcePath', () => {
    expect(shim).toContain(hint)
    expect(shim).toContain('electronExePath')
    expect(shim).toContain('cliResourcePath')
  })

  it('passes arguments with %*', () => {
    expect(shim).toContain('%*')
  })

  it('falls back when hint exe is stale (not just undefined)', () => {
    // The CMD shim must check BOTH "not defined" AND "not exist" before
    // falling back — mirroring POSIX behavior for stale hints.
    expect(shim).toContain('if not defined ELECTRON_EXE goto :use_fallback')
    expect(shim).toContain('if not exist "%ELECTRON_EXE%" goto :use_fallback')
    expect(shim).toContain(':use_fallback')
    expect(shim).toContain(fallbackExe)
    expect(shim).toContain(fallbackCli)
  })

  it('uses goto for fallback flow control', () => {
    // Verify the goto labels exist in the correct order
    const lines = shim.split('\r\n')
    const fallbackLabelIdx = lines.findIndex((l) => l === ':use_fallback')
    const afterLabelIdx = lines.findIndex((l) => l === ':after_fallback')
    expect(fallbackLabelIdx).toBeGreaterThan(-1)
    expect(afterLabelIdx).toBeGreaterThan(fallbackLabelIdx)
  })
})

describe('generateWindowsPs1Shim (real)', () => {
  const hint = 'C:\\Users\\test\\.forge\\cli\\install-hint'
  const fallbackExe = 'C:\\Programs\\Forge\\Forge.exe'
  const fallbackCli = 'C:\\Programs\\Forge\\resources\\cli\\cli.js'
  const shim = generateWindowsPs1Shim(hint, fallbackExe, fallbackCli)

  it('sets ELECTRON_RUN_AS_NODE env var', () => {
    expect(shim).toContain('ELECTRON_RUN_AS_NODE')
  })

  it('passes arguments with @args', () => {
    expect(shim).toContain('@args')
  })

  it('checks -not $electronExe -or -not (Test-Path) for fallback', () => {
    expect(shim).toContain('-not $electronExe -or -not (Test-Path $electronExe)')
    expect(shim).toContain(fallbackExe)
  })
})

/* ------------------------------------------------------------------ */
/*  Windows CMD stale-hint fallback behavior                           */
/* ------------------------------------------------------------------ */

describe('windows CMD stale-hint fallback', () => {
  it('falls back to known location when hint exe path is stale', () => {
    const fallbackExe = 'C:\\Programs\\Forge\\Forge.exe'
    const fallbackCli = 'C:\\Programs\\Forge\\resources\\cli\\cli.js'
    const shim = generateWindowsCmdShim('hint', fallbackExe, fallbackCli)

    // The shim has the existence check for ELECTRON_EXE
    expect(shim).toContain('if not exist "%ELECTRON_EXE%" goto :use_fallback')

    // The shim has the fallback assignment — verify it comes after the label
    const lines = shim.split('\r\n')
    const labelIdx = lines.findIndex((l) => l === ':use_fallback')
    const afterLabel = lines.slice(labelIdx + 1)
    // First set after :use_fallback should assign the fallback exe
    const firstSet = afterLabel.find((l) => l.startsWith('set "ELECTRON_EXE='))
    expect(firstSet).toBeDefined()
    expect(firstSet).toContain(fallbackExe)
  })

  it('skips fallback when hint exe exists (goto :after_fallback)', () => {
    const shim = generateWindowsCmdShim('hint', 'C:\\Good\\Forge.exe', 'C:\\Good\\cli.js')
    // When ELECTRON_EXE IS defined AND file exists, the shim should skip past fallback
    expect(shim).toContain('goto :after_fallback')
    // Verify :after_fallback comes after :use_fallback
    const lines = shim.split('\r\n')
    const useFallbackIdx = lines.findIndex((l) => l === ':use_fallback')
    const afterFallbackIdx = lines.findIndex((l) => l === ':after_fallback')
    expect(afterFallbackIdx).toBeGreaterThan(useFallbackIdx)
  })
})

/* ------------------------------------------------------------------ */
/*  Hint serialization / parsing                                       */
/* ------------------------------------------------------------------ */

describe('serializeInstallHint / parseInstallHintContent', () => {
  it('round-trips macOS paths', () => {
    const hint: InstallHint = {
      electronExePath: '/Applications/Forge.app/Contents/MacOS/Forge',
      cliResourcePath: '/Applications/Forge.app/Contents/Resources/cli/cli.js',
      version: '0.17.1',
    }
    const serialized = serializeInstallHint(hint)
    const parsed = parseInstallHintContent(serialized)
    expect(parsed).toEqual(hint)
  })

  it('round-trips Windows paths with drive letters', () => {
    const hint: InstallHint = {
      electronExePath: 'C:\\Users\\test\\AppData\\Local\\Programs\\Forge\\Forge.exe',
      cliResourcePath: 'C:\\Users\\test\\AppData\\Local\\Programs\\Forge\\resources\\cli\\cli.js',
      version: '0.17.1',
    }
    const serialized = serializeInstallHint(hint)
    const parsed = parseInstallHintContent(serialized)
    expect(parsed).toEqual(hint)
  })

  it('returns null for empty content', () => {
    expect(parseInstallHintContent('')).toBeNull()
  })

  it('returns null when electronExePath is missing', () => {
    expect(parseInstallHintContent('cliResourcePath=/some/path\nversion=1.0.0\n')).toBeNull()
  })

  it('returns null when cliResourcePath is missing', () => {
    expect(parseInstallHintContent('electronExePath=/some/exe\nversion=1.0.0\n')).toBeNull()
  })

  it('defaults version to empty string when missing', () => {
    const parsed = parseInstallHintContent('electronExePath=/exe\ncliResourcePath=/cli\n')
    expect(parsed?.version).toBe('')
  })
})

/* ------------------------------------------------------------------ */
/*  PATH detection (real function)                                     */
/* ------------------------------------------------------------------ */

describe('isBinDirOnPath (real)', () => {
  let originalPath: string | undefined

  beforeEach(() => {
    originalPath = process.env.PATH
  })

  afterEach(() => {
    if (originalPath !== undefined) {
      process.env.PATH = originalPath
    }
  })

  it('detects directory present in PATH', () => {
    const testDir = '/tmp/forge-test-bin'
    process.env.PATH = `/usr/bin:${testDir}:/usr/local/bin`
    expect(isBinDirOnPath(testDir)).toBe(true)
  })

  it('returns false when directory is not in PATH', () => {
    process.env.PATH = '/usr/bin:/usr/local/bin'
    expect(isBinDirOnPath('/tmp/forge-test-bin')).toBe(false)
  })

  it('does not false-match partial paths', () => {
    const testDir = '/home/user/.forge/bin'
    process.env.PATH = `/usr/bin:${testDir}-extra:/usr/local/bin`
    expect(isBinDirOnPath(testDir)).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/*  Idempotent generation                                              */
/* ------------------------------------------------------------------ */

describe('idempotent shim generation', () => {
  it('produces identical POSIX shim on repeated calls', () => {
    const args = ['/hint', '/fallback/exe', '/fallback/cli'] as const
    expect(generatePosixShim(...args)).toBe(generatePosixShim(...args))
  })

  it('produces identical CMD shim on repeated calls', () => {
    const args = ['C:\\hint', 'C:\\exe', 'C:\\cli'] as const
    expect(generateWindowsCmdShim(...args)).toBe(generateWindowsCmdShim(...args))
  })
})

/* ------------------------------------------------------------------ */
/*  verifyCliInstall — runs the actual installed shim (no args)        */
/* ------------------------------------------------------------------ */

describe('verifyCliInstall', () => {
  // Skip shim execution tests on Windows (these POSIX shims won't run there)
  const describePosix = process.platform === 'win32' ? describe.skip : describe

  describePosix('resolves and executes the shim at ~/.forge/bin/forge', () => {
    // Redirect the mock home to a temp dir so verifyCliInstall() resolves
    // to a controlled location without touching the real home directory.
    const tmpDir = path.join(os.tmpdir(), `forge-cli-verify-test-${process.pid}`)
    const shimBinDir = path.join(tmpDir, '.forge', 'bin')
    const shimPath = path.join(shimBinDir, SHIM_NAME_POSIX)

    beforeEach(() => {
      mockState.homeDir = tmpDir
      mkdirSync(shimBinDir, { recursive: true })
    })

    afterEach(() => {
      mockState.homeDir = null
      rmSync(tmpDir, { recursive: true, force: true })
    })

    it('returns error when shim does not exist at expected path', () => {
      // shimBinDir exists but no shim file written → should fail
      rmSync(shimPath, { force: true })
      const result = verifyCliInstall()
      expect(result.ok).toBe(false)
      expect(result.output).toContain('not found')
      expect(result.output).toContain('.forge')
    })

    it('succeeds when shim outputs a version', () => {
      writeFileSync(shimPath, '#!/bin/sh\necho "1.2.3"\n', 'utf8')
      chmodSync(shimPath, 0o755)

      const result = verifyCliInstall()
      expect(result.ok).toBe(true)
      expect(result.output).toBe('1.2.3')
    })

    it('reports failure when shim exits non-zero', () => {
      writeFileSync(shimPath, '#!/bin/sh\necho "boom" >&2\nexit 1\n', 'utf8')
      chmodSync(shimPath, 0o755)

      const result = verifyCliInstall()
      expect(result.ok).toBe(false)
      expect(result.output.length).toBeGreaterThan(0)
    })

    it('reports failure when shim is not executable', () => {
      writeFileSync(shimPath, '#!/bin/sh\necho "1.0.0"\n', 'utf8')
      chmodSync(shimPath, 0o644) // not executable

      const result = verifyCliInstall()
      expect(result.ok).toBe(false)
    })

    it('runs a real generated shim that delegates to a mock Electron binary', () => {
      // Create a mock "Electron" executable that outputs a version
      const mockElectronPath = path.join(tmpDir, 'mock-electron')
      const mockCliPath = path.join(tmpDir, 'mock-cli.js')
      writeFileSync(mockElectronPath, '#!/bin/sh\necho "mock-forge 2.0.0"\n', 'utf8')
      chmodSync(mockElectronPath, 0o755)
      writeFileSync(mockCliPath, '// placeholder cli', 'utf8')

      // Write a hint file pointing to the mock
      const hintDir = path.join(tmpDir, '.forge', 'cli')
      const hintPath = path.join(hintDir, 'install-hint')
      mkdirSync(hintDir, { recursive: true })
      writeFileSync(
        hintPath,
        serializeInstallHint({
          electronExePath: mockElectronPath,
          cliResourcePath: mockCliPath,
          version: '2.0.0',
        }),
        'utf8',
      )

      // Generate a real shim pointing at that hint
      const realShim = generatePosixShim(hintPath, '/nonexistent/fallback', '/nonexistent/fallback')
      writeFileSync(shimPath, realShim, 'utf8')
      chmodSync(shimPath, 0o755)

      const result = verifyCliInstall()
      expect(result.ok).toBe(true)
      expect(result.output).toContain('mock-forge 2.0.0')
    })

    it('runs a real generated shim that falls back when hint is stale', () => {
      // Hint points to nonexistent paths → shim should fall through to fallback
      const hintDir = path.join(tmpDir, '.forge', 'cli')
      const hintPath = path.join(hintDir, 'install-hint')
      mkdirSync(hintDir, { recursive: true })
      writeFileSync(
        hintPath,
        serializeInstallHint({
          electronExePath: '/nonexistent/stale-electron',
          cliResourcePath: '/nonexistent/stale-cli.js',
          version: '0.0.0',
        }),
        'utf8',
      )

      // Create a mock "Electron" at the fallback location
      const fallbackExe = path.join(tmpDir, 'fallback-electron')
      const fallbackCli = path.join(tmpDir, 'fallback-cli.js')
      writeFileSync(fallbackExe, '#!/bin/sh\necho "fallback 3.0.0"\n', 'utf8')
      chmodSync(fallbackExe, 0o755)
      writeFileSync(fallbackCli, '// placeholder', 'utf8')

      // Generate shim with hint pointing to stale paths, fallback pointing to real ones
      const realShim = generatePosixShim(hintPath, fallbackExe, fallbackCli)
      writeFileSync(shimPath, realShim, 'utf8')
      chmodSync(shimPath, 0o755)

      const result = verifyCliInstall()
      expect(result.ok).toBe(true)
      expect(result.output).toContain('fallback 3.0.0')
    })
  })
})
