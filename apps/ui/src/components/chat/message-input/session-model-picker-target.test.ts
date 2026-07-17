import { describe, expect, it } from 'vitest'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import { resolveSessionModelPickerApiClient } from './session-model-picker-target'

function client(label: string): SettingsApiClient {
  return { label } as unknown as SettingsApiClient
}

describe('resolveSessionModelPickerApiClient', () => {
  it('returns the exact target-aware client held by the active-origin ref', () => {
    const remoteClient = client('remote')

    expect(resolveSessionModelPickerApiClient({ current: remoteClient })).toBe(remoteClient)
  })

  it('does not reconstruct a local target when the active-origin ref is unavailable', () => {
    expect(resolveSessionModelPickerApiClient({ current: null })).toBeNull()
  })
})
