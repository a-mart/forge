import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol } from 'electron'
import { fork, type ChildProcess, type ForkOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { initAutoUpdater } from './auto-updater.js'
import { fixPath } from './fix-path.js'
import { showWhatsNewIfUpdated } from './whats-new.js'

const ELECTRON_DEV_SERVER_URL = 'http://127.0.0.1:47188'
const BACKEND_READY_CHANNEL = 'forge:get-backend-bootstrap'
const BACKEND_SHUTDOWN_TIMEOUT_MS = 5_000
const BACKEND_RESTART_DELAY_MS = 1_000
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

  constructor(private readonly onReady: (port: number, isRestart: boolean) => void) {}

  get bootstrap(): BackendBootstrap {
    if (this.currentPort == null) {
      throw new Error('Backend bootstrap requested before backend was ready')
    }

    return buildBackendBootstrap(this.currentPort)
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

    return await new Promise<number>((resolve, reject) => {
      const child = fork(backendEntry, [], {
        cwd: runtimeRoot,
        env: {
          ...process.env,
          FORGE_DESKTOP: '1',
          FORGE_HOST: '127.0.0.1',
          FORGE_PORT: '0',
          FORGE_RESOURCES_DIR: resourcesDir,
        },
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        execArgv,
      } satisfies ForkOptions)

      this.child = child

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
        finalizeReject(error)
      }

      child.on('message', handleMessage)
      child.on('error', handleError)
      child.once('exit', (code, signal) => {
        if (this.child === child) {
          this.child = null
        }

        if (!ready) {
          finalizeReject(
            new Error(`Backend exited before signaling readiness (code=${code ?? 'null'}, signal=${signal ?? 'null'})`),
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
}

const backendSupervisor = new BackendSupervisor((port, isRestart) => {
  backendBootstrap = buildBackendBootstrap(port)

  if (isRestart && mainWindow && !mainWindow.isDestroyed()) {
    void loadRenderer(mainWindow)
  }
})

async function prepareQuitForUpdate(): Promise<void> {
  if (!appIsQuitting) {
    appIsQuitting = true
    await backendSupervisor.stop()
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

  app.whenReady().then(async () => {
    fixPath()
    createApplicationMenu()
    if (app.isPackaged) {
      registerAppProtocol()
    }

    try {
      await backendSupervisor.start()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      dialog.showErrorBox(
        'Forge failed to start',
        'The backend process exited unexpectedly.\n\n' +
        'This might happen if another instance is running or if there\'s a configuration issue.\n\n' +
        `${detail}\n\n` +
        'Check the logs or try restarting the app.',
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

    void backendSupervisor.stop().finally(() => {
      app.exit(0)
    })
  })
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  window.once('ready-to-show', () => {
    window.show()
  })

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null
    }
  })

  return window
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
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
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
    const packagedBackendEntry = path.join(process.resourcesPath, PACKAGED_BACKEND_DIRNAME, 'dist', 'index.js')
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
    return [...process.execArgv, '--import', require.resolve('tsx')]
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

function isBackendReadyMessage(value: unknown): value is BackendReadyMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'ready' &&
    typeof (value as { port?: unknown }).port === 'number'
  )
}
