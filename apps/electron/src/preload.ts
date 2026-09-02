import { contextBridge, ipcRenderer } from 'electron'
import type { SleepBlockerSettingsPatch, SleepBlockerStatus } from './sleep-blocker.js'
import { createTrustedBrowserBridge, createTrustedBrowserWorkspaceBridge } from './browser/trusted-browser-bridge.js'
import type { ElectronWindowRole } from './browser/browser-bridge-contract.js'
import {
  SECURE_VAULT_RENDERER_CHANNEL,
  type SecureVaultRendererResponse,
} from './secure-vault-ipc.js'
import { createTrustedExternalChromeBridge } from './external-chrome/ipc.js'
import { MAIN_RENDERER_READY_CHANNEL } from './main-renderer-recovery.js'
import { OPEN_PDF_IN_DEFAULT_APP_CHANNEL } from './open-pdf-ipc.js'

const BACKEND_READY_CHANNEL = 'forge:get-backend-bootstrap'
const TERMINAL_SHORTCUT_CHANNEL = 'bridge:terminal-shortcut'

type BackendBootstrap = {
  backendUrl: string
  backendWsUrl: string
  version: string
  platform: string
  appRuntime: 'development' | 'installed'
  appStartedAt: string
  windowRole: ElectronWindowRole
  managedBrowserPopoutAvailable: boolean
  secureControlToken?: string
}

const bootstrap = readBootstrap()
const browserWorkspace = createTrustedBrowserWorkspaceBridge(
  ipcRenderer,
  bootstrap.windowRole,
  bootstrap.managedBrowserPopoutAvailable,
)

const roleScopedBridge = bootstrap.windowRole === 'managed-browser-popout'
  ? {
      windowRole: bootstrap.windowRole,
      platform: bootstrap.platform,
      browserWorkspace,
      secureControlToken: bootstrap.secureControlToken,
    }
  : {
      windowRole: bootstrap.windowRole,
      backendUrl: bootstrap.backendUrl,
      backendWsUrl: bootstrap.backendWsUrl,
      getVersion: (): string => bootstrap.version,
      appRuntime: bootstrap.appRuntime,
      appStartedAt: bootstrap.appStartedAt,
      platform: bootstrap.platform,
      secureControlToken: bootstrap.secureControlToken,
      markRendererReady: (): void => ipcRenderer.send(MAIN_RENDERER_READY_CHANNEL),
      browserAutomation: createTrustedBrowserBridge(ipcRenderer),
      browserWorkspace,
      externalChrome: createTrustedExternalChromeBridge(ipcRenderer),
      showOpenDialog: (options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> =>
        ipcRenderer.invoke('bridge:showOpenDialog', options),
      onTerminalShortcut: (listener: (event: { action: 'toggle' | 'new' | 'next' | 'prev' }) => void): (() => void) => {
        const wrapped = (_event: Electron.IpcRendererEvent, payload: { action: 'toggle' | 'new' | 'next' | 'prev' }) => listener(payload)
        ipcRenderer.on(TERMINAL_SHORTCUT_CHANNEL, wrapped)
        return () => ipcRenderer.removeListener(TERMINAL_SHORTCUT_CHANNEL, wrapped)
      },
      updateTitleBarOverlay: (colors: { color: string; symbolColor: string }): void => ipcRenderer.send('update-title-bar-overlay', colors),
      checkForUpdates: (): Promise<void> => ipcRenderer.invoke('check-for-updates'),
      downloadUpdate: (): Promise<void> => ipcRenderer.invoke('download-update'),
      installUpdate: (): Promise<void> => ipcRenderer.invoke('install-update'),
      getBetaChannel: (): Promise<boolean> => ipcRenderer.invoke('get-beta-channel'),
      setBetaChannel: (enabled: boolean): Promise<void> => ipcRenderer.invoke('set-beta-channel', enabled),
      getSleepBlockerSettings: (): Promise<SleepBlockerStatus> => ipcRenderer.invoke('get-sleep-blocker-settings'),
      setSleepBlockerSettings: (patch: SleepBlockerSettingsPatch): Promise<SleepBlockerStatus | null> => ipcRenderer.invoke('set-sleep-blocker-settings', patch),
      revealInFolder: (filePath: string): Promise<void> => ipcRenderer.invoke('reveal-in-folder', filePath),
      openPdfInDefaultApp: (request: { filePath?: string; bytes?: Uint8Array; fileName?: string }): Promise<{ success: boolean; error?: string }> =>
        ipcRenderer.invoke(OPEN_PDF_IN_DEFAULT_APP_CHANNEL, request),
      installCli: (): Promise<{
        success: boolean
        installedPath: string
        binDir: string
        pathIncluded: boolean
        pathInstructions: string | null
        error?: string
      }> => ipcRenderer.invoke('install-cli'),
      verifyCliInstall: (): Promise<{ ok: boolean; output: string }> => ipcRenderer.invoke('verify-cli-install'),
      getStreamDeckPluginStatus: () => ipcRenderer.invoke('get-stream-deck-plugin-status'),
      installStreamDeckPlugin: () => ipcRenderer.invoke('install-stream-deck-plugin'),
      openStreamDeck: () => ipcRenderer.invoke('open-stream-deck'),
      focusMainWindow: (): Promise<void> => ipcRenderer.invoke('focus-main-window'),
      secureVault: {
        status: (): Promise<SecureVaultRendererResponse> =>
          ipcRenderer.invoke(SECURE_VAULT_RENDERER_CHANNEL, { operation: 'status' }),
        unlock: (): Promise<SecureVaultRendererResponse> =>
          ipcRenderer.invoke(SECURE_VAULT_RENDERER_CHANNEL, { operation: 'unlock' }),
        encryptLocalValue: (value: string): Promise<SecureVaultRendererResponse> =>
          ipcRenderer.invoke(SECURE_VAULT_RENDERER_CHANNEL, { operation: 'encrypt', value }),
      },
      onUpdateStatus: (callback: (status: { type: string; version?: string; percent?: number; message?: string }) => void): (() => void) => {
        const handler = (_event: Electron.IpcRendererEvent, status: { type: string; version?: string; percent?: number; message?: string }) => callback(status)
        ipcRenderer.on('update-status', handler)
        return () => ipcRenderer.removeListener('update-status', handler)
      },
      onSleepBlockerStatus: (callback: (status: SleepBlockerStatus) => void): (() => void) => {
        const handler = (_event: Electron.IpcRendererEvent, status: SleepBlockerStatus): void => callback(status)
        ipcRenderer.on('sleep-blocker-status', handler)
        return () => ipcRenderer.removeListener('sleep-blocker-status', handler)
      },
    }

contextBridge.exposeInMainWorld('electronBridge', roleScopedBridge)

function readBootstrap(): BackendBootstrap {
  const value = ipcRenderer.sendSync(BACKEND_READY_CHANNEL) as Partial<BackendBootstrap> | null
  if (!value) throw new Error('Electron bridge bootstrap was not available from the main process')
  if (value.windowRole !== 'main' && value.windowRole !== 'managed-browser-popout') throw new Error('Electron bridge bootstrap did not include a valid windowRole')
  if (typeof value.platform !== 'string' || value.platform.length === 0) throw new Error('Electron bridge bootstrap did not include a valid platform')
  if (value.appRuntime !== 'development' && value.appRuntime !== 'installed') throw new Error('Electron bridge bootstrap did not include a valid appRuntime')
  if (typeof value.appStartedAt !== 'string' || !Number.isFinite(Date.parse(value.appStartedAt))) throw new Error('Electron bridge bootstrap did not include a valid appStartedAt')
  if (typeof value.managedBrowserPopoutAvailable !== 'boolean') throw new Error('Electron bridge bootstrap did not include Managed Browser capability')
  if (value.windowRole === 'main') {
    if (typeof value.backendUrl !== 'string' || value.backendUrl.length === 0) throw new Error('Electron bridge bootstrap did not include a valid backendUrl')
    if (typeof value.backendWsUrl !== 'string' || value.backendWsUrl.length === 0) throw new Error('Electron bridge bootstrap did not include a valid backendWsUrl')
    if (typeof value.version !== 'string') throw new Error('Electron bridge bootstrap did not include a valid version')
    if (typeof value.secureControlToken !== 'string' || value.secureControlToken.length < 32) throw new Error('Electron bridge bootstrap did not include a valid secure control capability')
  }
  return {
    backendUrl: value.backendUrl ?? '',
    backendWsUrl: value.backendWsUrl ?? '',
    version: value.version ?? '',
    platform: value.platform,
    appRuntime: value.appRuntime,
    appStartedAt: value.appStartedAt,
    windowRole: value.windowRole,
    managedBrowserPopoutAvailable: value.managedBrowserPopoutAvailable,
    ...(value.secureControlToken ? { secureControlToken: value.secureControlToken } : {}),
  }
}
