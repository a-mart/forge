import { app, BrowserWindow, screen } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
  isMaximized: boolean
}

const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json')
const DEBOUNCE_MS = 500
const DEFAULT_BOUNDS: WindowBounds = { x: -1, y: -1, width: 1440, height: 960, isMaximized: false }

export function loadWindowState(): WindowBounds {
  try {
    const raw = readFileSync(STATE_FILE, 'utf-8')
    const saved = JSON.parse(raw) as WindowBounds

    if (typeof saved.width !== 'number' || typeof saved.height !== 'number') {
      return DEFAULT_BOUNDS
    }

    // Clamp minimum size
    saved.width = Math.max(saved.width, 800)
    saved.height = Math.max(saved.height, 600)

    // Verify saved position is on a visible display
    if (typeof saved.x === 'number' && typeof saved.y === 'number' && saved.x !== -1) {
      const displays = screen.getAllDisplays()
      const visible = displays.some((d) => {
        const { x, y, width, height } = d.workArea
        return saved.x >= x - 100 && saved.x < x + width && saved.y >= y - 100 && saved.y < y + height
      })

      if (!visible) {
        saved.x = -1
        saved.y = -1
      }
    }

    return saved
  } catch {
    return DEFAULT_BOUNDS
  }
}

export function trackWindowState(window: BrowserWindow): void {
  let saveTimer: NodeJS.Timeout | null = null

  const save = (): void => {
    if (saveTimer) {
      clearTimeout(saveTimer)
    }

    saveTimer = setTimeout(() => {
      saveTimer = null

      if (window.isDestroyed() || window.isMinimized()) {
        return
      }

      const bounds: WindowBounds = {
        ...window.getBounds(),
        isMaximized: window.isMaximized(),
      }

      try {
        mkdirSync(path.dirname(STATE_FILE), { recursive: true })
        writeFileSync(STATE_FILE, JSON.stringify(bounds), 'utf-8')
      } catch {
        // Silently ignore write failures.
      }
    }, DEBOUNCE_MS)
  }

  window.on('resize', save)
  window.on('move', save)
  window.on('maximize', save)
  window.on('unmaximize', save)
}
