import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, protocol, shell } from 'electron'
import { fork, type ChildProcess, type ForkOptions } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkForUpdatesManually, downloadUpdateManually, installUpdateManually, initAutoUpdater, getBetaChannel, setBetaChannel } from './auto-updater.js'
import { fixPath } from './fix-path.js'
import { SleepBlockerService, type SleepBlockerSettingsPatch, type SleepBlockerStatus } from './sleep-blocker.js'
import { loadWindowState, trackWindowState } from './window-state.js'
import { showWhatsNewIfUpdated } from './whats-new.js'

// Load .env from repo root so FORGE_PORT etc. are available in main process
loadDotEnv()

const ELECTRON_DEV_SERVER_URL = 'http://127.0.0.1:47188'
const DEFAULT_BACKEND_PORT = 47287
const BACKEND_READY_CHANNEL = 'forge:get-backend-bootstrap'
const TERMINAL_SHORTCUT_CHANNEL = 'bridge:terminal-shortcut'
const BACKEND_SHUTDOWN_TIMEOUT_MS = 5_000
const BACKEND_RESTART_DELAY_MS = 1_000
const BACKEND_LOG_TAIL_LINES = 40
const BACKEND_LOG_FILENAME = 'backend.log'
const PACKAGED_BACKEND_DIRNAME = 'backend'
const PACKAGED_RENDERER_DIRNAME = 'ui'
const PACKAGED_RESOURCES_DIRNAME = 'forge-resources'
const APP_PROTOCOL_SCHEME = 'app'
const APP_PROTOCOL_HOST = 'forge'

type BackendReadyMessage = {
  type: 'ready'
  port: number
}

type BackendBootstrap = {
  backendUrl: string
  backendWsUrl: string
  version: string
  platform: string
}

let mainWindow: BrowserWindow | null = null
let backendBootstrap: BackendBootstrap | null = null
let appIsQuitting = false
let appProtocolRegistered = false

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
  private startPromise: Promise<number> | null = null
  private stopping = false
  private restartTimer: NodeJS.Timeout | null = null
  private backendLogPath: string | null = null
  private readonly recentOutputLines: string[] = []
  private stdoutRemainder = ''
  private stderrRemainder = ''

  constructor(private readonly onReady: (port: number, isRestart: boolean) => void) {}

  get bootstrap(): BackendBootstrap {
    if (this.currentPort == null) {
      throw new Error('Backend bootstrap requested before backend was ready')
    }

    return buildBackendBootstrap(this.currentPort)
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
        void this.forceTerminate(child).finally(() => {
          finish()
        })
      }, BACKEND_SHUTDOWN_TIMEOUT_MS)

      child.once('exit', () => {
        clearTimeout(timeout)
        finish()
      })

      try {
        child.send({ type: 'shutdown' })
      } catch {
        clearTimeout(timeout)
        void this.forceTerminate(child).finally(() => {
          finish()
        })
      }
    })
  }

  private async forceTerminate(child: ChildProcess): Promise<void> {
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

    this.initializeLaunchLogging()

    return await new Promise<number>((resolve, reject) => {
      const child = fork(backendEntry, [], {
        cwd: runtimeRoot,
        env: {
          ...process.env,
          FORGE_DESKTOP: '1',
          FORGE_HOST: process.env.FORGE_HOST || '0.0.0.0',
          FORGE_PORT: process.env.FORGE_PORT || String(resolveDefaultBackendPort()),
          FORGE_RESOURCES_DIR: resourcesDir,
          FORGE_APP_VERSION: app.getVersion(),
          FORGE_ELECTRON_VERSION: process.versions.electron ?? '',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        execArgv,
      } satisfies ForkOptions)

      this.child = child
      this.attachOutputCapture(child)

      let ready = false
      let settled = false

      const cleanup = (): void => {
        child.off('message', handleMessage)
        child.off('error', handleError)
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
        this.onReady(message.port, isRestart)
        finalizeResolve(message.port)
      }

      const handleError = (error: Error): void => {
        finalizeReject(new Error(`${error.message}\n\n${this.describeRecentOutput()}`))
      }

      child.on('message', handleMessage)
      child.on('error', handleError)
      child.once('exit', (code, signal) => {
        this.flushOutputRemainders()

        if (this.child === child) {
          this.child = null
        }

        if (!ready) {
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

const backendSupervisor = new BackendSupervisor((port, isRestart) => {
  backendBootstrap = buildBackendBootstrap(port)

  if (isRestart && mainWindow && !mainWindow.isDestroyed()) {
    void loadRenderer(mainWindow)
  }
})

let sleepBlockerService: SleepBlockerService | null = null

async function prepareQuitForUpdate(): Promise<void> {
  if (!appIsQuitting) {
    appIsQuitting = true
    sleepBlockerService?.dispose()
    await backendSupervisor.stop()
  }
}

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
  app.on('second-instance', () => {
    if (!mainWindow) {
      return
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }

    mainWindow.focus()
  })

  ipcMain.on(BACKEND_READY_CHANNEL, (event) => {
    event.returnValue = backendBootstrap ?? backendSupervisor.bootstrap
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
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return { success: false, error: 'Invalid file path' }
    }

    const normalized = path.normalize(filePath)

    if (!path.isAbsolute(normalized)) {
      return { success: false, error: 'Path must be absolute' }
    }

    if (!existsSync(normalized)) {
      return { success: false, error: 'File not found' }
    }

    shell.showItemInFolder(normalized)
    return { success: true }
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

  app.whenReady().then(async () => {
    nativeTheme.themeSource = 'dark'
    fixPath()
    createApplicationMenu()
    if (app.isPackaged) {
      registerAppProtocol()
    }

    try {
      await backendSupervisor.start()
    } catch (error) {
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

    mainWindow = createMainWindow()
    initAutoUpdater({
      mainWindow,
      getBackendBaseUrl: () => backendBootstrap?.backendUrl ?? null,
      prepareQuitForUpdate,
    })
    sleepBlockerService = new SleepBlockerService({
      getBackendBaseUrl: () => backendBootstrap?.backendUrl ?? null,
      onStatusChange: (status) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('sleep-blocker-status', status)
        }
      },
    })
    sleepBlockerService.initialize()
    await loadRenderer(mainWindow)

    // Show "What's New" dialog if the app was just updated (non-blocking)
    showWhatsNewIfUpdated(mainWindow).catch((error) => {
      console.warn('Failed to show What\'s New dialog', error)
    })
  }).catch((error) => {
    console.error('Electron app failed to initialize', error)
    app.exit(1)
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', (event) => {
    if (appIsQuitting) {
      return
    }

    event.preventDefault()
    appIsQuitting = true
    sleepBlockerService?.dispose()

    void backendSupervisor.stop().finally(() => {
      app.exit(0)
    })
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

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null
    }
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch((error) => {
      console.error('Failed to open external URL', url, error)
    })
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    const appOrigins = ['http://127.0.0.1', 'http://localhost']

    const isAppOrigin = appOrigins.some((origin) => url.startsWith(origin)) || url.startsWith(`${APP_PROTOCOL_SCHEME}://`)
    if (!isAppOrigin) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  return window
}

function sendTerminalShortcut(action: 'toggle' | 'new' | 'next' | 'prev'): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }

  mainWindow.webContents.send(TERMINAL_SHORTCUT_CHANNEL, { action })
}

function createApplicationMenu(): void {
  const isMac = process.platform === 'darwin'

  if (!isMac) {
    Menu.setApplicationMenu(null)
    return
  }

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
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    })
  }

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac ? [
        { role: 'pasteAndMatchStyle' as const },
        { role: 'delete' as const },
        { role: 'selectAll' as const },
      ] : [
        { role: 'delete' as const },
        { type: 'separator' as const },
        { role: 'selectAll' as const },
      ]),
    ],
  })

  template.push({
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' as const },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      ...(isMac
        ? []
        : [
            { type: 'separator' as const },
            {
              label: 'Check for Updates...',
              click: (): void => {
                void checkForUpdatesManually()
              },
            },
          ]),
      { type: 'separator' as const },
      { role: 'togglefullscreen' },
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
      { role: 'minimize' },
      { role: 'zoom' },
      ...(isMac ? [
        { type: 'separator' as const },
        { role: 'front' as const },
      ] : [
        { role: 'close' as const },
      ]),
    ],
  })

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

async function loadRenderer(window: BrowserWindow): Promise<void> {
  if (!app.isPackaged) {
    await window.loadURL(ELECTRON_DEV_SERVER_URL)
    return
  }

  await window.loadURL(resolvePackagedRendererUrl())
}

function buildBackendBootstrap(port: number): BackendBootstrap {
  return {
    backendUrl: `http://127.0.0.1:${port}`,
    backendWsUrl: `ws://127.0.0.1:${port}`,
    version: app.getVersion(),
    platform: process.platform,
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
