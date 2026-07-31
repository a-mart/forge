export const ELECTRON_DEVELOPMENT_SHUTDOWN_MESSAGE = 'forge:electron-development-shutdown'

interface DevelopmentProcessPort {
  connected?: boolean
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'disconnect', listener: () => void): unknown
  off(event: 'message', listener: (message: unknown) => void): unknown
  off(event: 'disconnect', listener: () => void): unknown
}

export function isElectronDevelopmentShutdownMessage(message: unknown): boolean {
  return typeof message === 'object'
    && message !== null
    && (message as { type?: unknown }).type === ELECTRON_DEVELOPMENT_SHUTDOWN_MESSAGE
}

export function installElectronDevelopmentProcessControl(options: {
  isPackaged: boolean
  processPort: DevelopmentProcessPort
  requestQuit: () => void
}): () => void {
  if (options.isPackaged || options.processPort.connected !== true) {
    return () => {}
  }

  const onMessage = (message: unknown): void => {
    if (isElectronDevelopmentShutdownMessage(message)) {
      options.requestQuit()
    }
  }
  const onDisconnect = (): void => {
    options.requestQuit()
  }

  options.processPort.on('message', onMessage)
  options.processPort.on('disconnect', onDisconnect)
  return () => {
    options.processPort.off('message', onMessage)
    options.processPort.off('disconnect', onDisconnect)
  }
}
