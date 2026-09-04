import { useState } from 'react'
import type {
  AgentDescriptor,
  ManagerExactModelSelection,
  ManagerProfile,
  ManagerReasoningLevel,
} from '@forge/protocol'
import { Edit3, FolderOpen, RefreshCw, ShieldCheck } from 'lucide-react'
import { ChangeCwdDialog } from '@/components/chat/ChangeCwdDialog'
import { ChangeModelDialog } from '@/components/chat/agent-sidebar/dialogs/ChangeModelDialog'
import { RenameProfileDialog } from '@/components/chat/agent-sidebar/dialogs/RenameProfileDialog'
import type { ServerDirectoryBrowserClient } from '@/components/chat/ServerDirectoryBrowserDialog'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { DirectoryValidationResult } from '@/lib/ws-client'
import type { SettingsApiClient } from './settings-api-client'
import { SettingsProjectResources } from './SettingsProjectResources'

export interface ProjectSettingsActions {
  onRenameProfile?: (profileId: string, displayName: string) => void
  onUpdateManagerModel?: (
    profileId: string,
    modelSelection: ManagerExactModelSelection,
    reasoningLevel?: ManagerReasoningLevel,
  ) => void
  onUpdateManagerCwd?: (profileId: string, cwd: string) => Promise<void>
  onBrowseDirectory?: (defaultPath: string) => Promise<string | null>
  onValidateDirectory?: (path: string) => Promise<DirectoryValidationResult>
  serverDirectoryBrowser?: {
    client: ServerDirectoryBrowserClient
    canCreateDirectory?: boolean
  }
  onOpenProjectSecrets?: (profileId: string) => void
}

interface SettingsProjectSettingsProps {
  wsUrl: string
  profile: ManagerProfile
  manager?: AgentDescriptor
  apiClient: SettingsApiClient
  modelConfigChangeKey?: number
  connectionEpoch?: number
  actions?: ProjectSettingsActions
}

/**
 * Builder-only configuration for one selected project. Mutation controls use
 * the same dialogs and handlers as the sidebar; repository resources retain
 * their existing profile/session-scoped API surface.
 */
export function SettingsProjectSettings({
  wsUrl,
  profile,
  manager,
  apiClient,
  modelConfigChangeKey,
  connectionEpoch,
  actions,
}: SettingsProjectSettingsProps) {
  const [renaming, setRenaming] = useState(false)
  const [changingModel, setChangingModel] = useState(false)
  const [changingCwd, setChangingCwd] = useState(false)
  const projectContext = manager
    ? { profileId: profile.profileId, sessionAgentId: manager.agentId }
    : null
  const model = profile.defaultModel
  const workingDirectory = manager?.cwd

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Project Settings</h2>
        <p className="text-sm text-muted-foreground">
          Settings for <span className="font-medium text-foreground">{profile.displayName}</span>. Changes apply only to this project.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div>
              <CardTitle>Project name</CardTitle>
              <CardDescription>{profile.displayName}</CardDescription>
            </div>
            <Button size="sm" variant="outline" onClick={() => setRenaming(true)} disabled={!actions?.onRenameProfile}>
              <Edit3 className="mr-2 size-3.5" />
              Rename
            </Button>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div className="min-w-0">
              <CardTitle>Working directory</CardTitle>
              <CardDescription className="mt-1 break-all font-mono text-xs">
                {workingDirectory ?? 'No primary project session is available.'}
              </CardDescription>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setChangingCwd(true)}
              disabled={!workingDirectory || !actions?.onUpdateManagerCwd || !actions.onValidateDirectory}
            >
              <FolderOpen className="mr-2 size-3.5" />
              Change
            </Button>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div className="min-w-0">
              <CardTitle>Default model</CardTitle>
              <CardDescription className="mt-1 break-all">
                {model ? `${model.provider}/${model.modelId}${model.thinkingLevel ? ` · ${model.thinkingLevel} reasoning` : ''}` : 'No default model configured.'}
              </CardDescription>
            </div>
            <Button size="sm" variant="outline" onClick={() => setChangingModel(true)} disabled={!actions?.onUpdateManagerModel}>
              <RefreshCw className="mr-2 size-3.5" />
              Change
            </Button>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div>
              <CardTitle>Project secrets</CardTitle>
              <CardDescription>Manage access to saved secrets for this project.</CardDescription>
            </div>
            <Button size="sm" variant="outline" onClick={() => actions?.onOpenProjectSecrets?.(profile.profileId)} disabled={!actions?.onOpenProjectSecrets}>
              <ShieldCheck className="mr-2 size-3.5" />
              Manage
            </Button>
          </CardHeader>
        </Card>
      </div>

      {projectContext ? (
        <SettingsProjectResources
          managers={[]}
          projectContext={projectContext}
          apiClient={apiClient}
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Repository resources</CardTitle>
            <CardDescription>A primary project session is required to inspect repository .forge resources.</CardDescription>
          </CardHeader>
        </Card>
      )}

      {renaming && actions?.onRenameProfile ? (
        <RenameProfileDialog
          profileId={profile.profileId}
          currentName={profile.displayName}
          onConfirm={(profileId, displayName) => {
            actions.onRenameProfile?.(profileId, displayName)
            setRenaming(false)
          }}
          onClose={() => setRenaming(false)}
        />
      ) : null}
      {changingModel && actions?.onUpdateManagerModel ? (
        <ChangeModelDialog
          wsUrl={wsUrl}
          apiClient={apiClient}
          modelConfigChangeKey={modelConfigChangeKey}
          connectionEpoch={connectionEpoch}
          profileId={profile.profileId}
          profileLabel={profile.displayName}
          currentModel={model}
          currentReasoningLevel={model?.thinkingLevel as ManagerReasoningLevel | undefined}
          onConfirm={(profileId, modelSelection, reasoningLevel) => {
            actions.onUpdateManagerModel?.(profileId, modelSelection, reasoningLevel)
            setChangingModel(false)
          }}
          onClose={() => setChangingModel(false)}
        />
      ) : null}
      {changingCwd && workingDirectory && actions?.onUpdateManagerCwd && actions.onValidateDirectory ? (
        <ChangeCwdDialog
          profileId={profile.profileId}
          profileLabel={profile.displayName}
          currentCwd={workingDirectory}
          onConfirm={actions.onUpdateManagerCwd}
          onClose={() => setChangingCwd(false)}
          onBrowseDirectory={actions.onBrowseDirectory}
          serverDirectoryBrowser={actions.serverDirectoryBrowser}
          onValidateDirectory={actions.onValidateDirectory}
        />
      ) : null}
    </div>
  )
}
