import type { SecureSessionPickerConfig } from '@/components/chat/secure-session/types'

type PickerVisibilityConfig = Pick<
  SecureSessionPickerConfig,
  'availability' | 'snapshot' | 'readOnly' | 'secrets' | 'outputState'
>

/**
 * Secure Sessions stay quiet until this project has a usable secret. Recovery
 * controls remain visible whenever secure state needs user attention, even if
 * the source or runtime later becomes unavailable.
 */
export function shouldShowSecureSessionPicker(
  config: PickerVisibilityConfig,
): boolean {
  const snapshot = config.snapshot
  const needsAttention =
    config.outputState === 'quarantined'
    || snapshot?.leases.some((lease) => lease.status === 'active')
    || (
      snapshot?.executionMode === 'secure'
      && snapshot.environmentStatus !== 'stopped'
    )
  if (needsAttention) return true

  if (config.readOnly || config.availability.state !== 'available') {
    return false
  }

  if (snapshot?.projectDefaults?.some(
    (projectDefault) => projectDefault.state !== 'unavailable',
  )) {
    return true
  }

  return config.secrets.some((secret) =>
    secret.available && secret.bindings.length > 0)
}
