import type {
  PlaywrightDiscoverySettings,
  PlaywrightDiscoverySnapshot,
} from './playwright.js'

export interface PlaywrightDiscoverySnapshotEvent {
  type: 'playwright_discovery_snapshot'
  snapshot: PlaywrightDiscoverySnapshot
}

export interface PlaywrightDiscoveryUpdatedEvent {
  type: 'playwright_discovery_updated'
  snapshot: PlaywrightDiscoverySnapshot
}

export interface PlaywrightDiscoverySettingsUpdatedEvent {
  type: 'playwright_discovery_settings_updated'
  settings: PlaywrightDiscoverySettings
}
