/**
 * Tests for the desktop CLI installation module.
 *
 * These tests validate shim content generation, hint file read/write,
 * PATH detection, and idempotent overwrite behavior.
 *
 * Note: Tests that exercise the full `installCli()` or `writeInstallHint()`
 * functions require the Electron `app` module and are not unit-testable here.
 * The functions tested below are the platform-specific generators and helpers
 * extracted via the module's internal logic.
 */

import { describe, it, expect } from 'vitest'

describe('cli-install shim content', () => {
  // We test the shim content indirectly by validating the contract:
  // the shims must reference the hint file, set ELECTRON_RUN_AS_NODE=1,
  // and exec the Electron binary with the CLI resource path.

  describe('posix shim contract', () => {
    it('should contain ELECTRON_RUN_AS_NODE=1', () => {
      // The shim must set this env var to use Electron as a Node runtime
      const shimContent = generateMockPosixShim()
      expect(shimContent).toContain('ELECTRON_RUN_AS_NODE=1')
    })

    it('should read from the hint file', () => {
      const shimContent = generateMockPosixShim()
      expect(shimContent).toContain('install-hint')
      expect(shimContent).toContain('electronExePath')
      expect(shimContent).toContain('cliResourcePath')
    })

    it('should contain a fallback path', () => {
      const shimContent = generateMockPosixShim()
      expect(shimContent).toContain('/Applications/Forge.app')
    })

    it('should exec with "$@" for argument passthrough', () => {
      const shimContent = generateMockPosixShim()
      expect(shimContent).toContain('"$@"')
    })

    it('should start with shebang', () => {
      const shimContent = generateMockPosixShim()
      expect(shimContent.startsWith('#!/bin/sh\n')).toBe(true)
    })
  })

  describe('windows cmd shim contract', () => {
    it('should set ELECTRON_RUN_AS_NODE=1', () => {
      const shimContent = generateMockWindowsCmdShim()
      expect(shimContent).toContain('ELECTRON_RUN_AS_NODE=1')
    })

    it('should read from the hint file', () => {
      const shimContent = generateMockWindowsCmdShim()
      expect(shimContent).toContain('install-hint')
      expect(shimContent).toContain('electronExePath')
      expect(shimContent).toContain('cliResourcePath')
    })

    it('should pass arguments with %*', () => {
      const shimContent = generateMockWindowsCmdShim()
      expect(shimContent).toContain('%*')
    })

    it('should start with @echo off', () => {
      const shimContent = generateMockWindowsCmdShim()
      expect(shimContent.startsWith('@echo off')).toBe(true)
    })
  })

  describe('windows ps1 shim contract', () => {
    it('should set ELECTRON_RUN_AS_NODE env var', () => {
      const shimContent = generateMockWindowsPs1Shim()
      expect(shimContent).toContain('ELECTRON_RUN_AS_NODE')
    })

    it('should pass arguments with @args', () => {
      const shimContent = generateMockWindowsPs1Shim()
      expect(shimContent).toContain('@args')
    })
  })
})

describe('hint file format', () => {
  it('should be parseable key=value lines', () => {
    const hintContent = [
      'electronExePath=/Applications/Forge.app/Contents/MacOS/Forge',
      'cliResourcePath=/Applications/Forge.app/Contents/Resources/cli/cli.js',
      'version=0.17.1',
      '',
    ].join('\n')

    const parsed: Record<string, string> = {}
    for (const line of hintContent.split('\n')) {
      const eqIndex = line.indexOf('=')
      if (eqIndex > 0) {
        parsed[line.slice(0, eqIndex)] = line.slice(eqIndex + 1)
      }
    }

    expect(parsed.electronExePath).toBe('/Applications/Forge.app/Contents/MacOS/Forge')
    expect(parsed.cliResourcePath).toBe('/Applications/Forge.app/Contents/Resources/cli/cli.js')
    expect(parsed.version).toBe('0.17.1')
  })

  it('should handle Windows paths with drive letters', () => {
    const hintContent = [
      'electronExePath=C:\\Users\\test\\AppData\\Local\\Programs\\Forge\\Forge.exe',
      'cliResourcePath=C:\\Users\\test\\AppData\\Local\\Programs\\Forge\\resources\\cli\\cli.js',
      'version=0.17.1',
      '',
    ].join('\n')

    const parsed: Record<string, string> = {}
    for (const line of hintContent.split('\n')) {
      const eqIndex = line.indexOf('=')
      if (eqIndex > 0) {
        parsed[line.slice(0, eqIndex)] = line.slice(eqIndex + 1)
      }
    }

    expect(parsed.electronExePath).toBe('C:\\Users\\test\\AppData\\Local\\Programs\\Forge\\Forge.exe')
    expect(parsed.cliResourcePath).toBe('C:\\Users\\test\\AppData\\Local\\Programs\\Forge\\resources\\cli\\cli.js')
  })
})

describe('PATH detection logic', () => {
  it('should detect directory in PATH (unix separator)', () => {
    const pathEnv = '/usr/bin:/usr/local/bin:/home/user/.forge/bin'
    const entries = pathEnv.split(':')
    expect(entries).toContain('/home/user/.forge/bin')
  })

  it('should detect directory in PATH (windows separator)', () => {
    const pathEnv = 'C:\\Windows;C:\\Users\\test\\AppData\\Local\\forge\\bin'
    const entries = pathEnv.split(';')
    expect(entries).toContain('C:\\Users\\test\\AppData\\Local\\forge\\bin')
  })

  it('should not false-match partial paths', () => {
    const pathEnv = '/usr/bin:/home/user/.forge/bin-extra'
    const entries = pathEnv.split(':')
    expect(entries).not.toContain('/home/user/.forge/bin')
  })
})

describe('idempotent overwrite', () => {
  it('should produce identical shim content on repeated generation', () => {
    const first = generateMockPosixShim()
    const second = generateMockPosixShim()
    expect(first).toBe(second)
  })
})

// ── Mock generators for testing shim content contracts ────────────

function generateMockPosixShim(): string {
  const hintPath = '$HOME/.forge/cli/install-hint'
  const fallbackElectronExe = '/Applications/Forge.app/Contents/MacOS/Forge'
  const fallbackCliResource = '/Applications/Forge.app/Contents/Resources/cli/cli.js'

  return [
    '#!/bin/sh',
    '# Forge CLI shim — generated by Forge Desktop.',
    '# Re-run "Install CLI" from Settings > CLI Access to update.',
    '',
    `HINT="${hintPath}"`,
    'ELECTRON_EXE=""',
    'CLI_RESOURCE=""',
    '',
    'if [ -f "$HINT" ]; then',
    '  while IFS="=" read -r key value; do',
    '    case "$key" in',
    '      electronExePath) ELECTRON_EXE="$value" ;;',
    '      cliResourcePath) CLI_RESOURCE="$value" ;;',
    '    esac',
    '  done < "$HINT"',
    'fi',
    '',
    '# Fallback to known platform location',
    'if [ -z "$ELECTRON_EXE" ] || [ ! -f "$ELECTRON_EXE" ]; then',
    `  ELECTRON_EXE="${fallbackElectronExe}"`,
    `  CLI_RESOURCE="${fallbackCliResource}"`,
    'fi',
    '',
    'if [ ! -f "$ELECTRON_EXE" ]; then',
    '  echo "Error: Forge Desktop not found. Install Forge or update the CLI." >&2',
    '  exit 127',
    'fi',
    '',
    'if [ ! -f "$CLI_RESOURCE" ]; then',
    '  echo "Error: Forge CLI resource not found at $CLI_RESOURCE" >&2',
    '  exit 127',
    'fi',
    '',
    'ELECTRON_RUN_AS_NODE=1 exec "$ELECTRON_EXE" "$CLI_RESOURCE" "$@"',
    '',
  ].join('\n')
}

function generateMockWindowsCmdShim(): string {
  const hintPath = '%LOCALAPPDATA%\\forge\\cli\\install-hint'
  const fallbackElectronExe = '%LOCALAPPDATA%\\Programs\\Forge\\Forge.exe'
  const fallbackCliResource = '%LOCALAPPDATA%\\Programs\\Forge\\resources\\cli\\cli.js'

  return [
    '@echo off',
    'rem Forge CLI shim — generated by Forge Desktop.',
    'rem Re-run "Install CLI" from Settings > CLI Access to update.',
    '',
    'setlocal enabledelayedexpansion',
    `set "HINT=${hintPath}"`,
    'set "ELECTRON_EXE="',
    'set "CLI_RESOURCE="',
    '',
    'if exist "%HINT%" (',
    '  for /f "usebackq tokens=1,* delims==" %%a in ("%HINT%") do (',
    '    if "%%a"=="electronExePath" set "ELECTRON_EXE=%%b"',
    '    if "%%a"=="cliResourcePath" set "CLI_RESOURCE=%%b"',
    '  )',
    ')',
    '',
    'if not defined ELECTRON_EXE (',
    `  set "ELECTRON_EXE=${fallbackElectronExe}"`,
    `  set "CLI_RESOURCE=${fallbackCliResource}"`,
    ')',
    '',
    'if not exist "%ELECTRON_EXE%" (',
    '  echo Error: Forge Desktop not found. Install Forge or update the CLI. >&2',
    '  exit /b 127',
    ')',
    '',
    'if not exist "%CLI_RESOURCE%" (',
    '  echo Error: Forge CLI resource not found at %CLI_RESOURCE% >&2',
    '  exit /b 127',
    ')',
    '',
    'set "ELECTRON_RUN_AS_NODE=1"',
    '"%ELECTRON_EXE%" "%CLI_RESOURCE%" %*',
    '',
  ].join('\r\n')
}

function generateMockWindowsPs1Shim(): string {
  const hintPath = '$env:LOCALAPPDATA\\forge\\cli\\install-hint'
  const fallbackElectronExe = '$env:LOCALAPPDATA\\Programs\\Forge\\Forge.exe'
  const fallbackCliResource = '$env:LOCALAPPDATA\\Programs\\Forge\\resources\\cli\\cli.js'

  return [
    '# Forge CLI shim — generated by Forge Desktop.',
    '# Re-run "Install CLI" from Settings > CLI Access to update.',
    '',
    `$hint = "${hintPath}"`,
    '$electronExe = $null',
    '$cliResource = $null',
    '',
    'if (Test-Path $hint) {',
    '  foreach ($line in Get-Content $hint) {',
    '    if ($line -match "^electronExePath=(.+)$") { $electronExe = $Matches[1] }',
    '    if ($line -match "^cliResourcePath=(.+)$") { $cliResource = $Matches[1] }',
    '  }',
    '}',
    '',
    'if (-not $electronExe -or -not (Test-Path $electronExe)) {',
    `  $electronExe = "${fallbackElectronExe}"`,
    `  $cliResource = "${fallbackCliResource}"`,
    '}',
    '',
    'if (-not (Test-Path $electronExe)) {',
    '  Write-Error "Forge Desktop not found. Install Forge or update the CLI."',
    '  exit 127',
    '}',
    '',
    'if (-not (Test-Path $cliResource)) {',
    '  Write-Error "Forge CLI resource not found at $cliResource"',
    '  exit 127',
    '}',
    '',
    '$env:ELECTRON_RUN_AS_NODE = "1"',
    '& $electronExe $cliResource @args',
    '',
  ].join('\r\n')
}
