import { Globe } from 'lucide-react'
import type { SettingsApiClient } from '../settings-api-client'

interface CollabSettingsBannerProps {
  apiClient: SettingsApiClient
}

/**
 * Persistent banner shown in Settings when editing a remote collaboration server.
 * Makes it unmistakable that changes go to the Collab server, not the local Builder.
 */
export function CollabSettingsBanner({ apiClient }: CollabSettingsBannerProps) {
  const serverUrl = apiClient.target.apiBaseUrl

  return (
    <div
      className="mb-4 flex items-start gap-3 rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-3"
      data-testid="collab-settings-banner"
    >
      <Globe className="mt-0.5 size-4 shrink-0 text-blue-400" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-blue-300">
          Editing remote collaboration server settings
        </p>
        <p className="mt-0.5 truncate text-xs text-blue-400/80">
          {serverUrl}
        </p>
      </div>
    </div>
  )
}
