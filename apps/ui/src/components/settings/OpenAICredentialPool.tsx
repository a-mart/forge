import { useState } from 'react'
import type { OpenAIBrokerSettingsState, SettingsAuthProviderAuthType } from '@forge/protocol'
import type { SettingsApiClient } from './settings-api-client'
import type { SettingsBackendTarget } from './settings-target'
import { CredentialPoolPanel } from './CredentialPoolPanel'
import { OpenAIBrokerAuthPanel } from './OpenAIBrokerAuthPanel'

/* ------------------------------------------------------------------ */
/*  OpenAI credential pool — broker source + local credential pool      */
/* ------------------------------------------------------------------ */

interface OpenAICredentialPoolProps {
  apiClient: SettingsApiClient
  target: SettingsBackendTarget
  authType?: SettingsAuthProviderAuthType
  onError: (message: string) => void
  onSuccess: (message: string) => void
  onAuthReload: () => void
}

export function OpenAICredentialPool({
  apiClient,
  target,
  authType,
  onError,
  onSuccess,
  onAuthReload,
}: OpenAICredentialPoolProps) {
  const [brokerSettings, setBrokerSettings] = useState<OpenAIBrokerSettingsState | null>(null)
  const brokerActive = brokerSettings?.effectiveMode === 'central_broker'

  return (
    <div className="space-y-3">
      <OpenAIBrokerAuthPanel
        apiClient={apiClient}
        onError={onError}
        onSuccess={onSuccess}
        onSettingsChanged={setBrokerSettings}
        onBrokerSettingsMutated={onAuthReload}
      />

      <CredentialPoolPanel
        provider="openai-codex"
        providerLabel="OpenAI local credentials"
        description={
          brokerActive
            ? 'Local OpenAI OAuth/API credentials (read-only while Forge Auth broker mode is active).'
            : 'Local OpenAI OAuth/API credentials and multi-account pooling.'
        }
        authType={authType}
        apiClient={apiClient}
        target={target}
        readOnly={brokerActive}
        onError={onError}
        onSuccess={onSuccess}
        onAuthReload={onAuthReload}
      />
    </div>
  )
}
