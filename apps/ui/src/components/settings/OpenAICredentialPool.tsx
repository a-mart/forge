import type { SettingsAuthProviderAuthType } from '@forge/protocol'
import type { SettingsApiClient } from './settings-api-client'
import type { SettingsBackendTarget } from './settings-target'
import { CredentialPoolPanel } from './CredentialPoolPanel'

/* ------------------------------------------------------------------ */
/*  OpenAI credential pool — thin wrapper around CredentialPoolPanel  */
/* ------------------------------------------------------------------ */

interface OpenAICredentialPoolProps {
  apiClient: SettingsApiClient
  target: SettingsBackendTarget
  authType?: SettingsAuthProviderAuthType
  onError: (message: string) => void
  onSuccess: (message: string) => void
  onAuthReload: () => void
}

export function OpenAICredentialPool({ apiClient, target, authType, onError, onSuccess, onAuthReload }: OpenAICredentialPoolProps) {
  return (
    <CredentialPoolPanel
      provider="openai-codex"
      providerLabel="OpenAI"
      authType={authType}
      apiClient={apiClient}
      target={target}
      onError={onError}
      onSuccess={onSuccess}
      onAuthReload={onAuthReload}
    />
  )
}
