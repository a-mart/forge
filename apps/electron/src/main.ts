import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, protocol, safeStorage, shell } from 'electron'
import { fork, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkForUpdatesManually, downloadUpdateManually, installUpdateManually, initAutoUpdater, getBetaChannel, setBetaChannel, type UpdateQuiesceHook } from './auto-updater.js'
import { installCli, verifyCliInstall, writeInstallHint, type CliInstallResult } from './cli-install.js'
import { buildCommandCenterRouteUrl, buildSkillImportRouteUrl, findCommandCenterDeepLinkInArgs, findSkillImportUrlInArgs, parseCommandCenterDeepLink, parseSkillImportDeepLink, shouldRegisterExternalDeepLinkProtocol } from './deep-link.js'
import { fixPath } from './fix-path.js'
import { SleepBlockerService, type SleepBlockerSettingsPatch, type SleepBlockerStatus } from './sleep-blocker.js'
import { sendSleepBlockerStatusToWindow } from './sleep-blocker-status-ipc.js'
import { sendToRendererWindow } from './renderer-ipc.js'
import {
  installMainRendererRecovery,
  MAIN_RENDERER_READY_CHANNEL,
  type MainRendererRecoveryController,
} from './main-renderer-recovery.js'
import { loadWindowState, trackWindowState } from './window-state.js'
import { showWhatsNewIfUpdated } from './whats-new.js'
import { createBackendForkOptions } from './backend-fork-options.js'
import { resolveDevBetterSqlite3Binding } from './dev-native-binding.js'
import { PackagedRemoteUiServer, resolvePackagedRemoteUiHost, startOptionalPackagedRemoteUi } from './packaged-remote-ui-server.js'
import type { BrowserAutomationRequest, BrowserTabSnapshot } from '@forge/protocol'
import { BrowserAutomationManager } from './browser/browser-automation-manager.js'
import { installBrowserIpc } from './browser/browser-ipc.js'
import { BrowserSessionRegistry } from './browser/browser-session.js'
import { ManagedBrowserViewHost } from './browser/managed-browser-view-host.js'
import { installBrowserWorkspaceIpc } from './browser/browser-workspace-ipc.js'
import { isDockManagedBrowserShortcut, isManagedBrowserPopoutAvailable } from './browser/managed-browser-platform.js'
import type { ManagedBrowserWorkspaceMode } from './browser/browser-bridge-contract.js'
import { LifecycleLog } from './lifecycle-log.js'
import { installElectronDevelopmentProcessControl } from './dev-process-control.js'
import {
  createSecureVaultController,
  initializeSecureVaultAtStartup,
  installSecureVaultChildBridge,
  installSecureVaultRendererIpc,
} from './secure-vault-ipc.js'
import { applyElectronStartupOverrides } from './startup-overrides.js'
import { validateAbsoluteLocalFilePath } from './open-path.js'
import { installOpenPdfIpc } from './open-pdf.js'
import { handleMainRendererWindowOpen, isUnsafeRendererWindowOpenUrl } from './window-open-policy.js'
import { ExternalChromeDeployer } from './external-chrome/deployer.js'
import { ExternalChromeDeploymentRecovery } from './external-chrome/recovery.js'
import { ExternalChromeHostCoordinator } from './external-chrome/coordinator.js'
import { resolveExternalChromeResources, type ExternalChromeResourceLocation } from './external-chrome/resources.js'
import { ExternalChromeTargetAdapter } from './browser/external-chrome-target-adapter.js'
import { installExternalChromeIpc } from './external-chrome/ipc.js'
import { getStreamDeckPluginStatus, resolveStreamDeckAppPath, resolveStreamDeckPluginPath } from './stream-deck-install.js'

// Load .env from repo root so FORGE_PORT etc. are available in main process
loadDotEnv()

const electronStartupOverrides = applyElectronStartupOverrides({
  app,
  env: process.env,
})
const electronDevServerUrl = electronStartupOverrides.devServerUrl
const DEFAULT_BACKEND_PORT = 47287
const BACKEND_READY_CHANNEL = 'forge:get-backend-bootstrap'
const TERMINAL_SHORTCUT_CHANNEL = 'bridge:terminal-shortcut'
// Secure Session teardown includes confirmed Docker removal. Give the backend
// enough time to complete its bounded cleanup contract before escalating to a
// process-tree kill.
const BACKEND_SHUTDOWN_TIMEOUT_MS = 30_000
const BACKEND_RESTART_DELAY_MS = 1_000
const BACKEND_LOG_TAIL_LINES = 40
const BACKEND_LOG_FILENAME = 'backend.log'
const LIFECYCLE_LOG_FILENAME = 'lifecycle.log'
const PACKAGED_BACKEND_DIRNAME = 'backend'
const PACKAGED_RENDERER_DIRNAME = 'ui'
const PACKAGED_RESOURCES_DIRNAME = 'forge-resources'
const APP_PROTOCOL_SCHEME = 'app'
const APP_PROTOCOL_HOST = 'forge'
const EXTERNAL_PROTOCOL_SCHEME = 'forge'
const ELECTRON_STARTED_AT = new Date(Date.now() - process.uptime() * 1_000).toISOString()

type BackendReadyMessage = {
  type: 'ready'
  port: number
  /** Optional for compatibility with older backend children. */
  dataDir?: string
}

type BackendBootstrap = {
  backendUrl: string
  backendWsUrl: string
  version: string
  platform: string
  appRuntime: 'development' | 'installed'
  appStartedAt: string
  windowRole: 'main' | 'managed-browser-popout'
  managedBrowserPopoutAvailable: boolean
  secureControlToken: string
  /** Backend-resolved, post-migration canonical root. Optional for old Desktop clients. */
  dataDir?: string
}

let mainWindow: BrowserWindow | null = null
let mainRendererRecovery: MainRendererRecoveryController | null = null
let browserPopoutWindow: BrowserWindow | null = null
let browserViewHost: ManagedBrowserViewHost | null = null
let browserWorkspaceIpc: ReturnType<typeof installBrowserWorkspaceIpc> | null = null
let browserWorkspaceMode: ManagedBrowserWorkspaceMode = isManagedBrowserPopoutAvailable() ? 'docked' : 'unavailable'
let browserTransition: Promise<ManagedBrowserWorkspaceMode> = Promise.resolve(browserWorkspaceMode)
let allowPopoutClose = false
let mainWindowClosing = false
let backendBootstrap: BackendBootstrap | null = null
let appIsQuitting = false
let appProtocolRegistered = false
let disposeBrowserHost: (() => void) | null = null
let disposeExternalChromeIpc: (() => void) | null = null
let disposeOpenPdfIpc: (() => void) | null = null
let externalChromeCoordinator: ExternalChromeHostCoordinator | null = null
let externalChromeDeployer: ExternalChromeDeployer | null = null
const browserSessions = new BrowserSessionRegistry()
let pendingSkillImportUrl: string | null = findSkillImportUrlInArgs(process.argv)
let pendingCommandCenterDeepLink: string | null = findCommandCenterDeepLinkInArgs(process.argv)
const lifecycleLog = new LifecycleLog({
  getLogPath: () => path.join(app.getPath('userData'), LIFECYCLE_LOG_FILENAME),
})
const secureVaultController = createSecureVaultController({
  safeStorage,
  platform: process.platform,
})
const handledTerminationSignals = new Set<NodeJS.Signals>()
const externalChromeUpdateQuiesceHook: UpdateQuiesceHook = {
  quiesce: async () => externalChromeCoordinator?.quiesce('desktop-update'),
}

app.commandLine.appendSwitch('disable-background-timer-throttling')

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_PROTOCOL_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
])

class BackendSupervisor {
  private child: ChildProcess | null = null
  private currentPort: number | null = null
  private currentDataDir: string | null = null
  private startPromise: Promise<number> | null = null
  private stopping = false
  private restartTimer: NodeJS.Timeout | null = null
  private backendLogPath: string | null = null
  private readonly recentOutputLines: string[] = []
  private stdoutRemainder = ''
  private stderrRemainder = ''
  private readonly secureControlToken = randomBytes(32).toString('base64url')

  constructor(private readonly onReady: (port: number, isRestart: boolean) => void) {}

  get bootstrap(): BackendBootstrap {
    if (this.currentPort == null) {
      throw new Error('Backend bootstrap requested before backend was ready')
    }

    return buildBackendBootstrap(
      this.currentPort,
      this.currentDataDir ?? undefined,
      this.secureControlToken,
    )
  }

  get currentBackendPort(): number {
    if (this.currentPort == null) {
      throw new Error('Backend port requested before backend was ready')
    }
    return this.currentPort
  }

  get logPath(): string | null {
    return this.ensureBackendLogPath()
  }

  getRecentOutput(lines = BACKEND_LOG_TAIL_LINES): string {
    const recentLines = this.recentOutputLines.slice(-lines)
    return recentLines.join('\n')
  }

  async start(): Promise<number> {
    if (this.startPromise) {
      return this.startPromise
    }

    const isRestart = this.currentPort != null
    this.stopping = false
    lifecycleLog.record('backend_launch_requested', { isRestart })
    this.startPromise = this.launch(isRestart).finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  async stop(): Promise<void> {
    this.stopping = true

    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }

    const child = this.child
    if (!child) {
      return
    }

    lifecycleLog.record('backend_shutdown_requested', { pid: child.pid ?? null })

    this.child = null

    await new Promise<void>((resolve) => {
      let settled = false

      const finish = (): void => {
        if (settled) {
          return
        }

        settled = true
        resolve()
      }

      const timeout = setTimeout(() => {
        lifecycleLog.record('backend_shutdown_timeout', { pid: child.pid ?? null })
        void this.forceTerminate(child).finally(() => {
          finish()
        })
      }, BACKEND_SHUTDOWN_TIMEOUT_MS)

      child.once('exit', () => {
        clearTimeout(timeout)
        lifecycleLog.record('backend_shutdown_completed', { pid: child.pid ?? null })
        finish()
      })

      try {
        child.send({ type: 'shutdown' })
      } catch {
        clearTimeout(timeout)
        lifecycleLog.record('backend_shutdown_ipc_failed', { pid: child.pid ?? null })
        void this.forceTerminate(child).finally(() => {
          finish()
        })
      }
    })
  }

  private async forceTerminate(child: ChildProcess): Promise<void> {
    lifecycleLog.record('backend_force_terminate_requested', { pid: child.pid ?? null })
    if (process.platform === 'win32') {
      const pid = child.pid
      if (typeof pid !== 'number') {
        return
      }

      try {
        const { taskkillProcessTree } = await import('./win-process.js')
        await taskkillProcessTree(pid)
      } catch {
        // Ignore taskkill failures during shutdown.
      }

      return
    }

    try {
      child.kill('SIGKILL')
    } catch {
      // Ignore kill failures during shutdown.
    }
  }

  private async launch(isRestart: boolean): Promise<number> {
    const backendEntry = resolveBackendEntry()
    const runtimeRoot = resolveBackendRuntimeRoot()
    const resourcesDir = resolveBackendResourcesDir()
    const execArgv = resolveBackendExecArgv(backendEntry)
    const devBetterSqlite3Binding = app.isPackaged
      ? undefined
      : resolveDevBetterSqlite3Binding({
          electronDir: path.resolve(__dirname, '..'),
          electronVersion: process.versions.electron ?? '',
          platform: process.platform,
          arch: process.arch,
        })
    const forkOptions = createBackendForkOptions({
      runtimeRoot,
      inheritedEnv: process.env,
      isPackaged: app.isPackaged,
      backendPort: resolveDefaultBackendPort(),
      resourcesDir,
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? '',
      execArgv,
      devBetterSqlite3Binding,
    })

    this.initializeLaunchLogging()

    return await new Promise<number>((resolve, reject) => {
      const child = fork(backendEntry, [], forkOptions)

      this.child = child
      const secureControlPipe = child.stdio[4]
      if (!secureControlPipe || !('end' in secureControlPipe)) {
        child.kill()
        reject(new Error('Backend secure control capability pipe is unavailable'))
        return
      }
      installSecureVaultChildBridge({
        child,
        controller: secureVaultController,
      })
      lifecycleLog.record('backend_spawned', { isRestart, pid: child.pid ?? null })
      this.attachOutputCapture(child)

      let ready = false
      let settled = false

      const handleSecureControlPipeError = (error: Error): void => {
        finalizeReject(new Error(`Backend secure control capability pipe failed: ${error.message}`))
      }
      const cleanup = (): void => {
        child.off('message', handleMessage)
        child.off('error', handleError)
        secureControlPipe.off('error', handleSecureControlPipeError)
      }

      const finalizeReject = (error: Error): void => {
        if (settled) {
          return
        }

        settled = true
        cleanup()
        reject(error)
      }

      const finalizeResolve = (port: number): void => {
        if (settled) {
          return
        }

        settled = true
        cleanup()
        resolve(port)
      }

      const handleMessage = (message: unknown): void => {
        if (!isBackendReadyMessage(message)) {
          return
        }

        ready = true
        this.currentPort = message.port
        this.currentDataDir = message.dataDir && path.isAbsolute(message.dataDir) ? path.normalize(message.dataDir) : null
        lifecycleLog.record('backend_ready', { isRestart, pid: child.pid ?? null, port: message.port })
        this.onReady(message.port, isRestart)
        finalizeResolve(message.port)
      }

      const handleError = (error: Error): void => {
        finalizeReject(new Error(`${error.message}\n\n${this.describeRecentOutput()}`))
      }

      child.on('message', handleMessage)
      child.on('error', handleError)
      secureControlPipe.once('error', handleSecureControlPipeError)
      secureControlPipe.end(this.secureControlToken)
      child.once('exit', (code, signal) => {
        this.flushOutputRemainders()
        lifecycleLog.record('backend_exited', {
          code: code ?? null,
          ready,
          signal: signal ?? null,
          stopping: this.stopping,
        })

        if (this.child === child) {
          this.child = null
        }

        if (!ready) {
          lifecycleLog.record('backend_start_failed', {
            code: code ?? null,
            signal: signal ?? null,
          })
          finalizeReject(
            new Error(
              `Backend exited before signaling readiness (code=${code ?? 'null'}, signal=${signal ?? 'null'}).\n\n${this.describeRecentOutput()}`,
            ),
          )
          return
        }

        if (this.stopping) {
          return
        }

        console.warn(`Backend child exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'}). Restarting...`)
        lifecycleLog.record('backend_restart_scheduled', {
          delayMs: BACKEND_RESTART_DELAY_MS,
          code: code ?? null,
          signal: signal ?? null,
        })
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null
          void this.start().catch((error) => {
            console.error('Failed to restart backend child', error)
          })
        }, BACKEND_RESTART_DELAY_MS)
      })
    })
  }

  private attachOutputCapture(child: ChildProcess): void {
    child.stdout?.on('data', (chunk: Buffer | string) => {
      this.captureOutputChunk('stdout', chunk)
    })

    child.stderr?.on('data', (chunk: Buffer | string) => {
      this.captureOutputChunk('stderr', chunk)
    })
  }

  private captureOutputChunk(stream: 'stdout' | 'stderr', chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    if (text.length === 0) {
      return
    }

    const normalized = text.replace(/\r\n/g, '\n')

    if (stream === 'stdout') {
      const combined = `${this.stdoutRemainder}${normalized}`
      const segments = combined.split('\n')
      this.stdoutRemainder = segments.pop() ?? ''
      for (const line of segments) {
        this.recordOutputLine(stream, line)
      }
      return
    }

    const combined = `${this.stderrRemainder}${normalized}`
    const segments = combined.split('\n')
    this.stderrRemainder = segments.pop() ?? ''
    for (const line of segments) {
      this.recordOutputLine(stream, line)
    }
  }

  private flushOutputRemainders(): void {
    if (this.stdoutRemainder.length > 0) {
      this.recordOutputLine('stdout', this.stdoutRemainder)
      this.stdoutRemainder = ''
    }

    if (this.stderrRemainder.length > 0) {
      this.recordOutputLine('stderr', this.stderrRemainder)
      this.stderrRemainder = ''
    }
  }

  private recordOutputLine(stream: 'stdout' | 'stderr', line: string): void {
    const formatted = `[${stream}] ${line}`
    this.recentOutputLines.push(formatted)

    if (this.recentOutputLines.length > 200) {
      this.recentOutputLines.splice(0, this.recentOutputLines.length - 200)
    }

    this.writeLogLine(formatted)
  }

  private initializeLaunchLogging(): void {
    this.stdoutRemainder = ''
    this.stderrRemainder = ''
    this.recentOutputLines.length = 0
    this.writeLogLine(`=== Backend launch ${new Date().toISOString()} ===`)
  }

  private describeRecentOutput(): string {
    const output = this.getRecentOutput()
    const outputSection = output.length > 0 ? output : '(no output captured)'
    const logPath = this.logPath

    if (!logPath) {
      return `Recent backend output:\n${outputSection}`
    }

    return `Recent backend output:\n${outputSection}\n\nBackend log file: ${logPath}`
  }

  private writeLogLine(line: string): void {
    const logPath = this.ensureBackendLogPath()
    if (!logPath) {
      return
    }

    try {
      mkdirSync(path.dirname(logPath), { recursive: true })
      appendFileSync(logPath, `${line}\n`, 'utf8')
    } catch (error) {
      console.warn('Failed to write backend log output', error)
    }
  }

  private ensureBackendLogPath(): string | null {
    if (this.backendLogPath) {
      return this.backendLogPath
    }

    try {
      this.backendLogPath = path.join(app.getPath('userData'), BACKEND_LOG_FILENAME)
      return this.backendLogPath
    } catch {
      return null
    }
  }
}

const backendSupervisor = new BackendSupervisor((_port, isRestart) => {
  backendBootstrap = backendSupervisor.bootstrap

  if (isRestart && mainWindow && !mainWindow.isDestroyed()) {
    void loadRenderer(mainWindow)
  }
})

let sleepBlockerService: SleepBlockerService | null = null
let packagedRemoteUiServer: PackagedRemoteUiServer | null = null

async function startPackagedRemoteUiServer(): Promise<void> {
  if (!app.isPackaged || packagedRemoteUiServer) {
    return
  }

  const remoteUiServer = new PackagedRemoteUiServer({
    rendererDir: resolvePackagedRendererDir(),
    host: resolvePackagedRemoteUiHost(process.env),
    getBackendPort: () => backendSupervisor.currentBackendPort,
  })
  await remoteUiServer.start()
  packagedRemoteUiServer = remoteUiServer
  lifecycleLog.record('packaged_remote_ui_started', {
    host: resolvePackagedRemoteUiHost(process.env),
    port: remoteUiServer.address?.port ?? null,
  })
}

async function stopPackagedRemoteUiServer(): Promise<void> {
  const remoteUiServer = packagedRemoteUiServer
  packagedRemoteUiServer = null
  if (!remoteUiServer) {
    return
  }

  await remoteUiServer.stop()
  lifecycleLog.record('packaged_remote_ui_stopped')
}

async function prepareQuitForUpdate(): Promise<void> {
  if (!appIsQuitting) {
    appIsQuitting = true
    allowPopoutClose = true
    if (browserPopoutWindow && !browserPopoutWindow.isDestroyed()) browserPopoutWindow.close()
    lifecycleLog.record('electron_quit_prepared_for_update')
    sleepBlockerService?.dispose()
    browserWorkspaceIpc?.dispose()
    browserWorkspaceIpc = null
    mainRendererRecovery?.dispose()
    mainRendererRecovery = null
    disposeBrowserHost?.()
    disposeBrowserHost = null
    disposeExternalChromeIpc?.()
    disposeExternalChromeIpc = null
    disposeOpenPdfIpc?.()
    disposeOpenPdfIpc = null
    await externalChromeCoordinator?.quiesce('desktop-update')
    await stopPackagedRemoteUiServer()
    await backendSupervisor.stop()
  }
}

function handleTerminationSignal(signal: NodeJS.Signals): void {
  if (handledTerminationSignals.has(signal)) {
    return
  }

  handledTerminationSignals.add(signal)
  lifecycleLog.record('electron_signal_received', { signal })
  app.quit()
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    handleTerminationSignal(signal)
  })
}

installElectronDevelopmentProcessControl({
  isPackaged: app.isPackaged,
  processPort: process,
  requestQuit: () => handleTerminationSignal('SIGINT'),
})

process.on('exit', (code) => {
  lifecycleLog.record('electron_process_exit', { code })
})

function getUnavailableSleepBlockerStatus(): SleepBlockerStatus {
  return {
    enabled: false,
    gracePeriodMinutes: 30,
    blocking: false,
    graceRemainingMs: null,
    reason: 'Sleep prevention is not available.',
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const skillImportUrl = findSkillImportUrlInArgs(argv)
    if (skillImportUrl) {
      openSkillImportUrl(skillImportUrl)
      return
    }
    const commandCenterLink = findCommandCenterDeepLinkInArgs(argv)
    if (commandCenterLink) {
      openCommandCenterDeepLink(commandCenterLink)
      return
    }

    focusMainWindow()
  })

  app.on('open-url', (event, url) => {
    event.preventDefault()
    const skillImportUrl = parseSkillImportDeepLink(url)
    if (skillImportUrl) {
      openSkillImportUrl(skillImportUrl)
      return
    }
    if (parseCommandCenterDeepLink(url)) openCommandCenterDeepLink(url)
  })

  ipcMain.on(BACKEND_READY_CHANNEL, (event) => {
    const bootstrap = backendBootstrap ?? backendSupervisor.bootstrap
    const windowRole = browserPopoutWindow && !browserPopoutWindow.isDestroyed() && event.sender.id === browserPopoutWindow.webContents.id
      ? 'managed-browser-popout'
      : 'main'
    event.returnValue = windowRole === 'main'
      ? { ...bootstrap, windowRole, managedBrowserPopoutAvailable: isManagedBrowserPopoutAvailable() }
      : {
          backendUrl: bootstrap.backendUrl,
          backendWsUrl: bootstrap.backendWsUrl,
          version: bootstrap.version,
          platform: bootstrap.platform,
          appRuntime: bootstrap.appRuntime,
          appStartedAt: bootstrap.appStartedAt,
          windowRole,
          managedBrowserPopoutAvailable: isManagedBrowserPopoutAvailable(),
        }
  })

  ipcMain.on(MAIN_RENDERER_READY_CHANNEL, (event) => {
    if (!isTrustedMainRenderer(event)) return
    mainRendererRecovery?.markReady(event.sender)
  })

  ipcMain.handle('bridge:showOpenDialog', async (_event, options: Electron.OpenDialogOptions) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      return dialog.showOpenDialog(mainWindow, options)
    }

    return dialog.showOpenDialog(options)
  })

  // No-op: overlay is not used on Windows (native title bar), but keep
  // the handler registered so the renderer doesn't throw on send.
  ipcMain.on('update-title-bar-overlay', () => {})

  ipcMain.handle('reveal-in-folder', (_event, filePath: string): { success: boolean; error?: string } => {
    const validated = validateAbsoluteLocalFilePath(filePath)
    if (!validated.ok) {
      return { success: false, error: validated.error }
    }

    shell.showItemInFolder(validated.path)
    return { success: true }
  })

  disposeOpenPdfIpc = installOpenPdfIpc({
    ipcMain,
    isTrustedSender: isTrustedMainRenderer,
    openPath: (target) => shell.openPath(target),
  })

  ipcMain.handle('check-for-updates', async () => {
    await checkForUpdatesManually(mainWindow)
  })

  ipcMain.handle('download-update', async () => {
    await downloadUpdateManually()
  })

  ipcMain.handle('install-update', () => {
    installUpdateManually()
  })

  ipcMain.handle('get-beta-channel', () => {
    return getBetaChannel()
  })

  ipcMain.handle('set-beta-channel', (_event, enabled: boolean) => {
    setBetaChannel(enabled)
  })

  ipcMain.handle('get-sleep-blocker-settings', () => {
    return sleepBlockerService?.getStatus() ?? getUnavailableSleepBlockerStatus()
  })

  ipcMain.handle('set-sleep-blocker-settings', (_event, patch: SleepBlockerSettingsPatch) => {
    return sleepBlockerService?.updateSettings(patch) ?? null
  })

  ipcMain.handle('install-cli', (): CliInstallResult => {
    return installCli()
  })

  ipcMain.handle('verify-cli-install', (): { ok: boolean; output: string } => {
    return verifyCliInstall()
  })

  installSecureVaultRendererIpc({
    ipcMain,
    controller: secureVaultController,
    isTrustedSender: isTrustedMainRenderer,
  })

  ipcMain.handle('get-stream-deck-plugin-status', () => getStreamDeckPluginStatus({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    platform: process.platform,
  }))

  ipcMain.handle('install-stream-deck-plugin', async (): Promise<{ success: boolean; message: string }> => {
    const installerPath = resolveStreamDeckPluginPath({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    })
    if (!existsSync(installerPath)) {
      return { success: false, message: 'The bundled Stream Deck plugin installer is missing.' }
    }
    const error = await shell.openPath(installerPath)
    return error
      ? { success: false, message: error }
      : { success: true, message: 'Stream Deck opened the Forge plugin installer.' }
  })

  ipcMain.handle('open-stream-deck', async (): Promise<{ success: boolean; message: string }> => {
    const streamDeckAppPath = resolveStreamDeckAppPath(process.platform)
    if (!streamDeckAppPath) {
      return { success: false, message: 'Elgato Stream Deck is not installed.' }
    }
    const error = await shell.openPath(streamDeckAppPath)
    return error
      ? { success: false, message: error }
      : { success: true, message: 'Opened Elgato Stream Deck.' }
  })

  ipcMain.handle('focus-main-window', (): void => {
    focusMainWindow()
  })

  app.whenReady().then(async () => {
    lifecycleLog.record('electron_started', {
      isPackaged: app.isPackaged,
      version: app.getVersion(),
    })
    const secureVaultStartupInitialization =
      initializeSecureVaultAtStartup(secureVaultController)
    nativeTheme.themeSource = 'dark'
    fixPath()
    createApplicationMenu()
    registerExternalDeepLinkProtocol()
    if (app.isPackaged) {
      registerAppProtocol()
    }

    try {
      await backendSupervisor.start()
    } catch (error) {
      await backendSupervisor.stop().catch((stopError) => {
        console.warn('Failed to stop backend after startup failure', stopError)
      })
      lifecycleLog.record('electron_backend_start_failed')
      const detail = error instanceof Error ? error.message : String(error)
      const logPath = backendSupervisor.logPath
      const logHint = logPath ? `\n\nBackend log: ${logPath}` : ''
      dialog.showErrorBox(
        'Forge failed to start',
        'The backend process exited unexpectedly.\n\n' +
        'This might happen if another instance is running or if there\'s a configuration issue.\n\n' +
        `${detail}\n\n` +
        `Check the logs or try restarting the app.${logHint}`,
      )
      app.exit(1)
      return
    }

    await startOptionalPackagedRemoteUi(
      () => startPackagedRemoteUiServer(),
      (error) => {
        lifecycleLog.record('packaged_remote_ui_start_failed', { error: error.message })
        console.warn('[packaged-remote-ui] Remote browser access is unavailable; local Desktop and backend remain available.', error.message)
      },
    )

    await secureVaultStartupInitialization

    const externalChromeResources = resolveExternalChromeResources({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      developmentAppRoot: path.resolve(__dirname, '..'),
    })
    externalChromeDeployer = await deployExternalChrome(externalChromeResources)
    externalChromeCoordinator = new ExternalChromeHostCoordinator({
      dataRoot: backendSupervisor.bootstrap.dataDir ?? resolveLegacyForgeDataRoot(),
      desktopVersion: app.getVersion(),
      packagedManifestPath: path.join(externalChromeResources.root, 'package-manifest.json'),
      ...(externalChromeResources.development ? { allowDevelopmentHost: true } : {}),
      ...(externalChromeDeployer ? {
        rollbackController: externalChromeDeployer,
        repairDeployment: () => new ExternalChromeDeploymentRecovery(externalChromeDeployer!).repair(),
        deploymentVerifier: externalChromeDeployer,
      } : {}),
    })
    await externalChromeCoordinator.resumeIfEnabled().catch((error) => {
      console.warn('[external-chrome] Previously enabled coordinator could not resume', error instanceof Error ? error.message : String(error))
    })

    // Write CLI install hint on every launch so the shim can find the current app
    writeInstallHint()

    mainWindow = createMainWindow()
    const authoritativeWindow = mainWindow
    mainRendererRecovery = installMainRendererRecovery({
      window: authoritativeWindow,
      loadRenderer: () => reloadRenderer(authoritativeWindow),
      isClosing: () => appIsQuitting || mainWindowClosing,
      onEvent: (event) => {
        lifecycleLog.record(`electron_main_renderer_${event.type}`, event)
      },
    })
    const automaticChromeTransport = externalChromeCoordinator.transport()
    const browserManager = new BrowserAutomationManager({
      approvedDataRoot: backendSupervisor.bootstrap.dataDir ?? resolveLegacyForgeDataRoot(),
      sendToRenderer: (channel, payload) => {
        sendToRendererWindow(mainWindow, channel, payload)
      },
      externalChromeAdapter: new ExternalChromeTargetAdapter(automaticChromeTransport),
      ensureManagedTarget: async (request) => {
        const host = browserViewHost
        if (!host) return null
        const tab = createAutomaticManagedTab(request)
        await host.ensureProvisional(tab, host.currentWorkspaceEpoch)
        await host.commitProvisional(tab.tabId, host.currentWorkspaceEpoch)
        return tab.tabId
      },
    })
    browserViewHost = new ManagedBrowserViewHost({
      manager: browserManager,
      sessions: browserSessions,
      guestPreloadPath: path.join(__dirname, 'guest-preload.js'),
      onGuestBeforeInput: handleManagedBrowserCloseShortcut,
      onGuestCrash: (tabId, reason) => {
        sendToRendererWindow(mainWindow, 'forge:browser-guest-crashed', { tabId, reason })
      },
    })
    disposeBrowserHost = installBrowserIpc({ ipcMain, mainWindow, manager: browserManager, viewHost: browserViewHost })
    disposeExternalChromeIpc = installExternalChromeIpc({
      ipcMain,
      mainWindow,
      coordinator: externalChromeCoordinator,
      revealExtensionFolder: async (validatedPath) => {
        const error = await shell.openPath(validatedPath)
        if (error) throw new Error(error)
      },
      onError: (error) => console.warn('[external-chrome] Coordinator operation failed', error instanceof Error ? error.message : String(error)),
    })
    browserWorkspaceIpc = installBrowserWorkspaceIpc({
      ipcMain,
      getMainWindow: () => mainWindow,
      getPopoutWindow: () => browserPopoutWindow,
      viewHost: browserViewHost,
      getMode: () => browserWorkspaceMode,
      popOut: popOutManagedBrowser,
      dock: dockManagedBrowser,
      bringToFront: bringManagedBrowserToFront,
    })
    installManagedBrowserFocusAggregation(mainWindow)
    initAutoUpdater({
      mainWindow,
      getBackendBaseUrl: () => backendBootstrap?.backendUrl ?? null,
      prepareQuitForUpdate,
      quiesceHook: externalChromeUpdateQuiesceHook,
    })
    sleepBlockerService = new SleepBlockerService({
      getBackendBaseUrl: () => backendBootstrap?.backendUrl ?? null,
      onStatusChange: (status) => {
        sendSleepBlockerStatusToWindow(mainWindow, status)
      },
    })
    sleepBlockerService.initialize()
    try {
      await loadRenderer(mainWindow)
    } catch (error) {
      if (!mainRendererRecovery.acceptsSupersededLoadError(error)) throw error
      lifecycleLog.record('electron_initial_renderer_load_superseded')
    }

    // Show "What's New" dialog if the app was just updated (non-blocking)
    showWhatsNewIfUpdated(mainWindow).catch((error) => {
      console.warn('Failed to show What\'s New dialog', error)
    })
  }).catch((error) => {
    lifecycleLog.record('electron_initialization_failed')
    void stopPackagedRemoteUiServer().catch((stopError) => {
      console.warn('[packaged-remote-ui] Failed to stop after initialization failure', stopError)
    })
    void backendSupervisor.stop().catch((stopError) => {
      console.warn('Failed to stop backend after initialization failure', stopError)
    })
    console.error('Electron app failed to initialize', error)
    app.exit(1)
  })

  app.on('window-all-closed', () => {
    lifecycleLog.record('electron_window_all_closed')
    app.quit()
  })

  app.on('before-quit', (event) => {
    lifecycleLog.record('electron_before_quit', { alreadyQuitting: appIsQuitting })
    if (appIsQuitting) {
      return
    }

    event.preventDefault()
    appIsQuitting = true
    allowPopoutClose = true
    if (browserPopoutWindow && !browserPopoutWindow.isDestroyed()) browserPopoutWindow.close()
    sleepBlockerService?.dispose()
    browserWorkspaceIpc?.dispose()
    browserWorkspaceIpc = null
    mainRendererRecovery?.dispose()
    mainRendererRecovery = null
    disposeBrowserHost?.()
    disposeBrowserHost = null
    disposeExternalChromeIpc?.()
    disposeExternalChromeIpc = null
    disposeOpenPdfIpc?.()
    disposeOpenPdfIpc = null

    void (externalChromeCoordinator?.quiesce('desktop-quit') ?? Promise.resolve()).catch((error) => {
      console.warn('[external-chrome] Quit quiesce failed', error instanceof Error ? error.message : String(error))
    }).finally(() => stopPackagedRemoteUiServer()).finally(() => backendSupervisor.stop()).finally(() => {
      lifecycleLog.record('electron_exit_requested', { code: 0 })
      app.exit(0)
    })
  })

  app.on('will-quit', () => {
    lifecycleLog.record('electron_will_quit')
  })
}

function createMainWindow(): BrowserWindow {
  const savedState = loadWindowState()

  const window = new BrowserWindow({
    width: savedState.width,
    height: savedState.height,
    ...(savedState.x !== undefined && savedState.y !== undefined
      ? {
          x: savedState.x,
          y: savedState.y,
        }
      : {}),
    minWidth: 1100,
    minHeight: 720,
    show: false,
    ...(process.platform !== 'darwin' && {
      autoHideMenuBar: true,
    }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: true,
    },
  })

  trackWindowState(window)

  window.once('ready-to-show', () => {
    if (savedState.isFullScreen) {
      window.setFullScreen(true)
    } else if (savedState.isMaximized) {
      window.maximize()
    }

    window.show()
  })

  window.on('close', () => {
    mainWindowClosing = true
    if (browserPopoutWindow && !browserPopoutWindow.isDestroyed()) {
      allowPopoutClose = true
      browserPopoutWindow.close()
    }
  })
  window.on('closed', () => {
    if (mainWindow === window) {
      mainRendererRecovery?.dispose()
      mainRendererRecovery = null
      browserWorkspaceIpc?.dispose()
      browserWorkspaceIpc = null
      disposeBrowserHost?.()
      disposeBrowserHost = null
      disposeExternalChromeIpc?.()
      disposeExternalChromeIpc = null
      browserViewHost = null
      mainWindow = null
    }
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    return handleMainRendererWindowOpen(url, {
      openExternal: (target) => shell.openExternal(target),
      handleDeepLink: handlePotentialSkillImportDeepLink,
      onExternalOpenError: (target, error) => {
        console.error('Failed to open external URL', target, error)
      },
    })
  })

  window.webContents.on('will-navigate', (event, url) => {
    if (handlePotentialSkillImportDeepLink(url)) {
      event.preventDefault()
      return
    }

    if (!isTrustedRendererUrl(url)) {
      event.preventDefault()
      if (!isUnsafeRendererWindowOpenUrl(url)) {
        void shell.openExternal(url)
      }
    }
  })

  // Native spell-check context menu with suggestions
  window.webContents.on('context-menu', (_event, params) => {
    console.log('[spell-check] context-menu event:', { misspelledWord: params.misspelledWord, suggestions: params.dictionarySuggestions, isEditable: params.isEditable })
    if (params.misspelledWord) {
      const menuItems: Electron.MenuItemConstructorOptions[] = [
        ...params.dictionarySuggestions.map((suggestion) => ({
          label: suggestion,
          click: () => window.webContents.replaceMisspelling(suggestion),
        })),
        ...(params.dictionarySuggestions.length > 0 ? [{ type: 'separator' as const }] : []),
        {
          label: 'Add to Dictionary',
          click: () => window.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
        },
      ]
      Menu.buildFromTemplate(menuItems).popup()
    }
  })

  return window
}

async function createBrowserPopoutWindow(): Promise<BrowserWindow> {
  if (browserPopoutWindow && !browserPopoutWindow.isDestroyed()) return browserPopoutWindow
  const saved = loadWindowState({
    key: 'managed-browser-window-state',
    minWidth: 720,
    minHeight: 560,
    defaultState: { width: 1180, height: 820, isMaximized: false, isFullScreen: false },
  })
  const window = new BrowserWindow({
    title: 'Forge Automatic Browser',
    width: saved.width,
    height: saved.height,
    ...(saved.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: 720,
    minHeight: 560,
    show: false,
    ...(process.platform !== 'darwin' && {
      autoHideMenuBar: true,
    }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      backgroundThrottling: false,
    },
  })
  browserPopoutWindow = window
  trackWindowState(window, { key: 'managed-browser-window-state', minWidth: 720, minHeight: 560 })
  installManagedBrowserFocusAggregation(window)
  window.on('close', (event) => {
    if (allowPopoutClose || appIsQuitting || mainWindowClosing) return
    event.preventDefault()
    const epoch = browserWorkspaceIpc?.getProjection()?.workspaceEpoch
    if (epoch !== undefined) void dockManagedBrowser(epoch).catch((error) => console.error('Failed to dock Automatic Browser', error))
  })
  window.on('closed', () => {
    if (browserPopoutWindow === window) browserPopoutWindow = null
    if (!allowPopoutClose && !appIsQuitting && !mainWindowClosing && browserWorkspaceMode === 'popped-out') {
      const epoch = browserWorkspaceIpc?.getProjection()?.workspaceEpoch
      if (epoch !== undefined) void dockManagedBrowser(epoch).catch(() => undefined)
    }
  })
  const recover = (): void => {
    if (appIsQuitting || mainWindowClosing) return
    const epoch = browserWorkspaceIpc?.getProjection()?.workspaceEpoch
    if (epoch !== undefined) void dockManagedBrowser(epoch).catch(() => undefined)
  }
  window.webContents.on('render-process-gone', recover)
  window.webContents.on('did-fail-load', recover)
  window.webContents.on('before-input-event', handleManagedBrowserCloseShortcut)
  await loadRenderer(window)
  return window
}

function popOutManagedBrowser(epoch: number): Promise<ManagedBrowserWorkspaceMode> {
  const run = async (): Promise<ManagedBrowserWorkspaceMode> => {
    if (browserWorkspaceMode === 'popped-out' && browserPopoutWindow && !browserPopoutWindow.isDestroyed()) {
      bringManagedBrowserToFront()
      return browserWorkspaceMode
    }
    const host = browserViewHost
    if (!host) throw new Error('Automatic Browser host is unavailable')
    browserWorkspaceMode = 'opening'
    browserWorkspaceIpc?.publishMode(browserWorkspaceMode)
    const window = await createBrowserPopoutWindow()
    await waitForBrowserTarget('popout', epoch)
    const transferred = await host.transferOwner('popout', epoch)
    if (!transferred) throw new Error('Automatic Browser pop-out viewport was not physically ready')
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    browserWorkspaceMode = 'popped-out'
    browserWorkspaceIpc?.publishMode(browserWorkspaceMode)
    publishManagedBrowserFocus()
    return browserWorkspaceMode
  }
  const result = browserTransition.then(run, run)
  browserTransition = result.catch(() => {
    browserWorkspaceMode = isManagedBrowserPopoutAvailable() ? 'docked' : 'unavailable'
    browserWorkspaceIpc?.publishMode(browserWorkspaceMode)
    return browserWorkspaceMode
  })
  return result
}

function dockManagedBrowser(epoch: number): Promise<ManagedBrowserWorkspaceMode> {
  const run = async (): Promise<ManagedBrowserWorkspaceMode> => {
    if (browserWorkspaceMode === 'docked' && (!browserPopoutWindow || browserPopoutWindow.isDestroyed())) {
      focusMainWindow()
      return browserWorkspaceMode
    }
    const host = browserViewHost
    if (!host) throw new Error('Automatic Browser host is unavailable')
    browserWorkspaceMode = 'docking'
    browserWorkspaceIpc?.publishMode(browserWorkspaceMode)
    await waitForBrowserTarget('docked', epoch)
    const transferred = await host.transferOwner('docked', epoch)
    if (!transferred) throw new Error('Automatic Browser dock viewport was not physically ready')
    const popout = browserPopoutWindow
    if (popout && !popout.isDestroyed()) {
      allowPopoutClose = true
      popout.close()
      allowPopoutClose = false
    }
    browserWorkspaceMode = 'docked'
    browserWorkspaceIpc?.publishMode(browserWorkspaceMode)
    focusMainWindow()
    publishManagedBrowserFocus()
    return browserWorkspaceMode
  }
  const result = browserTransition.then(run, run)
  browserTransition = result.catch(() => browserWorkspaceMode)
  return result
}

async function waitForBrowserTarget(owner: 'docked' | 'popout', epoch: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (browserViewHost?.hasPresentationTarget(owner, epoch)) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Automatic Browser ${owner} viewport did not become ready`)
}

function handleManagedBrowserCloseShortcut(
  event: { preventDefault(): void },
  input: { type: string; key: string; alt?: boolean; control?: boolean; meta?: boolean; shift?: boolean },
): void {
  if (browserWorkspaceMode !== 'popped-out' && browserWorkspaceMode !== 'opening') return
  if (!isDockManagedBrowserShortcut(input)) return
  event.preventDefault()
  const epoch = browserWorkspaceIpc?.getProjection()?.workspaceEpoch
  if (epoch !== undefined) void dockManagedBrowser(epoch).catch(() => undefined)
}

function bringManagedBrowserToFront(): void {
  const target = browserWorkspaceMode === 'popped-out' ? browserPopoutWindow : mainWindow
  if (!target || target.isDestroyed()) return
  if (target.isMinimized()) target.restore()
  target.show()
  target.focus()
}

function installManagedBrowserFocusAggregation(window: BrowserWindow): void {
  window.on('focus', publishManagedBrowserFocus)
  window.on('blur', publishManagedBrowserFocus)
  window.on('show', publishManagedBrowserFocus)
  window.on('hide', publishManagedBrowserFocus)
  window.on('minimize', publishManagedBrowserFocus)
  window.on('restore', publishManagedBrowserFocus)
}

function publishManagedBrowserFocus(): void {
  const ownerWindow = browserWorkspaceMode === 'popped-out' ? browserPopoutWindow : mainWindow
  const focused = Boolean(ownerWindow && !ownerWindow.isDestroyed() && ownerWindow.isVisible() && !ownerWindow.isMinimized() && ownerWindow.isFocused())
  browserWorkspaceIpc?.publishFocus(focused)
}

function sendTerminalShortcut(action: 'toggle' | 'new' | 'next' | 'prev'): void {
  sendToRendererWindow(mainWindow, TERMINAL_SHORTCUT_CHANNEL, { action })
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }

  mainWindow.focus()
}

function openSkillImportUrl(skillImportUrl: string): void {
  pendingSkillImportUrl = skillImportUrl
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }

  focusMainWindow()
  pendingSkillImportUrl = null
  void mainWindow.loadURL(resolveRendererUrl(skillImportUrl))
}

function openCommandCenterDeepLink(deepLink: string): void {
  pendingCommandCenterDeepLink = deepLink
  if (!mainWindow || mainWindow.isDestroyed()) return
  focusMainWindow()
  pendingCommandCenterDeepLink = null
  const baseUrl = app.isPackaged ? resolvePackagedRendererUrl() : electronDevServerUrl
  void mainWindow.loadURL(buildCommandCenterRouteUrl(baseUrl, deepLink))
}

function handlePotentialSkillImportDeepLink(url: string): boolean {
  const skillImportUrl = parseSkillImportDeepLink(url)
  if (!skillImportUrl) {
    return false
  }

  openSkillImportUrl(skillImportUrl)
  return true
}

function registerExternalDeepLinkProtocol(): void {
  if (!shouldRegisterExternalDeepLinkProtocol({ isPackaged: app.isPackaged, env: process.env })) {
    return
  }

  if (app.isPackaged) {
    app.setAsDefaultProtocolClient(EXTERNAL_PROTOCOL_SCHEME)
    return
  }

  app.setAsDefaultProtocolClient(EXTERNAL_PROTOCOL_SCHEME, process.execPath, [process.argv[1] ?? ''])
}

function createApplicationMenu(): void {
  const isMac = process.platform === 'darwin'

  const template: Array<Electron.MenuItemConstructorOptions> = []

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        {
          label: 'About Forge',
          click: (): void => {
            if (!mainWindow) {
              return
            }
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About Forge',
              message: 'Forge',
              detail: `Version: ${app.getVersion()}\nElectron: ${process.versions.electron}\nChromium: ${process.versions.chrome}\nNode.js: ${process.versions.node}\nPlatform: ${process.platform} ${process.arch}`,
            }).catch((error) => {
              console.error('Failed to show About dialog', error)
            })
          },
        },
        { type: 'separator' },
        {
          label: 'Check for Updates...',
          click: (): void => {
            void checkForUpdatesManually()
          },
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', accelerator: 'Command+H' },
        { role: 'hideOthers', accelerator: 'Alt+Command+H' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', accelerator: 'Command+Q' },
      ],
    })
  } else {
    template.push({
      label: 'File',
      submenu: [
        {
          label: 'Check for Updates...',
          click: (): void => {
            void checkForUpdatesManually()
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    })
  }

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo', accelerator: 'CmdOrCtrl+Z' },
      { role: 'redo', accelerator: isMac ? 'Shift+CmdOrCtrl+Z' : 'Ctrl+Y' },
      { type: 'separator' },
      { role: 'cut', accelerator: 'CmdOrCtrl+X' },
      { role: 'copy', accelerator: 'CmdOrCtrl+C' },
      { role: 'paste', accelerator: 'CmdOrCtrl+V' },
      ...(isMac ? [
        { role: 'pasteAndMatchStyle' as const, accelerator: 'Shift+Alt+CmdOrCtrl+V' },
        { role: 'delete' as const },
        { role: 'selectAll' as const, accelerator: 'CmdOrCtrl+A' },
      ] : [
        { role: 'delete' as const },
        { type: 'separator' as const },
        { role: 'selectAll' as const, accelerator: 'CmdOrCtrl+A' },
      ]),
    ],
  })

  template.push({
    label: 'View',
    submenu: [
      { role: 'reload', accelerator: 'CmdOrCtrl+R' },
      { role: 'forceReload', accelerator: 'Shift+CmdOrCtrl+R' },
      { role: 'toggleDevTools', accelerator: isMac ? 'Alt+Command+I' : 'Ctrl+Shift+I' },
      { type: 'separator' as const },
      { role: 'resetZoom', accelerator: 'CmdOrCtrl+0' },
      { role: 'zoomIn', accelerator: 'CmdOrCtrl+Plus' },
      { role: 'zoomOut', accelerator: 'CmdOrCtrl+-' },
      { type: 'separator' as const },
      { role: 'togglefullscreen', accelerator: isMac ? 'Ctrl+Command+F' : 'F11' },
    ],
  })

  template.push({
    label: 'Terminal',
    submenu: [
      {
        label: 'Toggle Terminal Panel',
        accelerator: 'CmdOrCtrl+`',
        click: (): void => sendTerminalShortcut('toggle'),
      },
      {
        label: 'New Terminal',
        accelerator: 'CmdOrCtrl+Shift+`',
        click: (): void => sendTerminalShortcut('new'),
      },
      { type: 'separator' as const },
      {
        label: 'Previous Terminal',
        accelerator: 'Alt+Shift+[',
        click: (): void => sendTerminalShortcut('prev'),
      },
      {
        label: 'Next Terminal',
        accelerator: 'Alt+Shift+]',
        click: (): void => sendTerminalShortcut('next'),
      },
    ],
  })

  template.push({
    label: 'Window',
    submenu: [
      { role: 'minimize', ...(isMac ? { accelerator: 'CmdOrCtrl+M' } : {}) },
      { role: 'zoom' },
      {
        label: 'Pop Out / Dock Automatic Browser',
        accelerator: 'CmdOrCtrl+Shift+B',
        enabled: isManagedBrowserPopoutAvailable(),
        click: () => {
          const epoch = browserWorkspaceIpc?.getProjection()?.workspaceEpoch
          if (epoch === undefined) return
          if (browserWorkspaceMode === 'popped-out' || browserWorkspaceMode === 'opening') void dockManagedBrowser(epoch)
          else void popOutManagedBrowser(epoch)
        },
      },
      ...(isMac ? [
        { type: 'separator' as const },
        { role: 'front' as const },
      ] : [
        { role: 'close' as const, accelerator: 'Alt+F4' },
      ]),
    ],
  })

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

async function loadRenderer(window: BrowserWindow): Promise<void> {
  const skillImportUrl = pendingSkillImportUrl
  const commandCenterDeepLink = pendingCommandCenterDeepLink
  pendingSkillImportUrl = null
  pendingCommandCenterDeepLink = null
  const base = resolveRendererUrl(skillImportUrl ?? undefined)
  await window.loadURL(commandCenterDeepLink ? buildCommandCenterRouteUrl(base, commandCenterDeepLink) : base)
}

async function reloadRenderer(window: BrowserWindow): Promise<void> {
  const currentUrl = window.webContents.isDestroyed() ? '' : window.webContents.getURL()
  await window.loadURL(isTrustedRendererUrl(currentUrl) ? currentUrl : resolveRendererUrl())
}

function resolveRendererUrl(skillImportUrl?: string): string {
  const baseUrl = app.isPackaged ? resolvePackagedRendererUrl() : electronDevServerUrl
  return skillImportUrl ? buildSkillImportRouteUrl(baseUrl, skillImportUrl) : baseUrl
}

function isTrustedRendererUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }

  if (app.isPackaged) {
    return url.protocol === `${APP_PROTOCOL_SCHEME}:` && url.hostname === APP_PROTOCOL_HOST
  }

  return url.origin === new URL(electronDevServerUrl).origin
}

function isTrustedMainRenderer(event: unknown): boolean {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    typeof event !== 'object' ||
    event === null ||
    !('sender' in event)
  ) {
    return false
  }

  const sender = (event as { sender?: unknown }).sender
  if (sender !== mainWindow.webContents || mainWindow.webContents.isDestroyed()) {
    return false
  }

  return isTrustedRendererUrl(mainWindow.webContents.getURL())
}

function createAutomaticManagedTab(request: BrowserAutomationRequest): BrowserTabSnapshot {
  const now = new Date().toISOString()
  const url = request.operation === 'open' && request.input.url ? normalizeAutomaticBrowserUrl(request.input.url) : 'about:blank'
  return {
    targetAffinity: 'managed-electron',
    tabId: `tab-${randomBytes(12).toString('hex')}`,
    sessionAgentId: request.sessionAgentId,
    profileId: request.profileId,
    url,
    title: 'New tab',
    lifecycle: 'restoring',
    loading: false,
    live: false,
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1,
    controller: 'none',
    agentCursor: null,
    recording: null,
    viewportSetting: { mode: 'fill' },
    renderedViewport: null,
    physicalVisible: false,
    error: null,
    createdAt: now,
    updatedAt: now,
  }
}

function normalizeAutomaticBrowserUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed === 'about:blank') return 'about:blank'
  if (/^https?:\/\//iu.test(trimmed)) return trimmed
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/iu.test(trimmed)) return `http://${trimmed}`
  return `https://${trimmed}`
}

function buildBackendBootstrap(
  port: number,
  dataDir: string | undefined,
  secureControlToken: string,
): BackendBootstrap {
  return {
    backendUrl: `http://127.0.0.1:${port}`,
    backendWsUrl: `ws://127.0.0.1:${port}`,
    version: app.getVersion(),
    platform: process.platform,
    appRuntime: app.isPackaged ? 'installed' : 'development',
    appStartedAt: ELECTRON_STARTED_AT,
    windowRole: 'main',
    managedBrowserPopoutAvailable: isManagedBrowserPopoutAvailable(),
    secureControlToken,
    ...(dataDir ? { dataDir } : {}),
  }
}

function resolveRepoRoot(): string {
  return path.resolve(__dirname, '..', '..', '..')
}

function resolveBackendRuntimeRoot(): string {
  if (!app.isPackaged) {
    return resolveRepoRoot()
  }

  return resolveBackendResourcesDir()
}

function resolveBackendResourcesDir(): string {
  if (!app.isPackaged) {
    return resolveRepoRoot()
  }

  const resourcesDir = path.join(process.resourcesPath, PACKAGED_RESOURCES_DIRNAME)
  assertPathExists(resourcesDir, 'Packaged backend resources directory')
  return resourcesDir
}

function resolvePackagedRendererDir(): string {
  const rendererDir = path.join(process.resourcesPath, PACKAGED_RENDERER_DIRNAME)
  assertPathExists(rendererDir, 'Packaged renderer directory')
  return rendererDir
}

function resolvePackagedRendererEntry(): string {
  const rendererEntry = path.join(resolvePackagedRendererDir(), 'index.html')
  assertPathExists(rendererEntry, 'Packaged renderer entry')
  return rendererEntry
}

function resolvePackagedRendererUrl(): string {
  return `${APP_PROTOCOL_SCHEME}://${APP_PROTOCOL_HOST}/index.html`
}

function resolveBackendEntry(): string {
  if (app.isPackaged) {
    const packagedBackendEntry = path.join(process.resourcesPath, PACKAGED_BACKEND_DIRNAME, 'dist', 'index.mjs')
    assertPathExists(packagedBackendEntry, 'Packaged backend entry')
    return packagedBackendEntry
  }

  const repoRoot = resolveRepoRoot()
  const backendDistEntry = path.join(repoRoot, 'apps', 'backend', 'dist', 'index.js')
  const backendSourceEntry = path.join(repoRoot, 'apps', 'backend', 'src', 'index.ts')

  if (existsSync(backendSourceEntry)) {
    return backendSourceEntry
  }

  if (existsSync(backendDistEntry)) {
    return backendDistEntry
  }

  throw new Error(`Unable to find backend entrypoint. Checked:\n- ${backendDistEntry}\n- ${backendSourceEntry}`)
}

function resolveBackendExecArgv(backendEntry: string): string[] {
  if (backendEntry.endsWith('.ts')) {
    // On Windows, --import requires a file:// URL — raw drive-letter paths
    // like T:\...\tsx are misinterpreted as URL schemes (protocol 't:').
    const tsxPath = require.resolve('tsx')
    const tsxUrl = pathToFileURL(tsxPath).href
    return [...process.execArgv, '--import', tsxUrl]
  }

  return [...process.execArgv]
}

function registerAppProtocol(): void {
  if (appProtocolRegistered) {
    return
  }

  const rendererDir = resolvePackagedRendererDir()
  const rendererEntry = resolvePackagedRendererEntry()

  protocol.handle(APP_PROTOCOL_SCHEME, (request) => {
    const requestUrl = new URL(request.url)
    const requestedPath = decodeURIComponent(requestUrl.pathname.replace(/^\/+/, ''))
    const normalizedRelativePath = requestedPath.length > 0 ? path.normalize(requestedPath) : 'index.html'
    const candidatePath = path.resolve(rendererDir, normalizedRelativePath)
    const shouldServeRequestedFile =
      candidatePath.startsWith(rendererDir) &&
      existsSync(candidatePath) &&
      path.extname(candidatePath).length > 0

    const filePath = shouldServeRequestedFile ? candidatePath : rendererEntry
    return net.fetch(pathToFileURL(filePath).toString())
  })

  appProtocolRegistered = true
}

function assertPathExists(targetPath: string, label: string): void {
  if (!existsSync(targetPath)) {
    throw new Error(`${label} was not found at ${targetPath}`)
  }
}

/**
 * Pick the default backend port. Uses the standard Forge convention
 * (47187 dev, 47287 prod) so mobile apps and other clients can connect
 * on a known port without any configuration.
 *
 * The backend's own listen logic handles EADDRINUSE — if the preferred port
 * is occupied, startup will fail and the error dialog will show. This is
 * intentional: silently falling back to a random port would break mobile
 * connectivity, so it's better to tell the user another instance is running.
 */
function resolveDefaultBackendPort(): number {
  return DEFAULT_BACKEND_PORT
}

async function deployExternalChrome(resources: ExternalChromeResourceLocation): Promise<ExternalChromeDeployer | null> {
  const dataRoot = backendSupervisor.bootstrap.dataDir
  if (!dataRoot) {
    console.warn('[external-chrome] Backend did not report a canonical data root; deployment skipped for compatibility')
    return null
  }
  const deployer = new ExternalChromeDeployer({
    dataRoot,
    resourcesRoot: resources.root,
    desktopVersion: app.getVersion(),
    ...(resources.development ? { allowDevelopmentHost: true } : {}),
  })
  try {
    await new ExternalChromeDeploymentRecovery(deployer).deployAtStartup({ development: resources.development })
  } catch (error) {
    // External Chrome is optional; deployment failure must not disable the embedded browser or Desktop.
    console.warn('[external-chrome] Resource deployment failed', error instanceof Error ? error.message : String(error))
  }
  return deployer
}

function resolveLegacyForgeDataRoot(): string {
  const configured = process.env.FORGE_DATA_DIR ?? process.env.MIDDLEMAN_DATA_DIR
  if (configured) return path.resolve(configured)
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA?.trim() || path.join(app.getPath('home'), 'AppData', 'Local')
    return path.resolve(localAppData, 'forge')
  }
  return path.resolve(app.getPath('home'), '.forge')
}

function isBackendReadyMessage(value: unknown): value is BackendReadyMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'ready' &&
    typeof (value as { port?: unknown }).port === 'number'
  )
}

/**
 * Minimal .env loader for the Electron main process. Reads the .env file
 * from the repo root (dev) and sets any vars not already in process.env.
 * No dependency on dotenv — the backend loads its own copy via dotenv later.
 */
function loadDotEnv(): void {
  try {
    const repoRoot = path.resolve(__dirname, '..', '..', '..')
    const envPath = path.join(repoRoot, '.env')
    if (!existsSync(envPath)) return

    const content = readFileSync(envPath, 'utf8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIndex = trimmed.indexOf('=')
      if (eqIndex < 1) continue
      const key = trimmed.slice(0, eqIndex).trim()
      const value = trimmed.slice(eqIndex + 1).trim().replace(/^["']|["']$/g, '')
      // Don't override existing env vars
      if (!(key in process.env)) {
        process.env[key] = value
      }
    }
  } catch {
    // Non-critical — continue without .env
  }
}
