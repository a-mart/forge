import type {
  SecureSecretDeliveryKind,
  SecureSecretProviderSummary,
} from '@/lib/secure-secrets-api'

export function providerLabel(
  providerId: string,
  providers: SecureSecretProviderSummary[],
): string {
  return providers.find((provider) => provider.providerId === providerId)?.displayName
    ?? 'Unknown source'
}

export const DELIVERY_LABELS: Record<SecureSecretDeliveryKind, string> = {
  environment: 'Environment variable',
  stdin: 'Standard input',
  file: 'File',
  askpass: 'Askpass',
  ssh_agent: 'SSH agent',
}

export const CONFIGURABLE_DELIVERY_KINDS: SecureSecretDeliveryKind[] = [
  'environment',
  'stdin',
  'file',
  'askpass',
  'ssh_agent',
]
