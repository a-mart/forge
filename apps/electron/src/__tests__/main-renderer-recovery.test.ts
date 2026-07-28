import { EventEmitter } from 'node:events'
import type { BrowserWindow, WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installMainRendererRecovery,
  type MainRendererRecoveryEvent,
} from '../main-renderer-recovery.js'

function createWindow() {
  const webContents = new EventEmitter() as EventEmitter & {
    isDestroyed(): boolean
  }
  webContents.isDestroyed = vi.fn(() => false)
  const window = {
    isDestroyed: vi.fn(() => false),
    webContents,
  } as unknown as BrowserWindow
  return { window, webContents }
}

function emitMainFrameNavigation(webContents: EventEmitter): void {
  webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('installMainRendererRecovery', () => {
  it('accepts only the authoritative renderer readiness signal and cancels its watchdog', () => {
    vi.useFakeTimers()
    const { window, webContents } = createWindow()
    const loadRenderer = vi.fn(async () => undefined)
    const controller = installMainRendererRecovery({
      window,
      loadRenderer,
      isClosing: () => false,
      readyTimeoutMs: 100,
      recoveryDelayMs: 10,
    })

    emitMainFrameNavigation(webContents)
    expect(controller.markReady({} as WebContents)).toBe(false)
    expect(controller.markReady(webContents as unknown as WebContents)).toBe(true)
    vi.advanceTimersByTime(200)

    expect(loadRenderer).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('reloads only the renderer after a renderer-process exit', async () => {
    vi.useFakeTimers()
    const { window, webContents } = createWindow()
    const events: MainRendererRecoveryEvent[] = []
    const loadRenderer = vi.fn(async () => undefined)
    const controller = installMainRendererRecovery({
      window,
      loadRenderer,
      isClosing: () => false,
      readyTimeoutMs: 100,
      recoveryDelayMs: 10,
      onEvent: (event) => events.push(event),
    })

    webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 9 })
    await vi.advanceTimersByTimeAsync(10)
    emitMainFrameNavigation(webContents)
    expect(controller.markReady(webContents as unknown as WebContents)).toBe(true)

    expect(loadRenderer).toHaveBeenCalledTimes(1)
    expect(events).toContainEqual({ type: 'attempt', reason: 'render-process-gone', attempt: 1 })
    expect(events).toContainEqual({ type: 'ready', recovered: true })
    controller.dispose()
  })

  it('does not let stale readiness cancel a scheduled crash recovery', async () => {
    vi.useFakeTimers()
    const { window, webContents } = createWindow()
    const loadRenderer = vi.fn(async () => undefined)
    const controller = installMainRendererRecovery({
      window,
      loadRenderer,
      isClosing: () => false,
      recoveryDelayMs: 10,
    })

    emitMainFrameNavigation(webContents)
    webContents.emit('render-process-gone')
    expect(controller.markReady(webContents as unknown as WebContents)).toBe(false)
    await vi.advanceTimersByTimeAsync(10)

    expect(loadRenderer).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('ignores subframe failures and aborted main-frame navigations', async () => {
    vi.useFakeTimers()
    const { window, webContents } = createWindow()
    const loadRenderer = vi.fn(async () => undefined)
    const controller = installMainRendererRecovery({
      window,
      loadRenderer,
      isClosing: () => false,
      recoveryDelayMs: 10,
    })

    webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://frame.invalid', false)
    webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://forge.invalid', true)
    await vi.advanceTimersByTimeAsync(20)
    expect(loadRenderer).not.toHaveBeenCalled()

    webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://forge.invalid', true)
    await vi.advanceTimersByTimeAsync(10)
    expect(loadRenderer).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  it('ignores spinner activity, subframe navigations, and same-document navigations', async () => {
    vi.useFakeTimers()
    const { window, webContents } = createWindow()
    const loadRenderer = vi.fn(async () => undefined)
    const controller = installMainRendererRecovery({
      window,
      loadRenderer,
      isClosing: () => false,
      readyTimeoutMs: 20,
      recoveryDelayMs: 5,
    })

    webContents.emit('did-start-loading')
    webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    await vi.advanceTimersByTimeAsync(30)

    expect(loadRenderer).not.toHaveBeenCalled()
    expect(controller.markReady(webContents as unknown as WebContents)).toBe(false)
    controller.dispose()
  })

  it('caps recovery when renderer loads never mount React', async () => {
    vi.useFakeTimers()
    const { window, webContents } = createWindow()
    const events: MainRendererRecoveryEvent[] = []
    const loadRenderer = vi.fn(async () => {
      emitMainFrameNavigation(webContents)
    })
    const controller = installMainRendererRecovery({
      window,
      loadRenderer,
      isClosing: () => false,
      readyTimeoutMs: 20,
      recoveryDelayMs: 5,
      maxRecoveryAttempts: 3,
      onEvent: (event) => events.push(event),
    })

    emitMainFrameNavigation(webContents)
    await vi.advanceTimersByTimeAsync(100)

    expect(loadRenderer).toHaveBeenCalledTimes(3)
    expect(events.at(-1)).toEqual({ type: 'exhausted', reason: 'renderer-ready-timeout', attempts: 3 })
    controller.dispose()
  })

  it('retries a rejected renderer load without exceeding the attempt cap', async () => {
    vi.useFakeTimers()
    const { window, webContents } = createWindow()
    const loadRenderer = vi.fn()
      .mockRejectedValueOnce(new Error('load rejected'))
      .mockResolvedValueOnce(undefined)
    const controller = installMainRendererRecovery({
      window,
      loadRenderer,
      isClosing: () => false,
      recoveryDelayMs: 5,
      maxRecoveryAttempts: 2,
    })

    webContents.emit('render-process-gone')
    await vi.advanceTimersByTimeAsync(10)

    expect(loadRenderer).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('does not recover while the app is closing', async () => {
    vi.useFakeTimers()
    const { window, webContents } = createWindow()
    const loadRenderer = vi.fn(async () => undefined)
    const controller = installMainRendererRecovery({
      window,
      loadRenderer,
      isClosing: () => true,
      recoveryDelayMs: 1,
    })

    webContents.emit('render-process-gone')
    await vi.advanceTimersByTimeAsync(10)
    expect(loadRenderer).not.toHaveBeenCalled()
    controller.dispose()
  })
})
