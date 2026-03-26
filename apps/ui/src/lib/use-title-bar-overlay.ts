import { useEffect } from 'react'
import { isElectron } from './electron-bridge'

/**
 * Syncs the Electron title bar overlay colors with the app's current theme.
 * Only runs on Windows/Linux in Electron.
 */
export function useTitleBarOverlay() {
  useEffect(() => {
    if (!isElectron()) {
      return
    }

    const updateOverlayColors = (): void => {
      const style = getComputedStyle(document.documentElement)

      // Read the actual CSS variable values for card (header background) and foreground
      const cardColor = style.getPropertyValue('--card').trim()
      const foregroundColor = style.getPropertyValue('--foreground').trim()

      // Convert HSL to hex for Electron API
      const cardHex = hslToHex(cardColor)
      const foregroundHex = hslToHex(foregroundColor)

      window.electronBridge?.updateTitleBarOverlay?.({
        color: cardHex,
        symbolColor: foregroundHex,
      })
    }

    // Update immediately
    updateOverlayColors()

    // Watch for theme changes (dark class toggle)
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
          updateOverlayColors()
          break
        }
      }
    })

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })

    return () => {
      observer.disconnect()
    }
  }, [])
}

/**
 * Convert HSL color string to hex.
 * Tailwind CSS variables are in HSL format, but Electron's titleBarOverlay expects hex.
 */
function hslToHex(hsl: string): string {
  // Parse HSL string like "47.9 27.1% 95.9%"
  const parts = hsl.split(/\s+/)
  if (parts.length !== 3) {
    // Fallback to a neutral color if parsing fails
    return '#f8f5f0'
  }

  const h = parseFloat(parts[0])
  const s = parseFloat(parts[1].replace('%', '')) / 100
  const l = parseFloat(parts[2].replace('%', '')) / 100

  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2

  let r = 0
  let g = 0
  let b = 0

  if (h >= 0 && h < 60) {
    r = c
    g = x
    b = 0
  } else if (h >= 60 && h < 120) {
    r = x
    g = c
    b = 0
  } else if (h >= 120 && h < 180) {
    r = 0
    g = c
    b = x
  } else if (h >= 180 && h < 240) {
    r = 0
    g = x
    b = c
  } else if (h >= 240 && h < 300) {
    r = x
    g = 0
    b = c
  } else if (h >= 300 && h < 360) {
    r = c
    g = 0
    b = x
  }

  const toHex = (n: number): string => {
    const hex = Math.round((n + m) * 255).toString(16)
    return hex.length === 1 ? `0${hex}` : hex
  }

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}
