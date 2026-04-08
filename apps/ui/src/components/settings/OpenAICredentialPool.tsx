import { CredentialPoolPanel } from './CredentialPoolPanel'

/* ------------------------------------------------------------------ */
/*  OpenAI credential pool — thin wrapper around CredentialPoolPanel  */
/* ------------------------------------------------------------------ */

interface OpenAICredentialPoolProps {
  wsUrl: string
  onError: (message: string) => void
  onSuccess: (message: string) => void
  onAuthReload: () => void
}

export function OpenAICredentialPool({ wsUrl, onError, onSuccess, onAuthReload }: OpenAICredentialPoolProps) {
  return (
    <CredentialPoolPanel
      provider="openai-codex"
      providerLabel="OpenAI"
      wsUrl={wsUrl}
      onError={onError}
      onSuccess={onSuccess}
      onAuthReload={onAuthReload}
    />
  )
}
