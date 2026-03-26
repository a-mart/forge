import { contextBridge, ipcRenderer } from 'electron'

const BACKEND_READY_CHANNEL = 'forge:get-backend-bootstrap'
const TERMINAL_SHORTCUT_CHANNEL = 'bridge:terminal-shortcut'

type BackendBootstrap = {
  backendUrl: string
  backendWsUrl: string
  version: string
  platform: string
}

const bootstrap = readBootstrap()

contextBridge.exposeInMainWorld('electronBridge', {
  backendUrl: bootstrap.backendUrl,
  backendWsUrl: bootstrap.backendWsUrl,
  getVersion: (): string => bootstrap.version,
  platform: bootstrap.platform,
  showOpenDialog: (options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> =>
    ipcRenderer.invoke('bridge:showOpenDialog', options),
  onTerminalShortcut: (listener: (event: { action: 'toggle' | 'new' | 'next' | 'prev' }) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: { action: 'toggle' | 'new' | 'next' | 'prev' }) => {
      listener(payload)
    }
    ipcRenderer.on(TERMINAL_SHORTCUT_CHANNEL, wrapped)
    return () => {
      ipcRenderer.removeListener(TERMINAL_SHORTCUT_CHANNEL, wrapped)
    }
  },
  updateTitleBarOverlay: (colors: { color: string; symbolColor: string }): void => {
    ipcRenderer.send('update-title-bar-overlay', colors)
  },
})

function readBootstrap(): BackendBootstrap {
  const bootstrap = ipcRenderer.sendSync(BACKEND_READY_CHANNEL) as BackendBootstrap | null

  if (!bootstrap) {
    throw new Error('Electron bridge bootstrap was not available from the main process')
  }

  if (typeof bootstrap.backendUrl !== 'string' || bootstrap.backendUrl.length === 0) {
    throw new Error('Electron bridge bootstrap did not include a valid backendUrl')
  }

  if (typeof bootstrap.backendWsUrl !== 'string' || bootstrap.backendWsUrl.length === 0) {
    throw new Error('Electron bridge bootstrap did not include a valid backendWsUrl')
  }

  if (typeof bootstrap.version !== 'string') {
    throw new Error('Electron bridge bootstrap did not include a valid version')
  }

  if (typeof bootstrap.platform !== 'string' || bootstrap.platform.length === 0) {
    throw new Error('Electron bridge bootstrap did not include a valid platform')
  }

  return bootstrap
}
