import type {
  PhoenixObservabilitySettings,
  PhoenixObservabilitySettingsPatch,
  PhoenixObservabilitySettingsResponse,
  PhoenixObservabilityStatus,
  PhoenixObservabilityTestResponse,
} from '@forge/protocol'
import type { SettingsApiClient } from './settings-api-client'

const SETTINGS_ENDPOINT = '/api/phoenix-observability/settings'
const STATUS_ENDPOINT = '/api/phoenix-observability/status'
const TEST_ENDPOINT = '/api/phoenix-observability/test'

export async function fetchPhoenixObservabilitySettings(
  client: SettingsApiClient,
): Promise<PhoenixObservabilitySettingsResponse> {
  return client.fetchJson<PhoenixObservabilitySettingsResponse>(SETTINGS_ENDPOINT)
}

export async function updatePhoenixObservabilitySettings(
  client: SettingsApiClient,
  patch: PhoenixObservabilitySettingsPatch,
): Promise<PhoenixObservabilitySettingsResponse> {
  return client.fetchJson<PhoenixObservabilitySettingsResponse>(SETTINGS_ENDPOINT, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

export async function fetchPhoenixObservabilityStatus(
  client: SettingsApiClient,
): Promise<PhoenixObservabilityStatus> {
  const result = await client.fetchJson<{ status: PhoenixObservabilityStatus }>(STATUS_ENDPOINT)
  return result.status
}

export async function testPhoenixObservabilityConnection(
  client: SettingsApiClient,
  settings?: PhoenixObservabilitySettingsPatch,
): Promise<PhoenixObservabilityTestResponse> {
  return client.fetchJson<PhoenixObservabilityTestResponse>(TEST_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings ? { settings } : {}),
  })
}

export function buildPhoenixObservabilityPatchFromSettings(
  settings: PhoenixObservabilitySettings,
): PhoenixObservabilitySettingsPatch {
  return {
    enabled: settings.enabled,
    endpoint: settings.endpoint,
    projectName: settings.projectName,
    contentMode: settings.contentMode,
    capture: settings.capture,
    privacy: settings.privacy,
    export: settings.export,
  }
}
