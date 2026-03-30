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

const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json')
const DEBOUNCE_MS = 500
const MIN_WIDTH = 800
const MIN_HEIGHT = 600
const DEFAULT_STATE: WindowState = {
  width: 1440,
  height: 960,
  isMaximized: false,
  isFullScreen: false,
}

function captureState(window: BrowserWindow): WindowState {
  const normalBounds = window.getNormalBounds()

  return {
    x: normalBounds.x,
    y: normalBounds.y,
    width: normalBounds.width,
    height: normalBounds.height,
    isMaximized: window.isMaximized(),
    isFullScreen: window.isFullScreen(),
  }
}

function writeState(state: WindowState): void {
  try {
    mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(state), 'utf-8')
  } catch {
    // Silently ignore write failures.
  }
}

export function loadWindowState(): WindowState {
  try {
    const raw = readFileSync(STATE_FILE, 'utf-8')
    const saved = JSON.parse(raw) as Partial<WindowState>

    if (!Number.isFinite(saved.width) || !Number.isFinite(saved.height)) {
      return { ...DEFAULT_STATE }
    }

    const state: WindowState = {
      width: Math.max(saved.width as number, MIN_WIDTH),
      height: Math.max(saved.height as number, MIN_HEIGHT),
      isMaximized: saved.isMaximized === true,
      isFullScreen: saved.isFullScreen === true,
    }

    if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      const displays = screen.getAllDisplays()
      const visible = displays.some((display) => {
        const { x, y, width, height } = display.workArea
        return saved.x >= x - 100 && saved.x < x + width && saved.y >= y - 100 && saved.y < y + height
      })

      if (visible) {
        state.x = saved.x
        state.y = saved.y
      }
    }

    return state
  } catch {
    return { ...DEFAULT_STATE }
  }
}

export function trackWindowState(window: BrowserWindow): void {
  let saveTimer: NodeJS.Timeout | null = null

  const debouncedSave = (): void => {
    if (saveTimer) {
      clearTimeout(saveTimer)
    }

    saveTimer = setTimeout(() => {
      saveTimer = null

      if (window.isDestroyed() || window.isMinimized()) {
        return
      }

      writeState(captureState(window))
    }, DEBOUNCE_MS)
  }

  window.on('resize', debouncedSave)
  window.on('move', debouncedSave)
  window.on('maximize', debouncedSave)
  window.on('unmaximize', debouncedSave)
  window.on('enter-full-screen', debouncedSave)
  window.on('leave-full-screen', debouncedSave)
  window.on('close', () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }

    if (window.isDestroyed()) {
      return
    }

    writeState(captureState(window))
  })
}
