import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

export interface ElectronSettings {
  betaChannel: boolean
}

const DEFAULTS: ElectronSettings = {
  betaChannel: false,
}

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'electron-settings.json')
}

export function readSettings(): ElectronSettings {
  try {
    const raw = readFileSync(getSettingsPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<ElectronSettings>
    return { ...DEFAULTS, ...parsed }
  } catch {
    return { ...DEFAULTS }
  }
}

export function writeSettings(settings: ElectronSettings): void {
  try {
    const settingsPath = getSettingsPath()
    mkdirSync(path.dirname(settingsPath), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8')
  } catch (error) {
    console.warn('[electron-settings] Failed to write settings', error)
  }
}
