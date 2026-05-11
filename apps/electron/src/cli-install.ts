/**
 * Desktop CLI installation: shim creation, install-hint management, and PATH detection.
 *
 * The desktop app bundles the Forge CLI at `resources/cli/cli.js`. On install,
 * a lightweight shell shim (macOS/Linux) or `.cmd` wrapper (Windows) is written
 * to `~/.forge/bin/forge` that invokes the Electron executable with
 * `ELECTRON_RUN_AS_NODE=1` to run the CLI entrypoint — no ambient Node.js required.
 *
 * An install-hint file (`~/.forge/cli/install-hint`) is written on every app
 * launch and update so the shim can resolve the current Electron executable
 * path at invocation time without baked-in paths.
 */

import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const FORGE_DATA_DIRNAME = '.forge'
const CLI_SUBDIR = 'cli'
const BIN_SUBDIR = 'bin'
const HINT_FILENAME = 'install-hint'
const SHIM_NAME_POSIX = 'forge'
const SHIM_NAME_WIN_CMD = 'forge.cmd'
const SHIM_NAME_WIN_PS1 = 'forge.ps1'

const PACKAGED_CLI_RESOURCE_RELATIVE = path.join('cli', 'cli.js')

/* ------------------------------------------------------------------ */
/*  Result types                                                       */
/* ------------------------------------------------------------------ */

export interface CliInstallResult {
  success: boolean
  /** Absolute path to the installed shim. */
  installedPath: string
  /** Directory containing the shim. */
  binDir: string
  /** Whether binDir is already present on PATH. */
  pathIncluded: boolean
  /** Shell/PowerShell instructions for adding to PATH, or null when already included. */
  pathInstructions: string | null
  /** Error message when success is false. */
  error?: string
}

/* ------------------------------------------------------------------ */
/*  Hint file management                                               */
/* ------------------------------------------------------------------ */

interface InstallHint {
  electronExePath: string
  cliResourcePath: string
  version: string
}

function resolveForgeDataDir(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    if (localAppData) {
      return path.join(localAppData, 'forge')
    }
  }

  return path.join(app.getPath('home'), FORGE_DATA_DIRNAME)
}

function resolveInstallHintPath(): string {
  return path.join(resolveForgeDataDir(), CLI_SUBDIR, HINT_FILENAME)
}

export function resolveShimBinDir(): string {
  return path.join(resolveForgeDataDir(), BIN_SUBDIR)
}

function resolveCliResourcePath(): string {
  if (!app.isPackaged) {
    // Dev mode: use the repo-built CLI directly
    const repoRoot = path.resolve(__dirname, '..', '..', '..')
    return path.join(repoRoot, 'packages', 'cli', 'dist', 'cli.js')
  }

  return path.join(process.resourcesPath, PACKAGED_CLI_RESOURCE_RELATIVE)
}

function resolveElectronExePath(): string {
  if (app.isPackaged) {
    return app.getPath('exe')
  }

  // Dev mode: return the Electron binary from node_modules
  return process.execPath
}

/**
 * Write the install hint file. Called on every app launch and update
 * so the shim can discover the current Electron install location.
 */
export function writeInstallHint(): void {
  const hintPath = resolveInstallHintPath()
  const hint: InstallHint = {
    electronExePath: resolveElectronExePath(),
    cliResourcePath: resolveCliResourcePath(),
    version: app.getVersion(),
  }

  try {
    mkdirSync(path.dirname(hintPath), { recursive: true })
    // Use line-based key=value format for trivial shell/cmd parsing
    const content = [
      `electronExePath=${hint.electronExePath}`,
      `cliResourcePath=${hint.cliResourcePath}`,
      `version=${hint.version}`,
      '', // trailing newline
    ].join('\n')
    writeFileSync(hintPath, content, 'utf8')
  } catch (error) {
    console.warn('Failed to write CLI install hint:', error)
  }
}

function readInstallHint(): InstallHint | null {
  const hintPath = resolveInstallHintPath()

  try {
    if (!existsSync(hintPath)) {
      return null
    }

    const content = readFileSync(hintPath, 'utf8')
    const parsed: Record<string, string> = {}
    for (const line of content.split('\n')) {
      const eqIndex = line.indexOf('=')
      if (eqIndex > 0) {
        parsed[line.slice(0, eqIndex)] = line.slice(eqIndex + 1)
      }
    }

    if (!parsed.electronExePath || !parsed.cliResourcePath) {
      return null
    }

    return {
      electronExePath: parsed.electronExePath,
      cliResourcePath: parsed.cliResourcePath,
      version: parsed.version ?? '',
    }
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/*  PATH detection                                                     */
/* ------------------------------------------------------------------ */

function isBinDirOnPath(binDir: string): boolean {
  const pathEnv = process.env.PATH ?? ''
  const separator = process.platform === 'win32' ? ';' : ':'
  const normalizedBinDir = path.resolve(binDir)

  return pathEnv
    .split(separator)
    .some((entry) => path.resolve(entry) === normalizedBinDir)
}

function buildPathInstructions(binDir: string): string {
  if (process.platform === 'win32') {
    const escapedDir = binDir.replace(/'/g, "''")
    return [
      'Add the Forge CLI to your PATH:',
      '',
      'PowerShell (current user, persistent):',
      `  $p = [Environment]::GetEnvironmentVariable('PATH','User')`,
      `  [Environment]::SetEnvironmentVariable('PATH',"${escapedDir};$p",'User')`,
      '',
      'Then restart your terminal.',
    ].join('\n')
  }

  // macOS / Linux
  const shell = process.env.SHELL ?? '/bin/sh'
  const shellName = path.basename(shell)
  let rcFile: string

  switch (shellName) {
    case 'zsh':
      rcFile = '~/.zshrc'
      break
    case 'bash':
      rcFile = process.platform === 'darwin' ? '~/.bash_profile' : '~/.bashrc'
      break
    case 'fish':
      rcFile = '~/.config/fish/config.fish'
      break
    default:
      rcFile = `~/.${shellName}rc`
      break
  }

  if (shellName === 'fish') {
    return [
      `Add to ${rcFile}:`,
      '',
      `  fish_add_path ${binDir}`,
      '',
      'Then restart your terminal.',
    ].join('\n')
  }

  return [
    `Add to ${rcFile}:`,
    '',
    `  export PATH="${binDir}:$PATH"`,
    '',
    'Then restart your terminal or run:',
    `  source ${rcFile}`,
  ].join('\n')
}

/* ------------------------------------------------------------------ */
/*  Shim content generators                                            */
/* ------------------------------------------------------------------ */

function generatePosixShim(hintPath: string, fallbackElectronExe: string, fallbackCliResource: string): string {
  // The shim reads the hint file at invocation time so it survives app updates/moves.
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

function generateWindowsCmdShim(hintPath: string, fallbackElectronExe: string, fallbackCliResource: string): string {
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

function generateWindowsPs1Shim(hintPath: string, fallbackElectronExe: string, fallbackCliResource: string): string {
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

/* ------------------------------------------------------------------ */
/*  Platform-specific fallback paths                                   */
/* ------------------------------------------------------------------ */

function getPlatformFallbackPaths(): { electronExe: string; cliResource: string } {
  if (process.platform === 'darwin') {
    return {
      electronExe: '/Applications/Forge.app/Contents/MacOS/Forge',
      cliResource: '/Applications/Forge.app/Contents/Resources/cli/cli.js',
    }
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? ''
    return {
      electronExe: path.join(localAppData, 'Programs', 'Forge', 'Forge.exe'),
      cliResource: path.join(localAppData, 'Programs', 'Forge', 'resources', 'cli', 'cli.js'),
    }
  }

  // Linux fallback
  return {
    electronExe: '/usr/lib/forge/forge',
    cliResource: '/usr/lib/forge/resources/cli/cli.js',
  }
}

/* ------------------------------------------------------------------ */
/*  Main install function                                              */
/* ------------------------------------------------------------------ */

/**
 * Install (or update) the Forge CLI shim.
 *
 * 1. Ensures the install hint is current.
 * 2. Creates the shim in `~/.forge/bin/`.
 * 3. Returns the result with PATH status and instructions.
 */
export function installCli(): CliInstallResult {
  const binDir = resolveShimBinDir()
  const hintPath = resolveInstallHintPath()
  const fallback = getPlatformFallbackPaths()

  // Ensure hint is up-to-date
  writeInstallHint()

  try {
    mkdirSync(binDir, { recursive: true })

    if (process.platform === 'win32') {
      // Write .cmd (primary) and .ps1 (convenience)
      const cmdPath = path.join(binDir, SHIM_NAME_WIN_CMD)
      const ps1Path = path.join(binDir, SHIM_NAME_WIN_PS1)

      writeFileSync(cmdPath, generateWindowsCmdShim(hintPath, fallback.electronExe, fallback.cliResource), 'utf8')
      writeFileSync(ps1Path, generateWindowsPs1Shim(hintPath, fallback.electronExe, fallback.cliResource), 'utf8')

      const pathIncluded = isBinDirOnPath(binDir)

      return {
        success: true,
        installedPath: cmdPath,
        binDir,
        pathIncluded,
        pathInstructions: pathIncluded ? null : buildPathInstructions(binDir),
      }
    }

    // macOS / Linux
    const shimPath = path.join(binDir, SHIM_NAME_POSIX)
    writeFileSync(shimPath, generatePosixShim(hintPath, fallback.electronExe, fallback.cliResource), 'utf8')
    chmodSync(shimPath, 0o755)

    const pathIncluded = isBinDirOnPath(binDir)

    return {
      success: true,
      installedPath: shimPath,
      binDir,
      pathIncluded,
      pathInstructions: pathIncluded ? null : buildPathInstructions(binDir),
    }
  } catch (error) {
    return {
      success: false,
      installedPath: '',
      binDir,
      pathIncluded: false,
      pathInstructions: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Verify the installed CLI shim works by running `forge --version` through it.
 * Returns the version string on success, or an error message on failure.
 */
export function verifyCliInstall(): { ok: boolean; output: string } {
  const hint = readInstallHint()
  if (!hint) {
    return { ok: false, output: 'Install hint not found. Run "Install CLI" first.' }
  }

  if (!existsSync(hint.electronExePath)) {
    return { ok: false, output: `Electron executable not found: ${hint.electronExePath}` }
  }

  if (!existsSync(hint.cliResourcePath)) {
    return { ok: false, output: `CLI resource not found: ${hint.cliResourcePath}` }
  }

  try {
    const result = execFileSync(hint.electronExePath, [hint.cliResourcePath, '--version'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 10_000,
      encoding: 'utf8',
    })

    return { ok: true, output: result.trim() }
  } catch (error) {
    return {
      ok: false,
      output: error instanceof Error ? error.message : String(error),
    }
  }
}
