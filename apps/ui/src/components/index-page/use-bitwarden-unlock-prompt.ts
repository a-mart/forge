import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SecureSecretsCatalog, SecureSecretProviderSummary } from '@/lib/secure-secrets-api'
import type { BitwardenUnlockReason } from '@/components/chat/secure-session/BitwardenUnlockDialog'

export interface BitwardenUnlockPromptState {
  providerId: string
  providerName: string
  reason: BitwardenUnlockReason
}

interface UseBitwardenUnlockPromptOptions {
  catalog: SecureSecretsCatalog | null
  providerIds?: readonly string[]
  promptWhenNeeded?: boolean
  active: boolean
  canUnlock: boolean
  unlock: (providerId: string, masterPassword: string) => Promise<void>
}

export function useBitwardenUnlockPrompt({
  catalog,
  providerIds,
  promptWhenNeeded = false,
  active,
  canUnlock,
  unlock,
}: UseBitwardenUnlockPromptOptions) {
  const [prompt, setPrompt] = useState<BitwardenUnlockPromptState | null>(null)
  const promptedAtLaunchRef = useRef(new Set<string>())
  const pendingResolutionRef = useRef<((unlocked: boolean) => void) | null>(null)
  const lockedProvider = useMemo(
    () => findLockedBitwardenPasswordManager(catalog, providerIds),
    [catalog, providerIds],
  )

  const finish = useCallback((unlocked: boolean) => {
    const resolve = pendingResolutionRef.current
    pendingResolutionRef.current = null
    setPrompt(null)
    resolve?.(unlocked)
  }, [])

  useEffect(() => {
    if (!promptWhenNeeded || !active || !canUnlock || !lockedProvider) return
    if (promptedAtLaunchRef.current.has(lockedProvider.providerId)) return
    promptedAtLaunchRef.current.add(lockedProvider.providerId)
    setPrompt({
      providerId: lockedProvider.providerId,
      providerName: lockedProvider.displayName,
      reason: 'secure_session',
    })
  }, [active, canUnlock, lockedProvider, promptWhenNeeded])

  useEffect(() => () => {
    pendingResolutionRef.current?.(false)
    pendingResolutionRef.current = null
  }, [])

  const ensureUnlocked = useCallback((): Promise<boolean> => {
    if (!lockedProvider) return Promise.resolve(true)
    if (!active || !canUnlock) return Promise.resolve(false)
    pendingResolutionRef.current?.(false)
    return new Promise<boolean>((resolve) => {
      pendingResolutionRef.current = resolve
      setPrompt({
        providerId: lockedProvider.providerId,
        providerName: lockedProvider.displayName,
        reason: 'secure_session',
      })
    })
  }, [active, canUnlock, lockedProvider])

  const unlockPrompt = useCallback(async (masterPassword: string) => {
    if (!prompt) return
    await unlock(prompt.providerId, masterPassword)
    finish(true)
  }, [finish, prompt, unlock])

  const dismissPrompt = useCallback(() => finish(false), [finish])

  return {
    lockedProvider,
    prompt,
    ensureUnlocked,
    unlockPrompt,
    dismissPrompt,
  }
}

export function findLockedBitwardenPasswordManager(
  catalog: SecureSecretsCatalog | null,
  providerIds?: readonly string[],
): SecureSecretProviderSummary | null {
  return catalog?.providers.find((provider) =>
    (!providerIds || providerIds.includes(provider.providerId))
    && provider.kind === 'bitwarden_password_manager'
    && provider.enabled
    && provider.status === 'locked'
  ) ?? null
}
