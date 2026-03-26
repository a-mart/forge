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

      // Convert to hex for Electron API (may already be hex, or HSL)
      const cardHex = toHex(cardColor)
      const foregroundHex = toHex(foregroundColor)

      if (cardHex && foregroundHex) {
        window.electronBridge?.updateTitleBarOverlay?.({
          color: cardHex,
          symbolColor: foregroundHex,
        })
      }
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
 * Convert a CSS color value to hex. Handles:
 * - Hex passthrough: "#f8f5f0" -> "#f8f5f0"
 * - RGB: "rgb(248, 245, 240)" -> "#f8f5f0"
 * - HSL string: "47.9 27.1% 95.9%" -> "#f8f5f0"
 */
function toHex(value: string): string | null {
  if (!value) return null

  // Already hex
  if (value.startsWith('#')) return value

  // rgb(r, g, b) or rgba(r, g, b, a)
  const rgbMatch = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1]).toString(16).padStart(2, '0')
    const g = parseInt(rgbMatch[2]).toString(16).padStart(2, '0')
    const b = parseInt(rgbMatch[3]).toString(16).padStart(2, '0')
    return `#${r}${g}${b}`
  }

  // HSL string "H S% L%"
  const parts = value.split(/\s+/)
  if (parts.length >= 3) {
    const h = parseFloat(parts[0])
    const s = parseFloat(parts[1].replace('%', '')) / 100
    const l = parseFloat(parts[2].replace('%', '')) / 100
    if (!isNaN(h) && !isNaN(s) && !isNaN(l)) {
      const c = (1 - Math.abs(2 * l - 1)) * s
      const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
      const m = l - c / 2
      let r = 0, g = 0, b = 0
      if (h < 60) { r = c; g = x }
      else if (h < 120) { r = x; g = c }
      else if (h < 180) { g = c; b = x }
      else if (h < 240) { g = x; b = c }
      else if (h < 300) { r = x; b = c }
      else { r = c; b = x }
      const toH = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0')
      return `#${toH(r)}${toH(g)}${toH(b)}`
    }
  }

  return null
}
