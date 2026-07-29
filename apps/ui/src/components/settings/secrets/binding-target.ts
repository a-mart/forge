import type { SecureSecretDeliveryKind } from '@/lib/secure-secrets-api'

export function isValidBindingTarget(
  deliveryKind: SecureSecretDeliveryKind,
  target: string,
): boolean {
  if (
    deliveryKind === 'stdin'
    || deliveryKind === 'ssh_agent'
  ) {
    return true
  }
  if (!target) return false
  if (deliveryKind !== 'file') return true

  const root = '/run/forge-secure/bindings/'
  const reservedSshRoot = `${root}.forge-ssh/`
  if (
    !target.startsWith(root)
    || target.startsWith(reservedSshRoot)
    || target.includes('\\')
    || target.includes('\0')
    || target.endsWith('/')
  ) {
    return false
  }
  return target
    .slice(root.length)
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}
