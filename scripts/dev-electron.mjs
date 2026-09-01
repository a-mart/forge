#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import {
  DEFAULT_FORCE_ARM_DELAY_MS,
  createElectronDevelopmentSupervisor,
  forceTerminateProcessTree,
  isChildRunning,
  waitForChildExit,
} from '../apps/electron/scripts/run-electron-dev.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(scriptPath), '..')
const electronDir = path.join(repoRoot, 'apps', 'electron')
const uiDir = path.join(repoRoot, 'apps', 'ui')
const uiRequire = createRequire(path.join(uiDir, 'package.json'))
const UI_PORT = 47_188
const BACKEND_PORT = 47_287
const UI_START_TIMEOUT_MS = 45_000

function resolveViteCliPath() {
  const vitePackagePath = uiRequire.resolve('vite/package.json')
  return path.join(path.dirname(vitePackagePath), 'bin', 'vite.js')
}

export function createElectronDevelopmentWorkspaceEnvironment({
  environment = process.env,
  remote = false,
} = {}) {
  return {
    ...environment,
    VITE_FORGE_WS_PORT: String(BACKEND_PORT),
    ...(remote
      ? {
          FORGE_HOST: '0.0.0.0',
          FORGE_DISABLE_TANSTACK_DEVTOOLS: 'true',
          VITE_FORGE_DISABLE_TANSTACK_DEVTOOLS: 'true',
        }
      : {}),
  }
}

export function createDevelopmentInterruptController({
  now = Date.now,
  forceArmDelayMs = DEFAULT_FORCE_ARM_DELAY_MS,
  onGracefulShutdown,
  onForceShutdown,
  logger = console,
} = {}) {
  let firstSignalAt = null

  return {
    handle(signal) {
      const receivedAt = now()
      if (firstSignalAt === null) {
        firstSignalAt = receivedAt
        logger.log(
          `[dev:electron] Received ${signal}; starting graceful shutdown. `
          + `Press Ctrl+C again after ${forceArmDelayMs}ms only to force termination.`,
        )
        onGracefulShutdown(signal)
        return 'graceful'
      }

      if (receivedAt - firstSignalAt < forceArmDelayMs) {
        logger.log('[dev:electron] Ignoring duplicate interrupt forwarded by the package runner.')
        return 'ignored'
      }

      logger.error(`[dev:electron] Received a second ${signal}; forcing shutdown.`)
      onForceShutdown(signal)
      return 'force'
    },
  }
}

function resolvePnpmInvocation(environment, platform) {
  const npmExecPath = environment.npm_execpath
  const npmExecPathExtension = typeof npmExecPath === 'string'
    ? path.extname(npmExecPath).toLowerCase()
    : ''
  if (['.js', '.cjs', '.mjs'].includes(npmExecPathExtension)) {
    return {
      command: process.execPath,
      prefixArgs: [npmExecPath],
    }
  }

  if (platform === 'win32') {
    return {
      command: environment.ComSpec || 'cmd.exe',
      prefixArgs: ['/d', '/s', '/c', 'pnpm.cmd'],
    }
  }

  return {
    command: 'pnpm',
    prefixArgs: [],
  }
}

export function createElectronDevelopmentSetupCommands({
  environment = process.env,
  platform = process.platform,
} = {}) {
  const pnpm = resolvePnpmInvocation(environment, platform)
  const pnpmCommand = (label, args) => ({
    label,
    command: pnpm.command,
    args: [...pnpm.prefixArgs, ...args],
    cwd: repoRoot,
  })
  const nodeScript = (label, relativePath) => ({
    label,
    command: process.execPath,
    args: [path.join(repoRoot, ...relativePath)],
    cwd: electronDir,
  })

  return [
    pnpmCommand('Workspace dependency sync', [
      'install',
      '--frozen-lockfile',
      '--prefer-offline',
    ]),
    pnpmCommand('Stream Deck build', ['run', 'streamdeck:build']),
    pnpmCommand('Stream Deck package', ['run', 'streamdeck:pack']),
    pnpmCommand('Protocol build', ['--filter', '@forge/protocol', 'build']),
    nodeScript('Electron runtime verification', ['apps', 'electron', 'scripts', 'verify-electron-runtime.mjs']),
    nodeScript('Electron native preparation', ['apps', 'electron', 'scripts', 'prepare-dev-native.mjs']),
    nodeScript('External Chrome development preparation', ['apps', 'electron', 'scripts', 'prepare-external-chrome-dev.mjs']),
    nodeScript('Electron main-process build', ['apps', 'electron', 'esbuild.config.mjs']),
  ]
}

function runCommand(command, {
  environment,
  platform,
  spawnProcess,
  onChild,
}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command.command, command.args, {
      cwd: command.cwd,
      env: environment,
      stdio: 'inherit',
      detached: platform !== 'win32',
      windowsHide: false,
    })
    onChild(child)
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(
        `${command.label} exited ${code === null ? `from signal ${String(signal)}` : `with code ${code}`}`,
      ))
    })
  })
}

function probeTcpPort(port, timeoutMs = 750) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let settled = false
    const finish = (reachable) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(reachable)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

async function assertPortAvailable(port) {
  if (await probeTcpPort(port)) {
    throw new Error(`Port ${port} is already in use; stop the existing Forge process before starting another.`)
  }
}

async function waitForUiReady(child, {
  timeoutMs = UI_START_TIMEOUT_MS,
  getSpawnError = () => null,
} = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const spawnError = getSpawnError()
    if (spawnError) throw spawnError
    if (!isChildRunning(child)) {
      throw new Error('UI development server exited before becoming ready')
    }
    if (await probeTcpPort(UI_PORT)) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`UI development server did not listen on port ${UI_PORT} within ${timeoutMs}ms`)
}

async function terminateChildAndWait(child, options) {
  if (!isChildRunning(child)) return
  await options.forceTerminate(child, {
    platform: options.platform,
    onError: (error) => {
      options.logger.error(
        `[dev:electron] Failed to terminate process tree ${String(child.pid)}: ${error instanceof Error ? error.message : String(error)}`,
      )
    },
  })
  await waitForChildExit(child, 5_000)
}

export async function runElectronDevelopmentWorkspace({
  remote = false,
  environment = process.env,
  platform = process.platform,
  signalSource = process,
  logger = console,
  now = Date.now,
  spawnProcess = spawn,
  forceTerminate = forceTerminateProcessTree,
  createSupervisor = createElectronDevelopmentSupervisor,
  setupCommands = createElectronDevelopmentSetupCommands({ environment, platform }),
} = {}) {
  const workspaceEnvironment = createElectronDevelopmentWorkspaceEnvironment({
    environment,
    remote,
  })
  const signalNames = platform === 'win32'
    ? ['SIGINT', 'SIGBREAK']
    : ['SIGINT', 'SIGTERM', 'SIGHUP']
  let activeSetupChild = null
  let uiChild = null
  let electronSupervisor = null
  let interrupted = false
  let startupInterruptCode = 0
  let resolveStartupInterrupt
  const startupInterrupt = new Promise((resolve) => {
    resolveStartupInterrupt = resolve
  })

  const cleanupStartupChildren = async () => {
    await Promise.all([
      terminateChildAndWait(activeSetupChild, { platform, forceTerminate, logger }),
      terminateChildAndWait(uiChild, { platform, forceTerminate, logger }),
    ])
  }

  const interruptController = createDevelopmentInterruptController({
    now,
    logger,
    onGracefulShutdown: (signal) => {
      interrupted = true
      startupInterruptCode = signal === 'SIGBREAK' ? 131 : 0
      if (electronSupervisor) {
        electronSupervisor.requestShutdown(`Received ${signal}`, 0)
        return
      }
      void cleanupStartupChildren().finally(() => resolveStartupInterrupt(startupInterruptCode))
    },
    onForceShutdown: (signal) => {
      interrupted = true
      startupInterruptCode = signal === 'SIGBREAK' ? 131 : 130
      if (electronSupervisor) {
        void electronSupervisor.forceShutdown(`Received a second ${signal}`, startupInterruptCode)
      }
      void cleanupStartupChildren().finally(() => resolveStartupInterrupt(startupInterruptCode))
    },
  })
  const handleSignal = (signal) => interruptController.handle(signal)
  const signalListeners = new Map(
    signalNames.map((signal) => [signal, () => handleSignal(signal)]),
  )

  for (const [signal, listener] of signalListeners) signalSource.on(signal, listener)

  try {
    await assertPortAvailable(UI_PORT)
    await assertPortAvailable(BACKEND_PORT)

    for (const command of setupCommands) {
      if (interrupted) return await startupInterrupt
      logger.log(`[dev:electron] ${command.label}...`)
      await runCommand(command, {
        environment: workspaceEnvironment,
        platform,
        spawnProcess,
        onChild: (child) => {
          activeSetupChild = child
        },
      })
      activeSetupChild = null
    }

    if (interrupted) return await startupInterrupt

    logger.log(`[dev:electron] Starting UI on http://127.0.0.1:${UI_PORT}...`)
    const viteCliPath = resolveViteCliPath()
    let uiSpawnError = null
    uiChild = spawnProcess(process.execPath, [viteCliPath, 'dev', '--port', String(UI_PORT), '--strictPort'], {
      cwd: uiDir,
      env: workspaceEnvironment,
      stdio: 'inherit',
      detached: platform !== 'win32',
      windowsHide: false,
    })
    uiChild.on('error', (error) => {
      uiSpawnError = error
      electronSupervisor?.requestShutdown(
        `UI development server failed: ${error instanceof Error ? error.message : String(error)}`,
        1,
      )
    })
    let uiExit = null
    uiChild.once('exit', (code, signal) => {
      uiExit = { code, signal }
      if (interrupted || !electronSupervisor) return
      electronSupervisor.requestShutdown(
        `UI development server exited ${code === null ? `from signal ${String(signal)}` : `with code ${code}`}`,
        code === 0 ? 1 : (code ?? 1),
      )
    })
    await waitForUiReady(uiChild, { getSpawnError: () => uiSpawnError })

    if (interrupted) return await startupInterrupt

    logger.log('[dev:electron] Starting Forge Desktop...')
    electronSupervisor = createSupervisor({
      environment: workspaceEnvironment,
      platform,
      signalSource: null,
      logger,
    })
    if (uiExit && !interrupted) {
      const { code, signal } = uiExit
      electronSupervisor.requestShutdown(
        `UI development server exited ${code === null ? `from signal ${String(signal)}` : `with code ${code}`}`,
        code === 0 ? 1 : (code ?? 1),
      )
    }

    const exitCode = await electronSupervisor.completion
    await terminateChildAndWait(uiChild, { platform, forceTerminate, logger })
    return exitCode
  } catch (error) {
    if (interrupted) {
      if (electronSupervisor) return electronSupervisor.completion
      return await startupInterrupt
    }

    logger.error(`[dev:electron] ${error instanceof Error ? error.message : String(error)}`)
    if (electronSupervisor) {
      electronSupervisor.requestShutdown('Startup failed', 1)
      const exitCode = await electronSupervisor.completion
      await terminateChildAndWait(uiChild, { platform, forceTerminate, logger })
      return exitCode || 1
    }
    await cleanupStartupChildren()
    return 1
  } finally {
    for (const [signal, listener] of signalListeners) signalSource.off(signal, listener)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  runElectronDevelopmentWorkspace({
    remote: process.argv.includes('--remote'),
  }).then((exitCode) => {
    process.exitCode = exitCode
  }).catch((error) => {
    console.error(`[dev:electron] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
