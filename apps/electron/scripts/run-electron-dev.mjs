import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ELECTRON_DEVELOPMENT_SHUTDOWN_MESSAGE = 'forge:electron-development-shutdown'
export const DEFAULT_ELECTRON_SHUTDOWN_TIMEOUT_MS = 35_000
export const DEFAULT_FORCE_ARM_DELAY_MS = 1_500

const scriptPath = fileURLToPath(import.meta.url)
const electronDir = path.resolve(path.dirname(scriptPath), '..')
const electronRequire = createRequire(path.join(electronDir, 'package.json'))

export function createElectronDevelopmentEnvironment(environment = process.env) {
  const childEnvironment = { ...environment }
  delete childEnvironment.ELECTRON_RUN_AS_NODE
  return childEnvironment
}

export function isChildRunning(child) {
  return Boolean(
    child
    && Number.isInteger(child.pid)
    && child.pid > 0
    && child.exitCode === null
    && child.signalCode === null,
  )
}

export function launchElectronDevelopment({
  environment = process.env,
  executable = electronRequire('electron'),
  cwd = electronDir,
  platform = process.platform,
  spawnElectron = spawn,
} = {}) {
  return spawnElectron(executable, ['.'], {
    cwd,
    env: createElectronDevelopmentEnvironment(environment),
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    // Keep terminal Ctrl+C on the supervising Node process. The supervisor
    // asks Electron to quit over IPC so Electron can stop its backend before
    // exiting instead of receiving Windows' console interrupt concurrently.
    // windowsHide must remain false: on Windows it can suppress Electron's
    // actual application window, not only a console window.
    detached: true,
    windowsHide: false,
  })
}

export function requestElectronDevelopmentShutdown(child, { onError = () => {} } = {}) {
  if (!isChildRunning(child) || child.connected !== true || typeof child.send !== 'function') {
    return false
  }

  try {
    child.send(
      { type: ELECTRON_DEVELOPMENT_SHUTDOWN_MESSAGE },
      (error) => {
        if (error) onError(error)
      },
    )
    return true
  } catch (error) {
    onError(error)
    return false
  }
}

export function waitForChildExit(child, timeoutMs) {
  if (!isChildRunning(child)) {
    return Promise.resolve(true)
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (exited) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.off?.('exit', onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    const timeout = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
  })
}

export async function forceTerminateProcessTree(child, {
  platform = process.platform,
  spawnProcess = spawn,
  killProcess = process.kill,
  onError = () => {},
} = {}) {
  if (!isChildRunning(child)) {
    return false
  }

  const pid = child.pid
  try {
    if (platform === 'win32') {
      await new Promise((resolve) => {
        const taskkill = spawnProcess(
          'taskkill.exe',
          ['/PID', String(pid), '/T', '/F'],
          { stdio: 'ignore', windowsHide: true },
        )
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          resolve()
        }
        const timeout = setTimeout(() => {
          try {
            taskkill.kill()
          } catch {
            // The bounded taskkill subprocess is already gone.
          }
          finish()
        }, 5_000)
        taskkill.once('error', (error) => {
          onError(error)
          finish()
        })
        taskkill.once('exit', finish)
      })
    } else {
      killProcess(-pid, 'SIGKILL')
    }
    return true
  } catch (error) {
    if (error?.code !== 'ESRCH') onError(error)
    return false
  }
}

export function createElectronDevelopmentSupervisor({
  environment = process.env,
  platform = process.platform,
  signalSource = process,
  logger = console,
  now = Date.now,
  shutdownTimeoutMs = DEFAULT_ELECTRON_SHUTDOWN_TIMEOUT_MS,
  forceArmDelayMs = DEFAULT_FORCE_ARM_DELAY_MS,
  launchElectron = launchElectronDevelopment,
  forceTerminate = forceTerminateProcessTree,
} = {}) {
  const child = launchElectron({ environment, platform })
  let stopping = false
  let settled = false
  let firstSignalAt = null
  let requestedExitCode = 0
  let forcedExitCode = null
  let shutdownTimer = null
  let forcePromise = null
  let resolveCompletion
  const completion = new Promise((resolve) => {
    resolveCompletion = resolve
  })

  const signalNames = platform === 'win32'
    ? ['SIGINT', 'SIGBREAK']
    : ['SIGINT', 'SIGTERM', 'SIGHUP']
  const signalListeners = new Map(
    signalNames.map((signal) => [signal, () => handleSignal(signal)]),
  )

  const removeSignalListeners = () => {
    if (!signalSource) return
    for (const [signal, listener] of signalListeners) {
      signalSource.off(signal, listener)
    }
  }

  const finish = (exitCode) => {
    if (settled) return
    settled = true
    if (shutdownTimer) clearTimeout(shutdownTimer)
    removeSignalListeners()
    resolveCompletion(exitCode)
  }

  const forceShutdown = async (reason, exitCode = 1) => {
    if (settled) return completion
    stopping = true
    forcedExitCode = exitCode
    if (!forcePromise) {
      forcePromise = (async () => {
        logger.error(`[electron/dev] ${reason}; force-terminating Electron process tree.`)
        await forceTerminate(child, {
          platform,
          onError: (error) => {
            logger.error(`[electron/dev] Force termination failed: ${error instanceof Error ? error.message : String(error)}`)
          },
        })
        if (!await waitForChildExit(child, 5_000)) {
          logger.error('[electron/dev] Electron process did not report exit after force termination.')
        }
        finish(exitCode)
      })()
    }
    await forcePromise
    return completion
  }

  const requestShutdown = (reason, exitCode = 0) => {
    if (settled) return completion
    if (exitCode !== 0) requestedExitCode = exitCode
    if (stopping) return completion

    stopping = true
    logger.log(`[electron/dev] ${reason}; waiting for Forge Desktop to shut down cleanly...`)
    const delivered = requestElectronDevelopmentShutdown(child, {
      onError: (error) => {
        logger.error(`[electron/dev] Graceful shutdown IPC failed: ${error instanceof Error ? error.message : String(error)}`)
      },
    })
    if (!delivered && platform !== 'win32' && isChildRunning(child)) {
      try {
        child.kill('SIGINT')
      } catch (error) {
        logger.error(`[electron/dev] Graceful shutdown signal failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    shutdownTimer = setTimeout(() => {
      void forceShutdown(
        `Graceful shutdown exceeded ${shutdownTimeoutMs}ms`,
        requestedExitCode || 1,
      )
    }, shutdownTimeoutMs)
    return completion
  }

  function handleSignal(signal) {
    const receivedAt = now()
    if (firstSignalAt === null) {
      firstSignalAt = receivedAt
      if (stopping) {
        logger.log('[electron/dev] Shutdown is already in progress; waiting for cleanup.')
      } else {
        requestShutdown(`Received ${signal}`, 0)
      }
      return
    }

    if (receivedAt - firstSignalAt < forceArmDelayMs) {
      logger.log('[electron/dev] Ignoring duplicate interrupt forwarded by the package runner.')
      return
    }

    void forceShutdown(`Received a second ${signal}`, signal === 'SIGBREAK' ? 131 : 130)
  }

  if (signalSource) {
    for (const [signal, listener] of signalListeners) {
      signalSource.on(signal, listener)
    }
  }

  child.once('error', (error) => {
    logger.error(`[electron/dev] Electron failed to start: ${error instanceof Error ? error.message : String(error)}`)
    finish(1)
  })
  child.once('exit', (code, signal) => {
    if (stopping) {
      logger.log('[electron/dev] Forge Desktop shutdown complete.')
      finish(forcedExitCode ?? requestedExitCode)
      return
    }
    if (code !== 0) {
      logger.error(`[electron/dev] Electron exited ${code === null ? `from signal ${String(signal)}` : `with code ${code}`}.`)
    }
    finish(code ?? 1)
  })

  return {
    child,
    completion,
    requestShutdown,
    forceShutdown,
    handleSignal,
  }
}

export async function runElectronDevelopmentCli(options = {}) {
  const supervisor = createElectronDevelopmentSupervisor(options)
  return supervisor.completion
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  runElectronDevelopmentCli().then((exitCode) => {
    process.exitCode = exitCode
  }).catch((error) => {
    console.error(`[electron/dev] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
