import type { SettingsAuthProviderAuthType } from '@forge/protocol'
import { CredentialPoolPanel } from './CredentialPoolPanel'

/* ------------------------------------------------------------------ */
/*  OpenAI credential pool — thin wrapper around CredentialPoolPanel  */
/* ------------------------------------------------------------------ */

interface OpenAICredentialPoolProps {
  wsUrl: string
  authType?: SettingsAuthProviderAuthType
  onError: (message: string) => void
  onSuccess: (message: string) => void
  onAuthReload: () => void
}

export function OpenAICredentialPool({ wsUrl, authType, onError, onSuccess, onAuthReload }: OpenAICredentialPoolProps) {
  return (
    <CredentialPoolPanel
      provider="openai-codex"
      providerLabel="OpenAI"
      authType={authType}
      wsUrl={wsUrl}
      onError={onError}
      onSuccess={onSuccess}
      onAuthReload={onAuthReload}
    />
  )
}
