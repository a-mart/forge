import type { RefObject } from 'react'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'

/** Capture the target-aware active-origin client at interaction time. */
export function resolveSessionModelPickerApiClient(
  httpClientRef: RefObject<SettingsApiClient | null>,
): SettingsApiClient | null {
  return httpClientRef.current
}
