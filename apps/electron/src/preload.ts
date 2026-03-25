import { contextBridge, ipcRenderer } from 'electron'

const BACKEND_READY_CHANNEL = 'forge:get-backend-bootstrap'

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
