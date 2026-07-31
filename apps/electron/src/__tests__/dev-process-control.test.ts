import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  ELECTRON_DEVELOPMENT_SHUTDOWN_MESSAGE,
  installElectronDevelopmentProcessControl,
  isElectronDevelopmentShutdownMessage,
} from '../dev-process-control.js'

class FakeProcessPort extends EventEmitter {
  constructor(readonly connected: boolean) {
    super()
  }
}

describe('Electron development process control', () => {
  it('accepts only the fixed development shutdown message', () => {
    expect(isElectronDevelopmentShutdownMessage({
      type: ELECTRON_DEVELOPMENT_SHUTDOWN_MESSAGE,
    })).toBe(true)
    expect(isElectronDevelopmentShutdownMessage({ type: 'shutdown' })).toBe(false)
    expect(isElectronDevelopmentShutdownMessage(null)).toBe(false)
  })

  it('requests quit for a message or launcher disconnect and can be disposed', () => {
    const processPort = new FakeProcessPort(true)
    const requestQuit = vi.fn()
    const dispose = installElectronDevelopmentProcessControl({
      isPackaged: false,
      processPort,
      requestQuit,
    })

    processPort.emit('message', { type: ELECTRON_DEVELOPMENT_SHUTDOWN_MESSAGE })
    expect(requestQuit).toHaveBeenCalledOnce()
    processPort.emit('disconnect')
    expect(requestQuit).toHaveBeenCalledTimes(2)

    dispose()
    processPort.emit('message', { type: ELECTRON_DEVELOPMENT_SHUTDOWN_MESSAGE })
    processPort.emit('disconnect')
    expect(requestQuit).toHaveBeenCalledTimes(2)
  })

  it('does not install control handlers in packaged or disconnected processes', () => {
    const packagedPort = new FakeProcessPort(true)
    const disconnectedPort = new FakeProcessPort(false)
    const requestQuit = vi.fn()

    installElectronDevelopmentProcessControl({
      isPackaged: true,
      processPort: packagedPort,
      requestQuit,
    })
    installElectronDevelopmentProcessControl({
      isPackaged: false,
      processPort: disconnectedPort,
      requestQuit,
    })

    expect(packagedPort.listenerCount('message')).toBe(0)
    expect(packagedPort.listenerCount('disconnect')).toBe(0)
    expect(disconnectedPort.listenerCount('message')).toBe(0)
    expect(disconnectedPort.listenerCount('disconnect')).toBe(0)
    expect(requestQuit).not.toHaveBeenCalled()
  })
})
