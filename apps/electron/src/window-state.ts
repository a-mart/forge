import { app, BrowserWindow, screen } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  isMaximized: boolean
  isFullScreen: boolean
}

export interface WindowStateOptions {
  key?: string
  minWidth?: number
  minHeight?: number
  defaultState?: WindowState
}

const DEBOUNCE_MS = 500
const DEFAULT_STATE: WindowState = { width: 1440, height: 960, isMaximized: false, isFullScreen: false }

function stateFile(key = 'window-state'): string {
  const safeKey = key.replace(/[^a-z0-9-]/gi, '') || 'window-state'
  return path.join(app.getPath('userData'), `${safeKey}.json`)
}

function captureState(window: BrowserWindow): WindowState {
  const normalBounds = window.getNormalBounds()
  return {
    x: normalBounds.x, y: normalBounds.y, width: normalBounds.width, height: normalBounds.height,
    isMaximized: window.isMaximized(), isFullScreen: window.isFullScreen(),
  }
}

function writeState(state: WindowState, options: WindowStateOptions): void {
  try {
    const file = stateFile(options.key)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(state), 'utf-8')
  } catch { /* Window state persistence is best effort. */ }
}

export function loadWindowState(options: WindowStateOptions = {}): WindowState {
  const defaults = options.defaultState ?? DEFAULT_STATE
  const minWidth = options.minWidth ?? 800
  const minHeight = options.minHeight ?? 600
  try {
    const saved = JSON.parse(readFileSync(stateFile(options.key), 'utf-8')) as Partial<WindowState>
    if (!Number.isFinite(saved.width) || !Number.isFinite(saved.height)) return { ...defaults }
    const state: WindowState = {
      width: Math.max(saved.width as number, minWidth),
      height: Math.max(saved.height as number, minHeight),
      isMaximized: saved.isMaximized === true,
      isFullScreen: saved.isFullScreen === true,
    }
    if (typeof saved.x === 'number' && Number.isFinite(saved.x) && typeof saved.y === 'number' && Number.isFinite(saved.y)) {
      const visible = screen.getAllDisplays().some(({ workArea }) =>
        saved.x! >= workArea.x - 100 && saved.x! < workArea.x + workArea.width
        && saved.y! >= workArea.y - 100 && saved.y! < workArea.y + workArea.height)
      if (visible) { state.x = saved.x; state.y = saved.y }
    }
    return state
  } catch { return { ...defaults } }
}

export function trackWindowState(window: BrowserWindow, options: WindowStateOptions = {}): () => void {
  let saveTimer: NodeJS.Timeout | null = null
  const save = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      if (!window.isDestroyed() && !window.isMinimized()) writeState(captureState(window), options)
    }, DEBOUNCE_MS)
  }
  window.on('resize', save)
  window.on('move', save)
  window.on('maximize', save)
  window.on('unmaximize', save)
  window.on('enter-full-screen', save)
  window.on('leave-full-screen', save)
  const close = (): void => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    if (!window.isDestroyed()) writeState(captureState(window), options)
  }
  window.on('close', close)
  return () => {
    if (saveTimer) clearTimeout(saveTimer)
    window.off('resize', save)
    window.off('move', save)
    window.off('maximize', save)
    window.off('unmaximize', save)
    window.off('enter-full-screen', save)
    window.off('leave-full-screen', save)
    window.off('close', close)
  }
}
