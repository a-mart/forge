import { app, BrowserWindow, ipcMain } from 'electron'
import { fork, type ChildProcess, type ForkOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fixPath } from './fix-path.js'

const ELECTRON_DEV_SERVER_URL = 'http://127.0.0.1:47188'
const BACKEND_READY_CHANNEL = 'forge:get-backend-bootstrap'
const BACKEND_SHUTDOWN_TIMEOUT_MS = 5_000
const BACKEND_RESTART_DELAY_MS = 1_000

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
        try {
          child.kill('SIGKILL')
        } catch {
          // Ignore kill failures during shutdown.
        }
        finish()
      }, BACKEND_SHUTDOWN_TIMEOUT_MS)

      child.once('exit', () => {
        clearTimeout(timeout)
        finish()
      })

      try {
        child.send({ type: 'shutdown' })
      } catch {
        clearTimeout(timeout)
        try {
          child.kill('SIGKILL')
        } catch {
          // Ignore kill failures during shutdown.
        }
        finish()
      }
    })
  }

  private async launch(isRestart: boolean): Promise<number> {
    const backendEntry = resolveBackendEntry()
    const repoRoot = resolveRepoRoot()
    const resourcesDir = resolveBackendResourcesDir(repoRoot)
    const execArgv = resolveBackendExecArgv(backendEntry)

    return await new Promise<number>((resolve, reject) => {
      const child = fork(backendEntry, [], {
        cwd: repoRoot,
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
    await backendSupervisor.start()
    mainWindow = createMainWindow()
    await loadRenderer(mainWindow)
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

async function loadRenderer(window: BrowserWindow): Promise<void> {
  if (!app.isPackaged) {
    await window.loadURL(ELECTRON_DEV_SERVER_URL)
    return
  }

  await window.loadFile(resolvePackagedRendererEntry())
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

function resolveBackendResourcesDir(repoRoot: string): string {
  if (!app.isPackaged) {
    return repoRoot
  }

  return path.join(process.resourcesPath, 'forge-resources')
}

function resolvePackagedRendererEntry(): string {
  return path.join(process.resourcesPath, 'ui', 'index.html')
}

function resolveBackendEntry(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'backend', 'index.js')
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

function isBackendReadyMessage(value: unknown): value is BackendReadyMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'ready' &&
    typeof (value as { port?: unknown }).port === 'number'
  )
}
